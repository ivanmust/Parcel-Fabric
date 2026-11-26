import VersionManagementService from "@arcgis/core/versionManagement/VersionManagementService.js";
import type { VersionIdentifier, VersionInfo } from "@arcgis/core/versionManagement/support/jsonTypes.js";
import type FeatureLayer from "@arcgis/core/layers/FeatureLayer.js";
import type Layer from "@arcgis/core/layers/Layer.js";
import * as reactiveUtils from "@arcgis/core/core/reactiveUtils.js";
import esriConfig from "@arcgis/core/config.js";
import { readRequestParam, urlPattern, type RequestParamsSource } from "../../utils/requestParams";
import { layerRegistry } from "../layers/layerRegistry";
import { getMapController } from "../map/MapController";
import { useEditing, isDefaultVersion } from "../../stores/editingStore";
import { useApp, hasPermission } from "../../stores/appStore";
import { isLaisVersionName } from "./laisVersions";
import { arcgisError, describeArcGISError, fetchServiceJson } from "../../services/arcgis/serviceMetadata";
import { audit } from "../../services/audit/audit";
import type { Permission } from "../../types/app";

/**
 * Branch-versioned editing workflow for the Parcel Fabric feature service:
 *
 *   changeVersion (startReading) → startEditing → applyEdits… → stopEditing(save|discard)
 *
 * The SDK attaches the session id of the VersionManagementService session to
 * every FeatureLayer.applyEdits for that service + version, so edits made by the
 * Editor, the attribute table or this app are always directed to the active
 * named version. Every state change is confirmed by the server before the UI
 * reports it.
 */
class VersionSession {
  vms: VersionManagementService | null = null;
  /**
   * Edit-session id per version (GUID without braces, upper case). Parcel Fabric and Validation
   * server operations must send the same session id as the version's edit session. The SDK sends it
   * on startEditing but does not expose it, so it is read from that request.
   */
  private sessionIds = new Map<string, string>();
  private watchedLayers = new Set<FeatureLayer>();

  private get store() {
    return useEditing.getState();
  }

  /** Layers whose gdbVersion follows the active version. */
  private versionedLayers(): Layer[] {
    const layers: Layer[] = layerRegistry.fabricLayers().map((i) => i.layer);
    const ms = getMapController().map.findLayerById("parcel-fabric-ms");
    if (ms) layers.push(ms);
    return layers;
  }

  async init(url: string): Promise<void> {
    if (this.vms) return;
    const vms = new VersionManagementService({ url });
    try {
      await vms.load();
    } catch (e) {
      useApp.getState().log("warning", "versions", "Version Management Service unavailable – editing disabled", describeArcGISError(e));
      this.store.patch({ session: "unavailable" });
      return;
    }
    this.vms = vms;
    this.captureSessionIds(url);
    const def = vms.defaultVersionIdentifier ?? null;
    this.store.patch({ defaultVersion: def, current: def, session: "reading" });
    useApp.getState().setActiveVersionName(def?.name ?? null);
    useApp.getState().log("info", "versions", `Version Management Service loaded; reading ${def?.name ?? "default"}`);
    void this.refreshVersions();
    this.watchLayerEdits();
    layerRegistry.subscribe(() => this.watchLayerEdits());
    const cfg = useApp.getState().config;
    if (cfg) void this.probeAdvancedEditing(layerRegistry.featureServiceJson, cfg.services.parcelFabricServer);
    // Best effort: release locks when the tab is closed (the SDK request may not complete).
    window.addEventListener("pagehide", () => void this.releaseLocks());
  }

  async refreshVersions(): Promise<VersionInfo[]> {
    if (!this.vms) return [];
    this.store.patch({ versionsLoading: true });
    try {
      const versions = await this.vms.getVersionInfos();
      versions.sort((a, b) => a.versionIdentifier.name.localeCompare(b.versionIdentifier.name));
      this.store.patch({ versions });
      return versions;
    } catch (e) {
      useApp.getState().notify("danger", "Could not list versions", describeArcGISError(e));
      return [];
    } finally {
      this.store.patch({ versionsLoading: false });
    }
  }

  getVersionInfoExtended(id: VersionIdentifier) {
    return this.vms!.getVersionInfoExtended(id);
  }

