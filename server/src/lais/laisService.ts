import { randomUUID } from "node:crypto";
import { config } from "../config/env.js";
import { logger } from "../logging/logger.js";
import { arcgisPost, ArcGisError, type ArcGisJson } from "./arcgisClient.js";
import { allEntries, clearLedgerForTests, getEntry, putEntry, type Completion, type LedgerEntry } from "./ledger.js";


export const TRANSACTION_TYPES = ["Subdivision", "Merge", "CorrectBoundaries", "CreatePlot"] as const;
export const TRANSACTION_STATUSES = ["New", "InProgress", "Approved", "Rejected"] as const;

export interface LaisSubmission {
  /**
   * The parcels of the transaction, from `UPI` (one) or `UPIs` (a list).
   * Merge: 2 or more neighbouring parcels · Subdivision: exactly 1 · CorrectBoundaries: 1 or more ·
   * CreatePlot: 0 or more (a new plot may have no parent).
   */
  UPIs: string[];
  Transaction_ID: string;
  Transaction_Type: string;
  Transaction_Date: string;
  Transaction_Status?: string;
}

export interface FieldError {
  field: string;
  code: string;
  message: string;
  /** UPI_EXPIRED: the current UPIs of the parcels that replaced the expired one. */
  replacedBy?: string[];
  /** UPI_IN_TRANSACTION: the open transaction that holds the parcel. */
  transactionId?: string;
}

export interface LaisRecord {
  /** The first parcel's UPI (kept for single-parcel clients); all of them are in UPIs. */
  UPI: string | null;
  UPIs: string[];
  Transaction_ID: string | null;
  Transaction_Type: string | null;
  Transaction_Status: string | null;
  Transaction_Date: string | null;
  case: string | null;
  validation_message: string | null;
  version_name: string | null;
  version_status: string | null;
  /**
   * InReview: GIS has not finished it (the change is not in sde.DEFAULT yet).
   * Posted: the GIS change is in sde.DEFAULT; `result` holds the resulting parcels.
   * Closed: its version was removed without the change reaching sde.DEFAULT (cancelled in GIS).
   */
  stage: Stage;
  /** Set when stage is Posted: what GIS changed, with the parcels' current attributes. */
  result: LaisResult | null;
  warnings: LaisWarning[];
  /** When what this record reports last changed (stage, result or warnings); null when unknown. */
  updated_at: string | null;
}

export const STAGES = ["InReview", "Posted", "Closed"] as const;
export type Stage = (typeof STAGES)[number];

export interface LaisParcel {
  /** null while GIS has not assigned the parcel a UPI (see warnings UPI_MISSING). */
  UPI: string | null;
  /** false if GIS has since retired this parcel too (merged or subdivided again later). */
  current: boolean;
  area_sqm: number | null;
  province: string | null;
  district: string | null;
  sector: string | null;
  cell: string | null;
  village: string | null;
}

export interface LaisResult {
  /** The parcels the transaction produced (Merge, Subdivision, CreatePlot) or corrected in place. */
  parcels: LaisParcel[];
  /** The parcels it ended: they are history now and their UPIs have expired. */
  retired_parcels: Array<{ UPI: string | null }>;
  /** The Parcel Fabric record(s) of the change. */
  records: Array<{ name: string | null; recorded_date: string | null }>;
  /** Latest GIS edit time of these parcels (the edit; it reached sde.DEFAULT when the version was posted). */
  completed_at: string | null;
  /** When this API first found the change in sde.DEFAULT. */
  detected_at: string;
}

export interface LaisWarning {
  code: "UPI_MISSING" | "NO_RESULT_PARCELS";
  message: string;
}

export type SubmitOutcome =
  | { kind: "created"; record: LaisRecord }
  | { kind: "duplicate"; record: LaisRecord }
  | { kind: "conflict"; errors: FieldError[] }
  /** A parcel is in another transaction that GIS has not finished. */
  | { kind: "busy"; errors: FieldError[] }
  | { kind: "invalid"; errors: FieldError[] };

/** Thrown when the deployed service does not look like what this API was built for. */
export class LaisConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LaisConfigurationError";
  }
}

// ---------------------------------------------------------------- input validation

const UPI_PATTERN = /^\d\/\d{2}\/\d{2}\/\d{2}\/\d+$/;
const TRANSACTION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const ISO_WITH_ZONE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-](\d{2}):(\d{2}))$/;
const ALLOWED_KEYS = new Set(["UPI", "UPIs", "Transaction_ID", "Transaction_Type", "Transaction_Date", "Transaction_Status"]);
export const MAX_UPIS = 20;
// Transaction_ID has no maximum length (agreed with LAIS, 2026-11-25); the request body limit (256 KB) still applies.
const MAX = { UPI: 100, Transaction_ID: Number.POSITIVE_INFINITY, Transaction_Type: 25, Transaction_Date: 64, Transaction_Status: 25 } as const;

export function isValidTransactionDate(value: string): boolean {
  const m = ISO_WITH_ZONE.exec(value);
  if (!m || Number.isNaN(Date.parse(value))) return false;
  const [, y, mo, d, h, mi, sec = "0", , zone, zh = "0", zm = "0"] = m;
  const year = Number(y), month = Number(mo), day = Number(d);
  const local = new Date(Date.UTC(year, month - 1, day));
  if (local.getUTCFullYear() !== year || local.getUTCMonth() !== month - 1 || local.getUTCDate() !== day) return false;
  if (Number(h) > 23 || Number(mi) > 59 || Number(sec) > 59) return false;
  if (zone !== "Z" && (Number(zh) > 14 || Number(zm) > 59 || (Number(zh) === 14 && Number(zm) !== 0))) return false;
  return true;
}

function matchCode<T extends string>(value: string, codes: readonly T[]): T | undefined {
  return codes.find((c) => c.toLowerCase() === value.toLowerCase());
}

/** How many parcels each transaction type takes: [min, max]. */
const UPI_COUNT: Record<(typeof TRANSACTION_TYPES)[number], [number, number]> = {
  Merge: [2, MAX_UPIS],
  Subdivision: [1, 1],
  CorrectBoundaries: [1, MAX_UPIS],
  CreatePlot: [0, MAX_UPIS],
};

/**
 * Validate the LAIS request body. Field-specific errors; `case` and unknown keys are rejected.
 * `listForm` says whether the parcels came as `UPIs` (errors then name `UPIs[i]`) or as `UPI`.
 */
