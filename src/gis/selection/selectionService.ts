import SketchViewModel from "@arcgis/core/widgets/Sketch/SketchViewModel.js";
import GraphicsLayer from "@arcgis/core/layers/GraphicsLayer.js";
import type MapView from "@arcgis/core/views/MapView.js";
import type FeatureLayer from "@arcgis/core/layers/FeatureLayer.js";
import type { GeometryUnion } from "@arcgis/core/unionTypes.js";
import * as unionOperator from "@arcgis/core/geometry/operators/unionOperator.js";
import Multipoint from "@arcgis/core/geometry/Multipoint.js";
import type Point from "@arcgis/core/geometry/Point.js";
import Polygon from "@arcgis/core/geometry/Polygon.js";
import Polyline from "@arcgis/core/geometry/Polyline.js";
import { layerRegistry, type ServiceLayerInfo } from "../layers/layerRegistry";
import { getMapController } from "../map/MapController";
import { useEditing, type SelectionMode } from "../../stores/editingStore";
import { useApp } from "../../stores/appStore";
import { describeArcGISError } from "../../services/arcgis/serviceMetadata";
import { asShownOnMap } from "../layers/query";

export type DrawTool = "rectangle" | "polygon" | "lasso";
/** Which source features define the location: those selected, or all of them in the current map view. */
export type SourceScope = "selected" | "view";
export type SpatialRelation = "intersects" | "contains" | "within" | "touches" | "crosses" | "overlaps" | "envelope-intersects";

/** Source features are combined in the browser and sent as one query shape; above this the map view is too large. */
const MAX_SOURCE_FEATURES = 10000;
/** Below the service's maxRecordCount (2,000), so no request is cut short. */
const SOURCE_BATCH = 1000;
/** Source shapes sent together in one query when they don't need to be merged. */
const QUERY_BATCH = 200;
const PARALLEL_QUERIES = 4;
/** Relationships a target has with a set of shapes exactly when it has them with at least one of them. */
const PER_SHAPE: readonly SpatialRelation[] = ["intersects", "envelope-intersects"];

/** Shapes of one kind as a single multi-part geometry, unchanged (no merging of their boundaries). */
function asOneGeometry(shapes: GeometryUnion[]): GeometryUnion {
  const [first] = shapes;
  const spatialReference = first!.spatialReference;
  if (first!.type === "polygon") return new Polygon({ rings: shapes.flatMap((g) => (g as Polygon).rings), spatialReference });
  if (first!.type === "polyline") return new Polyline({ paths: shapes.flatMap((g) => (g as Polyline).paths), spatialReference });
  if (first!.type === "point") return new Multipoint({ points: shapes.map((g) => [(g as Point).x, (g as Point).y]), spatialReference });
  return new Multipoint({ points: shapes.flatMap((g) => (g as Multipoint).points), spatialReference });
}


class SelectionService {
  private sketch: SketchViewModel | null = null;
  private sketchLayer = new GraphicsLayer({ id: "app-selection-sketch", listMode: "hide", title: "Selection sketch" });
  private watching = false;

  private view(): MapView {
    const v = getMapController().view;
    if (!v) throw new Error("Map is not ready.");
    return v;
  }

  /** Watch the SelectionManager and publish a per-layer summary to the store. */
  watch(view: MapView) {
    if (this.watching) return;
    this.watching = true;
    // Layers nested in group layers are not picked up automatically: keep the
    // SelectionManager's sources equal to the registered feature layers.
    const syncSources = () => {
      view.selectionManager.sources = layerRegistry
        .all()
        .filter((i) => i.kind === "feature")
        .map((i) => i.layer) as never;
    };
    syncSources();
    layerRegistry.subscribe(syncSources);
    const publish = () => {
      const summary = view.selectionManager.selections
        .map((s) => {
          const info = layerRegistry.findByLayer(s.layer as never);
          return info && s.selection.length ? { layerKey: info.key, name: info.name, count: s.selection.length } : null;
        })
        .filter((x): x is NonNullable<typeof x> => !!x);
      useEditing.getState().patch({ selection: summary });
    };
    view.selectionManager.on("selection-change", publish);
    publish();
  }

  /** Feature layers that can take part in selection (visible, queryable). */
  selectableLayers(visibleOnly = true): ServiceLayerInfo[] {
    return layerRegistry
      .all()
      .filter((i) => i.kind === "feature" && (!visibleOnly || (i.layer.visible && isVisibleInTree(i.layer))));
  }

