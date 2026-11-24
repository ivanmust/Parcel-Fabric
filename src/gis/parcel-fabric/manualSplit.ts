import Graphic from "@arcgis/core/Graphic.js";
import GraphicsLayer from "@arcgis/core/layers/GraphicsLayer.js";
import Polyline from "@arcgis/core/geometry/Polyline.js";
import SketchViewModel from "@arcgis/core/widgets/Sketch/SketchViewModel.js";
import type Polygon from "@arcgis/core/geometry/Polygon.js";
import * as areaOperator from "@arcgis/core/geometry/operators/areaOperator.js";
import * as cutOperator from "@arcgis/core/geometry/operators/cutOperator.js";
import * as multiPartToSinglePartOperator from "@arcgis/core/geometry/operators/multiPartToSinglePartOperator.js";
import { useApp } from "../../stores/appStore";
import { useEditing } from "../../stores/editingStore";
import { getMapController } from "../map/MapController";
import { ensureProjection, project } from "../geometry/coordinates";
import { createSnappingOptions } from "../editing/snapping";
import { editorBridge } from "../editing/editorBridge";
import { selectionService } from "../selection/selectionService";
import { parcelFabricService } from "./parcelFabricService";

/** Each end of the drawn line is lengthened this much, so an end snapped onto the boundary still cuts through it. */
const END_OVERSHOOT_M = 0.05;
const MIN_PART_M2 = 0.5;
const PART_COLORS = [
  [255, 152, 0],
  [124, 77, 255],
];

function lengthenEnds(path: number[][]): number[][] {
  const beyond = (end: number[], inner: number[]) => {
    const dx = end[0]! - inner[0]!;
    const dy = end[1]! - inner[1]!;
    const length = Math.hypot(dx, dy) || 1;
    return [end[0]! + (dx / length) * END_OVERSHOOT_M, end[1]! + (dy / length) * END_OVERSHOOT_M];
  };
  return [beyond(path[0]!, path[1]!), ...path.slice(1, -1), beyond(path.at(-1)!, path.at(-2)!)];
}

/** The two parts of a parcel cut by a line (both in the parcel's coordinate system), or a readable error. */
function cutInTwo(parcel: Polygon, line: Polyline): [Polygon, Polygon] {
  const path = line.paths[0]?.filter((p, i, all) => i === 0 || Math.hypot(p[0]! - all[i - 1]![0]!, p[1]! - all[i - 1]![1]!) > 0.001);
  if (!path || path.length < 2) throw new Error("Draw a line with at least two different points.");
  if (multiPartToSinglePartOperator.executeMany([parcel]).length > 1) throw new Error("This parcel has several separate pieces, so it can't be split with one line.");

  const cut = cutOperator.execute(parcel, new Polyline({ paths: [lengthenEnds(path)], spatialReference: parcel.spatialReference }));
  const parts = cut.length ? (multiPartToSinglePartOperator.executeMany(cut) as Polygon[]) : [];
  if (parts.length < 2) throw new Error("The line doesn't cross the whole parcel. Start and end on its boundary, or outside it.");
  if (parts.length > 2) throw new Error(`The line cuts the parcel into ${parts.length} parts. Cross it once, then split a new part again for more.`);
  if (parts.some((p) => Math.abs(areaOperator.execute(p)) < MIN_PART_M2)) throw new Error("One part would be smaller than 0.5 m². Draw the line further from the edge.");
  return [parts[0]!, parts[1]!];
}

/** Manual subdivision: draw a line across one parcel, preview both parts, then split through the Parcel Fabric. */
class ManualSplit {
  private layer = new GraphicsLayer({ id: "app-manual-split", listMode: "hide", title: "Manual split" });
  private sketch: SketchViewModel | null = null;
  private plan: { objectId: number; parcel: Polygon; part: Polygon } | null = null;
  private request = 0;

  get drawing() {
    return useEditing.getState().manualSplit?.phase === "drawing";
  }

