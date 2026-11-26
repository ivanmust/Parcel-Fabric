import { randomUUID } from "node:crypto";
import { config } from "../config/env.js";
import { logger } from "../logging/logger.js";
import { writeAudit } from "../audit/auditLog.js";
import { arcgisPost, ArcGisError, type ArcGisJson } from "./arcgisClient.js";
import { allEntries, getEntry, putEntry, type Approval, type LedgerEntry, type Rejection } from "./ledger.js";
import { asConfigurationError, layerSchema, ownedVersions, shortVersionName, sql, sqlList, withLock, type Attributes, type LayerSchema } from "./laisService.js";
import { buildFor, EditingDoneError, workFingerprint as fingerprint, type EditingDoneBody } from "./editingDone.js";

/**
 * The registrar's decision on a transaction whose work GIS sent with "Editing done" (LAIS → GIS).
 *
 * Approve: GIS gives every new parcel its UPI inside the transaction's version, then reconciles and
 * posts the version to sde.DEFAULT, and answers with the UPIs keyed by parcel_ref. LAIS approves one
 * editing-done event (event_id): if the editor changed the work after sending it, nothing is posted.
 * A failed attempt (version in use, conflict, GIS down) can be repeated; it reuses the same UPIs.
 *
 * Reject: recorded with the registrar's reason; the editor revises the work in the same version and
 * sends "Editing done" again (a new event_id). Nothing in GIS changes.
 *
 * UPI rule (the same as the web editor's Assign UPIs): the cell is the parents' cell (LAIS may name
 * one when the parents are in several cells, or for a new plot); the numbers continue after the
 * highest used in that cell by any parcel, current or historic, so a retired UPI is never reused.
 * Approvals in the same cell run one at a time.
 */

const UPI_PATTERN = /^\d\/\d{2}\/\d{2}\/\d{2}\/\d+$/;
export const CELL_PATTERN = /^\d\/\d{2}\/\d{2}\/\d{2}$/;
const prefixOf = (upi: string) => upi.trim().split("/").slice(0, 4).join("/");
const numberOf = (upi: string) => Number(upi.trim().split("/").pop());
const PAGE = 2000;
const MAX_PAGES = 50;
const NEW_UPIS = new Set(["Subdivision", "Merge", "CreatePlot"]);
const LOCATION = ["province", "district", "sector", "cell", "village"] as const;
const unique = <T>(values: T[]) => [...new Set(values)];

/** A refusal LAIS can act on; the route answers it in the LAIS shape. */
export class DecisionError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly data?: unknown,
  ) {
    super(message);
    this.name = "DecisionError";
  }
}

export interface ApprovalView {
  event_id: string;
  status: Approval["status"];
  approved_by: string;
  approved_at: string | null;
  cell: string | null;
  upis: Array<{ parcel_ref: string; UPI: string }>;
}
export const approvalView = (a: Approval): ApprovalView => ({
  event_id: a.eventId,
  status: a.status,
  approved_by: a.approvedBy,
  approved_at: a.approvedAt,
  cell: a.cell,
  upis: a.upis.map(({ parcel_ref, UPI }) => ({ parcel_ref, UPI })),
});

export interface RejectionView {
  event_id: string;
  rejected_by: string;
  rejected_at: string;
  reason: string;
}
export const rejectionView = (r: Rejection): RejectionView => ({ event_id: r.eventId, rejected_by: r.rejectedBy, rejected_at: r.at, reason: r.reason });

/** The editing-done event a decision is about, or why there is none to decide on. */
function decidable(entry: LedgerEntry | undefined, transactionId: string, eventId: string) {
  if (!entry) throw new DecisionError(404, "NOT_FOUND", `No LAIS transaction ${transactionId} is recorded in GIS.`);
  if (entry.approval?.status === "approved") {
    throw new DecisionError(409, "ALREADY_APPROVED", `This transaction was already approved (${entry.approval.approvedAt}) and posted; nothing was changed. Its UPIs are in data.`, { approval: approvalView(entry.approval) });
  }
  const done = entry.editingDone;
  if (!done || done.status !== "delivered") {
    throw new DecisionError(409, "NOT_SUBMITTED", "GIS has not sent this transaction's work for approval yet (Editing done). Wait for the editing-done notification.");
  }
  if (eventId.toLowerCase() !== done.eventId.toLowerCase()) {
    throw new DecisionError(409, "EVENT_MISMATCH", `event_id is not the latest work GIS sent for this transaction. Decide on event ${done.eventId}.`, { latest_event_id: done.eventId });
  }
  const rejected = (entry.rejections ?? []).find((r) => r.eventId === done.eventId);
  if (rejected) {
    throw new DecisionError(409, "ALREADY_REJECTED", `This work was already rejected (${rejected.at}). The GIS editor will send revised work with a new event_id.`, { rejection: rejectionView(rejected) });
  }
  return done;
}