  /** Apply a set of object IDs to one layer using the selection mode. */
  apply(layer: FeatureLayer, ids: number[], mode: SelectionMode) {
    const sm = this.view().selectionManager;
    switch (mode) {
      case "new":
        sm.replace(layer, ids);
        break;
      case "add":
        if (ids.length) sm.add(layer, ids);
        break;
      case "remove":
        if (ids.length) sm.remove(layer, ids);
        break;
      case "intersect": {
        const current = new Set((sm.getSelection(layer) ?? []) as number[]);
        sm.replace(
          layer,
          ids.filter((id) => current.has(id)),
        );
        break;
      }
    }
  }

  private resolveMode(modifiers?: { shift?: boolean; ctrl?: boolean }): SelectionMode {
    if (modifiers?.shift) return "add";
    if (modifiers?.ctrl) return "remove";
    return useEditing.getState().selectionMode;
  }

  async selectByGeometry(geometry: GeometryUnion, modifiers?: { shift?: boolean; ctrl?: boolean }, relation: SpatialRelation = "intersects") {
    const mode = this.resolveMode(modifiers);
    const targets = this.selectableLayers();
    if (mode === "new") this.view().selectionManager.clear();
    let total = 0;
    await Promise.all(
      targets.map(async (info) => {
        try {
          const ids = await info.layer.queryObjectIds(
            asShownOnMap(info.layer, {
              geometry,
              spatialRelationship: relation,
              where: "1=1",
            }),
          );
          this.apply(info.layer, ids as number[], mode === "new" ? "add" : mode);
          total += ids.length;
        } catch (e) {
          useApp.getState().log("warning", "selection", `Could not query ${info.name}`, describeArcGISError(e));
        }
      }),
    );
    this.report(mode, total);
  }

  async selectAtScreenPoint(screen: { x: number; y: number }, modifiers?: { shift?: boolean; ctrl?: boolean }) {
    const view = this.view();
    const mode = this.resolveMode(modifiers);
    const include = this.selectableLayers().map((i) => i.layer);
    const res = await view.hitTest(screen, { include });
    const hit = res.results.find((r) => r.type === "graphic");
    if (mode === "new") view.selectionManager.clear();
    if (hit && hit.type === "graphic") {
      const layer = hit.graphic.layer as FeatureLayer;
      const oid = hit.graphic.getObjectId();
      if (typeof oid === "number") {
        if (mode === "new" || mode === "add") view.selectionManager.add(layer, [oid]);
        else this.apply(layer, [oid], mode);
      }
    }
  }

  async selectByAttributes(info: ServiceLayerInfo, where: string, mode: SelectionMode): Promise<number> {
    const clause = where.trim() || "1=1";
    const ids = (await info.layer.queryObjectIds(asShownOnMap(info.layer, { where: clause }))) as number[];
    this.apply(info.layer, ids, mode);
    this.report(mode, ids.length, info.name);
    return ids.length;
  }

  /**
   * Select features of `target` by their spatial relationship to features of `source`: its selected
   * features, or all of its features in the current map view (optionally buffered by `distance` metres).
   */
  async selectByLocation(
    target: ServiceLayerInfo,
    source: ServiceLayerInfo,
    relation: SpatialRelation,
    distance: number,
    mode: SelectionMode,
    scope: SourceScope = "selected",
  ): Promise<number> {
    const view = this.view();
    const ids =
      scope === "selected"
        ? ((view.selectionManager.getSelection(source.layer) ?? []) as number[])
        : ((await source.layer.queryObjectIds(asShownOnMap(source.layer, { geometry: view.extent, where: "1=1" }))) as number[]);
    if (!ids.length)
      throw new Error(scope === "selected" ? `No features are selected in "${source.name}".` : `"${source.name}" has no features in this map view.`);
    if (ids.length > MAX_SOURCE_FEATURES)
      throw new Error(
        scope === "selected"
          ? `Use at most ${MAX_SOURCE_FEATURES} source features (you selected ${ids.length}).`
          : `"${source.name}" has ${ids.length.toLocaleString("en-US")} features in this view; the limit is ${MAX_SOURCE_FEATURES}. Zoom in or select the source features.`,
      );
    const geoms: GeometryUnion[] = [];
    for (let i = 0; i < ids.length; i += SOURCE_BATCH) {
      const fs = await source.layer.queryFeatures(asShownOnMap(source.layer, { objectIds: ids.slice(i, i + SOURCE_BATCH), returnGeometry: true, outFields: [] }));
      for (const f of fs.features) if (f.geometry) geoms.push(f.geometry as GeometryUnion);
    }
    if (!geoms.length) throw new Error("The selected source features have no geometry.");
    const query = (geometry: GeometryUnion) =>
      target.layer.queryObjectIds(
        asShownOnMap(target.layer, {
          geometry,
          spatialRelationship: relation,
          distance: distance > 0 ? distance : undefined,
          units: distance > 0 ? ("meters" as const) : undefined,
          where: "1=1",
        }),
      ) as Promise<number[]>;

    let result: number[];
    if (PER_SHAPE.includes(relation)) {
      // Exact: the source shapes are sent as they are, in batches. Merging them first moves shared
      // boundaries slightly and loses targets that lie exactly on an edge (fabric points do).
      const batches: GeometryUnion[][] = [];
      for (let i = 0; i < geoms.length; i += QUERY_BATCH) batches.push(geoms.slice(i, i + QUERY_BATCH));
      const found = new Set<number>();
      // A few requests at a time: faster than one by one, without flooding the server.
      for (let i = 0; i < batches.length; i += PARALLEL_QUERIES)
        for (const ids of await Promise.all(batches.slice(i, i + PARALLEL_QUERIES).map((b) => query(asOneGeometry(b))))) for (const id of ids) found.add(id);
      result = [...found];
    } else {
      // within / contains / touches / crosses / overlaps are about the sources as one shape.
      const geometry = geoms.length === 1 ? geoms[0]! : (unionOperator.executeMany(geoms as never) as GeometryUnion | null);
      if (!geometry) throw new Error("Could not combine the source geometries.");
      result = await query(geometry);
    }
    this.apply(target.layer, result, mode);
    this.report(mode, result.length, target.name);
    return result.length;
  }