export function validateSubmission(body: unknown): { ok: true; value: LaisSubmission; listForm: boolean } | { ok: false; errors: FieldError[] } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, errors: [{ field: "body", code: "INVALID_BODY", message: "Send a JSON object with Content-Type: application/json." }] };
  }
  const input = body as Record<string, unknown>;
  const errors: FieldError[] = [];
  for (const key of Object.keys(input)) {
    if (!ALLOWED_KEYS.has(key)) {
      errors.push({ field: key, code: "UNKNOWN_FIELD", message: key === "case" ? "case is decided by the GIS API and must not be sent." : `Unknown field ${key}.` });
    }
  }

  const text = (field: keyof typeof MAX, required: boolean): string | undefined => {
    const raw = input[field];
    if (raw === undefined || raw === null) {
      if (required) errors.push({ field, code: "REQUIRED_FIELD", message: `${field} is required.` });
      return undefined;
    }
    if (typeof raw !== "string") {
      errors.push({ field, code: "INVALID_TYPE", message: `${field} must be a string.` });
      return undefined;
    }
    const value = raw.trim();
    if (!value) {
      if (required) errors.push({ field, code: "REQUIRED_FIELD", message: `${field} must not be empty.` });
      return undefined;
    }
    if (value.length > MAX[field]) {
      errors.push({ field, code: "TOO_LONG", message: `${field} must be at most ${MAX[field]} characters.` });
      return undefined;
    }
    return value;
  };

  // The parcels: `UPI` (one) or `UPIs` (a list), not both. undefined = the list itself is invalid.
  const badFormat = (field: string) => ({ field, code: "INVALID_UPI_FORMAT", message: "UPI must follow province/district/sector/cell/number, for example 1/02/13/02/1001." });
  const hasOne = input.UPI !== undefined && input.UPI !== null;
  const hasList = input.UPIs !== undefined && input.UPIs !== null;
  let UPIs: string[] | undefined = [];
  if (hasOne && hasList) {
    errors.push({ field: "UPIs", code: "CONFLICTING_FIELDS", message: "Send either UPI (one parcel) or UPIs (a list of parcels), not both." });
    UPIs = undefined;
  } else if (hasList) {
    const raw = input.UPIs;
    if (!Array.isArray(raw)) {
      errors.push({ field: "UPIs", code: "INVALID_TYPE", message: "UPIs must be a list of UPI strings." });
      UPIs = undefined;
    } else if (raw.length > MAX_UPIS) {
      errors.push({ field: "UPIs", code: "TOO_LONG", message: `UPIs may list at most ${MAX_UPIS} parcels.` });
      UPIs = undefined;
    } else {
      const list: string[] = [];
      raw.forEach((u, i) => {
        const field = `UPIs[${i}]`;
        if (typeof u !== "string") return errors.push({ field, code: "INVALID_TYPE", message: `${field} must be a string.` });
        const v = u.trim();
        if (!v) return errors.push({ field, code: "REQUIRED_FIELD", message: `${field} must not be empty.` });
        if (v.length > MAX.UPI) return errors.push({ field, code: "TOO_LONG", message: `${field} must be at most ${MAX.UPI} characters.` });
        if (!UPI_PATTERN.test(v)) return errors.push(badFormat(field));
        if (list.includes(v)) return errors.push({ field, code: "DUPLICATE_UPI", message: `${v} is listed more than once.` });
        list.push(v);
      });
      UPIs = list.length === raw.length ? list : undefined;
    }
  } else if (hasOne) {
    const v = text("UPI", true);
    if (v && !UPI_PATTERN.test(v)) errors.push(badFormat("UPI"));
    UPIs = v && UPI_PATTERN.test(v) ? [v] : undefined;
  }
  const Transaction_ID = text("Transaction_ID", true);
  const typeRaw = text("Transaction_Type", true);
  const Transaction_Date = text("Transaction_Date", true);
  const statusRaw = text("Transaction_Status", false);
  if (Transaction_ID && !TRANSACTION_ID_PATTERN.test(Transaction_ID)) {
    errors.push({ field: "Transaction_ID", code: "INVALID_FORMAT", message: "Transaction_ID may contain letters, digits and . _ - : / and must start with a letter or digit." });
  }
  const Transaction_Type = typeRaw ? matchCode(typeRaw, TRANSACTION_TYPES) : undefined;
  if (typeRaw && !Transaction_Type) {
    errors.push({ field: "Transaction_Type", code: "INVALID_TRANSACTION_TYPE", message: `Allowed values: ${TRANSACTION_TYPES.join(", ")}.` });
  }
  const Transaction_Status = statusRaw ? matchCode(statusRaw, TRANSACTION_STATUSES) : undefined;
  if (statusRaw && !Transaction_Status) {
    errors.push({ field: "Transaction_Status", code: "INVALID_TRANSACTION_STATUS", message: `Allowed values: ${TRANSACTION_STATUSES.join(", ")}.` });
  }
  if (Transaction_Date && !isValidTransactionDate(Transaction_Date)) {
    errors.push({ field: "Transaction_Date", code: "INVALID_DATE", message: "Use an ISO 8601 date-time with an explicit timezone, for example 2026-11-24T08:30:00+02:00." });
  }

  // How many parcels this type of transaction needs.
  if (Transaction_Type && UPIs) {
    const [min, max] = UPI_COUNT[Transaction_Type];
    if (UPIs.length < min || UPIs.length > max) {
      const field = hasList ? "UPIs" : "UPI";
      if (Transaction_Type === "Merge") errors.push({ field: "UPIs", code: "MERGE_NEEDS_TWO_UPIS", message: 'A Merge lists the UPIs of all parcels being merged, at least two: "UPIs": ["…", "…"].' });
      else if (Transaction_Type === "Subdivision") errors.push({ field, code: "SUBDIVISION_NEEDS_ONE_UPI", message: "A Subdivision names exactly one parcel: the parcel being subdivided." });
      else errors.push({ field, code: "REQUIRED_FIELD", message: `A ${Transaction_Type} names at least one parcel in UPI or UPIs.` });
    }
  }

  if (errors.length || !UPIs || !Transaction_ID || !Transaction_Type || !Transaction_Date) {
    return { ok: false, errors };
  }
  return { ok: true, listForm: hasList, value: { UPIs, Transaction_ID, Transaction_Type, Transaction_Date, ...(Transaction_Status ? { Transaction_Status } : {}) } };
}

// ---------------------------------------------------------------- naming

/** Four-letter code per transaction type, the first part of the version name. */
export const TYPE_CODES: Record<(typeof TRANSACTION_TYPES)[number], string> = {
  Subdivision: "SUBV",
  Merge: "MERG",
  CorrectBoundaries: "CORB",
  CreatePlot: "CRPL",
};

const MAX_VERSION_NAME = 62;

/**
 * Version name `{TYPE}-{CASE_NUMBER}-{DATE}`, e.g. SUBV-CASE123-20261125:
 * TYPE = TYPE_CODES[Transaction_Type], CASE_NUMBER = Transaction_ID (letters, digits, - and _ kept;
 * other characters become -), DATE = yyyyMMdd of Transaction_Date as LAIS wrote it.
 * Deterministic, so a resubmission maps to the same version.
 */
export function versionNameFor(input: Pick<LaisSubmission, "Transaction_ID" | "Transaction_Type" | "Transaction_Date">): string {
  const type = TYPE_CODES[input.Transaction_Type as keyof typeof TYPE_CODES] ?? "LAIS";
  const date = input.Transaction_Date.slice(0, 10).replace(/-/g, "");
  const room = MAX_VERSION_NAME - type.length - date.length - 2;
  const caseNumber = input.Transaction_ID.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/-{2,}/g, "-").replace(/^-|-$/g, "").slice(0, room);
  return `${type}-${caseNumber}-${date}`;
}

/** The short name (after the owner) of a fully qualified version name. */
export const shortVersionName = (full: string) => full.slice(full.lastIndexOf(".") + 1);

export const sql = (value: string) => `'${value.replace(/'/g, "''")}'`;

// ---------------------------------------------------------------- layer schema

