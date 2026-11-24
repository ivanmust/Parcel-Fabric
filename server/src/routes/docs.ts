import express, { Router } from "express";
import path from "node:path";
import { createRequire } from "node:module";

/**
 * API documentation: the OpenAPI description (`server/openapi.yaml`) and Swagger UI for it, served
 * from the local swagger-ui-dist package (no CDN, so the Content Security Policy stays 'self').
 */
export const docs = Router();

const specFile = path.resolve(import.meta.dirname, "../../openapi.yaml");
const uiDir = path.dirname(createRequire(import.meta.url).resolve("swagger-ui-dist/package.json"));

/** Replaces the package's demo initializer: load our spec, no external validator badge. */
const initializer = `window.onload = () => {
  window.ui = SwaggerUIBundle({
    url: "../openapi.yaml",
    dom_id: "#swagger-ui",
    deepLinking: true,
    validatorUrl: null,
    presets: [SwaggerUIBundle.presets.apis],
    layout: "BaseLayout",
  });
};
`;

docs.get("/openapi.yaml", (_req, res) => res.type("application/yaml").sendFile(specFile));
docs.get("/docs/swagger-initializer.js", (_req, res) => res.type("application/javascript").send(initializer));
docs.use("/docs", express.static(uiDir, { index: "index.html", maxAge: "1h" }));