  /** Release this client's shared read lock on a named version (no-op for DEFAULT / no lock). */
  private async releaseReadLock(id: VersionIdentifier) {
    const vms = this.requireVms();
    if (vms.getLockType(id) === "none") return;
    const res = await vms.stopReadingWithResult(id);
    if (!res.success) throw new Error(res.error?.message ?? `Could not release the read lock on ${id.name}.`);
  }

  /**
   * Release server locks held by this browser (sign-out / page close). Unsaved
   * edits are never saved implicitly: an open edit session is stopped with
   * saveEdits=false, after the user has been warned by beforeunload.
   */
  async releaseLocks(): Promise<void> {
    const vms = this.vms;
    const cur = this.store.current;
    if (!vms || !cur) return;
    try {
      if (vms.getLockType(cur) === "edit") await vms.stopEditing(cur, false);
      if (vms.getLockType(cur) !== "none") await vms.stopReading(cur);
    } catch {
      /* best effort */
    }
  }

  /**
   * ArcGIS requires the "Advanced Editing" user type extension for ANY edit to a
   * feature service that contains a Parcel Fabric or topology. The
   * ParcelFabricServer root answers 403 / "user type extension" for users without
   * it, which gives a read-only way to know before the first edit fails.
   */
  private async probeAdvancedEditing(featureServiceJson: Record<string, unknown> | null, parcelFabricServerUrl: string) {
    if (!featureServiceJson?.controllerDatasetLayers) {
      this.store.patch({ advancedEditing: "not-required" });
      return;
    }
    try {
      await fetchServiceJson(parcelFabricServerUrl);
      this.store.patch({ advancedEditing: "yes" });
    } catch (e) {
      const msg = describeArcGISError(e);
      const missing = /user type extension|licen[cs]e|not authorized|do not have access/i.test(msg);
      this.store.patch({ advancedEditing: missing ? "no" : "unknown" });
      if (missing)
        useApp
          .getState()
          .log("warning", "licensing", "Editing disabled: this Parcel Fabric service requires the ArcGIS Advanced Editing user type extension", msg);
    }
  }

  private captureSessionIds(vmsUrl: string) {
    const root = urlPattern(vmsUrl);
    esriConfig.request.interceptors?.push({
      urls: new RegExp(`^${root}/versions/([^/]+)/startEditing`, "i"),
      before: (params) => {
        const guid = /versions\/([^/]+)\/startEditing/i.exec(params.url)?.[1];
        const sessionId = readRequestParam(params.requestOptions as RequestParamsSource, "sessionId");
        if (guid && sessionId) this.sessionIds.set(normalizeGuid(guid), sessionId);
      },
    });
  }

  /** The edit-session id of the version being edited, or null when not in an edit session. */
  editSessionId(): string | null {
    const cur = this.store.current;
    if (this.store.session !== "editing" || !cur) return null;
    return this.sessionIds.get(normalizeGuid(cur.guid)) ?? null;
  }

  /**
   * Book-keeping after a Parcel Fabric / Validation server operation in the edit session: move the
   * layers to the operation's moment (so the map and app queries see its result), count the edits as
   * pending, and disable undo (the operation is not on the SDK's undo stack; Discard still rolls back).
   */
  recordServerOperation(label: string, result: { moment?: number; serviceEdits?: ServiceEditsJson[] }, auditTarget?: Record<string, unknown>) {
    const moment = result.moment ? new Date(result.moment) : null;
    if (moment) for (const i of layerRegistry.fabricLayers()) i.layer.historicMoment = moment;
    this.refreshLayers();
    let adds = 0;
    let updates = 0;
    let deletes = 0;
    for (const e of result.serviceEdits ?? []) {
      adds += e.editedFeatures?.adds?.length ?? 0;
      updates += e.editedFeatures?.updates?.length ?? 0;
      deletes += e.editedFeatures?.deletes?.length ?? 0;
    }
    this.store.patch({
      pendingEdits: this.store.pendingEdits + Math.max(1, adds + updates + deletes),
      fabricOpsInSession: this.store.fabricOpsInSession + 1,
      canUndo: false,
      canRedo: false,
    });
    this.store.addHistory({ kind: "edit", layer: "Parcel Fabric", action: label, adds, updates, deletes, failures: 0, ok: true });
    audit(`parcel-fabric.${label.toLowerCase().replace(/[^a-z]+/g, "-").replace(/^-|-$/g, "")}`, "success", this.store.current?.name, { adds, updates, deletes, ...auditTarget });
  }

