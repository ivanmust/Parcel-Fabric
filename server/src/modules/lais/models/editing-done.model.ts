import type { GeoJsonPolygon } from "../../../common/utils/geojson.js";
import type { EditingDoneStatus } from "./ledger-entry.model.js";

export const EDITING_DONE_EVENT = "editing.completed";

export interface ParcelSummary {
  UPI: string | null;
  area_sqm: number | null;
  province: string | null;
  district: string | null;
  sector: string | null;
  cell: string | null;
  village: string | null;
}

export interface ProposedParcel extends ParcelSummary {
  /** The Plot's global id; the approval answers each parcel's UPI by it. */
  parcel_ref: string;
  geometry: GeoJsonPolygon | null;
}

/** The notification LAIS receives, without event_id and sent_at. */
export interface EditingDoneBody {
  event_type: typeof EDITING_DONE_EVENT;
  Transaction_ID: string;
  Transaction_Type: string;
  version_name: string;
  record_name: string;
  edited_by: string;
  parent_parcels: ParcelSummary[];
  proposed_parcels: ProposedParcel[];
  totals: { parent_area_sqm: number; proposed_area_sqm: number };
}

/** The notification in the format LAIS receives it; event_id and sent_at are null until it is sent. */
export type EditingDoneNotification = { event_id: string | null; event_type: typeof EDITING_DONE_EVENT; sent_at: string | null } & Omit<EditingDoneBody, "event_type">;

export type NotificationPreview = EditingDoneNotification & { warnings: string[] };

export interface Preview {
  /** null while there are problems to fix. */
  payload: EditingDoneBody | null;
  problems: string[];
  warnings: string[];
}

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

/** A refusal the editor can act on. */
export class EditingDoneError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "EditingDoneError";
  }
}
