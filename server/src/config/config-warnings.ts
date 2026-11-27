import type { AppConfig } from "./env.js";

/**
 * Settings that let the server start but break part of the LAIS flow. Logged at startup (never
 * fatal: a server that refuses to start is worse than a warning), and checked by
 * scripts/diagnose-production.ps1 on the server.
 */
export function configWarnings(c: Pick<AppConfig, "NODE_ENV" | "APP_ORIGINS" | "LAIS_ARCGIS_REFERER" | "LAIS_EDITING_DONE" | "LAIS_WEBHOOK_URL" | "LAIS_WEBHOOK_KEY">): string[] {
  const warnings: string[] = [];
  const local = (url: string) => /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/i.test(url);

  if (c.NODE_ENV === "production" && c.APP_ORIGINS.length && c.APP_ORIGINS.every(local)) {
    warnings.push(
      `APP_ORIGINS has only local addresses (${c.APP_ORIGINS.join(", ")}): GIS editors signing in from the public web app are refused, so they cannot press "Editing done". Add the public origin, e.g. https://esrirw.rw.`,
    );
  }
  if (c.NODE_ENV === "production" && local(c.LAIS_ARCGIS_REFERER)) {
    warnings.push(`LAIS_ARCGIS_REFERER is a local address (${c.LAIS_ARCGIS_REFERER}); set it to the server's public origin.`);
  }
  if (c.LAIS_EDITING_DONE === "true") {
    if (!c.LAIS_WEBHOOK_URL || !c.LAIS_WEBHOOK_KEY) {
      warnings.push('LAIS_EDITING_DONE is on but LAIS_WEBHOOK_URL or LAIS_WEBHOOK_KEY is empty: "Editing done" cannot reach LAIS.');
    } else {
      const url = new URL(c.LAIS_WEBHOOK_URL);
      if (url.protocol === "http:") {
        warnings.push(`LAIS_WEBHOOK_URL uses plain http (${url.host}): the LAIS key and the parcel data travel unencrypted. Ask LAIS for an https address.`);
      }
      if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(url.hostname)) {
        warnings.push(`LAIS_WEBHOOK_URL points to a private network address (${url.hostname}): it works only if this server is on the same network or VPN as LAIS. Check with scripts/diagnose-production.ps1 on the server.`);
      }
    }
  }
  return warnings;
}
