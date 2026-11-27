/** An accepted LAIS transaction, kept in data/lais/transactions.json so retries stay idempotent. */
export interface LedgerEntry {
  UPIs: string[];
  Transaction_ID: string;
  Transaction_Type: string;
  Transaction_Status?: string;
  Transaction_Date: string;
  /** Plot object ids, in the order of UPIs. */
  objectIds: number[];
  versionName: string | null;
  attributesWritten: boolean;
  completion?: Completion;
  /** What LAIS was last told (without updated_at); `updatedAt` moves only when this changes. */
  reported?: Record<string, unknown>;
  editingDone?: EditingDone;
  approval?: Approval;
  rejections?: Rejection[];
  createdAt: string;
  updatedAt: string;
}

export type EditingDoneStatus = "sending" | "retrying" | "delivered" | "refused" | "failed";

export interface EditingDone {
  eventId: string;
  status: EditingDoneStatus;
  /** The notification body without sent_at. */
  payload: Record<string, unknown>;
  requestedBy: string;
  requestedAt: string;
  attempts: number;
  firstAttemptAt: string | null;
  lastAttemptAt: string | null;
  nextAttemptAt: string | null;
  lastResult: string | null;
  lastMessage: string | null;
  deliveredAt: string | null;
}

export interface Approval {
  eventId: string;
  status: "approving" | "approved";
  approvedBy: string;
  requestedAt: string;
  approvedAt: string | null;
  cell: string | null;
  upis: Array<{ parcel_ref: string; UPI: string; assigned: boolean }>;
  attempts: number;
  lastError: string | null;
}

export interface Rejection {
  eventId: string;
  rejectedBy: string;
  reason: string;
  at: string;
}

export interface Completion {
  detectedAt: string;
  via: "record" | "lineage" | "fields";
  recordIds: string[];
  retiredObjectIds: number[];
  parcelObjectIds: number[];
}

export type NewLedgerEntry = Omit<LedgerEntry, "createdAt" | "updatedAt"> & Partial<Pick<LedgerEntry, "createdAt">>;
