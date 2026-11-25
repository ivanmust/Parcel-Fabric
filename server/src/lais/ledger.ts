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
  UPI: string;
  Transaction_ID: string;
  Transaction_Type: string;
  Transaction_Status?: string;
  /** ISO 8601 as received */
  Transaction_Date: string;
  objectId: number;
  versionName: string | null;
  /** True once the fields were also written on the Plot inside the version (attributes mode). */
  attributesWritten: boolean;
  createdAt: string;
  updatedAt: string;
}

const file = () => path.resolve(config.LAIS_DATA_DIR, "transactions.json");
let entries: Map<string, LedgerEntry> | null = null;
let writing: Promise<void> = Promise.resolve();

const key = (transactionId: string) => transactionId.toLowerCase();

async function load(): Promise<Map<string, LedgerEntry>> {
  if (entries) return entries;
  try {
    const list = JSON.parse(await readFile(file(), "utf8")) as LedgerEntry[];
    entries = new Map(list.map((e) => [key(e.Transaction_ID), e]));
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

export async function putEntry(entry: Omit<LedgerEntry, "createdAt" | "updatedAt"> & Partial<Pick<LedgerEntry, "createdAt">>): Promise<LedgerEntry> {
  const map = await load();
  const now = new Date().toISOString();
  const previous = map.get(key(entry.Transaction_ID));
  const full: LedgerEntry = { ...entry, createdAt: previous?.createdAt ?? entry.createdAt ?? now, updatedAt: now };
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
