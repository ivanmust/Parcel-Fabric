import { randomUUID } from "node:crypto";
import { config } from "../../../config/env.js";
import { logger } from "../../../common/logging/logger.js";
import { writeAudit } from "../../../common/audit/audit-log.js";
import { arcgisPost, withServiceToken } from "../../../common/arcgis/arcgis-client.js";
import { sql, sqlList, textOrNull as text, unique } from "../../../common/utils/sql.js";
import { withLock } from "../../../common/utils/lock.js";
import { toGeoJson } from "../../../common/utils/geojson.js";
import { allEntries, getEntry, putEntry } from "../repositories/ledger.repository.js";
import { layerSchema, plotField, plotLayerId, plotShapes, relatedPlots, type LayerSchema, type Optional } from "../repositories/plot-layer.repository.js";
import { editInVersion, ownedVersions, versionDifferences, type VersionRef } from "../repositories/version.repository.js";
import type { EditingDone, LedgerEntry } from "../models/ledger-entry.model.js";
import type { Attributes } from "../models/transaction.model.js";
import { EDITING_DONE_EVENT, EditingDoneError, type EditingDoneBody, type EditingDoneView, type NotificationPreview, type ParcelSummary, type Preview, type ProposedParcel } from "../models/editing-done.model.js";
import { isVersionInUse, LaisConfigurationError } from "./gis-errors.js";
import { shortVersionName } from "./version-naming.js";

/**
 * GIS → LAIS "editing done": the editor's finished work, read from the transaction's version, sent (PUT) to
 * LAIS_WEBHOOK_URL. 2xx = received; 408, 429, 5xx, timeout or no connection = retried with the same
 * event_id (after 1, 5, 15 minutes, then hourly, for 24 hours); any other 4xx = refused.
 */

export const editingDoneEnabled = () => config.LAIS_EDITING_DONE === "true";
export const webhookConfigured = () => !!config.LAIS_WEBHOOK_URL && config.LAIS_WEBHOOK_KEY.length > 0;

const LOCATION = ["province", "district", "sector", "cell", "village"] as const satisfies readonly Optional[];
const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000];
const RETRY_EVERY_MS = 60 * 60_000;
const GIVE_UP_AFTER_MS = 24 * 60 * 60_000;
const MAX_PARCELS = 500;

const round2 = (n: number) => Math.round(n * 100) / 100;

function parcelBase(schema: LayerSchema, a: Attributes): ParcelSummary {
  const first = (key: Optional) => (schema.optional[key] ?? []).map((f) => a[f]).find((v) => v !== null && v !== undefined && v !== "");
  const area = (schema.optional.area ?? []).map((f) => a[f]).find((v): v is number => typeof v === "number");
  const location = Object.fromEntries(LOCATION.map((k) => [k, text(first(k))])) as Pick<ParcelSummary, "province" | "district" | "sector" | "cell" | "village">;
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

interface VersionWork {
  /** The new parcels: current Plots the work created in the version. */
  newIds: number[];
  /** Plots that existed in sde.DEFAULT and the version changes (retired, reshaped or edited). */
  changedIds: number[];
}

const DIFFERENCES_RETRIES = 2;
const DIFFERENCES_RETRY_MS = 1500;

async function versionChanges(token: string, version: VersionRef) {
  try {
    return await versionDifferences(token, version, plotLayerId());
  } catch (error) {
    if (isVersionInUse(error)) {
      throw new EditingDoneError(409, "version_in_use", "A GIS editor is editing this version right now, so its work cannot be read. Try again when the editor has saved or stopped editing.");
    }
    throw error;
  }
}

/** Current parcels in the version created by the record that retired each of these parcels and lying over it (Parcel Fabric lineage). */
async function successorsInVersion(token: string, schema: LayerSchema, version: VersionRef, parentIds: number[]): Promise<number[] | null> {
  const f = schema.fields;
  const oid = schema.objectIdField;
  if (!parentIds.length) return null;
  const retired = await plotShapes(token, `${oid} IN (${parentIds.join(",")}) AND ${f.retiredBy} IS NOT NULL`, [oid, f.retiredBy], version.name);
  if (!retired.features.length) return null;
  const ids: number[] = [];
  for (const parent of retired.features) {
    const record = String(parent.attributes[f.retiredBy]);
    const children = await relatedPlots(token, schema, parent.geometry, retired.spatialReference, "T********", `${f.createdBy} = ${sql(record)} AND ${f.retiredBy} IS NULL`, version.name);
    ids.push(...children.map((c) => Number(c[oid])));
  }
  return unique(ids);
}

/**
 * The editing work in the transaction's version, whatever record the editor used. New parcels follow the
 * lineage of the transaction's retired parcels, which a query of the version sees as soon as the edits are
 * saved. A new plot without a parent has no lineage: it comes from the version's differences, which can lag
 * a save by a few seconds, so an empty answer is asked again briefly.
 */
async function workInVersion(token: string, schema: LayerSchema, version: VersionRef, entry: LedgerEntry): Promise<VersionWork> {
  let changes = await versionChanges(token, version);
  const lineage = await successorsInVersion(token, schema, version, entry.objectIds);
  if (lineage) return { newIds: lineage, changedIds: changes.updates };
  const newPlot = entry.Transaction_Type === "CreatePlot" && !entry.objectIds.length;
  for (let attempt = 0; newPlot && !changes.inserts.length && attempt < DIFFERENCES_RETRIES; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, DIFFERENCES_RETRY_MS));
    changes = await versionChanges(token, version);
  }
  return { newIds: changes.inserts, changedIds: changes.updates };
}

