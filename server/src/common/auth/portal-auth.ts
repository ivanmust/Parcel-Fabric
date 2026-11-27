import { createHash } from "node:crypto";
import type { Request } from "express";
import { config } from "../../config/env.js";
import { logger } from "../logging/logger.js";
import { HttpError } from "../errors/http-error.js";
import { permissionsFor, resolveRole, type AppRole, type Permission } from "./roles.js";

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
  /** Authenticated with the API key, not as a Portal user. */
  isApiClient?: boolean;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: SessionUser;
      portalToken?: string;
    }
  }
}

/** Who the API key acts as: one fixed identity with every permission, named in the audit log. */
export const API_CLIENT_USER: SessionUser = Object.freeze({
  username: "api-key",
  fullName: "API key client",
  portalRole: "none",
  privileges: [],
  appRole: "API_CLIENT",
  permissions: permissionsFor("API_CLIENT"),
  canEditFeaturesInPortal: false,
  isApiClient: true,
});

export function bearerToken(req: Request): string | undefined {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return undefined;
  const token = header.slice(7).trim();
  return token.length > 0 ? token : undefined;
}

interface CacheEntry {
  user: SessionUser;
  expires: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const REJECTED_TTL_MS = 60 * 1000;
const MAX_CACHE = 500;
const cache = new Map<string, CacheEntry>();
/** Tokens the Portal just rejected, so repeated bad tokens don't each cost a Portal round trip. */
const rejected = new Map<string, number>();

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

function prune<V>(map: Map<string, V>, expiresOf: (v: V) => number) {
  if (map.size < MAX_CACHE) return;
  const now = Date.now();
  for (const [k, v] of map) if (expiresOf(v) <= now) map.delete(k);
  if (map.size >= MAX_CACHE) map.clear();
}

const invalidToken = () => new HttpError(401, "Your ArcGIS session is invalid or has expired. Please sign in again.", "invalid_token");

/** Ask the Portal who the token belongs to (token in the POST body, never logged); cached 5 minutes by token hash. */
export async function validatePortalToken(token: string, clientOrigin?: string): Promise<SessionUser> {
  const key = hashToken(token);
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.user;
  if ((rejected.get(key) ?? 0) > Date.now()) throw invalidToken();

  // Tokens produced by generateToken are referer-bound; the Portal must see the
  // same referer the browser used. Only configured origins are accepted.
  const referer = clientOrigin && config.APP_ORIGINS.includes(clientOrigin) ? clientOrigin : config.APP_ORIGINS[0];

  let response: Response;
  try {
    response = await fetch(`${config.PORTAL_URL}/sharing/rest/community/self`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        ...(referer ? { Referer: `${referer}/` } : {}),
      },
      body: new URLSearchParams({ f: "json", token }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    logger.error({ err: (err as Error).message }, "Portal unreachable during token validation");
    throw new HttpError(503, "ArcGIS Portal is unreachable", "portal_unavailable");
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const body = (await response.json().catch(() => ({}))) as Record<string, any>;
  if (!response.ok || body.error || !body.username) {
    logger.warn({ portalErrorCode: body.error?.code }, "Portal rejected token");
    // Remember the rejection briefly (not for Portal outages, which are a 5xx).
    if (response.status < 500) {
      prune(rejected, (expires) => expires);
      rejected.set(key, Date.now() + REJECTED_TTL_MS);
    }
    throw invalidToken();
  }

  const appRole = resolveRole(body, {
    admin: config.ROLE_GROUP_ADMIN,
    editor: config.ROLE_GROUP_EDITOR,
    surveyor: config.ROLE_GROUP_SURVEYOR,
  });
  const privileges: string[] = body.privileges ?? [];
  const user: SessionUser = {
    username: body.username,
    fullName: body.fullName ?? body.username,
    email: body.email,
    portalRole: body.role ?? "unknown",
    userLicenseTypeId: body.userLicenseTypeId,
    privileges,
    thumbnailUrl: body.thumbnail
      ? `${config.PORTAL_URL}/sharing/rest/community/users/${encodeURIComponent(body.username)}/info/${body.thumbnail}`
      : undefined,
    appRole,
    permissions: permissionsFor(appRole),
    canEditFeaturesInPortal: privileges.includes("features:user:edit") || privileges.includes("features:user:fullEdit"),
  };

  prune(cache, (entry) => entry.expires);
  cache.set(key, { user, expires: Date.now() + CACHE_TTL_MS });
  return user;
}

export function forgetToken(token: string): void {
  cache.delete(hashToken(token));
}
