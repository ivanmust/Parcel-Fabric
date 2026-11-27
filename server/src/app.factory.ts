import "reflect-metadata";
import { existsSync } from "node:fs";
import path from "node:path";
import express from "express";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { config } from "./config/env.js";
import { NestPinoLogger } from "./common/logging/nest-logger.js";
import { AppExceptionFilter } from "./common/errors/app-exception.filter.js";
import { allowedOrigins, perMinuteLimit, requestLogger, securityHeaders } from "./common/http/http-middleware.js";
import { AppModule } from "./app.module.js";
import { setupApiDocs } from "./api-docs.js";

const webAppDir = path.resolve(import.meta.dirname, "../../dist");
const docsEnabled = () => (config.API_DOCS ? config.API_DOCS === "true" : config.NODE_ENV !== "production");

/** The configured API, initialised but not listening (main.ts listens; tests listen on a free port). */
export async function createApp(): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false, logger: new NestPinoLogger() });
  app.disable("x-powered-by");
  app.set("trust proxy", "loopback");

  app.use(requestLogger());
  app.use(securityHeaders());
  app.use("/api", allowedOrigins);
  app.use("/api", perMinuteLimit(600));
  app.use("/api/lais", perMinuteLimit(60));

  app.setGlobalPrefix("api");
  const servesWebApp = config.NODE_ENV === "production" && existsSync(webAppDir);
  app.useGlobalFilters(new AppExceptionFilter(servesWebApp ? path.join(webAppDir, "index.html") : null));
  if (docsEnabled()) setupApiDocs(app);
  if (servesWebApp) app.use(express.static(webAppDir, { index: false, maxAge: "1h" }));

  await app.init();
  return app;
}