  private requireVms(): VersionManagementService {
    if (!this.vms) throw new Error("Version Management Service is not available.");
    return this.vms;
  }

  /** Application-role check. ArcGIS still enforces its own permissions on every request. */
  private requirePermission(permission: Permission, message = "Your role does not allow version management.") {
    if (!hasPermission(useApp.getState().user, permission)) throw new Error(message);
  }

  private async run<T>(label: string, fn: () => Promise<T>): Promise<T> {
    this.store.patch({ busy: label });
    try {
      return await fn();
    } finally {
      this.store.patch({ busy: null });
    }
  }

  // ------------------------------------------------------------------ versions
  async switchTo(target: VersionIdentifier): Promise<void> {
    const vms = this.requireVms();
    const { current, session, pendingEdits } = this.store;
    if (!current || current.guid === target.guid) return;
    if (session === "editing" && pendingEdits > 0) throw new Error("Save or discard your edits before switching versions.");
    await this.run(`Switching to ${target.name}`, async () => {
      if (session === "editing") await this.stopEditing(false, { silent: true });
      // A version cannot be left while this session holds a lock on it: the edit
      // session leaves a shared (read) lock that must be released first.
      await this.releaseReadLock(current);
      // Switch when the map is idle: changing gdbVersion cancels in-flight tile requests.
      const view = getMapController().view;
      if (view?.updating)
        await Promise.race([reactiveUtils.whenOnce(() => !view.updating), new Promise((r) => setTimeout(r, 5000))]);
      const ok = await vms.changeVersion(this.versionedLayers() as never, current, target);
      if (!ok) throw new Error(`The server did not switch to ${target.name}.`);
      this.store.patch({ current: target, session: "reading", pendingEdits: 0, canUndo: false, canRedo: false });
      useApp.getState().setActiveVersionName(target.name);
      getMapController().clearHighlight();
      getMapController().view?.selectionManager.clear();
      this.store.addHistory({ kind: "version", action: `Switched to ${target.name}`, ok: true });
      useApp.getState().notify("success", "Version changed", `Now reading ${target.name}`);
      audit("version.switch", "success", target.name, { from: current.name });
    });
  }

  async createVersion(name: string, access: "private" | "protected" | "public", description: string): Promise<VersionIdentifier> {
    const vms = this.requireVms();
    this.requirePermission("versions:manage");
    if (!/^[A-Za-z][A-Za-z0-9_]{0,61}$/.test(name))
      throw new Error("Version names start with a letter and use letters, digits or underscores (max 62).");
    return this.run(`Creating ${name}`, async () => {
      try {
        const info = await vms.createVersion({ versionName: name, access, description });
        this.store.addHistory({ kind: "version", action: `Created version ${info.versionIdentifier.name}`, ok: true });
        audit("version.create", "success", info.versionIdentifier.name, { access });
        await this.refreshVersions();
        return info.versionIdentifier;
      } catch (e) {
        audit("version.create", "failure", name, { error: describeArcGISError(e) });
        throw arcgisError(e);
      }
    });
  }

  async deleteVersion(id: VersionIdentifier): Promise<void> {
    const vms = this.requireVms();
    this.requirePermission("versions:manage");
    if (this.store.current?.guid === id.guid) throw new Error("Switch to another version before deleting this one.");
    if (this.store.defaultVersion?.guid === id.guid) throw new Error("The default version cannot be deleted.");
    await this.run(`Deleting ${id.name}`, async () => {
      const ok = await vms.deleteVersion(id);
      if (!ok) throw new Error(`The server did not delete ${id.name}.`);
      this.store.addHistory({ kind: "version", action: `Deleted version ${id.name}`, ok: true });
      audit("version.delete", "success", id.name);
      await this.refreshVersions();
    });
  }

  // ------------------------------------------------------------------ edit session
  canEditCurrentVersion(): { ok: boolean; reason?: string } {
    const app = useApp.getState();
    if (!this.vms) return { ok: false, reason: "Version Management Service unavailable." };
    if (!hasPermission(app.user, "features:edit")) return { ok: false, reason: "Your application role does not include editing." };
    if (!app.user?.canEditFeaturesInPortal) return { ok: false, reason: "Your Portal account lacks the feature-editing privilege." };
    if (this.store.advancedEditing === "no")
      return {
        ok: false,
        reason:
          "ArcGIS Enterprise rejects edits to this Parcel Fabric service for your account: the ArcGIS Advanced Editing user type extension is required (Portal → Organization → Licenses).",
      };
    if (isDefaultVersion(this.store) && app.user.appRole !== "ADMINISTRATOR")
      return { ok: false, reason: "Edit in a named version. Only administrators may edit the default version." };
    return { ok: true };
  }

