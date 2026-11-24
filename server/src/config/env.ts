import { z } from "zod";

const csv = z
  .string()
  .default("")
  .transform((v) =>
    v
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );

const trimSlash = (v: string) => v.replace(/\/+$/, "");

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4001),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  APP_ORIGINS: csv,
  PORTAL_URL: z.url().transform(trimSlash),
  ARCGIS_SERVER_URL: z.url().transform(trimSlash),
  PARCEL_SERVICE_PATH: z.string().min(1).default("ParcelFabric"),
  ARCGIS_OAUTH_APP_ID: z.string().default(""),
  ROLE_GROUP_ADMIN: z.string().default(""),
  ROLE_GROUP_EDITOR: z.string().default(""),
  ROLE_GROUP_SURVEYOR: z.string().default(""),
  AUDIT_DIR: z.string().default("data/audit"),
  BOOKMARKS_DIR: z.string().default("data/bookmarks"),
  // LAIS-to-GIS integration. Empty defaults keep the endpoint disabled until configured.
  LAIS_API_KEY: z.string().default(""),
  LAIS_ARCGIS_USERNAME: z.string().default(""),
  LAIS_ARCGIS_PASSWORD: z.string().default(""),
  LAIS_ARCGIS_REFERER: z.url().default("http://localhost:5174"),
  LAIS_PARCEL_LAYER_URL: z.string().default(""),
  LAIS_TRANSACTION_TABLE_URL: z.string().default(""),
  LAIS_ALLOWED_STATUSES: csv,
  /** Serve the OpenAPI description and Swagger UI at /api/docs. Default: on, except in production. */
  API_DOCS: z.enum(["true", "false"]).optional(),
});

export type AppConfig = z.infer<typeof EnvSchema> & {
  services: {
    mapServer: string;
    featureServer: string;
    parcelFabricServer: string;
    versionManagementServer: string;
    validationServer: string;
  };
};

function loadConfig(): AppConfig {
  const parsed = EnvSchema.safeParse({
    ...process.env,
    PORTAL_URL: process.env.PORTAL_URL ?? "https://esrirw.rw/portal",
    ARCGIS_SERVER_URL: process.env.ARCGIS_SERVER_URL ?? "https://esrirw.rw/server",
    APP_ORIGINS: process.env.APP_ORIGINS ?? "http://localhost:5174,http://127.0.0.1:5174",
  });
  if (!parsed.success) {
    // Fail fast with a readable message; never print raw env (may contain secrets).
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid server configuration: ${issues}`);
  }
  const env = parsed.data;
  const base = `${env.ARCGIS_SERVER_URL}/rest/services/${env.PARCEL_SERVICE_PATH}`;
  return {
    ...env,
    services: {
      mapServer: `${base}/MapServer`,
      featureServer: `${base}/FeatureServer`,
      parcelFabricServer: `${base}/ParcelFabricServer`,
      versionManagementServer: `${base}/VersionManagementServer`,
      validationServer: `${base}/ValidationServer`,
    },
  };
}

export const config = loadConfig();
