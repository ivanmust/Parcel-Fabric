import ArcGISMap from "@arcgis/core/Map.js";
import MapView from "@arcgis/core/views/MapView.js";
import Graphic from "@arcgis/core/Graphic.js";
import GraphicsLayer from "@arcgis/core/layers/GraphicsLayer.js";
import Extent from "@arcgis/core/geometry/Extent.js";
import Point from "@arcgis/core/geometry/Point.js";
import type { GeometryUnion } from "@arcgis/core/unionTypes.js";
import SpatialReference from "@arcgis/core/geometry/SpatialReference.js";
import FeatureLayer from "@arcgis/core/layers/FeatureLayer.js";
import type Layer from "@arcgis/core/layers/Layer.js";
import type Basemap from "@arcgis/core/Basemap.js";
import * as reactiveUtils from "@arcgis/core/core/reactiveUtils.js";
import type { AppRuntimeConfig } from "../../types/app";
import { appActions, useApp } from "../../stores/appStore";
import { createBasemaps } from "./basemaps";
import { loadParcelFeatureService, loadParcelMapService, registerAddedLayer, unregisterLayer } from "../layers/layerLoader";
import { layerRegistry } from "../layers/layerRegistry";
import { ensureProjection, project, toWgs84 } from "../geometry/coordinates";
import { describeArcGISError, describeSpatialReference } from "../../services/arcgis/serviceMetadata";
import { selectionService } from "../selection/selectionService";
import { useEditing } from "../../stores/editingStore";
import { isEditorWorkflowActive } from "../editing/editorBridge";
import { versionSession } from "../version-management/versionSession";
import { asShownOnMap } from "../layers/query";
import { installServiceMetadataFixes } from "../layers/serviceMetadataFixes";
import { installUpiGuard } from "../parcel-fabric/upiGuard";

/** Kigali, used only until the service extent is known. */
const FALLBACK_CENTER: [number, number] = [30.0606, -1.9536];
const MAX_HISTORY = 50;

export interface IdentifyHit {
  layerKey: string;
  objectId: number;
}

type Handle = { remove(): void };

/**
 * Owns the ArcGIS MapView and everything that touches it. React components
 * call into this controller; the controller pushes small, throttled status
 * updates into the store so the map never re-renders because of React.
 */
export class MapController {
  readonly map: ArcGISMap;
  readonly basemaps: Basemap[];
  readonly markerLayer = new GraphicsLayer({ id: "app-markers", title: "Markers", listMode: "hide" });
  view: MapView | null = null;
  dataSpatialReference: SpatialReference | null = null;
  serviceExtent: Extent | null = null;

  private handles: Handle[] = [];
  private history: Extent[] = [];
  private historyIndex = -1;
  private navigatingHistory = false;
  private highlight: Handle | null = null;
  private highlightRequest = 0;
  private pointerFrame = 0;
  private abort = new AbortController();
  private readyListeners = new Set<(v: MapView) => void>();

  constructor() {
    this.basemaps = createBasemaps();
    const preferred = useApp.getState().basemapId;
    this.map = new ArcGISMap({
      basemap: this.basemaps.find((b) => b.id === preferred) ?? this.basemaps[0],
    });
  }

  /** Create the MapView in `container` and load the Parcel Fabric services. */
  async mount(container: HTMLDivElement, cfg: AppRuntimeConfig): Promise<void> {
    const view = new MapView({
      container,
      map: this.map,
      center: FALLBACK_CENTER,
      zoom: 13,
      popupEnabled: false,
      constraints: { snapToZoom: false },
      ui: { components: [] },
      highlights: [{ name: "default", color: "#00e5ff", haloOpacity: 0.95, fillOpacity: 0.2 }],
    });
    view.popup = { dockEnabled: true, dockOptions: { buttonEnabled: true, breakpoint: false, position: "top-right" } } as never;
    this.view = view;
    this.map.add(this.markerLayer);
    this.wireEvents(view);

    await view.when();
    appActions.patchMapStatus({ ready: true });
    this.readyListeners.forEach((l) => l(view));
    this.readyListeners.clear();
    ensureProjection().catch(() => appActions.log("warning", "map", "Projection engine failed to load"));
    selectionService.watch(view);
    await this.loadServices(cfg);
    // Versioning needs the service layers registered (they follow the active version).
    await versionSession.init(cfg.services.versionManagementServer);
  }

  onReady(fn: (v: MapView) => void): () => void {
    if (this.view?.ready) fn(this.view);
    else this.readyListeners.add(fn);
    return () => this.readyListeners.delete(fn);
  }