  /**
   * @param forVersionOperation reconcile/post only need an exclusive session and the
   *   version-management permission – not the feature-editing licence (verified
   *   against the server: reconcile succeeds without Advanced Editing).
   */
  async startEditing(forVersionOperation = false): Promise<void> {
    const vms = this.requireVms();
    if (forVersionOperation) {
      this.requirePermission("versions:manage");
    } else {
      const check = this.canEditCurrentVersion();
      if (!check.ok) throw new Error(check.reason);
    }
    const current = this.store.current!;
    this.store.patch({ session: "starting" });
    try {
      const res = await vms.startEditingWithResult(current);
      if (!res.success) throw new Error(res.error?.message ?? "The server refused to start an edit session.");
      this.store.patch({ session: "editing", pendingEdits: 0, fabricOpsInSession: 0 });
      this.updateUndoState();
      this.store.addHistory({ kind: "session", action: "Started editing", ok: true });
      audit("edit-session.start", "success", current.name);
      window.addEventListener("beforeunload", beforeUnload);
    } catch (e) {
      this.store.patch({ session: "reading" });
      audit("edit-session.start", "failure", current.name, { error: describeArcGISError(e) });
      throw arcgisError(e);
    }
  }

  /** Stop the session; `save=false` rolls back every edit since the last save. */
  async stopEditing(save: boolean, opts: { silent?: boolean } = {}): Promise<void> {
    const vms = this.requireVms();
    const current = this.store.current!;
    const pending = this.store.pendingEdits;
    this.store.patch({ session: "stopping" });
    try {
      const res = await vms.stopEditingWithResult(current, save);
      if (!res.success) throw new Error(res.error?.message ?? "The server could not stop the edit session.");
      this.store.patch({ session: "reading", pendingEdits: 0, canUndo: false, canRedo: false });
      window.removeEventListener("beforeunload", beforeUnload);
      this.store.addHistory({ kind: "session", action: save ? `Saved ${pending} edit(s) and stopped editing` : `Discarded ${pending} edit(s) and stopped editing`, ok: true });
      audit(save ? "edit-session.save" : "edit-session.discard", "success", current.name, { pending });
      if (!save) this.refreshLayers();
      if (!opts.silent) useApp.getState().notify("success", save ? "Edits saved" : "Edits discarded", `${pending} edit(s) in ${current.name}`);
    } catch (e) {
      this.store.patch({ session: "editing" });
      audit(save ? "edit-session.save" : "edit-session.discard", "failure", current.name, { error: describeArcGISError(e) });
      throw arcgisError(e);
    }
  }

  /** Save and keep editing. */
  async save(): Promise<void> {
    await this.run("Saving", async () => {
      await this.stopEditing(true);
      await this.startEditing();
    });
  }

  /** Discard everything since the last save and keep editing. */
  async discard(): Promise<void> {
    await this.run("Discarding", async () => {
      await this.stopEditing(false);
      await this.startEditing();
    });
  }

  undo(): void {
    const vms = this.requireVms();
    const cur = this.store.current!;
    if (this.store.fabricOpsInSession > 0 || !vms.canUndo(cur)) return;
    vms.undo(cur);
    this.store.addHistory({ kind: "session", action: "Undo", ok: true });
    setTimeout(() => this.afterUndoRedo(), 800);
  }

  redo(): void {
    const vms = this.requireVms();
    const cur = this.store.current!;
    if (this.store.fabricOpsInSession > 0 || !vms.canRedo(cur)) return;
    vms.redo(cur);
    this.store.addHistory({ kind: "session", action: "Redo", ok: true });
    setTimeout(() => this.afterUndoRedo(), 800);
  }

  private afterUndoRedo() {
    this.updateUndoState();
    this.refreshLayers();
  }