// ---------------------------------------------------------------- reject

export async function rejectTransaction(transactionId: string, input: { eventId: string; rejectedBy: string; reason: string }): Promise<RejectionView> {
  return withLock(transactionId.toLowerCase(), async () => {
    const entry = await getEntry(transactionId);
    const done = decidable(entry, transactionId, input.eventId);
    if (entry!.approval) {
      throw new DecisionError(409, "APPROVAL_IN_PROGRESS", "This work is being approved (GIS is posting it); it can no longer be rejected.", { approval: approvalView(entry!.approval) });
    }
    const rejection: Rejection = { eventId: done.eventId, rejectedBy: input.rejectedBy, reason: input.reason, at: new Date().toISOString() };
    // Bookkeeping LAIS already knows (it decided): what GET /transactions reports does not change.
    await putEntry({ ...entry!, rejections: [...(entry!.rejections ?? []), rejection] }, { keepUpdatedAt: true });
    logger.info({ transactionId, eventId: done.eventId, by: input.rejectedBy }, "LAIS rejected the editing work");
    return rejectionView(rejection);
  });
}

// ---------------------------------------------------------------- approve

async function query(token: string, where: string, outFields: string[], gdbVersion?: string, offset = 0): Promise<Attributes[]> {
  const body = await arcgisPost(
    `${config.lais.plotLayerUrl}/query`,
    { where, outFields: unique(outFields).join(","), returnGeometry: "false", resultOffset: String(offset), resultRecordCount: String(PAGE), ...(gdbVersion ? { gdbVersion } : {}) },
    token,
  );
  return ((body.features ?? []) as Array<{ attributes: Attributes }>).map((f) => f.attributes);
}

/**
 * The highest parcel number taken in a cell: used by any parcel (current or historic) in sde.DEFAULT now
 * or in the version, or reserved by another approval that has not finished (a retry reuses its UPIs).
 * DEFAULT is read as well as the version because a version sees DEFAULT only as of its last reconcile:
 * UPIs posted since then are invisible inside it.
 */
async function highestInCell(token: string, schema: LayerSchema, cell: string, gdbVersion: string, transactionId: string): Promise<number> {
  const [inDefault, inVersion] = await Promise.all([highestInView(token, schema, cell), highestInView(token, schema, cell, gdbVersion)]);
  let reserved = 0;
  for (const e of await allEntries()) {
    if (e.Transaction_ID.toLowerCase() === transactionId.toLowerCase() || e.approval?.status !== "approving") continue;
    for (const u of e.approval.upis) if (UPI_PATTERN.test(u.UPI) && prefixOf(u.UPI) === cell) reserved = Math.max(reserved, numberOf(u.UPI));
  }
  return Math.max(inDefault, inVersion, reserved);
}

/**
 * The highest parcel number in a cell as one view (DEFAULT, or a version) sees it. Reads every page in
 * a stable order, whatever page size the service allows, and checks the rows read against the cell's
 * count: numbering from a partial read could hand out a UPI that already exists.
 */
