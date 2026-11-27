import type { EditingDoneView } from "./editingDone";

export type AfterSaveOutcome =
  | { kind: "skipped" }
  | { kind: "sent"; transactionId: string; view: EditingDoneView; warnings: string[] }
  | { kind: "refused"; transactionId: string; code: string; message: string; problems: string[] }
  | { kind: "failed"; transactionId: string; message: string };

export interface AfterSaveNotice {
  kind: "success" | "info" | "warning";
  title: string;
  message: string;
}

/** Answers that only mean there is nothing (new) to send. */
const NOTHING_TO_SEND = new Set(["already_approved", "already_posted", "version_gone"]);

/** What the editor is told after the save; null when there is nothing worth saying. */
export function afterSaveNotice(outcome: AfterSaveOutcome): AfterSaveNotice | null {
  switch (outcome.kind) {
    case "skipped":
      return null;
    case "sent":
      return outcome.view.status === "delivered"
        ? { kind: "success", title: "Sent to LAIS", message: `${outcome.transactionId}: the saved work was sent to LAIS for the registrar's approval.` }
        : { kind: "warning", title: "Saved · LAIS not reached yet", message: `${outcome.transactionId}: GIS keeps trying to send it (${outcome.view.last_result ?? "no answer"}).` };
    case "refused":
      if (NOTHING_TO_SEND.has(outcome.code)) return null;
      if (outcome.code === "already_sent") return { kind: "info", title: "Saved · LAIS already has this work", message: outcome.message };
      return { kind: "info", title: "Saved · not sent to LAIS yet", message: outcome.problems[0] ?? outcome.message };
    case "failed":
      return { kind: "warning", title: "Saved, but Editing done failed", message: `${outcome.transactionId}: ${outcome.message}` };
  }
}
