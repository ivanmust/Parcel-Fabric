import { config } from "../../../config/env.js";
import { arcgisPost, type ArcGisJson } from "../../../common/arcgis/arcgis-client.js";
import { LaisConfigurationError } from "../domain/gis-errors.js";
import type { Attributes } from "../models/transaction.model.js";

const REQUIRED_FIELDS = {
  upi: "name",
  transactionId: "transaction_id",
  transactionType: "transaction_type",
  transactionStatus: "transaction_status",
  transactionDate: "transaction_date",
  case: "case_",
  validationMessage: "validation_message",
  versionStatus: "version_status",
  versionName: "version_name",
  retiredBy: "retiredbyrecord",
  createdBy: "createdbyrecord",
} as const;

/** Parcel details reported to LAIS when the layer has them; the first field with a value wins. */
const OPTIONAL_FIELDS = {
  area: ["size", "shape__area"],
  province: ["province"],
  district: ["district"],
  sector: ["sector"],
  cell: ["cell"],
  village: ["village"],
} as const;

export type Logical = keyof typeof REQUIRED_FIELDS;
export type Optional = keyof typeof OPTIONAL_FIELDS;

export interface RecordsSchema {
  url: string;
  globalIdField: string;
  nameField: string;
  recordedDateField?: string;
  transactionIdField?: string;
}

export interface LayerSchema {
  objectIdField: string;
  globalIdField?: string;
  fields: Record<Logical, string>;
  domains: Partial<Record<Logical, string[]>>;
  lengths: Partial<Record<Logical, number>>;
  optional: Partial<Record<Optional, string[]>>;
  editDateField?: string;
  fieldTypes: Record<string, string>;
  records: RecordsSchema | null;
}

export type PlotFeature = { attributes: Attributes; geometry: object };

interface FieldInfo {
  name: string;
  type?: string;
  length?: number;
  domain?: { codedValues?: Array<{ code: unknown }> };
}

const SCHEMA_TTL_MS = 10 * 60_000;
let schemaCache: { value: LayerSchema; at: number } | null = null;

const plotUrl = () => config.lais.plotLayerUrl;
const fieldsByLowerName = (meta: ArcGisJson) => new Map<string, FieldInfo>(((meta.fields ?? []) as FieldInfo[]).map((f) => [String(f.name).toLowerCase(), f]));

/** The Records layer, found through the Plot's relationship on createdbyrecord. */
async function readRecordsSchema(token: string, plotMeta: ArcGisJson): Promise<RecordsSchema | null> {
  const relation = ((plotMeta.relationships ?? []) as Array<{ keyField?: string; relatedTableId?: number }>).find(
    (r) => String(r.keyField ?? "").toLowerCase() === REQUIRED_FIELDS.createdBy && typeof r.relatedTableId === "number",
  );
  if (!relation) return null;
  const url = plotUrl().replace(/\/\d+$/, `/${relation.relatedTableId}`);
  const meta = await arcgisPost(url, {}, token);
  const fields = fieldsByLowerName(meta);
  const nameField = fields.get("name")?.name;
  const globalIdField = typeof meta.globalIdField === "string" ? meta.globalIdField : fields.get("globalid")?.name;
  if (!nameField || !globalIdField) return null;
  return { url, globalIdField, nameField, recordedDateField: fields.get("recordeddate")?.name, transactionIdField: fields.get("transaction_id")?.name };
}

function readRequiredFields(byName: Map<string, FieldInfo>) {
  const fields = {} as Record<Logical, string>;
  const domains: Partial<Record<Logical, string[]>> = {};
  const lengths: Partial<Record<Logical, number>> = {};
  const missing: string[] = [];
  for (const [logical, expected] of Object.entries(REQUIRED_FIELDS) as Array<[Logical, string]>) {
    const field = byName.get(expected);
    if (!field) {
      missing.push(expected);
      continue;
    }
    fields[logical] = field.name;
    if (field.domain?.codedValues) domains[logical] = field.domain.codedValues.map((c) => String(c.code));
    if (typeof field.length === "number" && field.length > 0) lengths[logical] = field.length;
  }
  if (missing.length) throw new LaisConfigurationError(`The Plot layer is missing fields: ${missing.join(", ")}`);
  for (const [logical, code] of [["case", "Yes"], ["versionStatus", "VersionCreated"]] as const) {
    const codes = domains[logical];
    if (codes && !codes.includes(code)) throw new LaisConfigurationError(`Domain of ${fields[logical]} has no '${code}' code.`);
  }
  return { fields, domains, lengths };
}