  private async loadServices(cfg: AppRuntimeConfig) {
    const { log, notify } = appActions;
    const signal = this.abort.signal;
    // Normalise known-invalid label settings in the published metadata before the SDK reads it.
    installServiceMetadataFixes(cfg.services.featureServer.replace(/\/FeatureServer$/i, ""));
    // UPI rules for every parcel attribute edit (form, table, app code): checked before applyEdits is sent.
    installUpiGuard(cfg.services.featureServer);
    log("info", "layers", "Loading Parcel Fabric FeatureServer metadata…", cfg.services.featureServer);
    try {
      const { group, tables, serviceJson, parcelLayerJson } = await loadParcelFeatureService(
        cfg.services.featureServer,
        cfg.services.mapServer,
        signal,
      );
      this.map.add(group, 0);
      if (parcelLayerJson) log("info", "layers", `Parcel Fabric controller: "${parcelLayerJson.name}" (layer ${parcelLayerJson.id})`);
      this.map.tables?.addMany(tables);
      if (serviceJson.spatialReference) {
        const sr = SpatialReference.fromJSON(serviceJson.spatialReference);
        this.dataSpatialReference = sr;
        appActions.patchMapStatus({
          dataWkid: sr.wkid ?? null,
          dataSrName: describeSpatialReference(serviceJson.spatialReference),
        });
      }
      // A service's fullExtent can be the whole spatial-reference domain (it is on this
      // service), so open at initialExtent and compute the real data extent afterwards.
      if (serviceJson.initialExtent) this.serviceExtent = Extent.fromJSON(serviceJson.initialExtent);
      const featureCount = layerRegistry.fabricLayers().filter((i) => i.kind === "feature").length;
      log(
        "success",
        "layers",
        `FeatureServer loaded: ${featureCount} feature layers, ${tables.length} tables`,
        `Capabilities: ${serviceJson.capabilities ?? "n/a"}`,
      );
      // Report per-layer load failures (e.g. permissions) instead of failing silently.
      for (const i of layerRegistry.fabricLayers())
        i.layer.load().catch((e: unknown) => log("error", "layers", `Layer "${i.name}" failed to load`, describeArcGISError(e)));
      await ensureProjection().catch(() => undefined);
      await this.goToFullExtent(false);
      void this.computeDataExtent(serviceJson.fullExtent);
    } catch (e) {
      if (signal.aborted) return;
      const msg = describeArcGISError(e);
      log("error", "layers", "Parcel Fabric FeatureServer failed to load", msg);
      notify("danger", "Feature service unavailable", msg);
    }
    try {
      const ms = await loadParcelMapService(cfg.services.mapServer, signal);
      this.map.add(ms, 0);
      log("success", "layers", "MapServer loaded (hidden by default)");
    } catch (e) {
      if (signal.aborted) return;
      log("warning", "layers", "Parcel Fabric MapServer failed to load", describeArcGISError(e));
    }
  }

  /**
   * Union of the server-computed extents of the parcel polygon and record
   * layers (`queryExtent`), which is what "Full extent" means to an editor.
   */
  private async computeDataExtent(fullExtentJson: unknown) {
    const candidates = layerRegistry
      .all()
      .filter((i) => i.fabricRole === "parcel-polygon" || i.fabricRole === "records");
    const pool = candidates.length ? candidates : layerRegistry.fabricLayers().filter((i) => i.kind === "feature");
    let union: Extent | null = null;
    for (const info of pool) {
      try {
        const { extent, count } = await info.layer.queryExtent(asShownOnMap(info.layer, {}));
        if (!extent || !count) continue;
        union = union ? union.union(extent) : extent.clone();
      } catch {
        /* layer not queryable – skip */
      }
    }
    if (union) {
      this.serviceExtent = union;
      appActions.log("info", "map", "Full extent set from parcel data extent");
    } else if (!this.serviceExtent && fullExtentJson) {
      this.serviceExtent = Extent.fromJSON(fullExtentJson);
    }
  }

  private wireEvents(view: MapView) {
    const { patchMapStatus } = appActions;
    this.handles.push(
      reactiveUtils.watch(
        () => view.updating,
        (updating) => patchMapStatus({ updating }),
      ),
      reactiveUtils.watch(
        () => view.stationary,
        (stationary) => stationary && this.onStationary(view),
        { initial: true },
      ),
      reactiveUtils.watch(
        () => this.map.basemap?.id,
        (id) => id && useApp.getState().setPref("basemapId", id),
      ),
      view.on("pointer-move", (e) => {
        cancelAnimationFrame(this.pointerFrame);
        this.pointerFrame = requestAnimationFrame(() => this.updatePointer(view.toMap({ x: e.x, y: e.y })));
      }),
      view.on("pointer-leave", () => patchMapStatus({ pointer: null })),
      view.on("click", (e) =>
        this.onClick(e.mapPoint, { x: e.x, y: e.y }, { shift: e.native?.shiftKey, ctrl: e.native?.ctrlKey || e.native?.metaKey }),
      ),
    );
  }

