import { create } from "zustand";
import type {
  AppRuntimeConfig,
  BottomTabId,
  CoordinateFormat,
  LeftPanelId,
  LogEntry,
  LogLevel,
  MapTool,
  Notice,
  SessionUser,
  ThemeMode,
} from "../types/app";

const PREFS_KEY = "parcel-studio.prefs";
const LEFT_PANELS: readonly LeftPanelId[] = ["contents", "layers", "catalog", "bookmarks", "selection", "editing"];

interface Prefs {
  theme: ThemeMode;
  coordinateFormat: CoordinateFormat;
  leftOpen: boolean;
  rightOpen: boolean;
  bottomOpen: boolean;
  leftPanel: LeftPanelId;
  basemapId: string;
}

const defaultPrefs: Prefs = {
  theme: "system",
  coordinateFormat: "dd",
  leftOpen: true,
  rightOpen: true,
  bottomOpen: false,
  leftPanel: "contents",
  basemapId: "imagery",
};

function loadPrefs(): Prefs {
  try {
    const prefs: Prefs = { ...defaultPrefs, ...JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") };
    // A panel saved by an older version may no longer exist (e.g. the removed "GIS Services").
    if (!LEFT_PANELS.includes(prefs.leftPanel)) prefs.leftPanel = defaultPrefs.leftPanel;
    return prefs;
  } catch {
    return defaultPrefs;
  }
}

/** Live view state that changes often – kept small and read via selectors. */
export interface MapStatus {
  ready: boolean;
  updating: boolean;
  scale: number;
  zoom: number;
  canGoBack: boolean;
  canGoForward: boolean;
  pointer: { lon: number; lat: number; x?: number; y?: number } | null;
  dataWkid: number | null;
  dataSrName: string | null;
  /** A feature is highlighted after identify or a search (it looks selected but isn't in the selection). */
  highlighted: boolean;
}

/** What the right-hand properties panel is showing. */
export type PropertiesTarget =
  | { kind: "none" }
  | { kind: "features"; hits: { layerKey: string; objectId: number }[]; index: number }
  | { kind: "layer"; layerKey: string }
  | { kind: "coordinates"; lon: number; lat: number };

interface AppState extends Prefs {
  config: AppRuntimeConfig | null;
  user: SessionUser | null;
  activeVersionName: string | null;
  tool: MapTool;
  bottomTab: BottomTabId;
  tableLayerId: string | null;
  properties: PropertiesTarget;
  mapStatus: MapStatus;
  notices: Notice[];
  toasts: Notice[];
  logs: LogEntry[];
  dialogs: { goTo: boolean; shortcuts: boolean; settings: boolean; profile: boolean };

  setConfig(c: AppRuntimeConfig): void;
  setUser(u: SessionUser | null): void;
  setActiveVersionName(n: string | null): void;
  setTool(t: MapTool): void;
  setPref<K extends keyof Prefs>(k: K, v: Prefs[K]): void;
  openLeftPanel(id: LeftPanelId): void;
  openBottomTab(tab: BottomTabId, tableLayerId?: string): void;
  showProperties(t: PropertiesTarget): void;
  patchMapStatus(p: Partial<MapStatus>): void;
  notify(kind: Notice["kind"], title: string, message?: string): void;
  dismissToast(id: number): void;
  markNoticesRead(): void;
  clearNotices(): void;
  log(level: LogLevel, source: string, message: string, detail?: string): void;
  clearLogs(): void;
  setDialog(name: keyof AppState["dialogs"], open: boolean): void;
}

let seq = 1;
const MAX_LOGS = 1000;

export const useApp = create<AppState>((set, get) => ({
  ...loadPrefs(),
  config: null,
  user: null,
  activeVersionName: null,
  tool: "explore",
  bottomTab: "table",
  tableLayerId: null,
  properties: { kind: "none" },
  mapStatus: {
    ready: false,
    updating: false,
    scale: 0,
    zoom: 0,
    canGoBack: false,
    canGoForward: false,
    pointer: null,
    dataWkid: null,
    dataSrName: null,
    highlighted: false,
  },
  notices: [],
  toasts: [],
  logs: [],
  dialogs: { goTo: false, shortcuts: false, settings: false, profile: false },

  setConfig: (config) => set({ config }),
  setUser: (user) => set({ user }),
  setActiveVersionName: (activeVersionName) => set({ activeVersionName }),
  setTool: (tool) => set({ tool }),
  setPref: (k, v) => {
    set({ [k]: v } as Partial<AppState>);
    const s = get();
    const prefs: Prefs = {
      theme: s.theme,
      coordinateFormat: s.coordinateFormat,
      leftOpen: s.leftOpen,
      rightOpen: s.rightOpen,
      bottomOpen: s.bottomOpen,
      leftPanel: s.leftPanel,
      basemapId: s.basemapId,
    };
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch {
      /* ignore */
    }
  },
  openLeftPanel: (id) => {
    const s = get();
    if (s.leftOpen && s.leftPanel === id) s.setPref("leftOpen", false);
    else {
      s.setPref("leftPanel", id);
      s.setPref("leftOpen", true);
    }
  },
  openBottomTab: (tab, tableLayerId) => {
    set({ bottomTab: tab, ...(tableLayerId ? { tableLayerId } : {}) });
    get().setPref("bottomOpen", true);
  },
  showProperties: (properties) => {
    set({ properties });
    if (properties.kind !== "none") get().setPref("rightOpen", true);
  },
  patchMapStatus: (p) => set((s) => ({ mapStatus: { ...s.mapStatus, ...p } })),
  notify: (kind, title, message) => {
    const n: Notice = { id: seq++, time: new Date(), kind, title, message, read: false };
    set((s) => ({ notices: [n, ...s.notices].slice(0, 200), toasts: [...s.toasts, n].slice(-4) }));
    const level: LogLevel = kind === "danger" ? "error" : kind === "warning" ? "warning" : kind === "success" ? "success" : "info";
    get().log(level, "notification", message ? `${title} — ${message}` : title);
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  markNoticesRead: () => set((s) => ({ notices: s.notices.map((n) => ({ ...n, read: true })) })),
  clearNotices: () => set({ notices: [] }),
  log: (level, source, message, detail) =>
    set((s) => ({
      logs: [{ id: seq++, time: new Date(), level, source, message, detail }, ...s.logs].slice(0, MAX_LOGS),
    })),
  clearLogs: () => set({ logs: [] }),
  setDialog: (name, open) => set((s) => ({ dialogs: { ...s.dialogs, [name]: open } })),
}));

/** Convenience accessors for non-React code (services, map controller). */
export const appActions = {
  log: (...a: Parameters<AppState["log"]>) => useApp.getState().log(...a),
  notify: (...a: Parameters<AppState["notify"]>) => useApp.getState().notify(...a),
  patchMapStatus: (p: Partial<MapStatus>) => useApp.getState().patchMapStatus(p),
};

export function hasPermission(user: SessionUser | null, p: SessionUser["permissions"][number]): boolean {
  return !!user?.permissions.includes(p);
}
