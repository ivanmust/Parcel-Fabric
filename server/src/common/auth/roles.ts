/** Application roles. They gate the app only; ArcGIS still authorises every edit against the user's own token. */
export const APP_ROLES = ["ADMINISTRATOR", "GIS_EDITOR", "SURVEYOR", "VIEWER", "API_CLIENT"] as const;
export type AppRole = (typeof APP_ROLES)[number];

export const PERMISSIONS = [
  "map:view",
  "features:edit",
  "attributes:edit",
  "parcels:edit",
  "parcels:construct",
  "records:manage",
  "versions:manage",
  "versions:post",
  "validation:run",
  "analysis:run",
  "data:export",
  "data:import",
  "admin:audit",
  "admin:forms",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const ROLE_PERMISSIONS: Record<AppRole, readonly Permission[]> = {
  ADMINISTRATOR: PERMISSIONS,
  API_CLIENT: PERMISSIONS,
  GIS_EDITOR: [
    "map:view",
    "features:edit",
    "attributes:edit",
    "parcels:edit",
    "records:manage",
    "versions:manage",
    "validation:run",
    "analysis:run",
    "data:export",
    "data:import",
  ],
  SURVEYOR: [
    "map:view",
    "features:edit",
    "attributes:edit",
    "parcels:edit",
    "parcels:construct",
    "records:manage",
    "versions:manage",
    "validation:run",
    "analysis:run",
    "data:export",
  ],
  VIEWER: ["map:view", "analysis:run", "data:export"],
};

export interface PortalUserLike {
  role?: string;
  privileges?: string[];
  groups?: { id: string }[];
}

export interface RoleGroupConfig {
  admin: string;
  editor: string;
  surveyor: string;
}

/** Derive the application role from Portal role, privileges and group membership. */
export function resolveRole(user: PortalUserLike, groups: RoleGroupConfig): AppRole {
  const groupIds = new Set((user.groups ?? []).map((g) => g.id));
  const privileges = new Set(user.privileges ?? []);
  if (groups.admin ? groupIds.has(groups.admin) : user.role === "org_admin") return "ADMINISTRATOR";
  if (groups.surveyor && groupIds.has(groups.surveyor)) return "SURVEYOR";
  const canEditFeatures = privileges.has("features:user:edit") || privileges.has("features:user:fullEdit");
  if (groups.editor ? groupIds.has(groups.editor) : canEditFeatures) return "GIS_EDITOR";
  return "VIEWER";
}

export function permissionsFor(role: AppRole): Permission[] {
  return [...ROLE_PERMISSIONS[role]];
}
