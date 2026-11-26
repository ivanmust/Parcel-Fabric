import { randomUUID } from "node:crypto";
import { config } from "../config/env.js";
import { logger } from "../logging/logger.js";
import { writeAudit } from "../audit/auditLog.js";
import { arcgisPost } from "./arcgisClient.js";
import { allEntries, getEntry, putEntry, type EditingDone, type LedgerEntry } from "./ledger.js";
import { LaisConfigurationError, layerSchema, ownedVersions, shortVersionName, sql, withLock, type Attributes, type LayerSchema, type Optional } from "./laisService.js";

/**
 * GIS → LAIS "editing done" notification.
 *
 * When a GIS editor has finished a LAIS transaction in its version, GIS posts this to the endpoint LAIS
 * hosts (LAIS_WEBHOOK_URL, header X-API-Key = LAIS_WEBHOOK_KEY). The registrar then approves in LAIS.
 * The body is the format agreed with LAIS (sample sent 2026-11-26): only data GIS already holds, read
 * from the transaction's version. New parcels have no UPI yet (UPIs are created at approval); each one
 * carries parcel_ref, its Plot global id, which the approve response will use to give its UPI.
 *
 * Delivery: any 2xx = received. 408, 429, 5xx, a timeout or no connection = retried with the same
 * event_id after about 1, 5 and 15 minutes, then hourly, for 24 hours. Any other 4xx = refused: the
 * editor sees LAIS's message and can send again.
 */

export const editingDoneEnabled = () => config.LAIS_EDITING_DONE === "true";
export const webhookConfigured = () => !!config.LAIS_WEBHOOK_URL && config.LAIS_WEBHOOK_KEY.length > 0;

const EVENT_TYPE = "editing.completed";
const LOCATION = ["province", "district", "sector", "cell", "village"] as const satisfies readonly Optional[];
const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000];
const RETRY_EVERY_MS = 60 * 60_000;
const GIVE_UP_AFTER_MS = 24 * 60 * 60_000;
const MAX_PARCELS = 500;

/** A refusal the editor can act on; the route turns it into an HTTP error. */
export class EditingDoneError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "EditingDoneError";
  }
}

// ---------------------------------------------------------------- payload

type GeoJsonPolygon = { type: "Polygon"; coordinates: number[][][] } | { type: "MultiPolygon"; coordinates: number[][][][] };

interface ParcelBase {
  UPI: string | null;
  area_sqm: number | null;
  province: string | null;
  district: string | null;
  sector: string | null;
  cell: string | null;
  village: string | null;
}
export interface ProposedParcel extends ParcelBase {
  parcel_ref: string;
  geometry: GeoJsonPolygon | null;
}

/** The notification without event_id and sent_at (added when it is sent). */
export interface EditingDoneBody {
  event_type: typeof EVENT_TYPE;
  Transaction_ID: string;
  Transaction_Type: string;
  version_name: string;
  record_name: string;
  edited_by: string;
  parent_parcels: ParcelBase[];
  proposed_parcels: ProposedParcel[];
  totals: { parent_area_sqm: number; proposed_area_sqm: number };
}