const LOGICAL_FIELDS = {
  upi: "name",
  transactionId: "transaction_id",
  transactionType: "transaction_type",
  transactionStatus: "transaction_status",
  transactionDate: "transaction_date",
  case: "case_",
  validationMessage: "validation_message",
  versionStatus: "version_status",
  versionName: "version_name",
  /** Parcel Fabric: set when the parcel was retired (merged, subdivided, …) and kept as history. */
  retiredBy: "retiredbyrecord",
  /** Parcel Fabric: the record that created the parcel (links a historic parcel to its successors). */
  createdBy: "createdbyrecord",
} as const;
type Logical = keyof typeof LOGICAL_FIELDS;

/** Parcel details reported to LAIS when the layer has them (the first of the fields with a value wins). */
const OPTIONAL_FIELDS = {
  area: ["size", "shape__area"],
  province: ["province"],
  district: ["district"],
  sector: ["sector"],
  cell: ["cell"],
  village: ["village"],
} as const;
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
  /** The Plot's global id: a parcel's permanent identity, kept through reconcile and post. */
  globalIdField?: string;
  fields: Record<Logical, string>;
  domains: Partial<Record<Logical, string[]>>;
  /** Text field lengths, where the layer states one. */
  lengths: Partial<Record<Logical, number>>;
  optional: Partial<Record<Optional, string[]>>;
  /** Editor tracking: when the Plot was last edited. */
  editDateField?: string;
  /** Every Plot field's ArcGIS type by name (e.g. esriFieldTypeDate), for faithful attribute export. */
  fieldTypes: Record<string, string>;
  /** The Parcel Fabric Records layer (related to Plot through createdbyrecord); null if not published. */
  records: RecordsSchema | null;
}

/** The Records layer, found through the Plot's relationship on createdbyrecord. */
async function recordsSchema(token: string, plotMeta: ArcGisJson): Promise<RecordsSchema | null> {
  const relation = ((plotMeta.relationships ?? []) as Array<{ keyField?: string; relatedTableId?: number }>).find(
    (r) => String(r.keyField ?? "").toLowerCase() === LOGICAL_FIELDS.createdBy && typeof r.relatedTableId === "number",
  );
  if (!relation) return null;
  const url = config.lais.plotLayerUrl.replace(/\/\d+$/, `/${relation.relatedTableId}`);
  const meta = await arcgisPost(url, {}, token);
  const byLower = new Map<string, string>(((meta.fields ?? []) as Array<{ name: string }>).map((f) => [f.name.toLowerCase(), f.name]));
  const nameField = byLower.get("name");
  const globalIdField = typeof meta.globalIdField === "string" ? meta.globalIdField : byLower.get("globalid");
  if (!nameField || !globalIdField) return null;
  return { url, globalIdField, nameField, recordedDateField: byLower.get("recordeddate"), transactionIdField: byLower.get("transaction_id") };
}

let schemaCache: { value: LayerSchema; at: number } | null = null;
const SCHEMA_TTL_MS = 10 * 60_000;

export async function layerSchema(token: string): Promise<LayerSchema> {
  if (schemaCache && Date.now() - schemaCache.at < SCHEMA_TTL_MS) return schemaCache.value;
  const meta = await arcgisPost(config.lais.plotLayerUrl, {}, token);
  if (meta.isDataBranchVersioned !== true) {
    throw new LaisConfigurationError("The configured Plot layer is not branch versioned; refusing to edit it.");
  }
  const byLower = new Map<string, { name: string; length?: number; domain?: { codedValues?: Array<{ code: unknown }> } }>();
  for (const f of meta.fields ?? []) byLower.set(String(f.name).toLowerCase(), f);
  const fields = {} as Record<Logical, string>;
  const domains: Partial<Record<Logical, string[]>> = {};
  const lengths: Partial<Record<Logical, number>> = {};
  const missing: string[] = [];
  for (const [logical, expected] of Object.entries(LOGICAL_FIELDS) as Array<[Logical, string]>) {
    const f = byLower.get(expected);
    if (!f) missing.push(expected);
    else {
      fields[logical] = f.name;
      if (f.domain?.codedValues) domains[logical] = f.domain.codedValues.map((c) => String(c.code));
      if (typeof f.length === "number" && f.length > 0) lengths[logical] = f.length;
    }
  }
  if (missing.length) throw new LaisConfigurationError(`The Plot layer is missing fields: ${missing.join(", ")}`);
  for (const [logical, code] of [["case", "Yes"], ["versionStatus", "VersionCreated"]] as const) {
    const codes = domains[logical];
    if (codes && !codes.includes(code)) throw new LaisConfigurationError(`Domain of ${fields[logical]} has no '${code}' code.`);
  }
  const optional: Partial<Record<Optional, string[]>> = {};
  for (const [key, names] of Object.entries(OPTIONAL_FIELDS) as Array<[Optional, readonly string[]]>) {
    const present = names.map((n) => byLower.get(n)?.name).filter((n): n is string => !!n);
    if (present.length) optional[key] = present;
  }
  // The shape's area field has a service-specific name (e.g. st_area(shape) on Enterprise geodatabases).
  const shapeArea = meta.geometryProperties?.shapeAreaFieldName;
  if (typeof shapeArea === "string" && !(optional.area ?? []).some((n) => n.toLowerCase() === shapeArea.toLowerCase())) {
    optional.area = [...(optional.area ?? []), shapeArea];
  }
  const globalId = typeof meta.globalIdField === "string" && meta.globalIdField ? meta.globalIdField : byLower.get("globalid")?.name;
  const editDate = meta.editFieldsInfo?.editDateField;
  const value: LayerSchema = {
    objectIdField: String(meta.objectIdField ?? "objectid"),
    globalIdField: globalId,
    fields,
    domains,
    lengths,
    optional,
    editDateField: typeof editDate === "string" && byLower.has(editDate.toLowerCase()) ? byLower.get(editDate.toLowerCase())!.name : undefined,
    fieldTypes: Object.fromEntries(((meta.fields ?? []) as Array<{ name: string; type?: string }>).map((x) => [x.name, String(x.type ?? "")])),
    records: await recordsSchema(token, meta),
  };
  schemaCache = { value, at: Date.now() };
  return value;
}

// ---------------------------------------------------------------- ArcGIS helpers

export interface VersionRef {
  /** Fully qualified, e.g. owner.LAIS_X_ABCD1234 */
  name: string;
  guid: string;
}

export type Attributes = Record<string, unknown>;

