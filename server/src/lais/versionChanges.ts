import { config } from "../config/env.js";
import { arcgisPost, ArcGisError } from "./arcgisClient.js";
import { getEntry } from "./ledger.js";
import { layerSchema, ownedVersions, shortVersionName, sqlList, type Attributes, type LayerSchema } from "./laisService.js";
import { toGeoJson } from "./editingDone.js";

/**
 * What a LAIS transaction's version changed, compared with sde.DEFAULT: the review data.
 *
 * Read with the VersionManagementServer `differences` operation (ArcGIS Enterprise 10.6+; `layers`
 * 10.9.1, `outSR` 11.1): first object ids per layer for a summary, then full features for the Plot and
 * Records layers. Updated and deleted Plots are compared with their row in sde.DEFAULT field by field.
 * Read-only: no edit session is opened and nothing is written.
 */

/** A refusal the caller can act on; routes answer it in their own shape. */
export class ChangesError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ChangesError";
  }
}

type ArcGisFeature = { attributes?: Attributes; geometry?: { rings?: number[][][] } };
type GeoJson = ReturnType<typeof toGeoJson>;

export interface ChangedParcel {
  object_id: number;
  global_id: string | null;
  UPI: string | null;
  /** True when this change retires the parcel (it becomes historic). */
  retired: boolean;
  /** The record that created (inserts) or retired/changed (updates) it, by name when known. */
  record: string | null;
  attributes: Attributes;
  geometry?: GeoJson;
}
export interface UpdatedParcel extends ChangedParcel {
  /** Fields whose value differs from sde.DEFAULT: { field: { before, after } }. */
  changed_fields: Record<string, { before: unknown; after: unknown }>;
  /** True when the boundary changed (area or perimeter differs from sde.DEFAULT). */
  shape_changed: boolean;
}

export interface VersionChanges {
  Transaction_ID: string;
  Transaction_Type: string;
  UPIs: string[];
  version_name: string;
  compared_with: "sde.DEFAULT";
  /** Inserts, updates and deletes per layer of the service. */
  summary: Array<{ layer_id: number; layer_name: string; inserts: number; updates: number; deletes: number }>;
  plots: { inserted: ChangedParcel[]; updated: UpdatedParcel[]; deleted: ChangedParcel[] };
  records: Array<{ change: "inserted" | "updated" | "deleted"; global_id: string | null; name: string | null }>;
  checks: {
    /** The transaction's parcels (from LAIS) that the version does not change. */
    transaction_parcels_unchanged: string[];
    /** Plots changed in the version that are not the transaction's parcels or new parcels. */
    other_parcels_changed: string[];
  };
  warnings: string[];
}

// Bookkeeping fields: they change with every edit and say nothing about the parcel.
const NOISE = /^(last_edited_(user|date)|created_(user|date)|validationstatus|shape__(area|length)|st_area\(shape\)|st_length\(shape\))$/i;
const layerIdOf = (url: string) => Number(url.split("/").pop());

let layerNames: { at: number; names: Map<number, string> } | null = null;
async function namesOfLayers(token: string): Promise<Map<number, string>> {
  if (layerNames && Date.now() - layerNames.at < 10 * 60_000) return layerNames.names;
  const featureServer = config.lais.plotLayerUrl.replace(/\/\d+$/, "");
  // Layer names only label the summary: without them it still works ("Layer 17").
  const body = await arcgisPost(featureServer, {}, token).catch(() => ({}) as Record<string, unknown>);
  const list = [...((body.layers as Array<{ id: number; name: string }>) ?? []), ...((body.tables as Array<{ id: number; name: string }>) ?? [])];
  const names = new Map<number, string>(list.map((l) => [l.id, l.name]));
  if (names.size) layerNames = { at: Date.now(), names };
  return names;
}

