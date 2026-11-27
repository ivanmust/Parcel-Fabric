export const TRANSACTION_TYPES = ["Subdivision", "Merge", "CorrectBoundaries", "CreatePlot"] as const;
export const TRANSACTION_STATUSES = ["New", "InProgress", "Approved", "Rejected"] as const;
export const STAGES = ["InReview", "Posted", "Closed"] as const;

export type TransactionType = (typeof TRANSACTION_TYPES)[number];
export type Stage = (typeof STAGES)[number];
export type Attributes = Record<string, unknown>;

export interface LaisSubmission {
  UPIs: string[];
  Transaction_ID: string;
  Transaction_Type: string;
  Transaction_Date: string;
  Transaction_Status?: string;
}

export interface FieldError {
  field: string;
  code: string;
  message: string;
  replacedBy?: string[];
  transactionId?: string;
}

export interface LaisParcel {
  UPI: string | null;
  current: boolean;
  area_sqm: number | null;
  province: string | null;
  district: string | null;
  sector: string | null;
  cell: string | null;
  village: string | null;
}

export interface LaisResult {
  parcels: LaisParcel[];
  retired_parcels: Array<{ UPI: string | null }>;
  records: Array<{ name: string | null; recorded_date: string | null }>;
  completed_at: string | null;
  detected_at: string;
}

export interface LaisWarning {
  code: "UPI_MISSING" | "NO_RESULT_PARCELS";
  message: string;
}

/** A transaction as LAIS sees it. `stage`: InReview (not in sde.DEFAULT yet), Posted, or Closed (version removed unposted). */
export interface LaisRecord {
  UPI: string | null;
  UPIs: string[];
  Transaction_ID: string | null;
  Transaction_Type: string | null;
  Transaction_Status: string | null;
  Transaction_Date: string | null;
  case: string | null;
  validation_message: string | null;
  version_name: string | null;
  version_status: string | null;
  stage: Stage;
  result: LaisResult | null;
  warnings: LaisWarning[];
  updated_at: string | null;
}

export type SubmitOutcome =
  | { kind: "created"; record: LaisRecord; plotFields: "written" | "version-only" | "no-parcel" }
  | { kind: "duplicate"; record: LaisRecord }
  | { kind: "conflict"; errors: FieldError[] }
  | { kind: "busy"; errors: FieldError[] }
  | { kind: "invalid"; errors: FieldError[] };

export type StatusOutcome = { kind: "found"; record: LaisRecord } | { kind: "not_found" } | { kind: "conflict" };

export interface ListOptions {
  updatedSince?: number;
  stage?: Stage;
  limit: number;
}

export interface ListOutcome {
  transactions: LaisRecord[];
  has_more: boolean;
  next_updated_since: string;
}
