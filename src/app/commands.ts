import { getMapController } from "../gis/map/MapController";
import { useApp } from "../stores/appStore";
import { useEditing } from "../stores/editingStore";
import { versionSession } from "../gis/version-management/versionSession";
import { selectionService } from "../gis/selection/selectionService";
import { editorBridge, isEditorWorkflowActive } from "../gis/editing/editorBridge";
import type { MapTool } from "../types/app";
import { parcelFabricService } from "../gis/parcel-fabric/parcelFabricService";

const onlyParcelsSelected = (selection: { layerKey: string }[]) =>
  selection.length === 1 && parcelFabricService.isParcelLayer(selection[0]!.layerKey);

/** Commands that need a confirmation dialog are raised as events and handled by <EditCommandDialogs/>. */
export function requestConfirm(kind: "delete-selected" | "discard" | "stop-editing" | "start-default") {
  window.dispatchEvent(new CustomEvent("ps:confirm", { detail: kind }));
}

async function guarded(label: string, fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (e) {
    useApp.getState().notify("warning", label, (e as Error).message);
  }
}

/** Every toolbar button and keyboard shortcut dispatches through here. */
export function runCommand(id: string): void {
  const app = useApp.getState();
  const ed = useEditing.getState();
  const ctrl = getMapController();
  const setTool = (t: MapTool) => app.setTool(app.tool === t && t !== "explore" ? "explore" : t);
  const editing = ed.session === "editing";

  switch (id) {
    case "explore":
    case "pan":
    case "measure-distance":
    case "measure-area":
    case "coordinate-info":
    case "select-click":
    case "select-rectangle":
    case "select-polygon":
    case "select-lasso":
      setTool(id);
      break;
    case "zoom-in":
      ctrl.zoomBy(2);
      break;
    case "zoom-out":
      ctrl.zoomBy(0.5);
      break;
    case "back":
      void ctrl.goBack();
      break;
    case "forward":
      void ctrl.goForward();
      break;
    case "full":
      if (!ctrl.serviceExtent) app.notify("warning", "Full extent unavailable", "The Parcel Fabric service extent has not loaded.");
      else void ctrl.goToFullExtent();
      break;
    case "locate":
      ctrl.locate().catch((e: Error) => app.notify("warning", "Location unavailable", e.message));
      break;
    case "goto":
      app.setDialog("goTo", true);
      break;

    // ---- selection
    case "select-attributes":
      ed.patch({ selectByAttributesOpen: true });
      break;
    case "select-location":
      ed.patch({ selectByLocationOpen: true });
      break;
    case "clear-selection":
      // Modify / split / merge work on the selected features: close them too, so the Editor is not
      // left editing a feature that no longer looks selected. A create in progress is kept.
      void editorBridge.cancelSelectionWorkflow();
      selectionService.clear();
      // A feature highlighted by identify or a search looks selected too: clear it and its details.
      ctrl.clearHighlight();
      if (app.properties.kind === "features") app.showProperties({ kind: "none" });
      break;

    // ---- edit session
    case "toggle-editing":
      if (editing) requestConfirm("stop-editing");
      else if (ed.current && ed.defaultVersion && ed.current.guid === ed.defaultVersion.guid) requestConfirm("start-default");
      else void guarded("Cannot start editing", () => versionSession.startEditing());
      break;
    case "save":
      if (editing) void guarded("Save failed", () => versionSession.save());
      break;
    case "discard":
      if (editing) requestConfirm("discard");
      break;
    case "undo":
      if (editing) void guarded("Undo failed", async () => versionSession.undo());
      break;
    case "redo":
      if (editing) void guarded("Redo failed", async () => versionSession.redo());
      break;
    case "create":
      void guarded("Create", () => editorBridge.create());
      break;
    case "modify":
      void guarded("Modify", () => editorBridge.modify());
      break;
    // Parcels are split and merged with Parcel Fabric operations (lineage kept); other layers use the Editor.
    case "split":
      if (onlyParcelsSelected(ed.selection)) ed.patch({ divideParcelOpen: true });
      else void guarded("Split", () => editorBridge.split());
      break;
    case "merge":
      if (onlyParcelsSelected(ed.selection)) ed.patch({ mergeParcelsOpen: true });
      else void guarded("Merge", () => editorBridge.merge());
      break;
    case "delete":
      if (!editing) app.notify("warning", "Delete", "Start editing first.");
      else if (!ed.selection.length) app.notify("warning", "Delete", "Select the features to delete first.");
      else requestConfirm("delete-selected");
      break;
    case "versions":
      ed.patch({ versionDialogOpen: true });
      break;

    // ---- workspace
    case "toggle-left":
      app.setPref("leftOpen", !app.leftOpen);
      break;
    case "toggle-right":
      app.setPref("rightOpen", !app.rightOpen);
      break;
    case "toggle-bottom":
      app.setPref("bottomOpen", !app.bottomOpen);
      break;
    case "help":
      app.setDialog("shortcuts", true);
      break;
    case "escape":
      if (isEditorWorkflowActive()) {
        void editorBridge.cancel();
        break;
      }
      app.setTool("explore");
      selectionService.cancelDraw();
      ctrl.clearHighlight();
      ctrl.clearMarkers();
      app.showProperties({ kind: "none" });
      break;
  }
}