async function highestInView(token: string, schema: LayerSchema, cell: string, gdbVersion?: string): Promise<number> {
  const upi = schema.fields.upi;
  const where = `${upi} LIKE ${sql(`${cell}/%`)}`;
  const view: Record<string, string> = gdbVersion ? { gdbVersion } : {};
  const counted = await arcgisPost(`${config.lais.plotLayerUrl}/query`, { where, returnCountOnly: "true", ...view }, token);
  const expected = Number(counted.count);
  if (!Number.isInteger(expected)) throw new ArcGisError(`ArcGIS did not count the parcels of cell ${cell}`);
  let highest = 0;
  let read = 0;
  for (let page = 0; page < MAX_PAGES && read < expected; page++) {
    const body = await arcgisPost(
      `${config.lais.plotLayerUrl}/query`,
      { where, outFields: upi, returnGeometry: "false", orderByFields: schema.objectIdField, resultOffset: String(read), resultRecordCount: String(PAGE), ...view },
      token,
    );
    const rows = ((body.features ?? []) as Array<{ attributes: Attributes }>).map((f) => f.attributes);
    if (!rows.length) break;
    read += rows.length;
    for (const r of rows) {
      const value = String(r[upi] ?? "");
      if (UPI_PATTERN.test(value) && prefixOf(value) === cell) highest = Math.max(highest, numberOf(value));
    }
  }
  if (read < expected) {
    throw new DecisionError(409, "CELL_TOO_LARGE", `GIS could read only ${read} of the ${expected} parcels of cell ${cell}, so it cannot number new UPIs safely. Nothing was posted. Contact the GIS administrator.`);
  }
  return highest;
}

/** The cell for the new UPIs: the one LAIS named, else the parents' cell, else the one the parcels' cell name is used with. */
async function cellFor(token: string, schema: LayerSchema, payload: EditingDoneBody, chosen: string | undefined, version: string): Promise<string> {
  if (chosen) return chosen;
  const parents = unique(payload.parent_parcels.map((p) => p.UPI).filter((u): u is string => !!u && UPI_PATTERN.test(u)).map(prefixOf)).sort();
  if (parents.length === 1) return parents[0]!;
  if (parents.length > 1) {
    throw new DecisionError(409, "CELL_REQUIRED", `The parcels are in several cells (${parents.join(", ")}). Approve again with "cell" set to the one the new UPIs belong to.`, { cells: parents });
  }
  const cellField = schema.optional.cell?.[0];
  const names = unique(payload.proposed_parcels.map((p) => p.cell).filter((c): c is string => !!c));
  if (cellField && names.length === 1) {
    const upi = schema.fields.upi;
    const rows = await query(token, `UPPER(${cellField}) = ${sql(names[0]!.toUpperCase())} AND ${schema.fields.retiredBy} IS NULL`, [upi], version);
    const counts = new Map<string, number>();
    for (const r of rows) {
      const value = String(r[upi] ?? "");
      if (UPI_PATTERN.test(value)) counts.set(prefixOf(value), (counts.get(prefixOf(value)) ?? 0) + 1);
    }
    const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    if (best) return best;
  }
  throw new DecisionError(409, "CELL_REQUIRED", `GIS cannot tell which cell the new UPIs belong to. Approve again with "cell" (for example 1/02/13/02).`, { cells: [] });
}

function assertOk(body: ArcGisJson, what: string): void {
  if (body.success === false) throw new ArcGisError(`ArcGIS refused ${what}`);
}

/**
 * One exclusive session on the version: write the UPIs (if any), save, then reconcile with sde.DEFAULT
 * and post. Conflicts abort the reconcile, so nothing is posted.
 */