  private onStationary(view: MapView) {
    appActions.patchMapStatus({ scale: view.scale, zoom: view.zoom });
    if (!view.extent) return;
    if (this.navigatingHistory) {
      this.navigatingHistory = false;
    } else {
      const last = this.history[this.historyIndex];
      if (!last || !last.equals(view.extent)) {
        this.history = this.history.slice(0, this.historyIndex + 1);
        this.history.push(view.extent.clone());
        if (this.history.length > MAX_HISTORY) this.history.shift();
        this.historyIndex = this.history.length - 1;
      }
    }
    appActions.patchMapStatus({
      canGoBack: this.historyIndex > 0,
      canGoForward: this.historyIndex < this.history.length - 1,
    });
  }

  private updatePointer(mapPoint: Point | null | undefined) {
    if (!mapPoint) return;
    const geo = toWgs84(mapPoint);
    if (!geo) return;
    let x: number | undefined;
    let y: number | undefined;
    if (this.dataSpatialReference && !this.dataSpatialReference.isGeographic) {
      const p = project(mapPoint, this.dataSpatialReference);
      if (p) {
        x = p.x;
        y = p.y;
      }
    }
    appActions.patchMapStatus({ pointer: { lon: geo.longitude ?? geo.x, lat: geo.latitude ?? geo.y, x, y } });
  }

  private async onClick(mapPoint: Point, screen: { x: number; y: number }, modifiers: { shift?: boolean; ctrl?: boolean }) {
    const tool = useApp.getState().tool;
    // While an Editor workflow is running, clicks belong to the Editor.
    if (isEditorWorkflowActive() || useEditing.getState().manualSplit?.phase === "drawing") return;
    if (tool === "explore") await this.identify(screen);
    else if (tool === "coordinate-info") this.showCoordinateInfo(mapPoint);
    else if (tool === "select-click")
      await selectionService
        .selectAtScreenPoint(screen, modifiers)
        .catch((e) => appActions.log("error", "selection", "Selection failed", describeArcGISError(e)));
  }

  /** Hit-test operational feature layers and open the result in the properties panel. */
  async identify(screen: { x: number; y: number }): Promise<IdentifyHit[]> {
    const view = this.view;
    if (!view) return [];
    const include = layerRegistry
      .all()
      .filter((i) => i.kind === "feature" && i.layer.visible)
      .map((i) => i.layer);
    if (!include.length) return [];
    try {
      const res = await view.hitTest(screen, { include });
      const hits: IdentifyHit[] = [];
      for (const r of res.results) {
        if (r.type !== "graphic") continue;
        const info = layerRegistry.findByLayer(r.graphic.layer as Layer);
        if (!info) continue;
        const oid = r.graphic.getObjectId();
        if (typeof oid === "number") hits.push({ layerKey: info.key, objectId: oid });
      }
      if (hits.length) {
        useApp.getState().showProperties({ kind: "features", hits, index: 0 });
        await this.highlightFeature(hits[0]!);
      } else {
        this.clearHighlight();
        useApp.getState().showProperties({ kind: "none" });
      }
      return hits;
    } catch (e) {
      appActions.log("error", "identify", "Identify failed", describeArcGISError(e));
      return [];
    }
  }

  async highlightFeature(hit: IdentifyHit) {
    this.clearHighlight();
    const request = ++this.highlightRequest;
    const info = layerRegistry.get(hit.layerKey);
    if (!info || !this.view) return;
    const lv = await this.view.whenLayerView(info.layer);
    if (request !== this.highlightRequest) return; // a newer highlight was requested meanwhile
    this.highlight = lv.highlight(hit.objectId);
    useApp.getState().patchMapStatus({ highlighted: true });
  }

  clearHighlight() {
    this.highlightRequest++;
    this.highlight?.remove();
    this.highlight = null;
    if (useApp.getState().mapStatus.highlighted) useApp.getState().patchMapStatus({ highlighted: false });
  }

  showCoordinateInfo(mapPoint: Point) {
    const geo = toWgs84(mapPoint);
    if (!geo) return;
    this.placeMarker(mapPoint, "coordinate");
    useApp.getState().showProperties({ kind: "coordinates", lon: geo.x, lat: geo.y });
  }

  placeMarker(point: Point, kind: "coordinate" | "goto" | "locate") {
    this.markerLayer.removeAll();
    const color = kind === "locate" ? [0, 122, 255] : kind === "goto" ? [255, 64, 129] : [255, 196, 0];
    this.markerLayer.add(
      new Graphic({
        geometry: point,
        symbol: {
          type: "simple-marker",
          style: kind === "goto" ? "cross" : "circle",
          size: kind === "goto" ? 18 : 12,
          color,
          outline: { color: kind === "goto" ? color : [255, 255, 255], width: 2 },
        },
      }),
    );
  }

