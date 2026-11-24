import type Graphic from "@arcgis/core/Graphic.js";
import type FeatureLayer from "@arcgis/core/layers/FeatureLayer.js";
import { useApp } from "../../stores/appStore";
import { useEditing } from "../../stores/editingStore";
import { layerRegistry, type ServiceLayerInfo } from "../layers/layerRegistry";
import { selectionService } from "../selection/selectionService";
import { asShownOnMap } from "../layers/query";

/** The subset of the arcgis-editor element API used by the application. */
export interface EditorElement extends HTMLElement {
  activeWorkflow: unknown;
  componentOnReady?: () => Promise<unknown>;
  cancelWorkflow(): Promise<void>;
  startCreateFeaturesWorkflowAtFeatureTypeSelection(): Promise<void>;
  startUpdateFeaturesWorkflow(features: Graphic[]): Promise<void>;
  startUpdateWorkflowAtFeatureEdit(feature: Graphic): Promise<void>;
  startUpdateWorkflowAtFeatureSelection(): Promise<void>;
  startSplitFeatureWorkflow(feature: Graphic, options: Record<string, unknown>): Promise<void>;
  startMergeFeaturesWorkflow(features: Graphic[], options: Record<string, unknown>): Promise<void>;
}

let editor: EditorElement | null = null;
const waiters = new Set<(e: EditorElement) => void>();

export function registerEditor(el: EditorElement | null) {
  editor = el;
  if (el) {
    waiters.forEach((w) => w(el));
    waiters.clear();
  }
}

/** Open the Editing panel and resolve once the Editor component is ready. */
async function whenEditor(): Promise<EditorElement> {
  if (useEditing.getState().session !== "editing") throw new Error("Start editing first.");
  useApp.getState().setPref("leftPanel", "editing");
  useApp.getState().setPref("leftOpen", true);
  const el =
    editor ??
    (await new Promise<EditorElement>((resolve, reject) => {
      waiters.add(resolve);
      setTimeout(() => reject(new Error("The Editor did not start.")), 15000);
    }));
  await el.componentOnReady?.();
  if (el.activeWorkflow) await el.cancelWorkflow();
  return el;
}

export function isEditorWorkflowActive(): boolean {
  return !!editor?.activeWorkflow;
}

export function isLayerEditable(info: ServiceLayerInfo | undefined): boolean {
  if (!info || info.kind !== "feature" || info.layer.editingEnabled === false) return false;
  const ops = info.layer.capabilities?.operations;
  return !!ops && (ops.supportsAdd || ops.supportsUpdate || ops.supportsDelete) && ops.supportsEditing !== false;
}

async function queryFull(layer: FeatureLayer, ids: number[]): Promise<Graphic[]> {
  const fs = await layer.queryFeatures(asShownOnMap(layer, { objectIds: ids, outFields: ["*"], returnGeometry: true }));
  fs.features.forEach((f) => (f.layer = layer));
  return fs.features;
}

/** Selected features of exactly one editable layer (for split / merge / modify). */
function singleLayerSelection(): { info: ServiceLayerInfo; ids: number[] } {
  const sel = useEditing.getState().selection;
  if (!sel.length) throw new Error("Select the feature(s) to edit first.");
  if (sel.length > 1) throw new Error("Select features from a single layer.");
  const info = layerRegistry.get(sel[0]!.layerKey)!;
  if (!isLayerEditable(info)) throw new Error(`"${info.name}" is not editable.`);
  return { info, ids: selectionService.getIds(info) };
}

export const editorBridge = {
  async create() {
    const el = await whenEditor();
    await el.startCreateFeaturesWorkflowAtFeatureTypeSelection();
  },

  /** Modify the current selection (move, rotate, scale, vertices, attributes). */
  async modify() {
    const el = await whenEditor();
    const sel = useEditing.getState().selection;
    if (!sel.length) return el.startUpdateWorkflowAtFeatureSelection();
    const { info, ids } = singleLayerSelection();
    if (ids.length > 200) throw new Error("Modify at most 200 features at once.");
    const features = await queryFull(info.layer, ids);
    if (features.length === 1) await el.startUpdateWorkflowAtFeatureEdit(features[0]!);
    else await el.startUpdateFeaturesWorkflow(features);
  },

  async editFeature(layerKey: string, objectId: number) {
    const info = layerRegistry.get(layerKey);
    if (!isLayerEditable(info)) throw new Error("This layer is not editable.");
    const el = await whenEditor();
    const [feature] = await queryFull(info!.layer, [objectId]);
    if (!feature) throw new Error("Feature not found.");
    await el.startUpdateWorkflowAtFeatureEdit(feature);
  },

  async split() {
    const { info, ids } = singleLayerSelection();
    if (ids.length !== 1) throw new Error("Select exactly one feature to split.");
    if (!["esriGeometryPolygon", "esriGeometryPolyline"].includes(info.geometryType ?? ""))
      throw new Error("Only line and polygon features can be split.");
    const el = await whenEditor();
    const [feature] = await queryFull(info.layer, ids);
    await el.startSplitFeatureWorkflow(feature!, {});
  },

  async merge() {
    const { info, ids } = singleLayerSelection();
    if (ids.length < 2) throw new Error("Select at least two features in the same layer to merge.");
    if (ids.length > 100) throw new Error("Merge at most 100 features at once.");
    const el = await whenEditor();
    const features = await queryFull(info.layer, ids);
    await el.startMergeFeaturesWorkflow(features, {});
  },

  async cancel() {
    if (editor?.activeWorkflow) await editor.cancelWorkflow();
  },

  /** Cancel an update, split or merge workflow (they act on the selection); leave a create running. */
  async cancelSelectionWorkflow() {
    const type = (editor?.activeWorkflow as { type?: string } | null | undefined)?.type;
    if (type && type !== "create-features") await editor!.cancelWorkflow();
  },
};
