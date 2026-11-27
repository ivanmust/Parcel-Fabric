import { Injectable } from "@nestjs/common";
import { config } from "../../config/env.js";
import { logger } from "../../common/logging/logger.js";

const HEALTH_TTL_MS = 15_000;

type ArcGisHealth = { reachable: boolean; version?: unknown; latencyMs?: number };

@Injectable()
export class SystemService {
  private lastCheck: { at: number; arcgis: ArcGisHealth } | null = null;

  /** Cached briefly so this public endpoint can't make the server hammer ArcGIS. */
  async health() {
    if (!this.lastCheck || Date.now() - this.lastCheck.at > HEALTH_TTL_MS) {
      this.lastCheck = { at: Date.now(), arcgis: await this.checkArcGis() };
    }
    return { status: "ok", time: new Date().toISOString(), arcgis: this.lastCheck.arcgis };
  }

  private async checkArcGis(): Promise<ArcGisHealth> {
    const started = Date.now();
    try {
      const response = await fetch(`${config.ARCGIS_SERVER_URL}/rest/info?f=json`, { signal: AbortSignal.timeout(10_000) });
      const info = (await response.json()) as { fullVersion?: string; currentVersion?: number };
      return { reachable: response.ok, version: info.fullVersion ?? info.currentVersion, latencyMs: Date.now() - started };
    } catch (error) {
      logger.warn({ err: (error as Error).message }, "ArcGIS Enterprise health check failed");
      return { reachable: false };
    }
  }

  /** Public, non-secret settings for the web app. */
  clientConfig() {
    return {
      portalUrl: config.PORTAL_URL,
      serverUrl: config.ARCGIS_SERVER_URL,
      oauthAppId: config.ARCGIS_OAUTH_APP_ID || null,
      services: config.services,
      project: { name: "Kigali Parcel Fabric", dataset: "kigaliParcels" },
      features: { laisEditingDone: config.LAIS_EDITING_DONE === "true" },
    };
  }
}
