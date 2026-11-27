import { randomUUID } from "node:crypto";
import { config } from "../../../config/env.js";
import { logger } from "../../../common/logging/logger.js";
import { arcgisPost, ArcGisError, type ArcGisJson } from "../../../common/arcgis/arcgis-client.js";
import { asConfigurationError } from "../domain/gis-errors.js";
import type { Attributes } from "../models/transaction.model.js";

export interface VersionRef {
  /** Fully qualified, e.g. owner.SUBV-X-20261125 */
  name: string;
  guid: string;
}

const vmsUrl = () => config.lais.versionManagementUrl;
const versionUrl = (version: VersionRef) => `${vmsUrl()}/versions/${version.guid.replace(/[{}]/g, "")}`;

/** The LAIS account's versions, by lower-case short name. */
export async function ownedVersions(token: string): Promise<Map<string, VersionRef>> {
  const body = await arcgisPost(`${vmsUrl()}/versionInfos`, { ownerFilter: config.LAIS_ARCGIS_USERNAME }, token);
  const owner = config.LAIS_ARCGIS_USERNAME.toLowerCase();
  const versions = new Map<string, VersionRef>();
  for (const v of (body.versions ?? []) as Array<{ versionName?: string; versionGuid?: string }>) {
    const fullName = String(v.versionName ?? "");
    const dot = fullName.lastIndexOf(".");
    if (dot < 0 || !v.versionGuid || fullName.slice(0, dot).toLowerCase() !== owner) continue;
    versions.set(fullName.slice(dot + 1).toLowerCase(), { name: fullName, guid: v.versionGuid });
  }
  return versions;
}

export async function findVersion(token: string, shortName: string): Promise<VersionRef | null> {
  return (await ownedVersions(token)).get(shortName.toLowerCase()) ?? null;
}

export async function createVersion(token: string, shortName: string, description: string): Promise<VersionRef> {
  try {
    const body = await arcgisPost(`${vmsUrl()}/create`, { versionName: shortName, description: description.slice(0, 60), accessPermission: "public" }, token);
    const info = body.versionInfo as { versionName?: string; versionGuid?: string } | undefined;
    if (!info?.versionName || !info.versionGuid) throw new ArcGisError("ArcGIS did not return the created version");
    return { name: info.versionName, guid: info.versionGuid };
  } catch (error) {
    // Another process may have just created it.
    const existing = await findVersion(token, shortName).catch(() => null);
    if (existing) return existing;
    throw error;
  }
}

function assertSuccess(body: ArcGisJson, what: string): void {
  if (body.success === false) throw new ArcGisError(`ArcGIS refused ${what}`);
}

/** An exclusive edit session on one version (VersionManagementServer start/stop reading and editing). */
export class VersionSession {
  readonly id = `{${randomUUID().toUpperCase()}}`;
  editing = false;

  constructor(
    private readonly token: string,
    readonly version: VersionRef,
  ) {}

  private call(operation: string, params: Record<string, string> = {}) {
    return arcgisPost(`${versionUrl(this.version)}/${operation}`, { sessionId: this.id, ...params }, this.token);
  }

  async startReading(): Promise<void> {
    assertSuccess(await this.call("startReading"), "startReading");
  }

  async stopReading(): Promise<void> {
    await this.call("stopReading");
  }

  async startEditing(): Promise<void> {
    assertSuccess(await this.call("startEditing"), "startEditing");
    this.editing = true;
  }

  async save(): Promise<void> {
    assertSuccess(await this.call("stopEditing", { saveEdits: "true" }), "stopEditing");
    this.editing = false;
  }

  async discard(): Promise<void> {
    await this.call("stopEditing", { saveEdits: "false" });
    this.editing = false;
  }

  /** Attribute updates of Plots, all or none. */
  async updatePlots(updates: Attributes[]): Promise<void> {
    const result = await arcgisPost(
      `${config.lais.plotLayerUrl}/applyEdits`,
      { gdbVersion: this.version.name, sessionID: this.id, rollbackOnFailure: "true", updates: JSON.stringify(updates.map((attributes) => ({ attributes }))) },
      this.token,
    );
    const results = (result.updateResults ?? []) as Array<{ success?: boolean; error?: { description?: string } }>;
    const failed = results.find((r) => !r.success);
    if (results.length !== updates.length || failed) throw new ArcGisError(failed?.error?.description ?? "ArcGIS did not confirm the Plot updates");
  }

  /** Reconcile with sde.DEFAULT and post; conflicts abort, so nothing is posted. */
  async reconcileAndPost(): Promise<ArcGisJson> {
    return this.call("reconcile", { abortIfConflicts: "true", conflictDetection: "byObject", withPost: "true", async: "false" });
  }
}

/** Run `work` in a session on the version; unsaved edits are discarded on failure and the read lock is always released. */
export async function withVersionSession<T>(token: string, version: VersionRef, work: (session: VersionSession) => Promise<T>): Promise<T> {
  const session = new VersionSession(token, version);
  let reading = false;
  try {
    await session.startReading();
    reading = true;
    return await work(session);
  } catch (error) {
    if (session.editing) {
      await session.discard().catch((e) => logger.error({ err: (e as Error).message, version: version.name }, "LAIS: could not discard edit session"));
    }
    throw error;
  } finally {
    if (reading) await session.stopReading().catch((e) => logger.warn({ err: (e as Error).message, version: version.name }, "LAIS: could not release read lock"));
  }
}

/** Attribute updates of Plots inside the version, saved in one session (all or none). */
export async function editInVersion(token: string, version: VersionRef, updates: Attributes[]): Promise<void> {
  try {
    await withVersionSession(token, version, async (session) => {
      await session.startEditing();
      await session.updatePlots(updates);
      await session.save();
    });
  } catch (error) {
    throw asConfigurationError(error);
  }
}

export interface LayerDifferences {
  inserts: number[];
  updates: number[];
  deletes: number[];
}

/** Object ids the version's saved edits added, changed or deleted in one layer, compared with sde.DEFAULT. */
export async function versionDifferences(token: string, version: VersionRef, layerId: number): Promise<LayerDifferences> {
  const body = await arcgisPost(`${versionUrl(version)}/differences`, { resultType: "objectIds", layers: JSON.stringify([layerId]) }, token);
  const layer = ((body.differences ?? []) as Array<{ layerId: number } & Partial<LayerDifferences>>).find((d) => d.layerId === layerId);
  return { inserts: layer?.inserts ?? [], updates: layer?.updates ?? [], deletes: layer?.deletes ?? [] };
}
