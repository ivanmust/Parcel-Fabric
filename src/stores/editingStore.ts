import { create } from "zustand";
import type { VersionIdentifier, VersionInfo } from "@arcgis/core/versionManagement/support/jsonTypes.js";

export type SessionState = "unavailable" | "reading" | "starting" | "editing" | "stopping";

export interface EditHistoryEntry {
  id: number;
  time: Date;
  /** "edit" = applyEdits result; others are session / version operations */
  kind: "edit" | "session" | "version" | "selection";
  layer?: string;
  action: string;
  adds?: number;
  updates?: number;
  deletes?: number;
  failures?: number;
  version: string;
  ok: boolean;
  detail?: string;
}

export interface ActiveRecord {
  objectId: number;
  globalId: string;
  name: string;
}

export interface SelectionSummary {
  layerKey: string;
  name: string;
  count: number;
}

/** Manual parcel split: drawing the line, then a valid preview (part areas in m²) or why the line can't be used. */
export type ManualSplitState = { phase: "drawing" } | { phase: "ready"; areas: number[] } | { phase: "invalid"; message: string };

export type SelectionMode = "new" | "add" | "remove" | "intersect";

interface EditingState {
  /** Branch versioning */
  defaultVersion: VersionIdentifier | null;
  current: VersionIdentifier | null;
  versions: VersionInfo[];
  versionsLoading: boolean;
  session: SessionState;
  /** Whether the user holds the ArcGIS Advanced Editing extension required to edit Parcel Fabric services. */
  advancedEditing: "unknown" | "yes" | "no" | "not-required";
  /** Edits applied since the last save/discard (server-confirmed only) */
  pendingEdits: number;
  canUndo: boolean;
  canRedo: boolean;
  /**
   * Parcel Fabric server operations (merge, divide, validate) run in this edit session. They are not
   * on the SDK undo stack, so undo is disabled after one; Discard still rolls the whole session back.
   */
  fabricOpsInSession: number;
  busy: string | null;
  activeRecord: ActiveRecord | null;
  history: EditHistoryEntry[];
  selection: SelectionSummary[];
  selectionMode: SelectionMode;
  versionDialogOpen: boolean;
  /** Selection dialogs */
  selectByAttributesOpen: boolean;
  selectByLocationOpen: boolean;
  /** Parcel Fabric dialogs */
  mergeParcelsOpen: boolean;
  divideParcelOpen: boolean;
  manualSplit: ManualSplitState | null;
  /** Parcels (object ids) to give UPIs; the dialog is open while this is non-empty. */
  assignUpiTargets: number[];
  /** The parcel(s) those come from (split or merge), whose cell the new UPIs use. */
  assignUpiFrom: number[];

  patch(p: Partial<EditingState>): void;
  addHistory(e: Omit<EditHistoryEntry, "id" | "time" | "version">): void;
  clearHistory(): void;
}

let seq = 1;

export const useEditing = create<EditingState>((set, get) => ({
  defaultVersion: null,
  current: null,
  versions: [],
  versionsLoading: false,
  session: "unavailable",
  advancedEditing: "unknown",
  pendingEdits: 0,
  canUndo: false,
  canRedo: false,
  fabricOpsInSession: 0,
  busy: null,
  activeRecord: null,
  history: [],
  selection: [],
  selectionMode: "new",
  versionDialogOpen: false,
  selectByAttributesOpen: false,
  selectByLocationOpen: false,
  mergeParcelsOpen: false,
  divideParcelOpen: false,
  manualSplit: null,
  assignUpiTargets: [],
  assignUpiFrom: [],

  patch: (p) => set(p),
  addHistory: (e) =>
    set((s) => ({
      history: [{ ...e, id: seq++, time: new Date(), version: get().current?.name ?? "?" }, ...s.history].slice(0, 2000),
    })),
  clearHistory: () => set({ history: [] }),
}));

export const isDefaultVersion = (s: Pick<EditingState, "current" | "defaultVersion">) =>
  !!s.current && !!s.defaultVersion && s.current.guid === s.defaultVersion.guid;