  clearMarkers() {
    this.markerLayer.removeAll();
  }

  /** Outline a feature (e.g. a historic parcel or a topology error) and zoom to it. */
  async showOutline(geometry: GeometryUnion) {
    this.markerLayer.removeAll();
    this.markerLayer.add(
      new Graphic({
        geometry,
        symbol:
          geometry.type === "point" || geometry.type === "multipoint"
            ? { type: "simple-marker", color: [255, 152, 0, 0.3], size: 16, outline: { color: [255, 152, 0], width: 2.5 } }
            : geometry.type === "polyline"
              ? { type: "simple-line", color: [255, 152, 0], width: 5 }
              : { type: "simple-fill", color: [255, 152, 0, 0.12], outline: { color: [255, 152, 0], width: 2.5, style: "dash" } },
      }),
    );
    // Show some surroundings: a point, or an error a few centimetres long, would zoom in too far.
    const extent = geometry.extent;
    const span = extent ? Math.max(extent.width, extent.height) : 0;
    const target = extent && span > 0 ? extent.clone().expand(Math.max(1.5, 30 / span)) : { target: geometry, scale: 500 };
    await this.view?.goTo(target, { duration: 400 }).catch(ignoreInterrupt);
  }

  // ---------------------------------------------------------------- navigation
  zoomBy(factor: number) {
    const v = this.view;
    if (!v) return;
    v.goTo({ scale: v.scale / factor }, { duration: 250 }).catch(ignoreInterrupt);
  }

  async goBack() {
    if (this.historyIndex <= 0 || !this.view) return;
    this.historyIndex--;
    this.navigatingHistory = true;
    await this.view.goTo(this.history[this.historyIndex], { duration: 300 }).catch(ignoreInterrupt);
  }

  async goForward() {
    if (this.historyIndex >= this.history.length - 1 || !this.view) return;
    this.historyIndex++;
    this.navigatingHistory = true;
    await this.view.goTo(this.history[this.historyIndex], { duration: 300 }).catch(ignoreInterrupt);
  }

  async goToFullExtent(animate = true) {
    const v = this.view;
    if (!v || !this.serviceExtent) return;
    const ext = project(this.serviceExtent, v.spatialReference);
    if (ext) await v.goTo(ext.expand(1.05), { duration: animate ? 400 : 0 }).catch(ignoreInterrupt);
  }

  async goToPoint(point: Point, scale?: number) {
    const v = this.view;
    if (!v) return;
    const target = project(point, v.spatialReference);
    if (!target) throw new Error("This coordinate could not be projected to the map's spatial reference.");
    this.placeMarker(target, "goto");
    await v.goTo({ target, scale: scale ?? Math.min(v.scale, 5000) }, { duration: 400 }).catch(ignoreInterrupt);
  }

  async goToLayer(layer: Layer) {
    const v = this.view;
    if (!v) return;
    await layer.load();
    let extent: Extent | null | undefined = layer.fullExtent;
    if (layer instanceof FeatureLayer) {
      try {
        extent = (await layer.queryExtent(asShownOnMap(layer, {}))).extent ?? extent;
      } catch {
        /* fall back to fullExtent */
      }
    }
    if (!extent) return;
    const ext = project(extent, v.spatialReference);
    if (ext) await v.goTo(ext.expand(1.1), { duration: 400 }).catch(ignoreInterrupt);
  }

  locate(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) return reject(new Error("Geolocation is not supported by this browser."));
      navigator.geolocation.getCurrentPosition(
        async (pos) => {
          const p = new Point({ longitude: pos.coords.longitude, latitude: pos.coords.latitude });
          const target = project(p, this.view!.spatialReference) ?? p;
          this.placeMarker(target, "locate");
          await this.view?.goTo({ target, scale: 4000 }, { duration: 400 }).catch(ignoreInterrupt);
          resolve();
        },
        (err) => reject(new Error(err.message || "Location unavailable")),
        { enableHighAccuracy: true, timeout: 15000 },
      );
    });
  }

  // ---------------------------------------------------------------- layers
  addLayer(layer: Layer) {
    registerAddedLayer(layer);
    this.map.add(layer);
  }

  removeLayer(layer: Layer) {
    unregisterLayer(layer);
    this.map.remove(layer);
    layer.destroy();
  }

  destroy() {
    this.abort.abort();
    this.handles.forEach((h) => h.remove());
    this.handles = [];
    this.clearHighlight();
    this.view?.destroy();
    this.view = null;
  }
}

function ignoreInterrupt(e: unknown) {
  if ((e as { name?: string })?.name !== "AbortError" && !(e as Error)?.message?.includes("interrupted")) throw e;
}

let instance: MapController | null = null;
export function getMapController(): MapController {
  instance ??= new MapController();
  return instance;
}
