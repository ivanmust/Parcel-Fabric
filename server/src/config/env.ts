import { z } from "zod";

const trimSlash = (value: string) => value.replace(/\/+$/, "");
const csv = z
  .string()
  .default("")
  .transform((value) =>
    value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
const optionalUrl = z.union([z.literal(""), z.url()]).default("");
const onOff = z.enum(["true", "false"]);

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4001),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  APP_ORIGINS: csv,
  /** Swagger UI at /api/docs. Default: on, except in production. */
  API_DOCS: onOff.optional(),

  PORTAL_URL: z.url().transform(trimSlash),
  ARCGIS_SERVER_URL: z.url().transform(trimSlash),
  ARCGIS_OAUTH_APP_ID: z.string().default(""),
  PARCEL_SERVICE_PATH: z.string().min(1).default("ParcelFabric"),
  /** Each service can be set on its own; empty = <ARCGIS_SERVER_URL>/rest/services/<PARCEL_SERVICE_PATH>/<Service>. */
  FEATURE_SERVER_URL: optionalUrl,
  MAP_SERVER_URL: optionalUrl,
  PARCEL_FABRIC_SERVER_URL: optionalUrl,
  VERSION_MANAGEMENT_SERVER_URL: optionalUrl,
  VALIDATION_SERVER_URL: optionalUrl,

  ROLE_GROUP_ADMIN: z.string().default(""),
  ROLE_GROUP_EDITOR: z.string().default(""),
  ROLE_GROUP_SURVEYOR: z.string().default(""),
  AUDIT_DIR: z.string().default("data/audit"),
  BOOKMARKS_DIR: z.string().default("data/bookmarks"),

  /** The API key (X-API-Key). It does not expire; it opens every endpoint. */
  LAIS_API_KEY: z.string().default(""),
  /** Only during a key change: the old key, accepted until clients have switched. */
  LAIS_API_KEY_PREVIOUS: z.string().default(""),
  LAIS_ARCGIS_USERNAME: z.string().default(""),
  LAIS_ARCGIS_PASSWORD: z.string().default(""),
  LAIS_ARCGIS_REFERER: z.url().default("http://localhost:5174"),
  /** The Plot layer of LAIS transactions. Empty = <Feature Server>/17. */
  LAIS_PARCEL_LAYER_URL: z.string().default(""),
  /** attributes: write the transaction fields on the Plot inside the version (needs Advanced Editing). version-only: only create the version. */
  LAIS_WRITE_MODE: z.enum(["version-only", "attributes"]).default("attributes"),
  LAIS_DATA_DIR: z.string().default("data/lais"),

  /** GIS → LAIS "editing done" notification and the registrar's approve/reject. */
  LAIS_EDITING_DONE: onOff.default("false"),
  LAIS_WEBHOOK_URL: optionalUrl,
  LAIS_WEBHOOK_KEY: z.string().default(""),
  /** How the notification is sent to LAIS_WEBHOOK_URL (LAIS asked for PUT). */
  LAIS_WEBHOOK_METHOD: z.enum(["PUT", "POST"]).default("PUT"),
  LAIS_WEBHOOK_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60_000).default(10_000),
  /** How often open versions are checked for parcels marked editing_status = "Edits done". 0 = off. */
  LAIS_EDITS_DONE_SCAN_MS: z.coerce.number().int().min(0).max(24 * 60 * 60_000).default(120_000),

  /** Subdivision completion webhook to App B; see docs/SUBDIVISION-WEBHOOK.md. */
  SUBDIVISION_WEBHOOK_ENABLED: onOff.default("false"),
  SUBDIVISION_WEBHOOK_URL: optionalUrl,
  SUBDIVISION_WEBHOOK_SECRET: z.string().default(""),
  SUBDIVISION_WEBHOOK_SECRET_PREVIOUS: z.string().default(""),
  SUBDIVISION_WEBHOOK_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60_000).default(10_000),
  SUBDIVISION_WEBHOOK_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(50).default(12),
  SUBDIVISION_WEBHOOK_BACKOFF_BASE_MS: z.coerce.number().int().min(1000).default(30_000),
  SUBDIVISION_WEBHOOK_BACKOFF_MAX_MS: z.coerce.number().int().min(1000).default(6 * 60 * 60_000),
  SUBDIVISION_WEBHOOK_RECONCILE_INTERVAL_MS: z.coerce.number().int().min(10_000).default(5 * 60_000),
  SUBDIVISION_WEBHOOK_DISPATCH_INTERVAL_MS: z.coerce.number().int().min(1000).default(15_000),
  /** Only transactions accepted at or after this time (ISO 8601). Empty = since the webhook was first enabled. */
  SUBDIVISION_WEBHOOK_SINCE: z.union([z.literal(""), z.iso.datetime({ offset: true })]).default(""),
});