async function queryPlots(token: string, schema: LayerSchema, where: string, gdbVersion?: string, outFields?: string[], count = 3): Promise<Attributes[]> {
  const body = await arcgisPost(
    `${config.lais.plotLayerUrl}/query`,
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

export const sqlList = (values: string[]) => values.map(sql).join(",");

/** Plots with their shapes (sde.DEFAULT), and the coordinate system the shapes are in. */
async function plotShapes(token: string, where: string, outFields: string[]) {
  const body = await arcgisPost(`${config.lais.plotLayerUrl}/query`, { where, outFields: outFields.join(","), returnGeometry: "true", resultRecordCount: "100" }, token);
  return {
    spatialReference: body.spatialReference as object,
    features: (body.features ?? []) as Array<{ attributes: Attributes; geometry: object }>,
  };
}

/**
 * Current parcels related to a shape by a DE-9IM relation (ArcGIS `esriSpatialRelRelation`):
 * "F***1****" = interiors apart, boundaries share a line (neighbours, not a corner touch);
 * "T********" = interiors overlap.
 */
async function relatedPlots(token: string, schema: LayerSchema, shape: object, spatialReference: object, relation: string, where: string): Promise<Attributes[]> {
  const body = await arcgisPost(
    `${config.lais.plotLayerUrl}/query`,
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
    },
    token,
  );
  return (body.features ?? []).map((f: { attributes?: Attributes }) => f.attributes ?? {});
}

/** Groups of ids connected through the given links. */
function connectedGroups(ids: number[], links: Array<[number, number]>): number[][] {
  const parent = new Map(ids.map((id) => [id, id]));
  const root = (id: number): number => (parent.get(id) === id ? id : root(parent.get(id)!));
  for (const [a, b] of links) if (parent.has(a) && parent.has(b)) parent.set(root(a), root(b));
  const groups = new Map<number, number[]>();
  for (const id of ids) groups.set(root(id), [...(groups.get(root(id)) ?? []), id]);
  return [...groups.values()];
}

/**
 * A Merge's parcels must be neighbours: one connected group in which each parcel shares a boundary
 * line (not just a corner) with another. Same rule as the web editor's Merge. Null when they do.
 */
async function mergeNeighbourProblem(token: string, schema: LayerSchema, parcels: Array<{ objectId: number; upi: string }>): Promise<string | null> {
  const oid = schema.objectIdField;
  const ids = parcels.map((p) => p.objectId);
  const shapes = await plotShapes(token, `${oid} IN (${ids.join(",")})`, [oid]);
  const links: Array<[number, number]> = [];
  for (const f of shapes.features) {
    const self = Number(f.attributes[oid]);
    const others = ids.filter((id) => id !== self);
    const touching = await relatedPlots(token, schema, f.geometry, shapes.spatialReference, "F***1****", `${oid} IN (${others.join(",")})`);
    for (const t of touching) links.push([self, Number(t[oid])]);
  }
  const groups = connectedGroups(ids, links);
  if (groups.length === 1) return null;
  const upi = new Map(parcels.map((p) => [p.objectId, p.upi]));
  const named = groups.map((g) => `[${g.map((id) => upi.get(id)).join(", ")}]`);
  return parcels.length === 2
    ? `${parcels[0]!.upi} and ${parcels[1]!.upi} are not neighbours: they share no boundary. Only neighbouring parcels can be merged.`
    : `The parcels are not one connected group of neighbours: ${named.join(" and ")} share no boundary with each other.`;
}

/** The current UPIs of the parcels that replaced a historic one (created by the record that retired it, overlapping it). */
async function successorUpis(token: string, schema: LayerSchema, historic: { attributes: Attributes; geometry: object }, spatialReference: object): Promise<string[]> {
  const f = schema.fields;
  const record = historic.attributes[f.retiredBy];
  if (typeof record !== "string" || !historic.geometry) return [];
  const rows = await relatedPlots(token, schema, historic.geometry, spatialReference, "T********", `${f.createdBy} = ${sql(record)} AND ${f.retiredBy} IS NULL`);
  return [...new Set(rows.map((r) => String(r[f.upi] ?? "")).filter(Boolean))].sort();
}

/**
 * Each UPI must name exactly one current parcel. A UPI found only on historic parcels has expired
 * (merged or subdivided): the error says which current parcels replaced it.
 */
async function resolveParcels(token: string, schema: LayerSchema, upis: string[], fieldOf: (i: number) => string): Promise<{ errors: FieldError[]; objectIds: number[] }> {
  const f = schema.fields;
  const oid = schema.objectIdField;
  if (!upis.length) return { errors: [], objectIds: [] };
  const current = await queryPlots(token, schema, `${f.upi} IN (${sqlList(upis)}) AND ${f.retiredBy} IS NULL`, undefined, [oid, f.upi], 200);
  const byUpi = new Map<string, number[]>();
  for (const r of current) byUpi.set(String(r[f.upi]), [...(byUpi.get(String(r[f.upi])) ?? []), Number(r[oid])]);
  const missing = upis.filter((u) => !byUpi.has(u));
  const historic = missing.length ? await plotShapes(token, `${f.upi} IN (${sqlList(missing)}) AND ${f.retiredBy} IS NOT NULL`, [oid, f.upi, f.retiredBy]) : null;

  const errors: FieldError[] = [];
  for (const [i, upi] of upis.entries()) {
    const found = byUpi.get(upi) ?? [];
    if (found.length > 1) {
      errors.push({ field: fieldOf(i), code: "UPI_NOT_UNIQUE", message: `More than one current parcel has the UPI ${upi} in GIS. GIS must resolve the duplicate before this transaction can be accepted.` });
    } else if (!found.length) {
      const old = historic?.features.find((h) => h.attributes[f.upi] === upi);
      if (!old) {
        errors.push({ field: fieldOf(i), code: "PARCEL_NOT_FOUND", message: `No parcel with the UPI ${upi} exists in GIS.` });
      } else {
        const replacedBy = await successorUpis(token, schema, old, historic!.spatialReference);
        errors.push({
          field: fieldOf(i),
          code: "UPI_EXPIRED",
          message: `The UPI ${upi} has expired: GIS merged or subdivided that parcel.${replacedBy.length ? ` It is now ${replacedBy.join(", ")}.` : ""} Use the UPI of the current parcel.`,
          ...(replacedBy.length ? { replacedBy } : {}),
        });
      }
    }
  }
  return { errors, objectIds: errors.length ? [] : upis.map((u) => byUpi.get(u)![0]!) };
}

/** The LAIS account's versions, by lower-case short name. */
export async function ownedVersions(token: string): Promise<Map<string, VersionRef>> {
  const body = await arcgisPost(`${config.lais.versionManagementUrl}/versionInfos`, { ownerFilter: config.LAIS_ARCGIS_USERNAME }, token);
  const owner = config.LAIS_ARCGIS_USERNAME.toLowerCase();
  const versions = new Map<string, VersionRef>();
  for (const v of (body.versions ?? []) as Array<{ versionName?: string; versionGuid?: string }>) {
    const full = String(v.versionName ?? "");
    const dot = full.lastIndexOf(".");
    if (dot < 0 || !v.versionGuid || full.slice(0, dot).toLowerCase() !== owner) continue;
    versions.set(full.slice(dot + 1).toLowerCase(), { name: full, guid: v.versionGuid });
  }
  return versions;
}

async function findVersion(token: string, shortName: string): Promise<VersionRef | null> {
  return (await ownedVersions(token)).get(shortName.toLowerCase()) ?? null;
}

async function createVersion(token: string, shortName: string, description: string): Promise<VersionRef> {
  try {
    const body = await arcgisPost(
      `${config.lais.versionManagementUrl}/create`,
      { versionName: shortName, description: description.slice(0, 60), accessPermission: "public" },
      token,
    );
    const info = body.versionInfo as { versionName?: string; versionGuid?: string } | undefined;
    if (!info?.versionName || !info.versionGuid) throw new ArcGisError("ArcGIS did not return the created version");
    return { name: info.versionName, guid: info.versionGuid };
  } catch (error) {
    // Another process may have created it a moment ago: use it rather than fail.
    const existing = await findVersion(token, shortName).catch(() => null);
    if (existing) return existing;
    throw error;
  }
}

/**
 * ArcGIS refusals that retrying can never fix (licence, privilege, ownership) are configuration
 * problems of the integration account: report them as such (503), not as a transient 502.
 */
const PERMANENT_REFUSAL = /user type extension|not been assigned|not licensed|license|permission|not authorized|insufficient privilege|does not have (the )?(required )?privilege/i;
/** Posting into a protected sde.DEFAULT needs a version administrator ("Manage versions" privilege). */
const PROTECTED_VERSION = /only be executed by the owner|version is protected/i;

export function asConfigurationError(error: unknown): unknown {
  if (error instanceof ArcGisError && PROTECTED_VERSION.test(error.message)) {
    return new LaisConfigurationError(
      `The LAIS ArcGIS account cannot post to the protected default version: give it the Portal "Manage versions" privilege (version administrator). ArcGIS: ${error.message}`,
    );
  }
  if (error instanceof ArcGisError && (error.code === 403 || PERMANENT_REFUSAL.test(error.message))) {
    return new LaisConfigurationError(`The LAIS ArcGIS account cannot edit: ${error.message}`);
  }
  return error;
}

function assertSuccess(body: ArcGisJson, what: string): void {
  if (body.success === false) throw new ArcGisError(`ArcGIS refused ${what}`);
}

/** Attribute updates of the transaction's Plots inside `version`, in one exclusive edit session (all or none). */
export async function editInVersion(token: string, version: VersionRef, updates: Attributes[]): Promise<void> {
  const sessionId = `{${randomUUID().toUpperCase()}}`;
  const versionUrl = `${config.lais.versionManagementUrl}/versions/${version.guid.replace(/[{}]/g, "")}`;
  let reading = false;
  let editing = false;
  try {
    assertSuccess(await arcgisPost(`${versionUrl}/startReading`, { sessionId }, token), "startReading");
    reading = true;
    assertSuccess(await arcgisPost(`${versionUrl}/startEditing`, { sessionId }, token), "startEditing");
    editing = true;
    const result = await arcgisPost(
      `${config.lais.plotLayerUrl}/applyEdits`,
      { gdbVersion: version.name, sessionID: sessionId, rollbackOnFailure: "true", updates: JSON.stringify(updates.map((attributes) => ({ attributes }))) },
      token,
    );
    const results = (result.updateResults ?? []) as Array<{ success?: boolean; error?: { description?: string } }>;
    const failed = results.find((r) => !r.success);
    if (results.length !== updates.length || failed) throw new ArcGisError(failed?.error?.description ?? "ArcGIS did not confirm the Plot updates");
    assertSuccess(await arcgisPost(`${versionUrl}/stopEditing`, { sessionId, saveEdits: "true" }, token), "stopEditing");
    editing = false;
  } catch (error) {
    if (editing) {
      await arcgisPost(`${versionUrl}/stopEditing`, { sessionId, saveEdits: "false" }, token).catch((e) =>
        logger.error({ err: (e as Error).message, version: version.name }, "LAIS: could not discard edit session"),
      );
    }
    throw asConfigurationError(error);
  } finally {
    if (reading) {
      await arcgisPost(`${versionUrl}/stopReading`, { sessionId }, token).catch((e) =>
        logger.warn({ err: (e as Error).message, version: version.name }, "LAIS: could not release read lock"),
      );
    }
  }
}

// ---------------------------------------------------------------- record mapping

function toIso(value: unknown): string | null {
  if (typeof value === "number") return new Date(value).toISOString();
  if (typeof value === "string" && value) return value;
  return null;
}

/** A transaction recorded on Plots (one row per parcel; the fields are the same on each). */
function toRecord(schema: LayerSchema, rows: Attributes[], stage: LaisRecord["stage"]): LaisRecord {
  const a = rows[0] ?? {};
  const s = (k: Logical) => (a[schema.fields[k]] === undefined || a[schema.fields[k]] === null ? null : String(a[schema.fields[k]]));
  const UPIs = [...new Set(rows.map((r) => String(r[schema.fields.upi] ?? "")).filter(Boolean))].sort();
  return {
    UPI: UPIs[0] ?? null,
    UPIs,
    Transaction_ID: s("transactionId"),
    Transaction_Type: s("transactionType"),
    Transaction_Status: s("transactionStatus"),
    Transaction_Date: toIso(a[schema.fields.transactionDate]),
    case: s("case"),
    validation_message: s("validationMessage"),
    version_name: s("versionName"),
    version_status: s("versionStatus"),
    stage,
    result: null,
    warnings: [],
    updated_at: null,
  };
}

const sameSet = (a: string[], b: string[]) => a.length === b.length && [...a].sort().every((v, i) => v === [...b].sort()[i]);

/** Posted rows match the request: same type, date (and status if sent), and every requested UPI among them. */
function samePayload(schema: LayerSchema, rows: Attributes[], input: LaisSubmission): boolean {
  const f = schema.fields;
  const a = rows[0]!;
  const upis = new Set(rows.map((r) => r[f.upi]));
  return (
    input.UPIs.every((u) => upis.has(u)) &&
    a[f.transactionType] === input.Transaction_Type &&
    Number(a[f.transactionDate]) === Date.parse(input.Transaction_Date) &&
    (input.Transaction_Status === undefined || a[f.transactionStatus] === input.Transaction_Status)
  );
}

/**
 * Is this Transaction_ID already in sde.DEFAULT (its fields posted on the Plot(s))? One transaction
 * may be on several Plots (a Merge's parcels); rows that disagree on type or date are a conflict.
 */
async function findPosted(token: string, schema: LayerSchema, transactionId: string): Promise<{ rows: Attributes[]; inconsistent: boolean }> {
  const f = schema.fields;
  const rows = await queryPlots(token, schema, `${f.transactionId} = ${sql(transactionId)}`, undefined, undefined, 50);
  const inconsistent = rows.some((r) => r[f.transactionType] !== rows[0]![f.transactionType] || r[f.transactionDate] !== rows[0]![f.transactionDate]);
  return { rows, inconsistent };
}

const VALIDATED = "Validated by the LAIS integration API";

function entryMatches(e: LedgerEntry, input: LaisSubmission): boolean {
  return (
    sameSet(e.UPIs, input.UPIs) &&
    e.Transaction_Type === input.Transaction_Type &&
    Date.parse(e.Transaction_Date) === Date.parse(input.Transaction_Date) &&
    (e.Transaction_Status ?? undefined) === input.Transaction_Status
  );
}

function entryRecord(e: LedgerEntry, stage: LaisRecord["stage"]): LaisRecord {
  return {
    UPI: e.UPIs[0] ?? null,
    UPIs: e.UPIs,
    Transaction_ID: e.Transaction_ID,
    Transaction_Type: e.Transaction_Type,
    Transaction_Status: e.Transaction_Status ?? null,
    Transaction_Date: new Date(Date.parse(e.Transaction_Date)).toISOString(),
    case: "Yes",
    validation_message: VALIDATED,
    version_name: e.versionName,
    version_status: e.versionName ? "VersionCreated" : "Pending",
    stage,
    result: null,
    warnings: [],
    updated_at: e.updatedAt,
  };
}

const duplicateIdError = (message: string): FieldError[] => [{ field: "Transaction_ID", code: "DUPLICATE_TRANSACTION_ID", message }];

// ---------------------------------------------------------------- per-transaction lock

const locks = new Map<string, Promise<unknown>>();

/** Serialise work on one Transaction_ID inside this process (concurrent identical retries). */
export async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(fn);
  const tail = run.catch(() => undefined);
  locks.set(key, tail);
  try {
    return await run;
  } finally {
    if (locks.get(key) === tail) locks.delete(key);
  }
}

