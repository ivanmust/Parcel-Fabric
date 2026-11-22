import type { NextFunction, Request, Response } from "express";
import { validatePortalToken, type SessionUser } from "../authentication/portalAuth.js";
import type { Permission } from "../authorization/roles.js";
import { HttpError } from "../utils/httpError.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: SessionUser;
      portalToken?: string;
    }
  }
}

export function bearerToken(req: Request): string | undefined {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return undefined;
  const token = header.slice(7).trim();
  return token.length > 0 ? token : undefined;
}

/** Require a valid ArcGIS Portal token (Authorization: Bearer <token>). */
export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const token = bearerToken(req);
  if (!token) throw new HttpError(401, "Authentication required", "auth_required");
  const origin = (req.headers["x-client-origin"] as string | undefined) ?? req.headers.origin;
  req.user = await validatePortalToken(token, origin);
  req.portalToken = token;
  next();
}

/** Require all of the given application permissions. Must run after requireAuth. */
export function requirePermission(...needed: Permission[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const granted = new Set(req.user?.permissions ?? []);
    if (!needed.every((p) => granted.has(p))) {
      throw new HttpError(403, "You do not have permission to perform this action", "forbidden", { needed });
    }
    next();
  };
}
