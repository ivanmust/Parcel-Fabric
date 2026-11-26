/** Runtime configuration served by the backend (`GET /api/config`). No secrets. */
export interface AppRuntimeConfig {
  portalUrl: string;
  serverUrl: string;
  oauthAppId: string | null;
  services: {
    mapServer: string;
    featureServer: string;
    parcelFabricServer: string;
    versionManagementServer: string;
    validationServer: string;
  };
  project: { name: string; dataset: string };
  /** Server switches (absent on older servers: treat as off). */
  features?: { laisEditingDone: boolean };
}

export type AppRole = "ADMINISTRATOR" | "GIS_EDITOR" | "SURVEYOR" | "VIEWER";

export type Permission =
  | "map:view"
  | "features:edit"
  | "attributes:edit"
  | "parcels:edit"
  | "parcels:construct"
  | "records:manage"
  | "versions:manage"
  | "versions:post"
  | "validation:run"
  | "analysis:run"
  | "data:export"
  | "data:import"
  | "admin:audit"
  | "admin:forms";

/** Application session resolved by the backend from the user's Portal token. */
export interface SessionUser {
  username: string;
  fullName: string;
  email?: string;
  portalRole: string;
  userLicenseTypeId?: string;
  privileges: string[];
  thumbnailUrl?: string;
  appRole: AppRole;
  permissions: Permission[];
  canEditFeaturesInPortal: boolean;
}

export const ROLE_LABELS: Record<AppRole, string> = {
  ADMINISTRATOR: "Administrator",
  GIS_EDITOR: "GIS Editor",
  SURVEYOR: "Surveyor",
  VIEWER: "Viewer",
};

export type ThemeMode = "light" | "dark" | "system";
export type CoordinateFormat = "dd" | "dms";

export type MapTool =
  | "explore"
  | "pan"
  | "measure-distance"
  | "measure-area"
  | "coordinate-info"
  | "select-click"
  | "select-rectangle"
  | "select-polygon"
  | "select-lasso";

export type LeftPanelId = "contents" | "layers" | "upload" | "bookmarks" | "selection" | "editing";
export type BottomTabId = "table" | "history" | "messages" | "logs";

export type LogLevel = "debug" | "info" | "success" | "warning" | "error";

export interface LogEntry {
  id: number;
  time: Date;
  level: LogLevel;
  source: string;
  message: string;
  detail?: string;
}

export interface Notice {
  id: number;
  time: Date;
  kind: "info" | "success" | "warning" | "danger";
  title: string;
  message?: string;
  read: boolean;
}
