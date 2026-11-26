import { apiFetch } from "../api/apiClient";

/** The GIS → LAIS "editing done" notification (server: /api/lais-editing). */

export type EditingDoneStatus = "sending" | "retrying" | "delivered" | "refused" | "failed";

export interface EditingDoneView {
  status: EditingDoneStatus;
  event_id: string;
  requested_by: string;
  requested_at: string;
  attempts: number;
  last_attempt_at: string | null;
  next_attempt_at: string | null;
  last_result: string | null;
  last_message: string | null;
  delivered_at: string | null;
  record_name: string | null;
  parcels: number;
}

export interface LaisTransactionSummary {
  Transaction_ID: string;
  Transaction_Type: string;
  UPIs: string[];
  version_name: string;
  posted: boolean;
  editing_done: EditingDoneView | null;
}

export interface ParcelInfo {
  UPI: string | null;
  area_sqm: number | null;
  province: string | null;
  district: string | null;
  sector: string | null;
  cell: string | null;
  village: string | null;
}

export interface EditingDonePreview {
  payload: {
    Transaction_ID: string;
    Transaction_Type: string;
    version_name: string;
    record_name: string;
    edited_by: string;
    parent_parcels: ParcelInfo[];
    proposed_parcels: Array<ParcelInfo & { parcel_ref: string }>;
    totals: { parent_area_sqm: number; proposed_area_sqm: number };
  } | null;
  problems: string[];
  warnings: string[];
}

export const listLaisTransactions = () =>
  apiFetch<{ enabled: boolean; configured: boolean; transactions: LaisTransactionSummary[] }>("/lais-editing/transactions");

export const previewEditingDone = (transactionId: string, recordName?: string) =>
  apiFetch<EditingDonePreview>(`/lais-editing/transactions/${encodeURIComponent(transactionId)}/preview${recordName ? `?recordName=${encodeURIComponent(recordName)}` : ""}`);

export const sendEditingDone = (transactionId: string, recordName?: string) =>
  apiFetch<{ editing_done: EditingDoneView; warnings: string[] }>(`/lais-editing/transactions/${encodeURIComponent(transactionId)}/editing-done`, {
    method: "POST",
    json: recordName ? { recordName } : {},
  });

/** How a notification's state reads to an editor. */
export function describeStatus(d: EditingDoneView | null): { label: string; tone: "ok" | "wait" | "bad" | "none" } {
  if (!d) return { label: "Not sent to LAIS", tone: "none" };
  switch (d.status) {
    case "delivered":
      return { label: "Sent to LAIS · waiting for approval", tone: "ok" };
    case "sending":
      return { label: "Sending to LAIS…", tone: "wait" };
    case "retrying":
      return { label: `LAIS not reached (${d.last_result ?? "error"}) · retrying`, tone: "wait" };
    case "refused":
      return { label: `LAIS refused it${d.last_message ? `: ${d.last_message}` : ` (${d.last_result})`}`, tone: "bad" };
    case "failed":
      return { label: "Not delivered after 24 hours", tone: "bad" };
  }
}
