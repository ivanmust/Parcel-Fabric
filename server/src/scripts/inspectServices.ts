/**
 * Inspect the five ParcelFabric services with an authenticated token and write
 * a metadata report to docs/service-inspection.json (+ a readable summary).
 *
 * Usage (credentials come from server/.env, which is git-ignored):
 *   ARCGIS_USERNAME=... ARCGIS_PASSWORD=... npm run inspect-services
 *
 * The token lives only in memory and is never written to disk or logged.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "../config/env.js";

const REFERER = config.APP_ORIGINS[0] ?? "http://localhost:5174";

async function generateToken(): Promise<string> {
  const username = process.env.ARCGIS_USERNAME;
  const password = process.env.ARCGIS_PASSWORD;
  if (!username || !password) {
    throw new Error("Set ARCGIS_USERNAME and ARCGIS_PASSWORD in server/.env (a named Portal account, not the DB owner).");
  }
  const r = await fetch(`${config.PORTAL_URL}/sharing/rest/generateToken`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ f: "json", username, password, client: "referer", referer: REFERER, expiration: "30" }),
  });
  const body = (await r.json()) as { token?: string; error?: { message: string } };
  if (!body.token) throw new Error(`generateToken failed: ${body.error?.message ?? r.status}`);
  return body.token;
}

async function getJson(url: string, token: string, extra: Record<string, string> = {}): Promise<unknown> {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Referer: `${REFERER}/` },
    body: new URLSearchParams({ f: "json", token, ...extra }),
  });
  return r.json();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

async function main() {
  const token = await generateToken();
  const s = config.services;
  const report: Record<string, Json> = { inspectedAt: new Date().toISOString() };

  report.serverInfo = await getJson(`${config.ARCGIS_SERVER_URL}/rest/info`, token);
  report.mapServer = await getJson(s.mapServer, token);
  report.mapServerLayers = await getJson(`${s.mapServer}/layers`, token);
  report.featureServer = await getJson(s.featureServer, token);
  report.featureServerLayers = await getJson(`${s.featureServer}/layers`, token);
  report.parcelFabricServer = await getJson(s.parcelFabricServer, token);
  report.versionManagementServer = await getJson(s.versionManagementServer, token);
  report.versionInfos = await getJson(`${s.versionManagementServer}/versionInfos`, token);
  report.validationServer = await getJson(s.validationServer, token);

  // Who is this account in Portal (licence / privileges decide Parcel Fabric access).
  const self: Json = await getJson(`${config.PORTAL_URL}/sharing/rest/community/self`, token);
  report.portalUser = {
    username: self.username,
    role: self.role,
    userLicenseTypeId: self.userLicenseTypeId,
    privileges: self.privileges,
    groups: (self.groups ?? []).map((g: Json) => ({ id: g.id, title: g.title })),
  };
  // Licence add-ons (user type extensions such as Advanced Editing).
  report.portalUserLicenses = await getJson(
    `${config.PORTAL_URL}/sharing/rest/community/users/${encodeURIComponent(self.username)}/userLicenseType`,
    token,
  ).catch((e: Error) => ({ error: e.message }));

  // Real data footprint + counts per feature layer (service fullExtent can be the whole SR domain).
  report.layerStats = {};
  for (const l of (report.featureServerLayers?.layers ?? []) as Json[]) {
    if (l.type !== "Feature Layer") continue;
    const q: Json = await getJson(`${s.featureServer}/${l.id}/query`, token, {
      where: "1=1",
      returnCountOnly: "true",
      returnExtentOnly: "true",
    });
    report.layerStats[l.id] = { name: l.name, count: q.count, extent: q.extent, defaultVisibility: l.defaultVisibility };
  }

  const outDir = path.resolve(import.meta.dirname, "../../../docs");
  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, "service-inspection.json"), JSON.stringify(report, null, 2));

  // Human-readable summary
  const fs: Json = report.featureServer;
  const layers: Json[] = [...(report.featureServerLayers?.layers ?? []), ...(report.featureServerLayers?.tables ?? [])];
  const lines = [
    `ArcGIS Server: ${report.serverInfo?.fullVersion}`,
    `FeatureServer capabilities: ${fs?.capabilities}`,
    `Portal user: ${report.portalUser.username} role=${report.portalUser.role} userType=${report.portalUser.userLicenseTypeId}`,
    `  edit privileges: ${(report.portalUser.privileges ?? []).filter((p: string) => p.startsWith("features:")).join(", ") || "none"}`,
    `  licences: ${JSON.stringify(report.portalUserLicenses).slice(0, 400)}`,
    `  hasBranchVersionedData / hasVersionedData: ${fs?.hasBranchVersionedData ?? "?"} / ${fs?.hasVersionedData ?? "?"}`,
    `Layer stats: ${Object.entries(report.layerStats)
      .map(([id, v]: [string, Json]) => `[${id}] ${v.name}=${v.count}${v.defaultVisibility === false ? " (hidden)" : ""}`)
      .join(", ")}`,
    `  spatialReference: ${JSON.stringify(fs?.spatialReference)}`,
    `  controllerDatasetLayers: ${JSON.stringify(fs?.controllerDatasetLayers ?? null)}`,
    `Layers/tables (${layers.length}):`,
    ...layers.map(
      (l) =>
        `  [${l.id}] ${l.name} — ${l.type}${l.geometryType ? ` ${l.geometryType}` : ""}, fields=${l.fields?.length ?? 0}, caps=${l.capabilities}`,
    ),
    `ParcelFabricServer: ${JSON.stringify(report.parcelFabricServer).slice(0, 800)}`,
    `VersionManagementServer: ${JSON.stringify(report.versionManagementServer).slice(0, 800)}`,
    `Versions: ${(report.versionInfos?.versions ?? []).map((v: Json) => v.versionName).join(", ")}`,
    `ValidationServer: ${JSON.stringify(report.validationServer).slice(0, 800)}`,
  ];
  await writeFile(path.join(outDir, "service-inspection-summary.txt"), lines.join("\n"));
  console.log(lines.join("\n"));
  console.log(`\nFull report: ${path.join(outDir, "service-inspection.json")}`);
}

main().catch((err: Error) => {
  console.error(err.message);
  process.exit(1);
});
