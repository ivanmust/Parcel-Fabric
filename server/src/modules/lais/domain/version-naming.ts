import type { LaisSubmission, TransactionType } from "../models/transaction.model.js";

export const TYPE_CODES: Record<TransactionType, string> = {
  Subdivision: "SUBV",
  Merge: "MERG",
  CorrectBoundaries: "CORB",
  CreatePlot: "CRPL",
};

const MAX_VERSION_NAME = 62;

/**
 * `{TYPE}-{CASE_NUMBER}-{DATE}`, e.g. SUBV-CASE123-20261125. Deterministic, so a resubmission maps to
 * the same version.
 */
export function versionNameFor(input: Pick<LaisSubmission, "Transaction_ID" | "Transaction_Type" | "Transaction_Date">): string {
  const type = TYPE_CODES[input.Transaction_Type as TransactionType] ?? "LAIS";
  const date = input.Transaction_Date.slice(0, 10).replace(/-/g, "");
  const room = MAX_VERSION_NAME - type.length - date.length - 2;
  const caseNumber = input.Transaction_ID.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/-{2,}/g, "-").replace(/^-|-$/g, "").slice(0, room);
  return `${type}-${caseNumber}-${date}`;
}

/** "owner.SUBV-X-20261125" → "SUBV-X-20261125" */
export const shortVersionName = (fullName: string) => fullName.slice(fullName.lastIndexOf(".") + 1);