async function differences(token: string, guid: string, params: Record<string, string>) {
  try {
    return await arcgisPost(`${config.lais.versionManagementUrl}/versions/${guid.replace(/[{}]/g, "")}/differences`, params, token);
  } catch (error) {
    if (error instanceof ArcGisError && /lock|in use|being edited/i.test(error.message)) {
      throw new ChangesError(409, "VERSION_IN_USE", "A GIS editor is editing this version right now, so its changes cannot be read. Try again when the editor has saved or stopped editing.");
    }
    throw error;
  }
}

const text = (v: unknown) => (v === null || v === undefined || String(v).trim() === "" ? null : String(v));
/** Equal values; numbers within floating-point noise (1533.64069261 vs 1533.6406926099999). */
const same = (a: unknown, b: unknown) =>
  typeof a === "number" && typeof b === "number" ? Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b)) : JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const SHAPE = /^(shape__(area|length)|st_area\(shape\)|st_length\(shape\))$/i;
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
/** Different boundaries: another number of rings or vertices, or a vertex moved more than ~1 cm. */
function ringsDiffer(a: number[][][] | undefined, b: number[][][] | undefined): boolean {
  if (!a || !b) return false;
  if (a.length !== b.length || a.some((ring, i) => ring.length !== b[i]!.length)) return true;
  return a.some((ring, i) => ring.some((p, j) => Math.abs(p[0]! - b[i]![j]![0]!) > 1e-7 || Math.abs(p[1]! - b[i]![j]![1]!) > 1e-7));
}

