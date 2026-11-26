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
  /** Only during a key change: the old key, still accepted until LAIS has switched. Then empty it. */
  LAIS_API_KEY_PREVIOUS: z.string().default(""),
  LAIS_ARCGIS_USERNAME: z.string().default(""),
  LAIS_ARCGIS_PASSWORD: z.string().default(""),
  LAIS_ARCGIS_REFERER: z.url().default("http://localhost:5174"),
  /** Plot layer that stores LAIS transaction fields. Default: <FeatureServer>/17. */
  LAIS_PARCEL_LAYER_URL: z.string().default(""),
  /**
   * version-only: the LAIS account creates the public version and nothing else (read-only GIS rights).
   * attributes:   it also writes the transaction fields on the Plot inside the version
   *               (needs the Portal "Advanced Editing" user type extension).
   */
  LAIS_WRITE_MODE: z.enum(["version-only", "attributes"]).default("version-only"),
  LAIS_DATA_DIR: z.string().default("data/lais"),
  /**
   * GIS → LAIS "editing done" notification. Off until the whole approval flow (LAIS endpoint, GIS
   * approve endpoint) is ready: once on, editors stop posting LAIS versions and wait for approval.
   */
  LAIS_EDITING_DONE: z.enum(["true", "false"]).default("false"),
  /** The LAIS endpoint that receives the notification (POST, JSON). */
  LAIS_WEBHOOK_URL: z.union([z.literal(""), z.url()]).default(""),
  /** The key LAIS issued to GIS, sent as X-API-Key. */
  LAIS_WEBHOOK_KEY: z.string().default(""),
  LAIS_WEBHOOK_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60_000).default(10_000),
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
  lais: {
    /** Branch-versioned Plot layer, e.g. .../ParcelFabric/FeatureServer/17 */
    plotLayerUrl: string;
    /** VersionManagementServer of the same service as the Plot layer. */
    versionManagementUrl: string;
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
  const plotLayerUrl = trimSlash(env.LAIS_PARCEL_LAYER_URL || `${base}/FeatureServer/17`);
  const layerMatch = /^(https?:\/\/.+)\/FeatureServer\/\d+$/i.exec(plotLayerUrl);
  if (!layerMatch) throw new Error("Invalid server configuration: LAIS_PARCEL_LAYER_URL must be a .../FeatureServer/<layerId> URL");
  return {
    ...env,
    lais: { plotLayerUrl, versionManagementUrl: `${layerMatch[1]}/VersionManagementServer` },
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