  /** Draw a rectangle / polygon / lasso and select what it intersects. */
  draw(tool: DrawTool): Promise<void> {
    const view = this.view();
    if (!view.map?.layers.includes(this.sketchLayer)) view.map?.add(this.sketchLayer);
    this.sketch ??= new SketchViewModel({
      view,
      layer: this.sketchLayer,
      defaultCreateOptions: { hasZ: false },
      polygonSymbol: { type: "simple-fill", color: [0, 229, 255, 0.12], outline: { color: [0, 229, 255, 1], width: 1.5, style: "dash" } },
      updateOnGraphicClick: false,
    });
    this.sketch.cancel();
    const sketch = this.sketch;
    return new Promise((resolve) => {
      const h = sketch.on("create", async (e) => {
        if (e.state === "cancel") {
          h.remove();
          this.sketchLayer.removeAll();
          resolve();
        } else if (e.state === "complete") {
          h.remove();
          const geom = e.graphic?.geometry as GeometryUnion | undefined;
          this.sketchLayer.removeAll();
          if (geom) await this.selectByGeometry(geom, { shift: shiftDown, ctrl: ctrlDown });
          resolve();
          // Keep the tool active for the next selection.
          if (useApp.getState().tool === `select-${tool}`) void this.draw(tool);
        }
      });
      if (tool === "rectangle") void sketch.create("rectangle");
      else void sketch.create("polygon", { mode: tool === "lasso" ? "freehand" : "click" });
    });
  }

  cancelDraw() {
    this.sketch?.cancel();
    this.sketchLayer.removeAll();
  }

  clear() {
    getMapController().view?.selectionManager.clear();
    useEditing.getState().addHistory({ kind: "selection", action: "Cleared selection", ok: true });
  }

  clearLayer(info: ServiceLayerInfo) {
    getMapController().view?.selectionManager.replace(info.layer, []);
  }

  getIds(info: ServiceLayerInfo): number[] {
    return ((getMapController().view?.selectionManager.getSelection(info.layer) ?? []) as number[]).slice();
  }

  private report(mode: SelectionMode, count: number, layerName?: string) {
    const verb = mode === "remove" ? "Removed" : mode === "intersect" ? "Kept" : "Selected";
    useApp.getState().log("info", "selection", `${verb} ${count} feature(s)${layerName ? ` in ${layerName}` : ""} (${mode})`);
  }
}

function isVisibleInTree(layer: FeatureLayer): boolean {
  let p = layer.parent as unknown as { visible?: boolean; parent?: unknown } | null;
  while (p && "visible" in p) {
    if (p.visible === false) return false;
    p = p.parent as typeof p;
  }
  return true;
}

// Track modifier keys so sketch-based selections honour Shift (add) / Ctrl (remove).
let shiftDown = false;
let ctrlDown = false;
window.addEventListener("keydown", (e) => {
  shiftDown = e.shiftKey;
  ctrlDown = e.ctrlKey || e.metaKey;
});
window.addEventListener("keyup", (e) => {
  shiftDown = e.shiftKey;
  ctrlDown = e.ctrlKey || e.metaKey;
});

export const selectionService = new SelectionService();