/** Checking that a parcel is free and recording the new transaction on it happen one submission at a time. */
const NEW_SUBMISSIONS = "\u0000new-submissions";

/**
 * One open transaction per parcel. Another accepted transaction holds a parcel while its version exists
 * and its change is not in sde.DEFAULT; once GIS posts or removes that version, the parcel is free again
 * (a posted Merge or Subdivision has expired its UPIs anyway).
 */
async function parcelsHeldElsewhere(token: string, schema: LayerSchema, input: LaisSubmission, objectIds: number[], fieldOf: (i: number) => string): Promise<FieldError[]> {
  const mine = input.Transaction_ID.toLowerCase();
  const wanted = new Set(objectIds);
  const others = (await allEntries()).filter((e) => e.Transaction_ID.toLowerCase() !== mine && e.versionName && !e.completion && e.objectIds.some((id) => wanted.has(id)));
  if (!others.length) return [];
  const versions = await ownedVersions(token);
  const errors: FieldError[] = [];
  for (const other of others) {
    if (!versions.has(shortVersionName(other.versionName!).toLowerCase())) continue; // posted or cancelled
    const posted = await findPosted(token, schema, other.Transaction_ID);
    if (await detectCompletion(token, schema, other, posted.rows)) continue; // posted, version kept
    objectIds.forEach((id, i) => {
      if (!other.objectIds.includes(id) || errors.some((e) => e.field === fieldOf(i))) return;
      errors.push({
        field: fieldOf(i),
        code: "UPI_IN_TRANSACTION",
        message: `UPI ${input.UPIs[i]} is already in transaction ${other.Transaction_ID} (${other.Transaction_Type}, GIS version ${other.versionName}), which GIS has not finished. Submit a new transaction for this parcel once that one is Posted or Closed.`,
        transactionId: other.Transaction_ID,
      });
    });
  }
  return errors;
}

