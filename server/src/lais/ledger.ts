import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "../config/env.js";

/**
 * Server-side ledger of accepted LAIS transactions (server/data/lais/transactions.json).
 *
 * The LAIS ArcGIS account may only read GIS and create versions (no editing licence), so the
 * transaction cannot be stored on the Plot. The ledger keeps the accepted payload so that
 * retries are idempotent, conflicting reuse of a Transaction_ID is rejected, and LAIS can
 * query the status. One JSON file, replaced atomically; single API instance assumed.
 */
export interface LedgerEntry {
  /** The parcels of the transaction (2+ for a Merge; none for a CreatePlot without a parent). */
  UPIs: string[];
  Transaction_ID: string;
  Transaction_Type: string;
  Transaction_Status?: string;
  /** ISO 8601 as received */
  Transaction_Date: string;
  /** Object ids of the parcels, in the order of UPIs. */
  objectIds: number[];
  versionName: string | null;
  /** True once the fields were also written on the Plot inside the version (attributes mode). */
  attributesWritten: boolean;
  /**
   * Set once the API finds the transaction's change in sde.DEFAULT (posted). Which parcels the change
   * produced and retired is fixed from then on; their current attributes are re-read on every report.
   */
  completion?: Completion;
  /** What LAIS was last told (without updated_at). `updatedAt` moves only when this changes. */
  reported?: Record<string, unknown>;
  /** The "editing done" notification to LAIS, once a GIS editor has finished the work. */
  editingDone?: EditingDone;
  createdAt: string;
  /** Last change of the entry, including of what LAIS sees (stage, result parcels, warnings). */
  updatedAt: string;
}

/**
 * The GIS → LAIS "editing done" notification. Kept here (not only in memory) so a notification that
 * LAIS has not received yet is retried after a restart, always with the same event_id.
 *   sending   accepted from the editor, first attempt not finished
 *   retrying  LAIS did not answer or answered 408/429/5xx; next attempt at nextAttemptAt
 *   delivered LAIS answered 2xx
 *   refused   LAIS answered another 4xx (the editor sees LAIS's message and can send again)
 *   failed    no 2xx within 24 hours of the first attempt (the editor can send again)
 */
export interface EditingDone {
  eventId: string;
  status: "sending" | "retrying" | "delivered" | "refused" | "failed";
  /** The notification body without sent_at (set on each attempt). */
  payload: Record<string, unknown>;
  requestedBy: string;
  requestedAt: string;
  attempts: number;
  firstAttemptAt: string | null;
  lastAttemptAt: string | null;
  nextAttemptAt: string | null;
  /** e.g. "HTTP 503", "timeout", "no connection". */
  lastResult: string | null;
  /** LAIS's explanation, when it gave one. */
  lastMessage: string | null;
  deliveredAt: string | null;
}

export interface Completion {
  detectedAt: string;
  /** How the change was found: a record named for the version, the parcels' retirement, or the posted fields. */
  via: "record" | "lineage" | "fields";
  /** Global ids of the Parcel Fabric records of the change. */
  recordIds: string[];
  /** Plots the change retired (historic now). */
  retiredObjectIds: number[];
  /** Plots the change produced or edited in place: the parcels LAIS now has. */
  parcelObjectIds: number[];
}

const file = () => path.resolve(config.LAIS_DATA_DIR, "transactions.json");
let entries: Map<string, LedgerEntry> | null = null;
let writing: Promise<void> = Promise.resolve();

const key = (transactionId: string) => transactionId.toLowerCase();

async function load(): Promise<Map<string, LedgerEntry>> {
  if (entries) return entries;
  try {
    const list = JSON.parse(await readFile(file(), "utf8")) as Array<LedgerEntry & { UPI?: string; objectId?: number }>;
    // Entries written before multi-parcel support held one UPI and one objectId.
    const normalised = list.map(({ UPI, objectId, ...e }) => ({
      ...e,
      UPIs: e.UPIs ?? (UPI ? [UPI] : []),
      objectIds: e.objectIds ?? (typeof objectId === "number" ? [objectId] : []),
    }));
    entries = new Map(normalised.map((e) => [key(e.Transaction_ID), e]));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; // never silently drop a corrupt ledger
    entries = new Map();
  }
  return entries;
}

async function persist(): Promise<void> {
  const snapshot = JSON.stringify([...(await load()).values()], null, 1);
  writing = writing.then(async () => {
    await mkdir(path.dirname(file()), { recursive: true });
    const tmp = `${file()}.${process.pid}.tmp`;
    await writeFile(tmp, snapshot, "utf8");
    await rename(tmp, file());
  });
  return writing;
}

export async function getEntry(transactionId: string): Promise<LedgerEntry | undefined> {
  return (await load()).get(key(transactionId));
}

export async function allEntries(): Promise<LedgerEntry[]> {
  return [...(await load()).values()];
}

/** `keepUpdatedAt`: store without marking the entry changed (bookkeeping LAIS cannot see). */
export async function putEntry(
  entry: Omit<LedgerEntry, "createdAt" | "updatedAt"> & Partial<Pick<LedgerEntry, "createdAt">>,
  options: { keepUpdatedAt?: boolean } = {},
): Promise<LedgerEntry> {
  const map = await load();
  const now = new Date().toISOString();
  const previous = map.get(key(entry.Transaction_ID));
  const full: LedgerEntry = {
    ...entry,
    createdAt: previous?.createdAt ?? entry.createdAt ?? now,
    updatedAt: options.keepUpdatedAt && previous ? previous.updatedAt : now,
  };
  map.set(key(entry.Transaction_ID), full);
  await persist();
  return full;
}

/** Test hook: forget everything, including the file. */
export async function clearLedgerForTests(): Promise<void> {
  await writing.catch(() => undefined);
  entries = new Map();
  await rm(file(), { force: true });
}