async function writeAndPost(token: string, version: { name: string; guid: string }, updates: Attributes[]): Promise<void> {
  const sessionId = `{${randomUUID().toUpperCase()}}`;
  const vms = `${config.lais.versionManagementUrl}/versions/${version.guid.replace(/[{}]/g, "")}`;
  let reading = false;
  let editing = false;
  try {
    assertOk(await arcgisPost(`${vms}/startReading`, { sessionId }, token), "startReading");
    reading = true;
    if (updates.length) {
      assertOk(await arcgisPost(`${vms}/startEditing`, { sessionId }, token), "startEditing");
      editing = true;
      const result = await arcgisPost(
        `${config.lais.plotLayerUrl}/applyEdits`,
        { gdbVersion: version.name, sessionID: sessionId, rollbackOnFailure: "true", updates: JSON.stringify(updates.map((attributes) => ({ attributes }))) },
        token,
      );
      const results = (result.updateResults ?? []) as Array<{ success?: boolean; error?: { description?: string } }>;
      const failed = results.find((r) => !r.success);
      if (results.length !== updates.length || failed) throw new ArcGisError(failed?.error?.description ?? "ArcGIS did not confirm the UPI updates");
      assertOk(await arcgisPost(`${vms}/stopEditing`, { sessionId, saveEdits: "true" }, token), "stopEditing");
      editing = false;
    }
    assertOk(await arcgisPost(`${vms}/startEditing`, { sessionId }, token), "startEditing");
    editing = true;
    const reconcile = await arcgisPost(`${vms}/reconcile`, { sessionId, abortIfConflicts: "true", conflictDetection: "byObject", withPost: "true", async: "false" }, token);
    if (reconcile.hasConflicts) {
      throw new DecisionError(409, "RECONCILE_CONFLICT", "The version conflicts with changes made in the official data since it was edited. Nothing was posted. The GIS editor must reconcile the version, resolve the conflicts and send Editing done again.");
    }
    if (reconcile.success === false || reconcile.didPost === false) throw new ArcGisError("ArcGIS did not post the version");
    assertOk(await arcgisPost(`${vms}/stopEditing`, { sessionId, saveEdits: "true" }, token), "stopEditing");
    editing = false;
  } catch (error) {
    if (editing) {
      await arcgisPost(`${vms}/stopEditing`, { sessionId, saveEdits: "false" }, token).catch((e) =>
        logger.error({ err: (e as Error).message, version: version.name }, "LAIS approval: could not discard edit session"),
      );
    }
    if (error instanceof DecisionError) throw error;
    if (error instanceof ArcGisError && /lock|in use|being edited|another (user|session)/i.test(error.message) && !/extension|licen/i.test(error.message)) {
      throw new DecisionError(409, "VERSION_IN_USE", "The version is open for editing in GIS, so it cannot be posted now. Nothing was posted. Try again in a few minutes.");
    }
    throw asConfigurationError(error);
  } finally {
    if (reading) {
      await arcgisPost(`${vms}/stopReading`, { sessionId }, token).catch((e) => logger.warn({ err: (e as Error).message, version: version.name }, "LAIS approval: could not release read lock"));
    }
  }
}

