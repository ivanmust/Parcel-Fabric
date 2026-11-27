import { ApiError } from "../api/apiClient";
import { listLaisTransactions, sendEditingDone } from "./editingDone";
import type { AfterSaveOutcome } from "./editingDoneNotice";

/**
 * After a save on a LAIS transaction's version, send "Editing done" for that transaction. The server
 * refuses unfinished work (not_ready) and work LAIS already has (already_sent), so saving often is safe.
 */
export async function sendEditingDoneAfterSave(versionName: string): Promise<AfterSaveOutcome> {
  const { enabled, transactions } = await listLaisTransactions();
  const transaction = transactions.find((t) => t.version_name.toLowerCase() === versionName.toLowerCase());
  if (!enabled || !transaction || transaction.posted) return { kind: "skipped" };

  const transactionId = transaction.Transaction_ID;
  try {
    const result = await sendEditingDone(transactionId);
    return { kind: "sent", transactionId, view: result.editing_done, warnings: result.warnings };
  } catch (error) {
    if (!(error instanceof ApiError)) return { kind: "failed", transactionId, message: (error as Error).message };
    if (error.status < 400 || error.status >= 500) return { kind: "failed", transactionId, message: error.message };
    const problems = (error.details as { problems?: string[] } | undefined)?.problems ?? [];
    return { kind: "refused", transactionId, code: error.code, message: error.message, problems };
  }
}