type Env = z.infer<typeof EnvSchema>;

export interface ServiceUrls {
  mapServer: string;
  featureServer: string;
  parcelFabricServer: string;
  versionManagementServer: string;
  validationServer: string;
}

export type AppConfig = Env & {
  services: ServiceUrls;
  lais: { plotLayerUrl: string; versionManagementUrl: string };
};

function parseEnv(): Env {
  const parsed = EnvSchema.safeParse({
    ...process.env,
    PORTAL_URL: process.env.PORTAL_URL ?? "https://esrirw.rw/portal",
    ARCGIS_SERVER_URL: process.env.ARCGIS_SERVER_URL ?? "https://esrirw.rw/server",
    APP_ORIGINS: process.env.APP_ORIGINS ?? "http://localhost:5174,http://127.0.0.1:5174",
  });
  if (!parsed.success) {
    // Names and messages only: the values may be secrets.
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid server configuration: ${issues}`);
  }
  return parsed.data;
}

function subdivisionWebhookProblems(env: Env): string[] {
  if (env.SUBDIVISION_WEBHOOK_ENABLED !== "true") return [];
  const problems: string[] = [];
  const url = env.SUBDIVISION_WEBHOOK_URL;
  if (!url) problems.push("SUBDIVISION_WEBHOOK_URL is required");
  else if (!url.startsWith("https://") && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\//.test(url)) {
    problems.push("SUBDIVISION_WEBHOOK_URL must use https:// (http:// only for localhost)");
  }
  if (env.SUBDIVISION_WEBHOOK_SECRET.length < 32) problems.push("SUBDIVISION_WEBHOOK_SECRET must be at least 32 characters");
  if (env.SUBDIVISION_WEBHOOK_SECRET_PREVIOUS && env.SUBDIVISION_WEBHOOK_SECRET_PREVIOUS.length < 32) {
    problems.push("SUBDIVISION_WEBHOOK_SECRET_PREVIOUS must be empty or at least 32 characters");
  }
  if (env.SUBDIVISION_WEBHOOK_BACKOFF_MAX_MS < env.SUBDIVISION_WEBHOOK_BACKOFF_BASE_MS) {
    problems.push("SUBDIVISION_WEBHOOK_BACKOFF_MAX_MS must not be below SUBDIVISION_WEBHOOK_BACKOFF_BASE_MS");
  }
  return problems;
}

function serviceUrls(env: Env): ServiceUrls {
  const base = `${env.ARCGIS_SERVER_URL}/rest/services/${env.PARCEL_SERVICE_PATH}`;
  const pick = (configured: string, service: string) => trimSlash(configured || `${base}/${service}`);
  return {
    mapServer: pick(env.MAP_SERVER_URL, "MapServer"),
    featureServer: pick(env.FEATURE_SERVER_URL, "FeatureServer"),
    parcelFabricServer: pick(env.PARCEL_FABRIC_SERVER_URL, "ParcelFabricServer"),
    versionManagementServer: pick(env.VERSION_MANAGEMENT_SERVER_URL, "VersionManagementServer"),
    validationServer: pick(env.VALIDATION_SERVER_URL, "ValidationServer"),
  };
}

/** The Plot layer, and the VersionManagementServer of the same service (its versions hold the transactions). */
function laisUrls(env: Env, services: ServiceUrls) {
  const plotLayerUrl = trimSlash(env.LAIS_PARCEL_LAYER_URL || `${services.featureServer}/17`);
  const serviceRoot = /^(https?:\/\/.+)\/FeatureServer\/\d+$/i.exec(plotLayerUrl)?.[1];
  if (!serviceRoot) throw new Error("Invalid server configuration: LAIS_PARCEL_LAYER_URL must be a .../FeatureServer/<layerId> URL");
  const sameService = !env.LAIS_PARCEL_LAYER_URL && env.VERSION_MANAGEMENT_SERVER_URL;
  return { plotLayerUrl, versionManagementUrl: sameService ? services.versionManagementServer : `${serviceRoot}/VersionManagementServer` };
}

function loadConfig(): AppConfig {
  const env = parseEnv();
  const problems = subdivisionWebhookProblems(env);
  if (problems.length) throw new Error(`Invalid server configuration: ${problems.join("; ")}`);
  const services = serviceUrls(env);
  return { ...env, services, lais: laisUrls(env, services) };
}

/** One shared configuration object (tests change values on it at run time). */
export const config = loadConfig();