const listOf = (upis: string[]) => (upis.length > 1 ? `parcels ${upis.join(", ")} are` : `parcel ${upis[0]} is`);

/**
 * The transaction's work as it stands in its version, and whether it can be sent to LAIS. The new parcels
 * are the Plots the version added (whatever record the editor used); record_name is the version's name.
 */
export async function buildFor(token: string, entry: LedgerEntry, editedBy: string): Promise<Preview> {
  if (!entry.versionName) throw new EditingDoneError(409, "no_version", "GIS has not created a version for this transaction.");
  if (entry.completion) throw new EditingDoneError(409, "already_posted", "This transaction is already in the official data (posted).");
  const recordName = shortVersionName(entry.versionName);
  const version = (await ownedVersions(token)).get(recordName.toLowerCase());
  if (!version) throw new EditingDoneError(409, "version_gone", `The version ${entry.versionName} no longer exists, so there is nothing to send.`);

  const schema = await layerSchema(token);
  const problems: string[] = [];
  const warnings: string[] = [];
  const type = entry.Transaction_Type;
  const f = schema.fields;
  const oid = schema.objectIdField;
  const inPlace = type === "CorrectBoundaries";
  const ours = new Set(entry.objectIds);
  const work = await workInVersion(token, schema, version, entry);

  const proposedIds = unique([...work.newIds, ...(inPlace ? entry.objectIds : [])]);
  const proposedRows = proposedIds.length ? await plots(token, schema, `${oid} IN (${proposedIds.join(",")}) AND ${f.retiredBy} IS NULL`, version.name, true) : [];
  // The transaction's parcels: in the version (retired by the work), or for a correction as they are in DEFAULT.
  const parentRows = entry.objectIds.length ? await plots(token, schema, `${oid} IN (${entry.objectIds.join(",")})`, inPlace ? undefined : version.name, false) : [];

  const n = proposedRows.length;
  const action = type.toLowerCase();
  if (inPlace && !work.changedIds.some((id) => ours.has(id))) problems.push(`The version does not change the transaction's parcels yet. Do the ${action} in the version and save your edits.`);
  else if (!n) problems.push(`The version has no new parcels yet. Do the ${action} in the version ${version.name} and save your edits.`);
  else if (type === "Subdivision" && n < 2) problems.push(`A subdivision must produce at least 2 parcels; the version has ${n} new parcel.`);
  else if (type === "Merge" && n !== 1) problems.push(`A merge must produce exactly 1 parcel; the version has ${n} new parcels.`);
  if (!inPlace && entry.objectIds.length) {
    const retired = new Set(parentRows.filter((p) => p.attributes[f.retiredBy] != null).map((p) => Number(p.attributes[oid])));
    const notRetired = entry.objectIds.map((id, i) => (retired.has(id) ? null : (entry.UPIs[i] ?? `object ${id}`))).filter((u): u is string => !!u);
    if (notRetired.length) {
      problems.push(`The transaction's ${listOf(notRetired)} not replaced in the version. The ${action} must be done on the parcel${entry.UPIs.length > 1 ? "s" : ""} LAIS sent (${entry.UPIs.join(", ")}).`);
    }
  }
  if (proposedRows.length && !schema.globalIdField) throw new LaisConfigurationError("The Plot layer has no global id field; parcels cannot be identified for LAIS.");

  const proposed: ProposedParcel[] = proposedRows.map((p) => ({
    parcel_ref: String(p.attributes[schema.globalIdField!] ?? ""),
    ...parcelBase(schema, p.attributes),
    geometry: toGeoJson(p.geometry),
  }));
  const parents = parentRows.map((p) => parcelBase(schema, p.attributes));

  const others = work.changedIds.filter((id) => !ours.has(id));
  if (others.length) {
    const rows = await plots(token, schema, `${oid} IN (${others.join(",")})`, version.name, false);
    const names = rows.map((p) => String(p.attributes[f.upi] ?? `object ${String(p.attributes[oid])}`));
    warnings.push(`The version also changes ${names.length === 1 ? `parcel ${names[0]}, which is` : `parcels ${names.join(", ")}, which are`} not in the transaction; LAIS is not told about ${names.length === 1 ? "it" : "them"}.`);
  }
  const noArea = [...parents, ...proposed].filter((p) => p.area_sqm === null).length;
  if (noArea) warnings.push(`${noArea} parcel(s) have no area in GIS; LAIS will receive area_sqm: null for them.`);
  const noPlace = proposed.filter((p) => LOCATION.some((k) => p[k] === null)).length;
  if (noPlace) warnings.push(`${noPlace} new parcel(s) are missing part of their location (province to village).`);
  const withUpi = inPlace ? 0 : proposed.filter((p) => p.UPI).length;
  if (withUpi) warnings.push(`${withUpi} new parcel(s) already have a UPI. In this flow UPIs are created when the registrar approves.`);
  const noShape = proposed.filter((p) => !p.geometry).length;
  if (noShape) problems.push(`${noShape} new parcel(s) have no boundary.`);

  if (problems.length) return { payload: null, problems, warnings };
  const sum = (list: ParcelSummary[]) => round2(list.reduce((t, p) => t + (p.area_sqm ?? 0), 0));
  return {
    payload: {
      event_type: EDITING_DONE_EVENT,
      Transaction_ID: entry.Transaction_ID,
      Transaction_Type: type,
      version_name: entry.versionName,
      record_name: recordName,
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

/** What would be sent, without sending it: for the editor to check first. `editedBy` is the signed-in editor (empty for an API-key client). */
export async function previewEditingDone(transactionId: string, editedBy = ""): Promise<NotificationPreview> {
  const entry = await entryOrThrow(transactionId);
  const sent = reachedLais(entry.editingDone);
  if (entry.completion && sent) return asNotification(sent.payload as unknown as EditingDoneBody, sent, []);

  const preview = await withServiceToken((token) => buildFor(token, entry, editedBy));
  if (!preview.payload) throw new EditingDoneError(422, "not_ready", preview.problems.join(" "), { problems: preview.problems, warnings: preview.warnings });
  const sentPayload = sent?.payload as unknown as EditingDoneBody | undefined;
  if (sent && sentPayload && workFingerprint(sentPayload) === workFingerprint(preview.payload)) return asNotification(sentPayload, sent, preview.warnings);
  return asNotification(preview.payload, null, preview.warnings);
}

/** A notification LAIS has, or will get by the retries (not one it refused or that gave up). */
const reachedLais = (d: EditingDone | undefined) => (d && d.status !== "refused" && d.status !== "failed" ? d : null);

function asNotification(body: EditingDoneBody, sent: EditingDone | null, warnings: string[]): NotificationPreview {
  const { event_type, ...work } = body;
  return { event_id: sent?.eventId ?? null, event_type, sent_at: sent ? (sent.deliveredAt ?? sent.lastAttemptAt) : null, ...work, warnings };
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


/**
 * The editor says the work is done: check it, record the notification, and make the first attempt.
 * A notification LAIS has received is never sent twice; one still being sent is not duplicated.
 */
export async function requestEditingDone(
  token: string,
  transactionId: string,
  editedBy: string,
  via: "button" | "field" = "button",
): Promise<{ view: EditingDoneView; warnings: string[] }> {
  if (!webhookConfigured()) throw new EditingDoneError(503, "not_configured", "The LAIS endpoint is not configured on this server (LAIS_WEBHOOK_URL and LAIS_WEBHOOK_KEY).");
  const queued = await withLock(transactionId.toLowerCase(), async () => {
    const entry = await entryOrThrow(transactionId);
    const previous = entry.editingDone;
    if (entry.approval?.status === "approved") {
      throw new EditingDoneError(409, "already_approved", `The registrar approved this work on ${entry.approval.approvedAt} and GIS posted it.`, viewOf(previous));
    }
    if (previous && (previous.status === "sending" || previous.status === "retrying")) return { warnings: [], resend: false };

    const preview = await buildFor(token, entry, editedBy);
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
    logger.info({ transactionId, eventId: editingDone.eventId, record: preview.payload.record_name, parcels: preview.payload.proposed_parcels.length, via }, "LAIS editing done: notification queued");
    // The status is also kept in GIS: editing_status = "Edits done" on the new parcels, in the version.
    const marked = await markEditsDone(token, entry, preview.payload).catch((error: Error) => {
      logger.warn({ transactionId, err: error.message }, 'LAIS editing done: could not write editing_status = "Edits done" in the version');
      return `GIS could not write editing_status = "${EDITS_DONE}" on the new parcels (${error.message}); LAIS is notified anyway.`;
    });
    return { warnings: typeof marked === "string" ? [...preview.warnings, marked] : preview.warnings, resend: true };
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
      method: config.LAIS_WEBHOOK_METHOD,
      headers: { "Content-Type": "application/json", "X-API-Key": config.LAIS_WEBHOOK_KEY, "X-GIS-Event-Id": eventId, "X-GIS-Event-Type": EDITING_DONE_EVENT },
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
    const body = JSON.stringify({ event_id: d.eventId, event_type: EDITING_DONE_EVENT, sent_at: at, ...Object.fromEntries(Object.entries(d.payload).filter(([k]) => k !== "event_type")) });
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


/** The Plot field's coded value (domain of editing_status). */
export const EDITS_DONE = "Edits done";


const editingStatusField = (schema: LayerSchema) => plotField(schema, "editing_status");

/** Write editing_status = "Edits done" on the new parcels of this work, inside the transaction's version. */
async function markEditsDone(token: string, entry: LedgerEntry, payload: EditingDoneBody): Promise<void> {
  const schema = await layerSchema(token);
  const field = editingStatusField(schema);
  if (!field || !schema.globalIdField || !entry.versionName || !payload.proposed_parcels.length) return;
  const version = (await ownedVersions(token)).get(shortVersionName(entry.versionName).toLowerCase());
  if (!version) return;
  const oid = schema.objectIdField;
  const refs = payload.proposed_parcels.map((p) => p.parcel_ref);
  const body = await arcgisPost(
    `${config.lais.plotLayerUrl}/query`,
    { where: `${schema.globalIdField} IN (${sqlList(refs)})`, outFields: [oid, field].join(","), returnGeometry: "false", gdbVersion: version.name },
    token,
  );
  const todo = ((body.features ?? []) as Array<{ attributes: Attributes }>).map((f) => f.attributes).filter((a) => a[field] !== EDITS_DONE);
  if (!todo.length) return;
  await editInVersion(token, version, todo.map((a) => ({ [oid]: a[oid], [field]: EDITS_DONE })));
}

/** Last problem logged per transaction by the scan, so an unfinished version is reported once, not every few minutes. */
const scanNotes = new Map<string, string>();

/**
 * Editors who finish in ArcGIS Pro (or any attribute form) set editing_status = "Edits done" on the new
 * parcels instead of pressing the web-app button. For each open LAIS transaction, look in its version for
 * such parcels (the new ones, or for a boundary correction the transaction's own) and send "Editing done"
 * like the button would. Never twice for the same work: LAIS already has it, or it was rejected/refused and the editor has not changed it since.
 */
export async function scanEditsDoneField(token: string): Promise<string[]> {
  const sent: string[] = [];
  if (!editingDoneEnabled() || !webhookConfigured()) return sent;
  const schema = await layerSchema(token);
  const field = editingStatusField(schema);
  if (!field) return sent;
  const f = schema.fields;
  const owned = await ownedVersions(token);

  for (const entry of await allEntries()) {
    if (!entry.versionName || entry.completion || entry.approval) continue;
    const previous = entry.editingDone;
    if (previous && (previous.status === "sending" || previous.status === "retrying")) continue;
    const rejected = !!previous && (entry.rejections ?? []).some((x) => x.eventId === previous.eventId);
    if (previous?.status === "delivered" && !rejected) continue; // LAIS has it and has not decided against it
    const version = owned.get(shortVersionName(entry.versionName).toLowerCase());
    if (!version) continue;
    try {
      // The work's parcels (new in the version, or for a correction the transaction's own) marked "Edits done".
      const work = await workInVersion(token, schema, version, entry);
      const ofWork = unique([...work.newIds, ...(entry.Transaction_Type === "CorrectBoundaries" ? entry.objectIds : [])]);
      if (!ofWork.length) continue;
      const lastEditor = Object.keys(schema.fieldTypes).find((x) => x.toLowerCase() === "last_edited_user");
      const marked = await arcgisPost(
        `${config.lais.plotLayerUrl}/query`,
        { where: `${schema.objectIdField} IN (${ofWork.join(",")}) AND ${f.retiredBy} IS NULL AND ${field} = ${sql(EDITS_DONE)}`, outFields: [schema.objectIdField, ...(lastEditor ? [lastEditor] : [])].join(","), returnGeometry: "false", gdbVersion: version.name },
        token,
      );
      const rows = ((marked.features ?? []) as Array<{ attributes: Attributes }>).map((x) => x.attributes);
      if (!rows.length) continue;
      const editedBy = (lastEditor && rows.map((a) => a[lastEditor]).find((v): v is string => typeof v === "string" && !!v)) || "ArcGIS (editing_status)";

      // Rejected or refused before: only revised work is sent again.
      if (previous) {
        const now = await buildFor(token, entry, editedBy);
        if (!now.payload || workFingerprint(now.payload) === workFingerprint(previous.payload as unknown as EditingDoneBody)) continue;
      }
      const { view } = await requestEditingDone(token, entry.Transaction_ID, editedBy, "field");
      scanNotes.delete(entry.Transaction_ID);
      sent.push(entry.Transaction_ID);
      logger.info({ transactionId: entry.Transaction_ID, editedBy, status: view.status, eventId: view.event_id }, 'LAIS editing done: sent because the parcels are marked editing_status = "Edits done"');
      void writeAudit({
        username: editedBy,
        appRole: "EDITOR",
        action: "lais.editing-done",
        target: entry.Transaction_ID,
        outcome: view.status === "refused" || view.status === "failed" ? "failure" : "success",
        details: { via: "editing_status field", event_id: view.event_id, status: view.status, record: view.record_name, parcels: view.parcels },
      }).catch(() => undefined);
    } catch (error) {
      const note = (error as Error).message;
      if (scanNotes.get(entry.Transaction_ID) !== note) {
        scanNotes.set(entry.Transaction_ID, note);
        logger.warn({ transactionId: entry.Transaction_ID, problem: note }, 'LAIS editing done: parcels are marked "Edits done" but the work cannot be sent yet');
      }
    }
  }
  return sent;
}

/** Retry loop (and the "Edits done" field scan) for the running server. Does nothing while the feature is off. */
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

  let scanning = false;
  const scan = () => {
    if (scanning) return;
    scanning = true;
    void withServiceToken((token) => scanEditsDoneField(token))
      .catch((error) => logger.error({ err: (error as Error).message }, 'LAIS editing done: the "Edits done" scan failed'))
      .finally(() => (scanning = false));
  };
  const scanTimer = config.LAIS_EDITS_DONE_SCAN_MS > 0 ? setInterval(scan, config.LAIS_EDITS_DONE_SCAN_MS) : null;
  scanTimer?.unref();
  return () => {
    clearInterval(timer);
    if (scanTimer) clearInterval(scanTimer);
  };
}
