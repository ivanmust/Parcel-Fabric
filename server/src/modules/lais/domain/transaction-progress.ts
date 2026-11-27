import { logger } from "../../../common/logging/logger.js";
import { arcgisPost } from "../../../common/arcgis/arcgis-client.js";
import { sql, sqlList, textOrNull, unique } from "../../../common/utils/sql.js";
import { putEntry } from "../repositories/ledger.repository.js";
import { plotShapes, queryPlots, relatedPlots, type LayerSchema, type Optional } from "../repositories/plot-layer.repository.js";
import type { VersionRef } from "../repositories/version.repository.js";
import type { Completion, LedgerEntry } from "../models/ledger-entry.model.js";
import type { Attributes, LaisParcel, LaisRecord, LaisResult, LaisWarning, Stage } from "../models/transaction.model.js";
import { entryRecord, toIso } from "./transaction-records.js";
import { shortVersionName, versionNameFor } from "./version-naming.js";

const MAX_RESULT_PARCELS = 500;

/** Records in sde.DEFAULT named after the transaction's version, or carrying its Transaction_ID. */
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
 * The transaction's change in sde.DEFAULT, found by (1) its record, (2) the lineage of its retired
 * parcels, or (3) for CorrectBoundaries, its fields posted on the parcels. Reads only.
 */
export async function detectCompletion(token: string, schema: LayerSchema, entry: LedgerEntry, postedRows: Attributes[]): Promise<Completion | null> {
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

const textOf = textOrNull;

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
export async function describeEntry(token: string, schema: LayerSchema, entry: LedgerEntry, version: VersionRef | null, postedRows: Attributes[]): Promise<LaisRecord> {
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
