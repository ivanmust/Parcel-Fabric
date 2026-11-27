import { createHash, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { config } from "../config/env.js";
import { logger } from "../logging/logger.js";
import type { Permission } from "../authorization/roles.js";
import { HttpError } from "../utils/httpError.js";
import { requireAuth, requirePermission } from "./authenticate.js";

/** Constant-time comparison of two secrets (hashed first, so lengths don't leak). */
export function sameSecret(received: string | undefined, expected: string): boolean {
  if (!received) return false;
  const a = createHash("sha256").update(received).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * Require the LAIS API key (header X-API-Key). The key does not expire: it is valid until it is changed
 * in LAIS_API_KEY. During a key change LAIS_API_KEY_PREVIOUS (the old key) is accepted too, so LAIS can
 * switch without downtime; remove it once LAIS uses the new key. Keys shorter than 32 characters are
 * never accepted. Never accepts or reuses a browser Portal token.
 */
export function requireLaisApiKey(req: Request, _res: Response, next: NextFunction) {
  const received = req.header("x-api-key");
  const keys = [config.LAIS_API_KEY, config.LAIS_API_KEY_PREVIOUS].filter((k) => k.length >= 32);
  // Compare against every key (constant time each), so timing doesn't reveal which one matched.
  const matches = keys.map((k) => sameSecret(received, k));
  if (config.LAIS_API_KEY.length < 32 || !matches.some(Boolean)) {
    throw new HttpError(401, "Valid LAIS API credentials are required", "unauthorized");
  }
  if (!matches[0]) logger.warn({ requestId: req.id }, "LAIS authenticated with the previous API key; finish the key change");
  next();
}

/**
 * For read-only endpoints that both the web app and API clients (e.g. Swagger) use: a request with an
 * X-API-Key header must carry the LAIS API key; any other request needs a signed-in Portal user with
 * the given permissions. A wrong key is refused, never passed on to the Portal check.
 */
export function requireApiKeyOrPermission(...needed: Permission[]) {
  const permission = requirePermission(...needed);
  return async (req: Request, res: Response, next: NextFunction) => {
    if (req.header("x-api-key") !== undefined) return requireLaisApiKey(req, res, next);
    await requireAuth(req, res, (err?: unknown) => {
      if (err) throw err;
      permission(req, res, next);
    });
  };
}
