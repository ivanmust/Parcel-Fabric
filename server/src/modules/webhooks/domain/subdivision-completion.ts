import { config } from "../../../config/env.js";
import { logger } from "../../../common/logging/logger.js";
import { writeAudit } from "../../../common/audit/audit-log.js";
import { arcgisPost } from "../../../common/arcgis/arcgis-client.js";
import { sqlList } from "../../../common/utils/sql.js";
import { toGeoJson } from "../../../common/utils/geojson.js";
import { allEntries, getEntry } from "../../lais/repositories/ledger.repository.js";
import { layerSchema, type LayerSchema } from "../../lais/repositories/plot-layer.repository.js";
import { transactionStatus } from "../../lais/domain/transaction-queries.js";
import type { LedgerEntry } from "../../lais/models/ledger-entry.model.js";
import type { Attributes } from "../../lais/models/transaction.model.js";
import { stableEventId } from "./signing.js";
import type { FileOutbox } from "./outbox.js";

/**
 * The event sent to App B once a LAIS Subdivision is posted: built from sde.DEFAULT, created once in
 * the outbox with a stable id. An incomplete result (e.g. a parcel without UPI) waits for the next run.
 */

export const EVENT_TYPE = "subdivision.completed";
export const EVENT_VERSION = "1.0";
const MAX_PARCELS = 200;

type GeoJson = ReturnType<typeof toGeoJson>;

export interface WebhookParcel {
  UPI: string | null;
  object_id: number;
  global_id: string | null;
  /** False if the parcel has itself been retired since (e.g. subdivided again). */
  current: boolean;
  area_sqm: number | null;
  /** Every field of the Plot layer, as stored in sde.DEFAULT (dates as ISO 8601 UTC). */
  attributes: Record<string, unknown>;
  geometry: GeoJson;
}

export interface SubdivisionCompletedEvent {
  event_id: string;
  event_type: typeof EVENT_TYPE;
  event_version: typeof EVENT_VERSION;
  created_at: string;
  data: {
    Transaction_ID: string;
    Transaction_Type: "Subdivision";
    Transaction_Date: string;
    Transaction_Status: string | null;
    version_name: string | null;
    /** Latest edit time of the resulting parcels in sde.DEFAULT, when editor tracking provides it. */
    completed_at: string | null;
    detected_at: string;
    /** How GIS found the posted change: the record named after the version, or parcel lineage. */
    detected_via: "record" | "lineage" | "fields";
    records: Array<{ global_id: string; name: string | null; recorded_date: string | null }>;
    original_parcel: Omit<WebhookParcel, "area_sqm" | "geometry"> & { area_sqm: number | null };
    resulting_parcels: WebhookParcel[];
  };
}

export type BuildOutcome = { kind: "ready"; event: SubdivisionCompletedEvent } | { kind: "incomplete"; problems: string[] };

const iso = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? new Date(v).toISOString() : null);
const textOrNull = (v: unknown) => (v === null || v === undefined || String(v).trim() === "" ? null : String(v).trim());

/** All attributes as stored; date fields become ISO 8601 (ArcGIS returns epoch milliseconds). */
function exportAttributes(schema: LayerSchema, a: Attributes): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(a)) out[k] = schema.fieldTypes[k] === "esriFieldTypeDate" ? (v === null || v === undefined ? null : iso(v)) : v;
  return out;
}

/**
 * The area of the parcel's boundary (the shape's area field, m²), so it always matches the geometry sent
 * with it; a stored area attribute (e.g. `size`) can be stale after an edit and is only the fallback.
 * The stored attributes themselves still go out unchanged in `attributes`.
 */
const isShapeArea = (field: string) => /shape__area|shape_area|st_area|starea/i.test(field);
function areaOf(schema: LayerSchema, a: Attributes): number | null {
  const fields = schema.optional.area ?? [];
  const v = [...fields.filter(isShapeArea), ...fields.filter((f) => !isShapeArea(f))].map((f) => a[f]).find((x): x is number => typeof x === "number");
  return v === undefined ? null : Math.round(v * 100) / 100;
}