export async function versionChanges(token: string, transactionId: string, options: { geometry?: boolean } = {}): Promise<VersionChanges> {
  const entry = await getEntry(transactionId);
  if (!entry) throw new ChangesError(404, "NOT_FOUND", `No LAIS transaction ${transactionId} is recorded in GIS.`);
  if (!entry.versionName) throw new ChangesError(409, "NO_VERSION", "GIS has no version for this transaction.");
  const version = (await ownedVersions(token)).get(shortVersionName(entry.versionName).toLowerCase());
  if (!version) {
    throw new ChangesError(409, "VERSION_GONE", `The version ${entry.versionName} no longer exists (posted or deleted), so there is nothing to compare. The result is in GET /transactions/${transactionId}.`);
  }

  const schema: LayerSchema = await layerSchema(token);
  const plotLayer = layerIdOf(config.lais.plotLayerUrl);
  const recordsLayer = schema.records ? layerIdOf(schema.records.url) : null;
  const f = schema.fields;
  const oid = schema.objectIdField;
  const gid = schema.globalIdField;

  // 1. Summary: object ids of every changed feature, per layer.
  const [ids, names] = await Promise.all([differences(token, version.guid, { resultType: "objectIds" }), namesOfLayers(token)]);
  const summary = ((ids.differences ?? []) as Array<{ layerId: number; inserts?: number[]; updates?: number[]; deletes?: number[] }>)
    .map((d) => ({ layer_id: d.layerId, layer_name: names.get(d.layerId) ?? `Layer ${d.layerId}`, inserts: d.inserts?.length ?? 0, updates: d.updates?.length ?? 0, deletes: d.deletes?.length ?? 0 }))
    .sort((a, b) => a.layer_id - b.layer_id);

  // 2. Full features for Plot (and Records), in WGS 84 for GeoJSON.
  const layers = [plotLayer, ...(recordsLayer !== null ? [recordsLayer] : [])];
  const full = await differences(token, version.guid, { resultType: "features", layers: JSON.stringify(layers), outSR: JSON.stringify({ wkid: 4326 }) });
  type LayerFeatures = { layerId: number; inserts?: ArcGisFeature[]; updates?: ArcGisFeature[]; deletes?: ArcGisFeature[] };
  const byLayer = new Map(((full.features ?? []) as LayerFeatures[]).map((l) => [l.layerId, l]));
  const plotDiff: LayerFeatures = byLayer.get(plotLayer) ?? { layerId: plotLayer };
  const deletedIds = ((ids.differences ?? []) as Array<{ layerId: number; deletes?: number[] }>).find((d) => d.layerId === plotLayer)?.deletes ?? [];

  // Updated and deleted Plots as they are in sde.DEFAULT, to compare with.
  const updatedIds = (plotDiff.updates ?? []).map((x) => Number(x.attributes?.[oid])).filter(Number.isFinite);
  const before = new Map<number, Attributes>();
  const wanted = [...new Set([...updatedIds, ...deletedIds])];
  if (wanted.length) {
    // Geometry in the same coordinates as the differences (WGS 84), to tell boundary changes apart.
    const body = await arcgisPost(`${config.lais.plotLayerUrl}/query`, { objectIds: wanted.join(","), outFields: "*", returnGeometry: "true", outSR: "4326" }, token);
    for (const row of (body.features ?? []) as ArcGisFeature[]) before.set(Number(row.attributes?.[oid]), { ...row.attributes, __geometry: row.geometry });
  }

  // Record names for the record ids the Plots point to (and the records changed in the version).
  const recordDiff = recordsLayer !== null ? byLayer.get(recordsLayer) : undefined;
  const recordIds = new Set<string>();
  for (const x of [...(plotDiff.inserts ?? []), ...(plotDiff.updates ?? [])]) for (const k of [f.createdBy, f.retiredBy]) if (text(x.attributes?.[k])) recordIds.add(String(x.attributes![k]));
  const recordName = new Map<string, string>();
  const r = schema.records;
  for (const x of [...(recordDiff?.inserts ?? []), ...(recordDiff?.updates ?? [])]) if (r && text(x.attributes?.[r.globalIdField])) recordName.set(String(x.attributes![r.globalIdField]).toUpperCase(), String(x.attributes![r.nameField] ?? ""));
  const unknown = [...recordIds].filter((g) => !recordName.has(g.toUpperCase()));
  if (r && unknown.length) {
    const body = await arcgisPost(`${r.url}/query`, { where: `${r.globalIdField} IN (${sqlList(unknown)})`, outFields: [r.globalIdField, r.nameField].join(","), returnGeometry: "false", gdbVersion: version.name }, token);
    for (const x of (body.features ?? []) as ArcGisFeature[]) recordName.set(String(x.attributes?.[r.globalIdField]).toUpperCase(), String(x.attributes?.[r.nameField] ?? ""));
  }
  const nameOf = (g: unknown) => (text(g) ? (recordName.get(String(g).toUpperCase()) ?? String(g)) : null);

  const parcel = (x: ArcGisFeature, use: "created" | "changed"): ChangedParcel => {
    const a = x.attributes ?? {};
    const retired = text(a[f.retiredBy]) !== null;
    return {
      object_id: Number(a[oid]),
      global_id: gid ? text(a[gid]) : null,
      UPI: text(a[f.upi]),
      retired,
      record: use === "created" ? nameOf(a[f.createdBy]) : nameOf(retired ? a[f.retiredBy] : a[f.createdBy]),
      attributes: a,
      ...(options.geometry ? { geometry: toGeoJson(x.geometry) } : {}),
    };
  };

  const inserted = (plotDiff.inserts ?? []).map((x) => parcel(x, "created"));
  const updated: UpdatedParcel[] = (plotDiff.updates ?? []).map((x) => {
    const p = parcel(x, "changed");
    const old = before.get(p.object_id) ?? {};
    const changed: UpdatedParcel["changed_fields"] = {};
    let shapeChanged = ringsDiffer(x.geometry?.rings, (old.__geometry as ArcGisFeature["geometry"])?.rings);
    const known = Object.keys(old).length > 0; // the DEFAULT row was found
    for (const [k, after] of Object.entries(p.attributes)) {
      if (k === "__geometry" || !known) continue;
      if (SHAPE.test(k)) shapeChanged ||= !same(old[k], after);
      else if (!NOISE.test(k) && !same(old[k], after)) changed[k] = { before: old[k] ?? null, after: after ?? null };
    }
    // An update that is not a retirement has no record of its own: don't name the parcel's creating record.
    return { ...p, record: p.retired ? p.record : null, changed_fields: changed, shape_changed: shapeChanged };
  });
  const deleted = deletedIds.map((id) => {
    const old = before.get(id) ?? { [oid]: id };
    const { __geometry, ...attributes } = old as Attributes & { __geometry?: ArcGisFeature["geometry"] };
    return { ...parcel({ attributes }, "changed"), ...(options.geometry ? { geometry: toGeoJson(__geometry) } : {}) };
  });

  const records = [
    ...(recordDiff?.inserts ?? []).map((x) => ({ change: "inserted" as const, x })),
    ...(recordDiff?.updates ?? []).map((x) => ({ change: "updated" as const, x })),
    ...(recordDiff?.deletes ?? []).map((x) => ({ change: "deleted" as const, x })),
  ].map(({ change, x }) => ({ change, global_id: r ? text(x.attributes?.[r.globalIdField]) : null, name: r ? text(x.attributes?.[r.nameField]) : null }));

  // Does the version change what the transaction is about?
  const touched = new Set([...updated.map((p) => p.object_id), ...deletedIds]);
  const transaction_parcels_unchanged = entry.objectIds.map((id, i) => (touched.has(id) ? null : (entry.UPIs[i] ?? `object ${id}`))).filter((u): u is string => !!u);
  const ours = new Set(entry.objectIds);
  const other_parcels_changed = [...updated, ...deleted].filter((p) => !ours.has(p.object_id)).map((p) => p.UPI ?? `object ${p.object_id}`);

  const warnings: string[] = [];
  if (!summary.length) warnings.push("The version has no changes yet: the GIS editor has not saved any work in it.");
  if (transaction_parcels_unchanged.length && summary.length) {
    const n = transaction_parcels_unchanged.length;
    warnings.push(`The version does not change the transaction's ${plural(n, "parcel", "parcels")} ${transaction_parcels_unchanged.join(", ")} (sent by LAIS).`);
  }
  if (other_parcels_changed.length) {
    const n = other_parcels_changed.length;
    warnings.push(`The version also changes ${plural(n, "a parcel that is", "parcels that are")} not in the transaction: ${other_parcels_changed.join(", ")}.`);
  }
  // New parcels whose UPI a current parcel in sde.DEFAULT already has (e.g. posted from another version since).
  const newUpis = [...new Set(inserted.map((p) => p.UPI).filter((u): u is string => !!u))];
  if (newUpis.length) {
    const body = await arcgisPost(`${config.lais.plotLayerUrl}/query`, { where: `${f.upi} IN (${sqlList(newUpis)}) AND ${f.retiredBy} IS NULL`, outFields: f.upi, returnGeometry: "false" }, token);
    const taken = [...new Set(((body.features ?? []) as ArcGisFeature[]).map((x) => String(x.attributes?.[f.upi] ?? "")))].filter(Boolean);
    if (taken.length) warnings.push(`New ${plural(taken.length, "parcel has the UPI", "parcels have the UPIs")} ${taken.join(", ")}, already used by a current parcel in the official data.`);
  }
  const short = shortVersionName(entry.versionName);
  const usedRecords = [...new Set([...inserted, ...updated].map((p) => p.record).filter((n): n is string => !!n))];
  if (usedRecords.length && !usedRecords.some((n) => n.toUpperCase() === short.toUpperCase())) {
    warnings.push(`The work uses the record${usedRecords.length > 1 ? "s" : ""} ${usedRecords.join(", ")}, not one named after the version (${short}); "Editing done" will ask for the record name.`);
  }

  return {
    Transaction_ID: entry.Transaction_ID,
    Transaction_Type: entry.Transaction_Type,
    UPIs: entry.UPIs,
    version_name: version.name,
    compared_with: "sde.DEFAULT",
    summary,
    plots: { inserted, updated, deleted },
    records,
    checks: { transaction_parcels_unchanged, other_parcels_changed },
    warnings,
  };
}