function readOptionalFields(byName: Map<string, FieldInfo>, meta: ArcGisJson) {
  const optional: Partial<Record<Optional, string[]>> = {};
  for (const [key, names] of Object.entries(OPTIONAL_FIELDS) as Array<[Optional, readonly string[]]>) {
    const present = names.map((n) => byName.get(n)?.name).filter((n): n is string => !!n);
    if (present.length) optional[key] = present;
  }
  // The shape area field has a service-specific name, e.g. st_area(shape).
  const shapeArea = meta.geometryProperties?.shapeAreaFieldName;
  if (typeof shapeArea === "string" && !(optional.area ?? []).some((n) => n.toLowerCase() === shapeArea.toLowerCase())) {
    optional.area = [...(optional.area ?? []), shapeArea];
  }
  return optional;
}

export async function layerSchema(token: string): Promise<LayerSchema> {
  if (schemaCache && Date.now() - schemaCache.at < SCHEMA_TTL_MS) return schemaCache.value;
  const meta = await arcgisPost(plotUrl(), {}, token);
  if (meta.isDataBranchVersioned !== true) {
    throw new LaisConfigurationError("The configured Plot layer is not branch versioned; refusing to edit it.");
  }
  const byName = fieldsByLowerName(meta);
  const editDate = meta.editFieldsInfo?.editDateField;
  const value: LayerSchema = {
    objectIdField: String(meta.objectIdField ?? "objectid"),
    globalIdField: typeof meta.globalIdField === "string" && meta.globalIdField ? meta.globalIdField : byName.get("globalid")?.name,
    ...readRequiredFields(byName),
    optional: readOptionalFields(byName, meta),
    editDateField: typeof editDate === "string" ? byName.get(editDate.toLowerCase())?.name : undefined,
    fieldTypes: Object.fromEntries([...byName.values()].map((f) => [f.name, String(f.type ?? "")])),
    records: await readRecordsSchema(token, meta),
  };
  schemaCache = { value, at: Date.now() };
  return value;
}

export function clearSchemaCacheForTests(): void {
  schemaCache = null;
}

/** A field of the Plot layer by name, ignoring case (e.g. editing_status), or null. */
export const plotField = (schema: LayerSchema, name: string) => Object.keys(schema.fieldTypes).find((f) => f.toLowerCase() === name) ?? null;

export async function queryPlots(token: string, schema: LayerSchema, where: string, gdbVersion?: string, outFields?: string[], count = 3): Promise<Attributes[]> {
  const body = await arcgisPost(
    `${plotUrl()}/query`,
    {
      where,
      outFields: (outFields ?? [schema.objectIdField, ...Object.values(schema.fields)]).join(","),
      returnGeometry: "false",
      resultRecordCount: String(count),
      ...(gdbVersion ? { gdbVersion } : {}),
    },
    token,
  );
  return (body.features ?? []).map((f: { attributes?: Attributes }) => f.attributes ?? {});
}

/** Plots with their shapes (sde.DEFAULT, or a version), and the coordinate system of the shapes. */
export async function plotShapes(token: string, where: string, outFields: string[], gdbVersion?: string) {
  const body = await arcgisPost(`${plotUrl()}/query`, { where, outFields: outFields.join(","), returnGeometry: "true", resultRecordCount: "100", ...(gdbVersion ? { gdbVersion } : {}) }, token);
  return {
    spatialReference: body.spatialReference as object,
    features: (body.features ?? []) as PlotFeature[],
  };
}

/**
 * Plots related to a shape by a DE-9IM relation: "F***1****" = neighbours sharing a boundary line,
 * "T********" = overlapping.
 */
export async function relatedPlots(token: string, schema: LayerSchema, shape: object, spatialReference: object, relation: string, where: string, gdbVersion?: string): Promise<Attributes[]> {
  const body = await arcgisPost(
    `${plotUrl()}/query`,
    {
      where,
      geometry: JSON.stringify(shape),
      geometryType: "esriGeometryPolygon",
      inSR: JSON.stringify(spatialReference),
      spatialRel: "esriSpatialRelRelation",
      relationParam: relation,
      outFields: [schema.objectIdField, schema.fields.upi].join(","),
      returnGeometry: "false",
      resultRecordCount: "100",
      ...(gdbVersion ? { gdbVersion } : {}),
    },
    token,
  );
  return (body.features ?? []).map((f: { attributes?: Attributes }) => f.attributes ?? {});
}

/** The Plot layer's id in its feature service (e.g. 17). */
export const plotLayerId = () => Number(config.lais.plotLayerUrl.split("/").pop());
