import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "../../../config/env.js";
import type { LedgerEntry, NewLedgerEntry } from "../models/ledger-entry.model.js";

const ledgerFile = () => path.resolve(config.LAIS_DATA_DIR, "transactions.json");
const keyOf = (transactionId: string) => transactionId.toLowerCase();

let entries: Map<string, LedgerEntry> | null = null;
let writing: Promise<void> = Promise.resolve();

type StoredEntry = LedgerEntry & { UPI?: string; objectId?: number };

/** Older entries held a single UPI and objectId. */
function upgrade({ UPI, objectId, ...entry }: StoredEntry): LedgerEntry {
  return {
    ...entry,
    UPIs: entry.UPIs ?? (UPI ? [UPI] : []),
    objectIds: entry.objectIds ?? (typeof objectId === "number" ? [objectId] : []),
  };
}

async function load(): Promise<Map<string, LedgerEntry>> {
  if (entries) return entries;
  try {
    const stored = JSON.parse(await readFile(ledgerFile(), "utf8")) as StoredEntry[];
    entries = new Map(stored.map(upgrade).map((e) => [keyOf(e.Transaction_ID), e]));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    entries = new Map();
  }
  return entries;
}

async function persist(): Promise<void> {
  const snapshot = JSON.stringify([...(await load()).values()], null, 1);
  writing = writing.then(async () => {
    const file = ledgerFile();
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, snapshot, "utf8");
    await rename(tmp, file);
  });
  return writing;
}

export async function getEntry(transactionId: string): Promise<LedgerEntry | undefined> {
  return (await load()).get(keyOf(transactionId));
}

export async function allEntries(): Promise<LedgerEntry[]> {
  return [...(await load()).values()];
}

/** `keepUpdatedAt`: store bookkeeping that LAIS cannot see without marking the entry changed. */
export async function putEntry(entry: NewLedgerEntry, options: { keepUpdatedAt?: boolean } = {}): Promise<LedgerEntry> {
  const map = await load();
  const now = new Date().toISOString();
  const previous = map.get(keyOf(entry.Transaction_ID));
  const saved: LedgerEntry = {
    ...entry,
    createdAt: previous?.createdAt ?? entry.createdAt ?? now,
    updatedAt: options.keepUpdatedAt && previous ? previous.updatedAt : now,
  };
  map.set(keyOf(entry.Transaction_ID), saved);
  await persist();
  return saved;
}

export async function clearLedgerForTests(): Promise<void> {
  await writing.catch(() => undefined);
  entries = new Map();
  await rm(ledgerFile(), { force: true });
}