// ---------------------------------------------------------------- public API

/** `listForm`: the parcels came as `UPIs`, so per-parcel errors name `UPIs[i]` (else `UPI`). */
export async function submitTransaction(token: string, input: LaisSubmission, listForm = false): Promise<SubmitOutcome> {
  const fieldOf = (i: number) => (listForm ? `UPIs[${i}]` : "UPI");
  return withLock(input.Transaction_ID.toLowerCase(), async () => {
    const schema = await layerSchema(token);
    const f = schema.fields;

    for (const [logical, value, field] of [
      ["transactionType", input.Transaction_Type, "Transaction_Type"],
      ["transactionStatus", input.Transaction_Status, "Transaction_Status"],
    ] as const) {
      const codes = schema.domains[logical];
      if (value !== undefined && codes && !codes.includes(value)) {
        return { kind: "invalid", errors: [{ field, code: field === "Transaction_Type" ? "INVALID_TRANSACTION_TYPE" : "INVALID_TRANSACTION_STATUS", message: `Allowed values: ${codes.join(", ")}.` }] };
      }
    }

    const writeAttributes = config.LAIS_WRITE_MODE === "attributes";
    const usedElsewhere = duplicateIdError("Transaction_ID has already been used for a different transaction. Use a new Transaction_ID; existing records are not overwritten.");

    // An accepted transaction is answered from the ledger before its parcels are checked again: once GIS
    // has posted a Merge or Subdivision its UPIs have expired, and a retry must still be a duplicate.
    const known = await getEntry(input.Transaction_ID);
    if (known && !entryMatches(known, input)) return { kind: "conflict", errors: usedElsewhere };
    if (known?.versionName && (known.attributesWritten || !writeAttributes)) {
      const posted = await findPosted(token, schema, input.Transaction_ID);
      if (posted.inconsistent) return { kind: "conflict", errors: duplicateIdError("GIS holds different transactions under this Transaction_ID. Contact the GIS integration administrator.") };
      const version = await findVersion(token, shortVersionName(known.versionName));
      return { kind: "duplicate", record: await describeEntry(token, schema, known, version, posted.rows) };
    }

    // Each UPI must be exactly one current parcel: a UPI retired by a merge or subdivision has expired.
    const parcels = await resolveParcels(token, schema, input.UPIs, fieldOf);
    if (parcels.errors.length) return { kind: "invalid", errors: parcels.errors };
    const objectIds = parcels.objectIds;

    // A Merge's parcels must be neighbours, one connected group (same rule as the web editor).
    if (input.Transaction_Type === "Merge") {
      const problem = await mergeNeighbourProblem(token, schema, objectIds.map((objectId, i) => ({ objectId, upi: input.UPIs[i]! })));
      if (problem) return { kind: "invalid", errors: [{ field: "UPIs", code: "NOT_NEIGHBOURS", message: problem }] };
    }

    // 1. Already posted to sde.DEFAULT (fields present on the Plot(s))?
    const posted = await findPosted(token, schema, input.Transaction_ID);
    if (posted.inconsistent) return { kind: "conflict", errors: duplicateIdError("GIS holds different transactions under this Transaction_ID. Contact the GIS integration administrator.") };
    if (posted.rows.length) {
      return samePayload(schema, posted.rows, input)
        ? { kind: "duplicate", record: toRecord(schema, posted.rows, "Posted") }
        : { kind: "conflict", errors: usedElsewhere };
    }

    // 2. Accepted by this API but not finished (version or Plot fields missing after a failure, or the
    //    write mode changed since)? `known` matches the request (checked above).
    const entry = known;

    // An entry made before a naming change keeps the version name it was given.
    const shortName = entry?.versionName ? shortVersionName(entry.versionName) : versionNameFor(input);
    // The API takes any length, but writing to the Plot (attributes mode) must fit its transaction_id field.
    const idRoom = schema.lengths.transactionId;
    if (writeAttributes && idRoom && input.Transaction_ID.length > idRoom && !entry?.attributesWritten) {
      return { kind: "invalid", errors: [{ field: "Transaction_ID", code: "TOO_LONG_FOR_GIS", message: `GIS stores Transaction_ID on the parcel in a field of ${idRoom} characters; this one has ${input.Transaction_ID.length}. Contact the GIS integration administrator.` }] };
    }

    return withLock(NEW_SUBMISSIONS, async (): Promise<SubmitOutcome> => {
      let version = await findVersion(token, shortName);
      if (entry?.versionName && !version) {
        // Its version was posted or deleted by GIS: report what happened. Never recreate it.
        return { kind: "duplicate", record: await describeEntry(token, schema, entry, null, posted.rows) };
      }
      if (!entry && version) {
        return { kind: "conflict", errors: duplicateIdError(`GIS version ${shortName} already exists for another submission. Contact the GIS integration administrator.`) };
      }

      // One open transaction per parcel.
      const held = await parcelsHeldElsewhere(token, schema, input, objectIds, fieldOf);
      if (held.length) return { kind: "busy", errors: held };

      // 3. New transaction, or the completion of an earlier attempt that failed part-way.
      //    Record the intent first so a failure after version creation is recoverable on retry.
      let current = entry ?? (await putEntry({ ...input, objectIds, versionName: null, attributesWritten: false }));
      const parcelText = input.UPIs.length ? `UPI ${input.UPIs[0]}${input.UPIs.length > 1 ? ` +${input.UPIs.length - 1}` : ""}` : "new plot";
      version ??= await createVersion(token, shortName, `LAIS ${input.Transaction_Type} ${parcelText} ${input.Transaction_ID}`);
      current = await putEntry({ ...current, versionName: version.name });

      // Write the transaction on every parcel of it, inside the version (a CreatePlot without parent has none).
      if (writeAttributes && !current.attributesWritten && objectIds.length) {
        const fields = {
          [f.transactionId]: input.Transaction_ID,
          [f.transactionType]: input.Transaction_Type,
          [f.transactionDate]: Date.parse(input.Transaction_Date),
          [f.case]: "Yes",
          [f.validationMessage]: VALIDATED,
          [f.versionStatus]: "VersionCreated",
          [f.versionName]: version.name,
          ...(input.Transaction_Status ? { [f.transactionStatus]: input.Transaction_Status } : {}),
        };
        await editInVersion(token, version, objectIds.map((objectId) => ({ [schema.objectIdField]: objectId, ...fields })));
        current = await putEntry({ ...current, attributesWritten: true });
      }
      logger.info({ transactionId: input.Transaction_ID, version: version.name, objectIds, mode: config.LAIS_WRITE_MODE }, "LAIS transaction accepted");
      return { kind: "created", record: entryRecord(current, "InReview") };
    });
  });
}

