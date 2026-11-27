import express, { type Request, type Response } from "express";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import { pinoHttp } from "pino-http";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { config } from "./config/env.js";
import { logger, scrubUrl } from "./logging/logger.js";
import { api } from "./routes/index.js";
import { lais } from "./routes/lais.js";
import { laisWorkflow } from "./routes/laisWorkflow.js";
import { laisEditing } from "./routes/laisEditing.js";
import { webhooks } from "./routes/webhooks.js";
import { bookmarks } from "./routes/bookmarks.js";
import { docs } from "./routes/docs.js";
import { errorHandler, isLaisRequest, notFound } from "./middleware/errorHandler.js";

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", "loopback");

  app.use(
    pinoHttp({
      logger,
      genReqId: (req, res) => {
        // Accept a caller's request id only if it is short and plain; it is echoed in a header and logged.
        const incoming = req.headers["x-request-id"];
        const id = typeof incoming === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(incoming) ? incoming : randomUUID();
        res.setHeader("X-Request-Id", id);
        return id;
      },
      serializers: {
        req: (req) => ({ id: req.id, method: req.method, url: scrubUrl(req.url ?? "") }),
        res: (res) => ({ statusCode: res.statusCode }),
      },
      autoLogging: { ignore: (req) => req.url === "/api/health" },
    }),
  );

  const arcgisHosts = [new URL(config.PORTAL_URL).origin, new URL(config.ARCGIS_SERVER_URL).origin];
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          // The ArcGIS Maps SDK runs workers from blob: URLs and loads WASM.
          "script-src": ["'self'", "blob:", "'wasm-unsafe-eval'"],
          "worker-src": ["'self'", "blob:"],
          "style-src": ["'self'", "'unsafe-inline'", "https://js.arcgis.com"],
          "img-src": ["'self'", "data:", "blob:", "https:"],
          "font-src": ["'self'", "data:", "https://js.arcgis.com"],
          "connect-src": [
            "'self'",
            ...arcgisHosts,
            "https://*.arcgis.com",
            "https://*.arcgisonline.com",
            "https://js.arcgis.com",
          ],
          "frame-src": ["'self'", ...arcgisHosts],
        },
      },
      crossOriginEmbedderPolicy: false,
    }),
  );

  // Only same-origin (or configured) browser origins may call the API.
  app.use("/api", (req, res, next) => {
    const origin = req.headers.origin;
    if (origin && config.APP_ORIGINS.includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Client-Origin, X-Request-Id");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE");
    }
    if (req.method === "OPTIONS") return res.status(204).end();
    next();
  });

  const tooMany = (req: Request, res: Response) => {
    const message = "Too many requests. Retry after the number of seconds in the Retry-After header.";
    if (isLaisRequest(req)) {
      res.status(429).json({ success: false, case: "No", message, errors: [{ field: "request", code: "RATE_LIMITED", message }], requestId: req.id });
    } else {
      res.status(429).json({ error: { code: "rate_limited", message, requestId: req.id } });
    }
  };
  app.use("/api", rateLimit({ windowMs: 60_000, limit: 600, standardHeaders: "draft-8", legacyHeaders: false, handler: tooMany }));
  app.use(express.json({ limit: "256kb" }));
  app.use("/api", api);
  app.use("/api/lais", rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: "draft-8", legacyHeaders: false, handler: tooMany }));
  app.use("/api/lais", lais);
  app.use("/api/lais-workflow", laisWorkflow);
  app.use("/api/lais-editing", laisEditing);
  app.use("/api/webhooks", webhooks);
  app.use("/api", bookmarks);
  if (config.API_DOCS ? config.API_DOCS === "true" : config.NODE_ENV !== "production") app.use("/api", docs);
  app.use("/api", notFound);

  // Production: serve the built SPA from ../dist.
  const spaDir = path.resolve(import.meta.dirname, "../../dist");
  if (config.NODE_ENV === "production" && existsSync(spaDir)) {
    app.use(express.static(spaDir, { index: false, maxAge: "1h" }));
    app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(path.join(spaDir, "index.html")));
  }

  app.use(errorHandler);
  return app;
}
