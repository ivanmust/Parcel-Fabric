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
  /**
   * Subdivision completion webhook: when a LAIS Subdivision is posted in GIS, notify an external
   * application ("App B") with the resulting parcels. Off by default; see docs/SUBDIVISION-WEBHOOK.md.
   */
  SUBDIVISION_WEBHOOK_ENABLED: z.enum(["true", "false"]).default("false"),
  SUBDIVISION_WEBHOOK_URL: z.union([z.literal(""), z.url()]).default(""),
  /** HMAC-SHA256 key shared with App B (at least 32 characters). */
  SUBDIVISION_WEBHOOK_SECRET: z.string().default(""),
  /** Only during a key change: the old key. Requests then carry a signature for each key. */
  SUBDIVISION_WEBHOOK_SECRET_PREVIOUS: z.string().default(""),
  SUBDIVISION_WEBHOOK_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60_000).default(10_000),
  /** Attempts before an event is dead-lettered (retryable failures; permanent ones dead-letter at once). */
  SUBDIVISION_WEBHOOK_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(50).default(12),
  /** Exponential backoff: base × 2^(attempt−1), capped, with jitter. */
  SUBDIVISION_WEBHOOK_BACKOFF_BASE_MS: z.coerce.number().int().min(1000).default(30_000),
  SUBDIVISION_WEBHOOK_BACKOFF_MAX_MS: z.coerce.number().int().min(1000).default(6 * 60 * 60_000),
  /** How often GIS is checked for newly posted subdivisions. */
  SUBDIVISION_WEBHOOK_RECONCILE_INTERVAL_MS: z.coerce.number().int().min(10_000).default(5 * 60_000),
  /** How often due deliveries are sent. */
  SUBDIVISION_WEBHOOK_DISPATCH_INTERVAL_MS: z.coerce.number().int().min(1000).default(15_000),
  /**
   * Only transactions accepted at or after this time are eligible (ISO 8601). Empty: from the moment
   * the webhook was first enabled, so switching it on does not replay every past subdivision.
   */
  SUBDIVISION_WEBHOOK_SINCE: z.union([z.literal(""), z.iso.datetime({ offset: true })]).default(""),
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
  if (env.SUBDIVISION_WEBHOOK_ENABLED === "true") {
    const problems: string[] = [];
    if (!env.SUBDIVISION_WEBHOOK_URL) problems.push("SUBDIVISION_WEBHOOK_URL is required");
    else if (!env.SUBDIVISION_WEBHOOK_URL.startsWith("https://") && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\//.test(env.SUBDIVISION_WEBHOOK_URL)) {
      problems.push("SUBDIVISION_WEBHOOK_URL must use https:// (http:// only for localhost)");
    }
    if (env.SUBDIVISION_WEBHOOK_SECRET.length < 32) problems.push("SUBDIVISION_WEBHOOK_SECRET must be at least 32 characters");
    if (env.SUBDIVISION_WEBHOOK_SECRET_PREVIOUS && env.SUBDIVISION_WEBHOOK_SECRET_PREVIOUS.length < 32) problems.push("SUBDIVISION_WEBHOOK_SECRET_PREVIOUS must be empty or at least 32 characters");
    if (env.SUBDIVISION_WEBHOOK_BACKOFF_MAX_MS < env.SUBDIVISION_WEBHOOK_BACKOFF_BASE_MS) problems.push("SUBDIVISION_WEBHOOK_BACKOFF_MAX_MS must not be below SUBDIVISION_WEBHOOK_BACKOFF_BASE_MS");
    // Names only: the values may be secrets.
    if (problems.length) throw new Error(`Invalid server configuration: ${problems.join("; ")}`);
  }
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