export interface Preview {
  /** Null when the work cannot be sent yet (see problems). */
  payload: EditingDoneBody | null;
  /** Why it cannot be sent yet; the editor must fix these. */
  problems: string[];
  /** Worth checking, but the notification can be sent. */
  warnings: string[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const round7 = (n: number) => Math.round(n * 1e7) / 1e7;
const text = (v: unknown) => (v === null || v === undefined || String(v).trim() === "" ? null : String(v).trim());
const unique = <T>(values: T[]) => [...new Set(values)];

/** Signed area of a ring (shoelace): positive = counter-clockwise. */
function signedArea(ring: number[][]): number {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i++) sum += ring[i]![0]! * ring[i + 1]![1]! - ring[i + 1]![0]! * ring[i]![1]!;
  return sum / 2;
}

/**
 * ArcGIS polygon rings (outer rings clockwise, holes counter-clockwise) → GeoJSON (RFC 7946: outer
 * rings counter-clockwise, holes clockwise). A hole belongs to the outer ring before it, as ArcGIS
 * orders them.
 */
export function toGeoJson(geometry: { rings?: number[][][] } | undefined): GeoJsonPolygon | null {
  const rings = (geometry?.rings ?? []).filter((r) => r.length >= 4);
  if (!rings.length) return null;
  const polygons: number[][][][] = [];
  for (const ring of rings) {
    const outer = signedArea(ring) < 0; // clockwise in ArcGIS
    const geo = [...ring].reverse().map(([x, y]) => [round7(x!), round7(y!)]);
    if (outer || !polygons.length) polygons.push([geo]);
    else polygons[polygons.length - 1]!.push(geo);
  }
  return polygons.length === 1 ? { type: "Polygon", coordinates: polygons[0]! } : { type: "MultiPolygon", coordinates: polygons };
}

function parcelBase(schema: LayerSchema, a: Attributes): ParcelBase {
  const first = (key: Optional) => (schema.optional[key] ?? []).map((f) => a[f]).find((v) => v !== null && v !== undefined && v !== "");
  const area = (schema.optional.area ?? []).map((f) => a[f]).find((v): v is number => typeof v === "number");
  const location = Object.fromEntries(LOCATION.map((k) => [k, text(first(k))])) as Pick<ParcelBase, "province" | "district" | "sector" | "cell" | "village">;
  return { UPI: text(a[schema.fields.upi]), area_sqm: area === undefined ? null : round2(area), ...location };
}

const plotOutFields = (schema: LayerSchema) =>
  unique([schema.objectIdField, ...(schema.globalIdField ? [schema.globalIdField] : []), schema.fields.upi, schema.fields.retiredBy, ...Object.values(schema.optional).flat()]);

async function plots(token: string, schema: LayerSchema, where: string, gdbVersion: string | undefined, withShape: boolean) {
  const body = await arcgisPost(
    `${config.lais.plotLayerUrl}/query`,
    {
      where,
      outFields: plotOutFields(schema).join(","),
      returnGeometry: String(withShape),
      ...(withShape ? { outSR: "4326" } : {}),
      resultRecordCount: String(MAX_PARCELS),
      ...(gdbVersion ? { gdbVersion } : {}),
    },
    token,
  );
  return (body.features ?? []) as Array<{ attributes: Attributes; geometry?: { rings?: number[][][] } }>;
}

/** The work as LAIS reviews it: which parcels, with which areas (not their UPIs, which GIS gives at approval). */
export const workFingerprint = (body: Pick<EditingDoneBody, "proposed_parcels" | "parent_parcels">) =>
  JSON.stringify({
    proposed: body.proposed_parcels.map((p) => `${p.parcel_ref.toUpperCase()}|${p.area_sqm}`).sort(),
    parents: body.parent_parcels.map((p) => `${p.UPI}|${p.area_sqm}`).sort(),
  });

/** The transaction's work as it stands in its version, and whether it can be sent to LAIS. */
export async function buildFor(token: string, entry: LedgerEntry, editedBy: string, recordName?: string): Promise<Preview> {
  if (!entry.versionName) throw new EditingDoneError(409, "no_version", "GIS has not created a version for this transaction.");
  if (entry.completion) throw new EditingDoneError(409, "already_posted", "This transaction is already in the official data (posted).");
  const short = shortVersionName(entry.versionName);
  const version = (await ownedVersions(token)).get(short.toLowerCase());
  if (!version) throw new EditingDoneError(409, "version_gone", `The version ${entry.versionName} no longer exists, so there is nothing to send.`);

  const schema = await layerSchema(token);
  const r = schema.records;
  if (!r) throw new LaisConfigurationError("The Parcel Fabric Records layer is not published with the Plot layer.");
  const problems: string[] = [];
  const warnings: string[] = [];
  const type = entry.Transaction_Type;
  const f = schema.fields;
  const oid = schema.objectIdField;

  // The record of the change: named after the version (the editors' convention), or the one the editor names.
  const wanted = unique([recordName?.trim(), short].filter((n): n is string => !!n));
  const recordBody = await arcgisPost(
    `${r.url}/query`,
    { where: `UPPER(${r.nameField}) IN (${wanted.map((n) => sql(n.toUpperCase())).join(",")})`, outFields: [r.globalIdField, r.nameField].join(","), returnGeometry: "false", gdbVersion: version.name },
    token,
  );
  const records = ((recordBody.features ?? []) as Array<{ attributes: Attributes }>).map((x) => ({ id: String(x.attributes[r.globalIdField] ?? ""), name: String(x.attributes[r.nameField] ?? "") }));
  const byName = (n: string) => records.filter((x) => x.name.toUpperCase() === n.toUpperCase());
  const chosenName = wanted.find((n) => byName(n).length) ?? null;
  if (!chosenName) {
    problems.push(`No Parcel Fabric record named ${wanted.map((n) => `"${n}"`).join(" or ")} was found in the version. Create the record with the version's name (${short}), do the work with it as the active record, and save your edits.`);
    return { payload: null, problems, warnings };
  }
  if (byName(chosenName).length > 1) {
    problems.push(`More than one record is named "${chosenName}" in the version. Keep one, then try again.`);
    return { payload: null, problems, warnings };
  }
  const record = byName(chosenName)[0]!;

  // The parcels the record produced (and, for a boundary correction, the transaction's parcels edited in place).
  const proposedRows = await plots(token, schema, `${f.createdBy} = ${sql(record.id)} AND ${f.retiredBy} IS NULL`, version.name, true);
  const inPlace = type === "CorrectBoundaries";
  if (inPlace && entry.objectIds.length) {
    const known = new Set(proposedRows.map((p) => Number(p.attributes[oid])));
    for (const p of await plots(token, schema, `${oid} IN (${entry.objectIds.join(",")}) AND ${f.retiredBy} IS NULL`, version.name, true)) {
      if (!known.has(Number(p.attributes[oid]))) proposedRows.push(p);
    }
  }
  // The parcels being replaced: retired by the record in the version, or for a correction the same parcels as they are in DEFAULT.
  const parentRows = inPlace
    ? entry.objectIds.length
      ? await plots(token, schema, `${oid} IN (${entry.objectIds.join(",")})`, undefined, false)
      : []
    : await plots(token, schema, `${f.retiredBy} = ${sql(record.id)}`, version.name, false);

  // Does the work match the transaction?
  const n = proposedRows.length;
  if (!n) problems.push(`The record ${record.name} has no parcels in the version yet. Do the ${type.toLowerCase()} with it as the active record and save your edits.`);
  else if (type === "Subdivision" && n < 2) problems.push(`A subdivision must produce at least 2 parcels; the record ${record.name} has ${n}.`);
  else if (type === "Merge" && n !== 1) problems.push(`A merge must produce exactly 1 parcel; the record ${record.name} has ${n}.`);
  if (!inPlace && entry.objectIds.length) {
    const retired = new Set(parentRows.map((p) => Number(p.attributes[oid])));
    const notRetired = entry.objectIds.map((id, i) => (retired.has(id) ? null : entry.UPIs[i] ?? `object ${id}`)).filter((u): u is string => !!u);
    if (notRetired.length) {
      problems.push(`The transaction's parcel${notRetired.length > 1 ? "s" : ""} ${notRetired.join(", ")} ${notRetired.length > 1 ? "are" : "is"} not replaced by the record ${record.name} in the version. The ${type.toLowerCase()} must be done on the parcel${entry.UPIs.length > 1 ? "s" : ""} LAIS sent (${entry.UPIs.join(", ")}).`);
    }
  }
  if (proposedRows.length && !schema.globalIdField) throw new LaisConfigurationError("The Plot layer has no global id field; parcels cannot be identified for LAIS.");

  const proposed: ProposedParcel[] = proposedRows.map((p) => ({
    parcel_ref: String(p.attributes[schema.globalIdField!] ?? ""),
    ...parcelBase(schema, p.attributes),
    geometry: toGeoJson(p.geometry),
  }));
  const parents = parentRows.map((p) => parcelBase(schema, p.attributes));

  const noArea = [...parents, ...proposed].filter((p) => p.area_sqm === null).length;
  if (noArea) warnings.push(`${noArea} parcel(s) have no area in GIS; LAIS will receive area_sqm: null for them.`);
  const noPlace = proposed.filter((p) => LOCATION.some((k) => p[k] === null)).length;
  if (noPlace) warnings.push(`${noPlace} new parcel(s) are missing part of their location (province to village).`);
  const withUpi = inPlace ? 0 : proposed.filter((p) => p.UPI).length;
  if (withUpi) warnings.push(`${withUpi} new parcel(s) already have a UPI. In this flow UPIs are created when the registrar approves.`);
  const noShape = proposed.filter((p) => !p.geometry).length;
  if (noShape) problems.push(`${noShape} new parcel(s) have no boundary.`);

  if (problems.length) return { payload: null, problems, warnings };
  const sum = (list: ParcelBase[]) => round2(list.reduce((t, p) => t + (p.area_sqm ?? 0), 0));
  return {
    payload: {
      event_type: EVENT_TYPE,
      Transaction_ID: entry.Transaction_ID,
      Transaction_Type: type,
      version_name: entry.versionName,
      record_name: record.name,
      edited_by: editedBy,
      parent_parcels: parents,
      proposed_parcels: proposed,
      totals: { parent_area_sqm: sum(parents), proposed_area_sqm: sum(proposed) },
    },
    problems,
    warnings,
  };
}

async function entryOrThrow(transactionId: string): Promise<LedgerEntry> {
  const entry = await getEntry(transactionId);
  if (!entry) throw new EditingDoneError(404, "not_found", `No LAIS transaction ${transactionId} is recorded in GIS.`);
  return entry;
}

/** What would be sent, without sending it: for the editor to check first. */
export async function previewEditingDone(token: string, transactionId: string, editedBy: string, recordName?: string): Promise<Preview> {
  return buildFor(token, await entryOrThrow(transactionId), editedBy, recordName);
}

// ---------------------------------------------------------------- state for the web app

export interface EditingDoneView {
  status: EditingDone["status"];
  event_id: string;
  requested_by: string;
  requested_at: string;
  attempts: number;
  last_attempt_at: string | null;
  next_attempt_at: string | null;
  last_result: string | null;
  last_message: string | null;
  delivered_at: string | null;
  record_name: string | null;
  parcels: number;
}

export function viewOf(d: EditingDone | undefined): EditingDoneView | null {
  if (!d) return null;
  return {
    status: d.status,
    event_id: d.eventId,
    requested_by: d.requestedBy,
    requested_at: d.requestedAt,
    attempts: d.attempts,
    last_attempt_at: d.lastAttemptAt,
    next_attempt_at: d.nextAttemptAt,
    last_result: d.lastResult,
    last_message: d.lastMessage,
    delivered_at: d.deliveredAt,
    record_name: typeof d.payload.record_name === "string" ? d.payload.record_name : null,
    parcels: Array.isArray(d.payload.proposed_parcels) ? d.payload.proposed_parcels.length : 0,
  };
}

/** The LAIS transactions with a version, for the editors' list. Reads the ledger only. */
export async function transactionsForEditors() {
  return (await allEntries())
    .filter((e) => e.versionName)
    .map((e) => ({
      Transaction_ID: e.Transaction_ID,
      Transaction_Type: e.Transaction_Type,
      UPIs: e.UPIs,
      version_name: e.versionName,
      posted: !!e.completion,
      editing_done: viewOf(e.editingDone),
      decision: decisionOf(e),
    }));
}

/** The registrar's decision on the work last sent: approved (with the UPIs), rejected (with the reason), or none yet. */
function decisionOf(e: LedgerEntry) {
  if (e.approval?.status === "approved") return { kind: "approved" as const, by: e.approval.approvedBy, at: e.approval.approvedAt, upis: e.approval.upis.map((u) => u.UPI), reason: null, error: null };
  if (e.approval) return { kind: "approving" as const, by: e.approval.approvedBy, at: e.approval.requestedAt, upis: e.approval.upis.map((u) => u.UPI), reason: null, error: e.approval.lastError };
  const last = e.editingDone && (e.rejections ?? []).find((r) => r.eventId === e.editingDone!.eventId);
  if (last) return { kind: "rejected" as const, by: last.rejectedBy, at: last.at, upis: [], reason: last.reason, error: null };
  return null;
}

// ---------------------------------------------------------------- sending

/**
 * The editor says the work is done: check it, record the notification, and make the first attempt.
 * A notification LAIS has received is never sent twice; one still being sent is not duplicated.
 */
export async function requestEditingDone(token: string, transactionId: string, editedBy: string, recordName?: string): Promise<{ view: EditingDoneView; warnings: string[] }> {
  if (!webhookConfigured()) throw new EditingDoneError(503, "not_configured", "The LAIS endpoint is not configured on this server (LAIS_WEBHOOK_URL and LAIS_WEBHOOK_KEY).");
  const queued = await withLock(transactionId.toLowerCase(), async () => {
    const entry = await entryOrThrow(transactionId);
    const previous = entry.editingDone;
    if (entry.approval?.status === "approved") {
      throw new EditingDoneError(409, "already_approved", `The registrar approved this work on ${entry.approval.approvedAt} and GIS posted it.`, viewOf(previous));
    }
    if (previous && (previous.status === "sending" || previous.status === "retrying")) return { warnings: [], resend: false };

    const preview = await buildFor(token, entry, editedBy, recordName);
    if (!preview.payload) throw new EditingDoneError(422, "not_ready", preview.problems.join(" "), { problems: preview.problems, warnings: preview.warnings });
    // LAIS has it and has not rejected it: send again only revised work (it replaces what LAIS reviews).
    const rejected = !!previous && (entry.rejections ?? []).some((r) => r.eventId === previous.eventId);
    if (previous?.status === "delivered" && !rejected && workFingerprint(preview.payload) === workFingerprint(previous.payload as unknown as EditingDoneBody)) {
      throw new EditingDoneError(409, "already_sent", `LAIS already received this work on ${previous.deliveredAt}. Wait for the registrar's decision; change the work first to send a revision.`, viewOf(previous));
    }
    const now = new Date().toISOString();
    const editingDone: EditingDone = {
      eventId: randomUUID(),
      status: "sending",
      payload: preview.payload as unknown as Record<string, unknown>,
      requestedBy: editedBy,
      requestedAt: now,
      attempts: 0,
      firstAttemptAt: null,
      lastAttemptAt: null,
      nextAttemptAt: now,
      lastResult: null,
      lastMessage: null,
      deliveredAt: null,
    };
    // Not something LAIS sees through GET /transactions: its updated_at stays as it was.
    await putEntry({ ...entry, editingDone }, { keepUpdatedAt: true });
    logger.info({ transactionId, eventId: editingDone.eventId, record: preview.payload.record_name, parcels: preview.payload.proposed_parcels.length }, "LAIS editing done: notification queued");
    return { warnings: preview.warnings, resend: true };
  });
  if (queued.resend) await deliver(transactionId, Date.now(), true);
  const entry = await entryOrThrow(transactionId);
  return { view: viewOf(entry.editingDone)!, warnings: queued.warnings };
}

type AttemptResult = { kind: "delivered" | "retry" | "refused"; label: string; message: string | null };

async function attempt(body: string, eventId: string): Promise<AttemptResult> {
  let res: Response;
  try {
    res = await fetch(config.LAIS_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": config.LAIS_WEBHOOK_KEY, "X-GIS-Event-Id": eventId, "X-GIS-Event-Type": EVENT_TYPE },
      body,
      signal: AbortSignal.timeout(config.LAIS_WEBHOOK_TIMEOUT_MS),
      redirect: "error",
    });
  } catch (error) {
    const name = (error as Error).name;
    return { kind: "retry", label: name === "TimeoutError" || name === "AbortError" ? "timeout" : "no connection", message: null };
  }
  const raw = await res.text().catch(() => "");
  let message: string | null;
  try {
    const parsed = JSON.parse(raw) as { message?: unknown; error?: { message?: unknown } };
    message = text(parsed.message ?? parsed.error?.message);
  } catch {
    message = text(raw.slice(0, 300));
  }
  const label = `HTTP ${res.status}`;
  if (res.ok) return { kind: "delivered", label, message };
  if (res.status === 408 || res.status === 429 || res.status >= 500) return { kind: "retry", label, message };
  return { kind: "refused", label, message: message?.slice(0, 500) ?? null };
}