  async draw(objectId: number): Promise<void> {
    this.cancel();
    const request = this.request;
    const ctrl = getMapController();
    const view = ctrl.view;
    if (!view) throw new Error("The map is not ready.");
    parcelFabricService.requireSplitReady();
    await ensureProjection();
    const parcel = await parcelFabricService.editableGeometry(objectId);
    const shown = project(parcel, view.spatialReference);
    if (!shown) throw new Error("The parcel could not be shown on the map.");
    await editorBridge.cancel();
    if (request !== this.request) return; // cancelled meanwhile

    useApp.getState().setTool("explore");
    selectionService.cancelDraw();
    ctrl.clearHighlight();
    if (!ctrl.map.layers.includes(this.layer)) ctrl.map.add(this.layer);
    useEditing.getState().patch({ manualSplit: { phase: "drawing" } });

    const sketch = new SketchViewModel({
      view,
      layer: this.layer,
      updateOnGraphicClick: false,
      defaultCreateOptions: { hasZ: false },
      snappingOptions: createSnappingOptions(),
      tooltipOptions: { enabled: true, inputEnabled: true },
      // The survey unit is the metre, whatever the Portal's default units are.
      valueOptions: { displayUnits: { length: "meters" }, inputUnits: { length: "meters" } },
      polylineSymbol: { type: "simple-line", color: [255, 64, 129], width: 2.5 },
    });
    this.sketch = sketch;
    sketch.on("create", (e) => {
      if (this.sketch !== sketch) return;
      if (e.state === "cancel") this.cancel();
      else if (e.state === "complete") this.preview(objectId, parcel, e.graphic?.geometry as Polyline);
    });

    await view.goTo(shown.extent!.clone().expand(1.8), { duration: 400 }).catch(() => undefined);
    if (this.sketch !== sketch) return;
    view.focus();
    void sketch.create("polyline", { mode: "click" });
  }

  private preview(objectId: number, parcel: Polygon, drawn: Polyline) {
    const view = getMapController().view!;
    this.stopSketch();
    try {
      const line = project(drawn, parcel.spatialReference);
      if (!line) throw new Error("The line could not be converted to the parcel's coordinate system.");
      const parts = cutInTwo(parcel, line);
      this.layer.removeAll();
      parts.forEach((part, i) => {
        const shown = project(part, view.spatialReference)!;
        this.layer.add(new Graphic({ geometry: shown, symbol: { type: "simple-fill", color: [...PART_COLORS[i]!, 0.35], outline: { color: PART_COLORS[i]!, width: 2 } } }));
        this.layer.add(new Graphic({ geometry: shown.centroid, symbol: { type: "text", text: "AB"[i]!, color: "white", haloColor: "black", haloSize: 1.5, font: { size: 14, weight: "bold" } } }));
      });
      this.plan = { objectId, parcel, part: parts[0] };
      useEditing.getState().patch({ manualSplit: { phase: "ready", areas: parts.map((p) => Math.abs(areaOperator.execute(p))) } });
    } catch (e) {
      this.layer.removeAll();
      useEditing.getState().patch({ manualSplit: { phase: "invalid", message: (e as Error).message } });
    }
  }

  async commit(): Promise<number[]> {
    if (!this.plan) throw new Error("Draw the split line first.");
    const { objectId, parcel, part } = this.plan;
    try {
      return await parcelFabricService.splitOff(objectId, parcel, part);
    } finally {
      this.cancel();
    }
  }

  private stopSketch() {
    const sketch = this.sketch;
    this.sketch = null;
    // Destroyed after the event that may have triggered this has finished.
    if (sketch) queueMicrotask(() => sketch.destroy());
  }

  cancel() {
    this.request++;
    this.stopSketch();
    this.plan = null;
    this.layer.removeAll();
    if (useEditing.getState().manualSplit) useEditing.getState().patch({ manualSplit: null });
  }
}

export const manualSplit = new ManualSplit();
