import { createRequire } from "node:module";
import path from "node:path";
import express from "express";
import type { INestApplication } from "@nestjs/common";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { API_KEY_HEADER } from "./common/auth/api-key.js";

const swaggerUiDir = path.dirname(createRequire(import.meta.url).resolve("swagger-ui-dist/package.json"));

/** Loads the spec by a relative URL, so the page also works behind a path prefix (IIS /fabric). */
const swaggerInitializer = `window.onload = () => {
  window.ui = SwaggerUIBundle({
    url: "../openapi.json",
    dom_id: "#swagger-ui",
    deepLinking: true,
    persistAuthorization: true,
    validatorUrl: null,
    presets: [SwaggerUIBundle.presets.apis],
    layout: "BaseLayout",
  });
};
`;

const DESCRIPTION = `Rwanda Parcel Fabric API.

**Authentication.** Click *Authorize* and enter the API key (X-API-Key): it does not expire and opens every endpoint.
The web app signs in with an ArcGIS Portal token (Bearer) instead. The LAIS endpoints accept only the API key.

**LAIS responses.** Success: \`{ success: true, case: "Yes", message, data }\`. Failure: \`{ success: false, case: "No", message, errors: [{ field, code, message }], requestId }\`.`;

/** OpenAPI generated from the controllers, at /api/openapi.json (and .yaml), and Swagger UI at /api/docs/. */
export function setupApiDocs(app: INestApplication): void {
  const spec = new DocumentBuilder()
    .setTitle("Parcel Fabric API")
    .setDescription(DESCRIPTION)
    .setVersion("2.0")
    .addServer(".")
    .addApiKey({ type: "apiKey", in: "header", name: API_KEY_HEADER, description: "The API key (LAIS_API_KEY); does not expire" }, "apiKey")
    .addBearerAuth({ type: "http", scheme: "bearer", bearerFormat: "ArcGIS Portal token" })
    .build();
  const document = SwaggerModule.createDocument(app, spec, { ignoreGlobalPrefix: true });
  SwaggerModule.setup("api/openapi", app, document, { ui: false, raw: ["json", "yaml"], jsonDocumentUrl: "api/openapi.json", yamlDocumentUrl: "api/openapi.yaml" });

  app.use("/api/docs/swagger-initializer.js", (_request: express.Request, response: express.Response) => {
    response.type("application/javascript").send(swaggerInitializer);
  });
  app.use("/api/docs", express.static(swaggerUiDir, { index: "index.html", maxAge: "1h" }));
}