/** One delivery attempt, if one is due. `now` is injectable for tests. */
async function deliver(transactionId: string, now: number, force = false): Promise<void> {
  await withLock(transactionId.toLowerCase(), async () => {
    const entry = await getEntry(transactionId);
    const d = entry?.editingDone;
    if (!entry || !d || (d.status !== "sending" && d.status !== "retrying")) return;
    if (!force && d.nextAttemptAt && Date.parse(d.nextAttemptAt) > now) return;
    if (!webhookConfigured()) return;

    const at = new Date(now).toISOString();
    const body = JSON.stringify({ event_id: d.eventId, event_type: EVENT_TYPE, sent_at: at, ...Object.fromEntries(Object.entries(d.payload).filter(([k]) => k !== "event_type")) });
    const result = await attempt(body, d.eventId);
    const first = d.firstAttemptAt ?? at;
    const attempts = d.attempts + 1;
    const next: EditingDone = { ...d, attempts, firstAttemptAt: first, lastAttemptAt: at, lastResult: result.label, lastMessage: result.message };
    if (result.kind === "delivered") Object.assign(next, { status: "delivered", deliveredAt: at, nextAttemptAt: null });
    else if (result.kind === "refused") Object.assign(next, { status: "refused", nextAttemptAt: null });
    else {
      const delay = RETRY_DELAYS_MS[attempts - 1] ?? RETRY_EVERY_MS;
      const giveUp = now + delay - Date.parse(first) > GIVE_UP_AFTER_MS;
      Object.assign(next, giveUp ? { status: "failed", nextAttemptAt: null } : { status: "retrying", nextAttemptAt: new Date(now + delay).toISOString() });
    }
    await putEntry({ ...entry, editingDone: next }, { keepUpdatedAt: true });

    const log = { transactionId, eventId: d.eventId, attempt: attempts, result: result.label, status: next.status, lais: result.message ?? undefined };
    if (next.status === "delivered") logger.info(log, "LAIS editing done: delivered");
    else if (next.status === "retrying") logger.warn({ ...log, nextAttemptAt: next.nextAttemptAt }, "LAIS editing done: not delivered, will retry");
    else logger.error(log, next.status === "failed" ? "LAIS editing done: gave up after 24 hours" : "LAIS editing done: LAIS refused the notification");
    void writeAudit({
      username: "GIS",
      appRole: "INTEGRATION",
      action: "lais.editing-done.delivery",
      target: transactionId,
      outcome: next.status === "delivered" ? "success" : next.status === "retrying" ? "attempt" : "failure",
      details: { event_id: d.eventId, attempt: attempts, result: result.label, status: next.status, ...(result.message ? { message: result.message } : {}) },
    }).catch(() => undefined);
  });
}

/** Attempts that are due (after a failure, or left over from before a restart). */
export async function deliverDueEditingDone(now = Date.now()): Promise<void> {
  for (const e of await allEntries()) {
    const d = e.editingDone;
    if (d && (d.status === "sending" || d.status === "retrying") && (!d.nextAttemptAt || Date.parse(d.nextAttemptAt) <= now)) {
      await deliver(e.Transaction_ID, now).catch((error) => logger.error({ err: (error as Error).message, transactionId: e.Transaction_ID }, "LAIS editing done: delivery attempt crashed"));
    }
  }
}

/** Retry loop for the running server. Does nothing while the feature is off. */
export function startEditingDoneRetries(intervalMs = 30_000): (() => void) | null {
  if (!editingDoneEnabled()) return null;
  if (!webhookConfigured()) logger.warn("LAIS_EDITING_DONE is on but LAIS_WEBHOOK_URL or LAIS_WEBHOOK_KEY is empty: notifications cannot be sent");
  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    void deliverDueEditingDone().finally(() => (running = false));
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