/** The event for a posted subdivision, or why it cannot be sent yet. Reads sde.DEFAULT only. */
export async function buildSubdivisionEvent(token: string, entry: LedgerEntry, now: number): Promise<BuildOutcome> {
  const c = entry.completion;
  if (entry.Transaction_Type !== "Subdivision") return { kind: "incomplete", problems: ["Not a Subdivision."] };
  if (!c) return { kind: "incomplete", problems: ["GIS has not detected the posted change yet."] };
  const schema = await layerSchema(token);
  const f = schema.fields;
  const oid = schema.objectIdField;
  const originalId = entry.objectIds[0];
  const problems: string[] = [];
  if (originalId === undefined) problems.push("The transaction has no original parcel recorded.");
  if (c.parcelObjectIds.length > MAX_PARCELS) problems.push(`More than ${MAX_PARCELS} resulting parcels; refusing to build an unbounded event.`);
  if (problems.length) return { kind: "incomplete", problems };

  const ids = [...new Set([originalId!, ...c.parcelObjectIds])];
  const body = await arcgisPost(
    `${config.lais.plotLayerUrl}/query`,
    { where: `${oid} IN (${ids.join(",")})`, outFields: "*", returnGeometry: "true", outSR: "4326", resultRecordCount: String(ids.length) },
    token,
  );
  const rows = new Map(((body.features ?? []) as Array<{ attributes: Attributes; geometry?: { rings?: number[][][] } }>).map((x) => [Number(x.attributes[oid]), x]));

  const original = rows.get(originalId!);
  if (!original) problems.push(`The original parcel (object ${originalId}) is not in sde.DEFAULT.`);
  else if (original.attributes[f.retiredBy] == null) problems.push(`The original parcel ${textOrNull(original.attributes[f.upi]) ?? originalId} is not retired in sde.DEFAULT.`);
  else if (!c.retiredObjectIds.includes(originalId!)) problems.push(`The posted change did not retire the original parcel ${textOrNull(original.attributes[f.upi]) ?? originalId}.`);

  if (c.parcelObjectIds.length < 2) problems.push(`A subdivision must produce at least 2 parcels; GIS found ${c.parcelObjectIds.length}.`);
  const missingRows = c.parcelObjectIds.filter((id) => !rows.has(id));
  if (missingRows.length) problems.push(`Resulting parcel(s) ${missingRows.join(", ")} are not in sde.DEFAULT.`);
  const noUpi = c.parcelObjectIds.filter((id) => rows.has(id) && !textOrNull(rows.get(id)!.attributes[f.upi]));
  if (noUpi.length) problems.push(`${noUpi.length} resulting parcel(s) have no UPI yet; GIS must assign them.`);
  const noShape = c.parcelObjectIds.filter((id) => rows.has(id) && !toGeoJson(rows.get(id)!.geometry));
  if (noShape.length) problems.push(`${noShape.length} resulting parcel(s) have no boundary.`);
  if (problems.length) return { kind: "incomplete", problems };

  const parcel = (id: number): WebhookParcel => {
    const row = rows.get(id)!;
    const a = row.attributes;
    return {
      UPI: textOrNull(a[f.upi]),
      object_id: id,
      global_id: schema.globalIdField ? textOrNull(a[schema.globalIdField]) : null,
      current: a[f.retiredBy] == null,
      area_sqm: areaOf(schema, a),
      attributes: exportAttributes(schema, a),
      geometry: toGeoJson(row.geometry),
    };
  };
  const resulting = c.parcelObjectIds.map(parcel).sort((x, y) => String(x.UPI).localeCompare(String(y.UPI)));
  const { geometry: _g, ...originalParcel } = parcel(originalId!);

  let records: SubdivisionCompletedEvent["data"]["records"] = c.recordIds.map((id) => ({ global_id: id, name: null, recorded_date: null }));
  const r = schema.records;
  if (r && c.recordIds.length) {
    const rb = await arcgisPost(
      `${r.url}/query`,
      { where: `${r.globalIdField} IN (${sqlList(c.recordIds)})`, outFields: [r.globalIdField, r.nameField, ...(r.recordedDateField ? [r.recordedDateField] : [])].join(","), returnGeometry: "false" },
      token,
    );
    const byId = new Map(((rb.features ?? []) as Array<{ attributes: Attributes }>).map((x) => [String(x.attributes[r.globalIdField]), x.attributes]));
    records = c.recordIds.map((id) => ({ global_id: id, name: textOrNull(byId.get(id)?.[r.nameField]), recorded_date: r.recordedDateField ? iso(byId.get(id)?.[r.recordedDateField]) : null }));
  }
  const edits = schema.editDateField ? c.parcelObjectIds.map((id) => rows.get(id)!.attributes[schema.editDateField!]).filter((v): v is number => typeof v === "number") : [];

  const id = stableEventId(EVENT_TYPE, entry.Transaction_ID);
  return {
    kind: "ready",
    event: {
      event_id: id,
      event_type: EVENT_TYPE,
      event_version: EVENT_VERSION,
      created_at: new Date(now).toISOString(),
      data: {
        Transaction_ID: entry.Transaction_ID,
        Transaction_Type: "Subdivision",
        Transaction_Date: entry.Transaction_Date,
        Transaction_Status: entry.Transaction_Status ?? null,
        version_name: entry.versionName,
        completed_at: edits.length ? new Date(Math.max(...edits)).toISOString() : null,
        detected_at: c.detectedAt,
        detected_via: c.via,
        records,
        original_parcel: originalParcel,
        resulting_parcels: resulting,
      },
    },
  };
}