// ---------------------------------------------------------------- completion: is the change in sde.DEFAULT?

const unique = <T>(values: T[]) => [...new Set(values)];
const MAX_RESULT_PARCELS = 500;

/**
 * Records in sde.DEFAULT that belong to the transaction: named for its version (the editors' convention,
 * e.g. record SUBV-000008-20261120 for version owner.SUBV-000008-20261120) or carrying its Transaction_ID.
 * A record reaches sde.DEFAULT only when the version that created it is posted.
 */
async function linkedRecordIds(token: string, schema: LayerSchema, entry: LedgerEntry): Promise<string[]> {
  const r = schema.records;
  if (!r) return [];
  const short = entry.versionName ? shortVersionName(entry.versionName) : versionNameFor(entry);
  const names = unique([short, ...(entry.versionName ? [entry.versionName] : [])].map((n) => n.toUpperCase()));
  const where = [`UPPER(${r.nameField}) IN (${sqlList(names)})`, ...(r.transactionIdField ? [`${r.transactionIdField} = ${sql(entry.Transaction_ID)}`] : [])].join(" OR ");
  const body = await arcgisPost(`${r.url}/query`, { where, outFields: r.globalIdField, returnGeometry: "false", resultRecordCount: "20" }, token);
  const rows = (body.features ?? []).map((f: { attributes?: Attributes }) => f.attributes ?? {}) as Attributes[];
  return unique(rows.map((a) => String(a[r.globalIdField] ?? "")).filter(Boolean));
}

/**
 * Find the transaction's change in sde.DEFAULT (reads only; works in version-only mode):
 *   1. a record of the transaction is in DEFAULT with parcels it created or retired;
 *   2. the transaction's parcels are retired in DEFAULT: the change is the record that retired them, and
 *      the result is the current parcels that record created over them (Parcel Fabric lineage);
 *   3. CorrectBoundaries edits parcels in place: its record in DEFAULT, or (attributes mode) its fields
 *      posted on the parcels, mean the corrected parcels are in DEFAULT.
 * The parcels were current when LAIS submitted (checked then), so a retirement since is this change.
 */
async function detectCompletion(token: string, schema: LayerSchema, entry: LedgerEntry, postedRows: Attributes[]): Promise<Completion | null> {
  const f = schema.fields;
  const oid = schema.objectIdField;
  const detectedAt = new Date().toISOString();
  const idsOf = (rows: Attributes[]) => unique(rows.map((r) => Number(r[oid])));
  const inPlace = entry.Transaction_Type === "CorrectBoundaries";
  const originals = entry.objectIds.length ? await plotShapes(token, `${oid} IN (${entry.objectIds.join(",")})`, [oid, f.retiredBy]) : null;
  const currentOriginals = idsOf((originals?.features ?? []).map((p) => p.attributes).filter((a) => a[f.retiredBy] == null));

  const recordIds = await linkedRecordIds(token, schema, entry);
  if (recordIds.length) {
    const list = sqlList(recordIds);
    const [created, retired] = await Promise.all([
      queryPlots(token, schema, `${f.createdBy} IN (${list}) AND ${f.retiredBy} IS NULL`, undefined, [oid], MAX_RESULT_PARCELS),
      queryPlots(token, schema, `${f.retiredBy} IN (${list})`, undefined, [oid], MAX_RESULT_PARCELS),
    ]);
    if (created.length || retired.length || inPlace) {
      return { detectedAt, via: "record", recordIds, retiredObjectIds: idsOf(retired), parcelObjectIds: unique([...idsOf(created), ...(inPlace ? currentOriginals : [])]) };
    }
  }

  const retired = (originals?.features ?? []).filter((p) => p.attributes[f.retiredBy] != null);
  if (retired.length) {
    const successors: Attributes[] = [];
    for (const p of retired) {
      const record = String(p.attributes[f.retiredBy]);
      successors.push(...(await relatedPlots(token, schema, p.geometry, originals!.spatialReference, "T********", `${f.createdBy} = ${sql(record)} AND ${f.retiredBy} IS NULL`)));
    }
    return {
      detectedAt,
      via: "lineage",
      recordIds: unique(retired.map((p) => String(p.attributes[f.retiredBy]))),
      retiredObjectIds: idsOf(retired.map((p) => p.attributes)),
      parcelObjectIds: unique([...idsOf(successors), ...(inPlace ? currentOriginals : [])]),
    };
  }

  if (inPlace && postedRows.length) return { detectedAt, via: "fields", recordIds: [], retiredObjectIds: [], parcelObjectIds: idsOf(postedRows) };
  return null;
}

const textOf = (value: unknown) => (value === null || value === undefined || String(value).trim() === "" ? null : String(value).trim());

