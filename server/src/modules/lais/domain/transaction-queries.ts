import { withLock } from "../../../common/utils/lock.js";
import { allEntries, getEntry } from "../repositories/ledger.repository.js";
import { layerSchema } from "../repositories/plot-layer.repository.js";
import { findVersion, ownedVersions, type VersionRef } from "../repositories/version.repository.js";
import type { LaisRecord, ListOptions, ListOutcome, StatusOutcome } from "../models/transaction.model.js";
import { findPosted, toRecord } from "./transaction-records.js";
import { describeEntry } from "./transaction-progress.js";
import { shortVersionName } from "./version-naming.js";

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

/** All transactions, oldest change first. Settled ones (Posted without warnings) come from the ledger; the rest are checked in GIS. */
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
