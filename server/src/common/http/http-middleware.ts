import { randomUUID } from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import { pinoHttp } from "pino-http";
import { config } from "../../config/env.js";
import { logger, scrubUrl } from "../logging/logger.js";
import { isLaisRequest } from "../errors/app-exception.filter.js";

const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{1,64}$/;

/** Logs each request with an id: the caller's X-Request-Id when it is short and plain, else a new one. */
export const requestLogger = (): RequestHandler =>
  pinoHttp({
    logger,
    genReqId: (req, res) => {
      const incoming = req.headers["x-request-id"];
      const id = typeof incoming === "string" && SAFE_REQUEST_ID.test(incoming) ? incoming : randomUUID();
      res.setHeader("X-Request-Id", id);
      return id;
    },
    serializers: {
      req: (req) => ({ id: req.id, method: req.method, url: scrubUrl(req.url ?? "") }),
      res: (res) => ({ statusCode: res.statusCode }),
    },
    autoLogging: { ignore: (req) => req.url === "/api/health" },
  });

export function securityHeaders(): RequestHandler {
  const arcgisHosts = [new URL(config.PORTAL_URL).origin, new URL(config.ARCGIS_SERVER_URL).origin];
  return helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        // The ArcGIS Maps SDK runs workers from blob: URLs and loads WASM.
        "script-src": ["'self'", "blob:", "'wasm-unsafe-eval'"],
        "worker-src": ["'self'", "blob:"],
        "style-src": ["'self'", "'unsafe-inline'", "https://js.arcgis.com"],
        "img-src": ["'self'", "data:", "blob:", "https:"],
        "font-src": ["'self'", "data:", "https://js.arcgis.com"],
        "connect-src": ["'self'", ...arcgisHosts, "https://*.arcgis.com", "https://*.arcgisonline.com", "https://js.arcgis.com"],
        "frame-src": ["'self'", ...arcgisHosts],
      },
    },
    crossOriginEmbedderPolicy: false,
  });
}

/** Only the configured browser origins may call the API. */
export function allowedOrigins(request: Request, response: Response, next: NextFunction): void {
  const origin = request.headers.origin;
  if (origin && config.APP_ORIGINS.includes(origin)) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
    response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-API-Key, X-Client-Origin, X-Request-Id");
    response.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE");
  }
  if (request.method === "OPTIONS") {
    response.status(204).end();
    return;
  }
  next();
}

function tooManyRequests(request: Request, response: Response): void {
  const message = "Too many requests. Retry after the number of seconds in the Retry-After header.";
  if (isLaisRequest(request)) {
    response.status(429).json({ success: false, case: "No", message, errors: [{ field: "request", code: "RATE_LIMITED", message }], requestId: request.id });
  } else {
    response.status(429).json({ error: { code: "rate_limited", message, requestId: request.id } });
  }
}

export const perMinuteLimit = (limit: number) => rateLimit({ windowMs: 60_000, limit, standardHeaders: "draft-8", legacyHeaders: false, handler: tooManyRequests });