/** The result parcels with their attributes as they are now in sde.DEFAULT. */
async function buildResult(token: string, schema: LayerSchema, c: Completion): Promise<LaisResult> {
  const f = schema.fields;
  const o = schema.optional;
  const oid = schema.objectIdField;
  const ids = unique([...c.parcelObjectIds, ...c.retiredObjectIds]);
  const outFields = unique([oid, f.upi, f.retiredBy, ...Object.values(o).flat(), ...(schema.editDateField ? [schema.editDateField] : [])]);
  const rows = ids.length ? await queryPlots(token, schema, `${oid} IN (${ids.join(",")})`, undefined, outFields, ids.length) : [];
  const byId = new Map(rows.map((r) => [Number(r[oid]), r]));
  const pick = (list: number[]) => list.map((id) => byId.get(id)).filter((a): a is Attributes => !!a);
  const value = (a: Attributes, field: string) => textOf(a[field]);
  const optional = (a: Attributes, key: Optional) => (o[key] ?? []).map((field) => textOf(a[field])).find((v) => v !== null) ?? null;
  const area = (a: Attributes) => {
    const v = (o.area ?? []).map((field) => a[field]).find((x): x is number => typeof x === "number");
    return v === undefined ? null : Math.round(v * 100) / 100;
  };

  const parcels: LaisParcel[] = pick(c.parcelObjectIds)
    .map((a) => ({
      UPI: value(a, f.upi),
      current: a[f.retiredBy] == null,
      area_sqm: area(a),
      province: optional(a, "province"),
      district: optional(a, "district"),
      sector: optional(a, "sector"),
      cell: optional(a, "cell"),
      village: optional(a, "village"),
    }))
    .sort((a, b) => (a.UPI ?? "￿").localeCompare(b.UPI ?? "￿"));

  let records: LaisResult["records"] = [];
  const r = schema.records;
  if (r && c.recordIds.length) {
    const body = await arcgisPost(
      `${r.url}/query`,
      { where: `${r.globalIdField} IN (${sqlList(c.recordIds)})`, outFields: unique([r.globalIdField, r.nameField, ...(r.recordedDateField ? [r.recordedDateField] : [])]).join(","), returnGeometry: "false" },
      token,
    );
    records = ((body.features ?? []) as Array<{ attributes?: Attributes }>).map(({ attributes: a = {} }) => ({
      name: textOf(a[r.nameField]),
      recorded_date: r.recordedDateField ? toIso(a[r.recordedDateField]) : null,
    }));
  }

  const edits = schema.editDateField ? rows.map((a) => a[schema.editDateField!]).filter((v): v is number => typeof v === "number") : [];
  return {
    parcels,
    retired_parcels: pick(c.retiredObjectIds).map((a) => ({ UPI: value(a, f.upi) })),
    records,
    completed_at: edits.length ? new Date(Math.max(...edits)).toISOString() : null,
    detected_at: c.detectedAt,
  };
}

function warningsFor(entry: LedgerEntry, result: LaisResult): LaisWarning[] {
  const warnings: LaisWarning[] = [];
  const missing = result.parcels.filter((p) => p.current && !p.UPI).length;
  if (missing) {
    warnings.push({
      code: "UPI_MISSING",
      message: `${missing} of the resulting parcels ${missing === 1 ? "has" : "have"} no UPI in GIS yet. GIS must assign ${missing === 1 ? "it" : "them"}; the UPIs appear here once assigned.`,
    });
  }
  if (!result.parcels.length && entry.Transaction_Type !== "CorrectBoundaries") {
    warnings.push({ code: "NO_RESULT_PARCELS", message: "GIS posted the change, but no resulting parcel was found. Contact the GIS team." });
  }
  return warnings;
}

/**
 * The transaction as LAIS should see it now. Saves what was reported: `updated_at` moves only when the
 * stage, result parcels or warnings change. Call under the transaction's lock.
 */
async function describeEntry(token: string, schema: LayerSchema, entry: LedgerEntry, version: VersionRef | null, postedRows: Attributes[]): Promise<LaisRecord> {
  const completion = entry.completion ?? (await detectCompletion(token, schema, entry, postedRows));
  const stage: Stage = completion ? "Posted" : entry.versionName && !version ? "Closed" : "InReview";
  const result = completion ? await buildResult(token, schema, completion) : null;
  const { updated_at: _previous, ...view } = { ...entryRecord(entry, stage), result, warnings: result ? warningsFor(entry, result) : [] };
  let current = entry;
  // LAIS was told InReview when it submitted, so a first report that still says so is not a change.
  const changed = entry.reported ? JSON.stringify(view) !== JSON.stringify(entry.reported) : stage !== "InReview";
  if (changed || !entry.reported || (completion && !entry.completion)) {
    current = await putEntry({ ...entry, ...(completion ? { completion } : {}), reported: view }, { keepUpdatedAt: !changed });
    if (changed && entry.reported?.stage !== stage) {
      logger.info({ transactionId: entry.Transaction_ID, stage, via: completion?.via, parcels: result?.parcels.length }, "LAIS transaction stage changed");
    }
  }
  return { ...view, updated_at: current.updatedAt };
}

export type StatusOutcome = { kind: "found"; record: LaisRecord } | { kind: "not_found" } | { kind: "conflict" };

export async function transactionStatus(token: string, transactionId: string): Promise<StatusOutcome> {
  return withLock(transactionId.toLowerCase(), async () => {
    const schema = await layerSchema(token);
    const posted = await findPosted(token, schema, transactionId);
    if (posted.inconsistent) return { kind: "conflict" };
    const entry = await getEntry(transactionId);
    if (!entry) return posted.rows.length ? { kind: "found", record: toRecord(schema, posted.rows, "Posted") } : { kind: "not_found" };
    const version = entry.versionName ? await findVersion(token, shortVersionName(entry.versionName)) : null;
    return { kind: "found", record: await describeEntry(token, schema, entry, version, posted.rows) };
  });
}

export interface ListOptions {
  /** Only transactions whose reported state changed at or after this time (epoch ms). */
  updatedSince?: number;
  stage?: Stage;
  limit: number;
}

export interface ListOutcome {
  /** Oldest change first. */
  transactions: LaisRecord[];
  has_more: boolean;
  /** Pass as updatedSince on the next call to get only what changed since (and the rest of this list when has_more). */
  next_updated_since: string;
}

/**
 * All transactions, for the LAIS dashboard. Transactions that can still change (InReview, Closed, or
 * Posted with warnings) are checked against GIS first; settled ones are answered from the ledger.
 */
export async function listTransactions(token: string, options: ListOptions): Promise<ListOutcome> {
  const until = new Date().toISOString();
  const schema = await layerSchema(token);
  let versions: Map<string, VersionRef> | null = null;
  const records: LaisRecord[] = [];
  for (const e of await allEntries()) {
    const reported = e.reported as Omit<LaisRecord, "updated_at"> | undefined;
    if (e.completion && reported && !reported.warnings?.length) {
      records.push({ ...reported, updated_at: e.updatedAt });
      continue;
    }
    versions ??= await ownedVersions(token);
    const known = versions;
    const record = await withLock(e.Transaction_ID.toLowerCase(), async () => {
      const fresh = (await getEntry(e.Transaction_ID)) ?? e;
      const posted = await findPosted(token, schema, fresh.Transaction_ID);
      if (posted.inconsistent) return null; // GET /transactions/{id} reports it as a conflict
      const version = fresh.versionName ? (known.get(shortVersionName(fresh.versionName).toLowerCase()) ?? null) : null;
      return describeEntry(token, schema, fresh, version, posted.rows);
    });
    if (record) records.push(record);
  }
  const matching = records
    .filter((r) => (options.updatedSince === undefined || Date.parse(r.updated_at!) >= options.updatedSince) && (!options.stage || r.stage === options.stage))
    .sort((a, b) => Date.parse(a.updated_at!) - Date.parse(b.updated_at!) || String(a.Transaction_ID).localeCompare(String(b.Transaction_ID)));
  const page = matching.slice(0, options.limit);
  const hasMore = matching.length > options.limit;
  return { transactions: page, has_more: hasMore, next_updated_since: hasMore ? page[page.length - 1]!.updated_at! : until };
}

/** Test hook. */
export async function resetLaisCachesForTests(): Promise<void> {
  schemaCache = null;
  locks.clear();
  await clearLedgerForTests();
}