  updateUndoState() {
    const cur = this.store.current;
    if (!this.vms || !cur) return;
    const blocked = this.store.fabricOpsInSession > 0;
    this.store.patch({ canUndo: !blocked && this.vms.canUndo(cur), canRedo: !blocked && this.vms.canRedo(cur) });
  }

  // ------------------------------------------------------------------ reconcile & post
  async reconcile(opts: { withPost: boolean; abortIfConflicts: boolean; conflictDetection: "by-object" | "by-attribute" }) {
    const vms = this.requireVms();
    const current = this.store.current!;
    if (isDefaultVersion(this.store)) throw new Error("The default version cannot be reconciled with itself.");
    if (opts.withPost) this.requirePermission("versions:post", "Your role does not allow posting to the default version.");
    if (opts.withPost && useApp.getState().config?.features?.laisEditingDone && isLaisVersionName(current.name)) {
      throw new Error("LAIS transaction versions are posted when the registrar approves in LAIS. Use LAIS transactions ▸ Editing done.");
    }
    return this.run(opts.withPost ? "Reconciling and posting" : "Reconciling", async () => {
      const startedHere = this.store.session !== "editing";
      if (startedHere) await this.startEditing(true);
      try {
        const res = await vms.reconcile(current, {
          withPost: opts.withPost,
          abortIfConflicts: opts.abortIfConflicts,
          conflictDetection: opts.conflictDetection,
        });
        const ok = res.success;
        this.store.addHistory({
          kind: "version",
          action: opts.withPost ? "Reconcile & post" : "Reconcile",
          ok,
          detail: `conflicts: ${res.hasConflicts ? "yes" : "no"}${opts.withPost ? `, posted: ${res.didPost ? "yes" : "no"}` : ""}`,
        });
        audit(opts.withPost ? "version.reconcile-post" : "version.reconcile", ok ? "success" : "failure", current.name, {
          hasConflicts: res.hasConflicts,
          didPost: res.didPost,
        });
        if (startedHere) await this.stopEditing(true, { silent: true });
        this.refreshLayers();
        return res;
      } catch (e) {
        if (startedHere && this.store.session === "editing") await this.stopEditing(false, { silent: true }).catch(() => undefined);
        audit("version.reconcile", "failure", current.name, { error: describeArcGISError(e) });
        throw arcgisError(e);
      }
    });
  }

  // ------------------------------------------------------------------ edit tracking
  private watchLayerEdits() {
    for (const info of layerRegistry.fabricLayers()) {
      if (this.watchedLayers.has(info.layer)) continue;
      this.watchedLayers.add(info.layer);
      info.layer.on("edits", (e) => {
        const results = [...e.addedFeatures, ...e.updatedFeatures, ...e.deletedFeatures];
        const failed = results.filter((r) => r.error);
        this.store.patch({ pendingEdits: this.store.pendingEdits + results.length - failed.length });
        this.store.addHistory({
          kind: "edit",
          layer: info.name,
          action: "applyEdits",
          adds: e.addedFeatures.length,
          updates: e.updatedFeatures.length,
          deletes: e.deletedFeatures.length,
          failures: failed.length,
          ok: failed.length === 0,
          detail: failed[0]?.error?.message,
        });
        audit("feature.edit", failed.length ? "failure" : "success", `${info.name} @ ${this.store.current?.name}`, {
          layerId: info.serviceLayerId,
          adds: e.addedFeatures.map((r) => r.objectId),
          updates: e.updatedFeatures.map((r) => r.objectId),
          deletes: e.deletedFeatures.map((r) => r.objectId),
          failures: failed.length,
        });
        this.updateUndoState();
        window.dispatchEvent(new CustomEvent("ps:features-edited", { detail: { layerKey: info.key, edits: e } }));
      });
    }
  }

  refreshLayers() {
    for (const i of layerRegistry.fabricLayers()) i.layer.refresh();
  }
}

/** Edits returned by Parcel Fabric / Validation server operations (`serviceEdits`). */
export interface ServiceEditsJson {
  id: number;
  editedFeatures?: { adds?: unknown[]; updates?: unknown[]; deletes?: unknown[] };
}

const normalizeGuid = (g: string) => g.replace(/[{}]/g, "").toUpperCase();

function beforeUnload(e: BeforeUnloadEvent) {
  if (useEditing.getState().pendingEdits > 0) {
    e.preventDefault();
    e.returnValue = "";
  }
}

export const versionSession = new VersionSession();
