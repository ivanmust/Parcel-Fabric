import { config } from "../../config/env.js";

/**
 * Minimal ArcGIS REST client for the LAIS service account.
 *
 * Tokens come from `generateToken` with client=referer, so EVERY request must carry
 * the same Referer header or ArcGIS rejects the token (498). Tokens go in the POST
 * body, never the URL, and are never logged.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ArcGisJson = Record<string, any> & { error?: { code?: number; message?: string; details?: string[] } };

export class ArcGisError extends Error {
  constructor(message: string, readonly code?: number) {
    super(message);
    this.name = "ArcGisError";
  }
}

const TOKEN_ERRORS = new Set([498, 499]);

function referer(): string {
  return `${config.LAIS_ARCGIS_REFERER.replace(/\/+$/, "")}/`;
}

export async function arcgisPost(url: string, params: Record<string, string>, token?: string): Promise<ArcGisJson> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Referer: referer() },
    body: new URLSearchParams({ ...params, f: "json", ...(token ? { token } : {}) }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = (await response.json().catch(() => ({}))) as ArcGisJson;
  if (!response.ok || body.error) {
    const detail = body.error?.details?.filter(Boolean).join("; ");
    throw new ArcGisError(
      `${body.error?.message ?? `ArcGIS request failed (HTTP ${response.status})`}${detail ? ` (${detail})` : ""}`,
      body.error?.code ?? response.status,
    );
  }
  return body;
}

let tokenCache: { value: string; expiresAt: number } | null = null;
let tokenInFlight: Promise<string> | null = null;

/** Short-lived token for the dedicated LAIS integration account (shared by concurrent requests). */
async function serviceToken(forceRefresh = false): Promise<string> {
  if (!forceRefresh && tokenCache && tokenCache.expiresAt > Date.now() + 60_000) return tokenCache.value;
  tokenInFlight ??= (async () => {
    if (!config.LAIS_ARCGIS_USERNAME || !config.LAIS_ARCGIS_PASSWORD) {
      throw new ArcGisError("LAIS ArcGIS integration account is not configured");
    }
    const body = await arcgisPost(`${config.PORTAL_URL}/sharing/rest/generateToken`, {
      username: config.LAIS_ARCGIS_USERNAME,
      password: config.LAIS_ARCGIS_PASSWORD,
      client: "referer",
      referer: config.LAIS_ARCGIS_REFERER,
      expiration: "30",
    });
    if (!body.token) throw new ArcGisError("ArcGIS did not issue an integration token");
    tokenCache = { value: body.token, expiresAt: body.expires ?? Date.now() + 25 * 60_000 };
    return body.token as string;
  })().finally(() => {
    tokenInFlight = null;
  });
  return tokenInFlight;
}

/** Run `fn` with a service token; if ArcGIS says the token is invalid/expired, refresh once and retry. */
export async function withServiceToken<T>(fn: (token: string) => Promise<T>): Promise<T> {
  try {
    return await fn(await serviceToken());
  } catch (error) {
    if (error instanceof ArcGisError && error.code !== undefined && TOKEN_ERRORS.has(error.code)) {
      tokenCache = null;
      return fn(await serviceToken(true));
    }
    throw error;
  }
}

/** Test hook: forget cached tokens. */
export function resetServiceTokenForTests(): void {
  tokenCache = null;
  tokenInFlight = null;
}