export interface ReconcileSummary {
  checked: number;
  created: number;
  waiting: number;
  errors: number;
}

/**
 * One reconciliation pass. Safe to run at any time and after any downtime: every eligible
 * transaction without an event is checked again, and an event is never created twice.
 */
export async function reconcileSubdivisions(outbox: FileOutbox, withToken: <T>(fn: (token: string) => Promise<T>) => Promise<T>, now = Date.now()): Promise<ReconcileSummary> {
  // The first run is always recorded, so clearing SUBDIVISION_WEBHOOK_SINCE later leaves no gap.
  const tracked = await outbox.trackingSince(now);
  const since = Date.parse(config.SUBDIVISION_WEBHOOK_SINCE || tracked);
  const summary: ReconcileSummary = { checked: 0, created: 0, waiting: 0, errors: 0 };
  for (const candidate of await allEntries()) {
    // Scope: LAIS Subdivisions with a version, accepted since tracking began. Other types never qualify.
    if (candidate.Transaction_Type !== "Subdivision" || !candidate.versionName) continue;
    if (Date.parse(candidate.createdAt) < since) continue;
    const id = stableEventId(EVENT_TYPE, candidate.Transaction_ID);
    if (await outbox.hasEvent(id)) continue;
    // Closed (version removed, change never posted) is final.
    if (!candidate.completion && (candidate.reported as { stage?: string } | undefined)?.stage === "Closed") continue;
    summary.checked += 1;
    try {
      const status = await withToken((token) => transactionStatus(token, candidate.Transaction_ID));
      if (status.kind !== "found" || status.record.stage !== "Posted") continue; // InReview: not yet; Closed: never
      const entry = (await getEntry(candidate.Transaction_ID))!; // with the completion just recorded
      const built = await withToken((token) => buildSubdivisionEvent(token, entry, now));
      if (built.kind === "incomplete") {
        const wait = await outbox.markWaiting(entry.Transaction_ID, built.problems.join(" "), now);
        summary.waiting += 1;
        if (wait.checks === 1) logger.warn({ transactionId: entry.Transaction_ID, problems: built.problems }, "Subdivision posted, but its completion event is waiting for complete data");
        continue;
      }
      const { created } = await outbox.createEvent({ id, type: EVENT_TYPE, key: entry.Transaction_ID, payload: built.event as unknown as Record<string, unknown>, now });
      if (created) {
        summary.created += 1;
        logger.info({ transactionId: entry.Transaction_ID, eventId: id, parcels: built.event.data.resulting_parcels.length }, "Subdivision completion event created");
        void writeAudit({
          username: "GIS",
          appRole: "INTEGRATION",
          action: "webhook.event.created",
          target: entry.Transaction_ID,
          outcome: "success",
          details: { event_id: id, event_type: EVENT_TYPE, parcels: built.event.data.resulting_parcels.map((p) => p.UPI) },
        }).catch(() => undefined);
      }
    } catch (error) {
      summary.errors += 1;
      logger.error({ err: (error as Error).message, transactionId: candidate.Transaction_ID }, "Subdivision completion check failed; will retry on the next run");
    }
  }
  return summary;
}