export async function approveTransaction(token: string, transactionId: string, input: { eventId: string; approvedBy: string; cell?: string }): Promise<ApprovalView> {
  return withLock(transactionId.toLowerCase(), async () => {
    const found = await getEntry(transactionId);
    const done = decidable(found, transactionId, input.eventId);
    const entry = found!;
    if (entry.completion && !entry.approval) {
      throw new DecisionError(409, "ALREADY_POSTED", "This transaction's change is already in the official data (posted in GIS without approval). Nothing was changed.");
    }
    const previous = entry.approval;
    if (previous && input.cell && previous.cell && input.cell !== previous.cell && previous.upis.some((u) => u.assigned)) {
      throw new DecisionError(409, "CELL_ALREADY_CHOSEN", `An earlier attempt already numbered the new UPIs in cell ${previous.cell}. Approve again without "cell" or with that cell.`, { approval: approvalView(previous) });
    }
    // An earlier attempt may have posted and then failed before recording it (crash, verification
    // read): if its new parcels are in sde.DEFAULT with the planned UPIs, the approval is complete.
    if (previous?.status === "approving" && previous.eventId === done.eventId && previous.upis.length && NEW_UPIS.has(entry.Transaction_Type)) {
      const schema = await layerSchema(token);
      if (await inDefaultWithUpis(token, schema, previous.upis)) {
        const approved: Approval = { ...previous, status: "approved", approvedAt: new Date().toISOString(), lastError: null };
        await putEntry({ ...entry, approval: approved });
        logger.warn({ transactionId, eventId: done.eventId }, "LAIS approval: an earlier attempt had already posted; recorded as approved");
        return approvalView(approved);
      }
    }
    if (entry.completion) throw new DecisionError(409, "ALREADY_POSTED", "This transaction's change is already in the official data. Nothing was changed.");
    if (!entry.versionName) throw new DecisionError(409, "VERSION_GONE", "GIS has no version for this transaction.");
    const version = (await ownedVersions(token)).get(shortVersionName(entry.versionName).toLowerCase());
    if (!version) throw new DecisionError(409, "VERSION_GONE", `The version ${entry.versionName} no longer exists in GIS; there is nothing to post.`);

    // The work must still be what LAIS reviewed.
    const sent = done.payload as unknown as EditingDoneBody;
    let now;
    try {
      now = await buildFor(token, entry, done.requestedBy, sent.record_name);
    } catch (error) {
      if (error instanceof EditingDoneError) throw new DecisionError(409, error.code.toUpperCase(), error.message);
      throw error;
    }
    if (!now.payload) throw new DecisionError(409, "NOT_READY", `The work in the version is no longer complete: ${now.problems.join(" ")} Nothing was posted.`, { problems: now.problems });
    if (fingerprint(now.payload) !== fingerprint(sent)) {
      throw new DecisionError(409, "CHANGED_SINCE_SUBMISSION", "The GIS editor changed the work after sending it, so it is not what was reviewed. Nothing was posted. Wait for the new editing-done notification and decide on that one.");
    }

    // UPIs: kept where a parcel already has a valid one of its own, else the next numbers in the cell.
    const schema = await layerSchema(token);
    const upi = schema.fields.upi;
    const gid = schema.globalIdField!;
    const oid = schema.objectIdField;
    const locationFields = LOCATION.map((k) => schema.optional[k]?.[0]).filter((f): f is string => !!f);
    const refs = now.payload.proposed_parcels.map((p) => p.parcel_ref);
    const rows = await query(token, `${gid} IN (${sqlList(refs)})`, [oid, gid, upi, ...locationFields], version.name);
    const byRef = new Map(rows.map((r) => [String(r[gid]).toUpperCase(), r]));
    const ordered = refs.map((ref) => ({ ref, row: byRef.get(ref.toUpperCase()) })).sort((a, b) => Number(a.row?.[oid] ?? 0) - Number(b.row?.[oid] ?? 0));
    if (ordered.some((p) => !p.row)) throw new DecisionError(409, "CHANGED_SINCE_SUBMISSION", "A parcel GIS sent is no longer in the version. Nothing was posted.");

    const planned = new Map((previous?.upis ?? []).map((u) => [u.parcel_ref.toUpperCase(), u]));
    const needsUpi = NEW_UPIS.has(entry.Transaction_Type);
    const own = ordered.map((p) => String(p.row![upi] ?? "").trim()).filter((u) => UPI_PATTERN.test(u));
    // A UPI the parcels already have, or an earlier attempt planned, is kept only if no other parcel
    // holds it, in sde.DEFAULT now or in the version.
    const candidates = unique([...own, ...[...planned.values()].map((u) => u.UPI)].filter((u) => UPI_PATTERN.test(u)));
    const takenWhere = `${upi} IN (${sqlList(candidates)}) AND ${gid} NOT IN (${sqlList(refs)})`;
    const taken = candidates.length
      ? new Set((await Promise.all([query(token, takenWhere, [upi]), query(token, takenWhere, [upi], version.name)])).flat().map((r) => String(r[upi])))
      : new Set<string>();
    const keepable = (value: string) => UPI_PATTERN.test(value) && !taken.has(value);
    const earlierOf = (ref: string) => {
      const earlier = planned.get(ref.toUpperCase());
      return earlier && keepable(earlier.UPI) ? earlier : undefined;
    };

    const decide = async (cell: string | null) => {
      const upis: Approval["upis"] = [];
      let next = cell ? await highestInCell(token, schema, cell, version.name, entry.Transaction_ID) : 0;
      for (const { ref, row } of ordered) {
        const current = String(row![upi] ?? "").trim();
        const earlier = earlierOf(ref);
        if (earlier) upis.push({ parcel_ref: ref, UPI: earlier.UPI, assigned: earlier.assigned });
        else if (!needsUpi || keepable(current)) upis.push({ parcel_ref: ref, UPI: current, assigned: false });
        else upis.push({ parcel_ref: ref, UPI: `${cell}/${++next}`, assigned: true });
      }
      return upis;
    };
    const missing = needsUpi && ordered.some(({ ref, row }) => !earlierOf(ref) && !keepable(String(row![upi] ?? "").trim()));
    const cell = missing ? (previous?.cell ?? (await cellFor(token, schema, now.payload, input.cell, version.name))) : (previous?.cell ?? null);

    const run = async () => {
      const upis = await decide(missing ? cell : null);
      const attempt: Approval = {
        eventId: done.eventId,
        status: "approving",
        approvedBy: input.approvedBy,
        requestedAt: previous?.requestedAt ?? new Date().toISOString(),
        approvedAt: null,
        cell,
        upis,
        attempts: (previous?.attempts ?? 0) + 1,
        lastError: null,
      };
      // Recorded before GIS is touched: a retry after a failure reuses exactly these UPIs.
      await putEntry({ ...entry, approval: attempt }, { keepUpdatedAt: true });

      // Location: kept where the parcel has it, else the parents' common value (as Assign UPIs does).
      const parentPlace = Object.fromEntries(
        LOCATION.map((k) => [k, mostCommon(sent.parent_parcels.map((p) => p[k]))]).filter((kv): kv is [string, string] => !!kv[1]),
      );
      const numberField = Object.keys(schema.fieldTypes).find((f) => f.toLowerCase() === "parcel_number");
      const updates: Attributes[] = [];
      for (const { ref, row } of ordered) {
        const target = upis.find((u) => u.parcel_ref === ref)!;
        const change: Attributes = {};
        if (String(row![upi] ?? "").trim() !== target.UPI) {
          change[upi] = target.UPI;
          if (numberField) change[numberField] = numberOf(target.UPI);
        }
        for (const k of LOCATION) {
          const field = schema.optional[k]?.[0];
          if (field && (row![field] === null || row![field] === undefined || String(row![field]).trim() === "") && parentPlace[k]) change[field] = parentPlace[k];
        }
        if (Object.keys(change).length) updates.push({ [oid]: row![oid], ...change });
      }

      try {
        await writeAndPost(token, version, updates);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await putEntry({ ...entry, approval: { ...attempt, lastError: message.slice(0, 500) } }, { keepUpdatedAt: true });
        throw error;
      }

      // Posted: every resulting parcel must now be current in sde.DEFAULT with its UPI.
      if (!(await inDefaultWithUpis(token, schema, upis))) {
        await putEntry({ ...entry, approval: { ...attempt, lastError: "Posted, but the new parcels are not all in sde.DEFAULT with their UPIs" } }, { keepUpdatedAt: true });
        throw new ArcGisError("The version was posted but the new parcels are not all in sde.DEFAULT with their UPIs");
      }
      const approved: Approval = { ...attempt, status: "approved", approvedAt: new Date().toISOString() };
      await putEntry({ ...entry, approval: approved });
      logger.info({ transactionId, eventId: done.eventId, cell, upis: upis.map((u) => u.UPI), by: input.approvedBy }, "LAIS approval: UPIs assigned and version posted");
      void writeAudit({
        username: "LAIS",
        appRole: "INTEGRATION",
        action: "lais.transaction.post",
        target: transactionId,
        outcome: "success",
        details: { event_id: done.eventId, approved_by: input.approvedBy, version: version.name, cell, UPIs: upis.map((u) => u.UPI) },
      }).catch(() => undefined);
      return approvalView(approved);
    };
    // Numbering and posting in one cell happen one approval at a time, so two never take the same number.
    return cell ? withLock(`upi-cell:${cell}`, run) : run();
  });
}

/** True when every parcel is current in sde.DEFAULT with the given UPI. */
async function inDefaultWithUpis(token: string, schema: LayerSchema, upis: Approval["upis"]): Promise<boolean> {
  const gid = schema.globalIdField!;
  const upi = schema.fields.upi;
  const rows = await query(token, `${gid} IN (${sqlList(upis.map((u) => u.parcel_ref))})`, [gid, upi, schema.fields.retiredBy]);
  return upis.every((u) => rows.some((r) => String(r[gid]).toUpperCase() === u.parcel_ref.toUpperCase() && String(r[upi] ?? "") === u.UPI && r[schema.fields.retiredBy] == null));
}

function mostCommon(values: Array<string | null>): string | null {
  const counts = new Map<string, number>();
  for (const v of values) if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}
