import { useCallback, useState } from "react";
import type ListItem from "@arcgis/core/widgets/LayerList/ListItem.js";
import type { ListItemModifierEvent } from "@arcgis/core/widgets/LayerList/types.js";
import type { LayerListViewModelTriggerActionEvent } from "@arcgis/core/widgets/LayerList/LayerListViewModel.js";
import { useMapController, useMapView } from "../../hooks/useMapController";
import { layerRegistry } from "../../gis/layers/layerRegistry";
import { useApp } from "../../stores/appStore";
import { ConfirmDialog } from "../dialogs/ConfirmDialog";

/** Build the per-layer transparency slider shown in the layer list item panel. */
function opacityPanel(item: ListItem): HTMLElement {
  const wrap = document.createElement("div");
  wrap.style.padding = "8px 12px 12px";
  const label = document.createElement("calcite-label");
  label.textContent = "Transparency";
  label.setAttribute("scale", "s");
  const slider = document.createElement("calcite-slider") as HTMLElement & { value: number };
  slider.setAttribute("min", "0");
  slider.setAttribute("max", "100");
  slider.setAttribute("step", "5");
  slider.setAttribute("label-handles", "");
  slider.setAttribute("scale", "s");
  slider.value = Math.round((1 - (item.layer?.opacity ?? 1)) * 100);
  slider.addEventListener("calciteSliderInput", () => {
    if (item.layer) item.layer.opacity = 1 - Number(slider.value) / 100;
  });
  label.appendChild(slider);
  wrap.appendChild(label);
  return wrap;
}

export function ContentsPanel() {
  const view = useMapView();
  const ctrl = useMapController();
  const [tab, setTab] = useState<"layers" | "legend">("layers");
  const [pendingRemove, setPendingRemove] = useState<ListItem | null>(null);

  const listItemCreated = useCallback((event: ListItemModifierEvent) => {
    const item = event.item;
    const layer = item.layer;
    if (!layer || layer.id === "app-markers") return;
    const isOperationalTop = view?.map?.layers.includes(layer as never);
    const isService = !!layerRegistry.findByLayer(layer as never);
    const sections: { title: string; id: string; icon: string; type: "button" }[][] = [
      [
        { title: "Zoom to layer", id: "zoom-to", icon: "zoom-to-object", type: "button" },
        ...(isService
          ? [
              { title: "Layer properties", id: "properties", icon: "information", type: "button" as const },
              { title: "Open attribute table", id: "table", icon: "table", type: "button" as const },
            ]
          : []),
      ],
    ];
    if (isOperationalTop && !["parcel-fabric-fs", "parcel-fabric-ms"].includes(String(layer.id))) {
      sections.push([{ title: "Remove layer", id: "remove", icon: "trash", type: "button" }]);
    }
    item.actionsSections = sections as never;
    if ("opacity" in layer) {
      // Use the Legend *component* (the "legend" shortcut instantiates the deprecated widget).
      const legend = document.createElement("arcgis-legend") as HTMLElement & { view: unknown; layerInfos: unknown };
      legend.view = view;
      legend.layerInfos = [{ layer }];
      item.panel = { content: [opacityPanel(item), legend], icon: "sliders-horizontal", title: "Transparency & legend" } as never;
    }
  }, [view]);

  const onAction = useCallback(
    (e: CustomEvent<LayerListViewModelTriggerActionEvent>) => {
      const { action, item } = e.detail;
      const layer = item.layer;
      if (!layer) return;
      const app = useApp.getState();
      const info = layerRegistry.findByLayer(layer as never);
      switch (action.id) {
        case "zoom-to":
          void ctrl.goToLayer(layer as never);
          break;
        case "properties":
          if (info) app.showProperties({ kind: "layer", layerKey: info.key });
          break;
        case "table":
          if (info) app.openBottomTab("table", info.key);
          break;
        case "remove":
          setPendingRemove(item);
          break;
      }
    },
    [ctrl],
  );

  return (
    <calcite-panel heading="Contents" description="Layers drawn in the map">
      <calcite-segmented-control
        slot="content-top"
        width="full"
        scale="s"
        oncalciteSegmentedControlChange={(e) => setTab((e.target as HTMLElement & { value: string }).value as "layers" | "legend")}
      >
        <calcite-segmented-control-item value="layers" checked={tab === "layers" || undefined}>
          Layers
        </calcite-segmented-control-item>
        <calcite-segmented-control-item value="legend" checked={tab === "legend" || undefined}>
          Legend
        </calcite-segmented-control-item>
      </calcite-segmented-control>

      {!view ? (
        <div className="ps-panel-body">
          <div className="ps-skel" style={{ width: "70%" }} />
          <div className="ps-skel" style={{ width: "55%" }} />
          <div className="ps-skel" style={{ width: "62%" }} />
        </div>
      ) : (
        <>
          <arcgis-layer-list
            view={view}
            hidden={tab !== "layers"}
            dragEnabled
            showFilter
            minFilterItems={6}
            filterPlaceholder="Filter layers"
            visibilityAppearance="checkbox"
            showErrors
            showTemporaryLayerIndicators
            listItemCreatedFunction={listItemCreated}
            onarcgisTriggerAction={onAction as never}
          />
          <arcgis-legend view={view} hidden={tab !== "legend"} />
        </>
      )}

      <ConfirmDialog
        open={!!pendingRemove}
        title="Remove layer?"
        message={`"${pendingRemove?.title ?? "Layer"}" will be removed from the map. The data on the server is not affected.`}
        confirmLabel="Remove"
        kind="danger"
        onCancel={() => setPendingRemove(null)}
        onConfirm={() => {
          if (pendingRemove?.layer) ctrl.removeLayer(pendingRemove.layer as never);
          useApp.getState().log("info", "layers", `Removed layer "${pendingRemove?.title}"`);
          setPendingRemove(null);
        }}
      />
    </calcite-panel>
  );
}
