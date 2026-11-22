import { useState } from "react";
import type Layer from "@arcgis/core/layers/Layer.js";
import { useLayerRegistryVersion, useMapController } from "../../hooks/useMapController";
import { createLayerFromPortalItem, createLayerFromUrl } from "../../gis/layers/layerLoader";
import { useApp } from "../../stores/appStore";
import { ConfirmDialog } from "../dialogs/ConfirmDialog";
import { layerRegistry } from "../../gis/layers/layerRegistry";
import { friendlyGeometryType, geometryIcon } from "../../utils/format";
import { calciteInput } from "../../utils/calciteInput";
import { useAsyncAction } from "../../hooks/useAsyncAction";
import { ErrorNotice } from "../common/ErrorNotice";

type Mode = "url" | "item";

export function LayersPanel() {
  const ctrl = useMapController();
  useLayerRegistryVersion();
  const [mode, setMode] = useState<Mode>("url");
  const [value, setValue] = useState("");
  const { isBusy, error, setError, run } = useAsyncAction();
  const [added, setAdded] = useState<Layer[]>([]);
  const [pendingRemove, setPendingRemove] = useState<Layer | null>(null);
  const { notify, log, showProperties, openBottomTab } = useApp.getState();

  const add = async () => {
    const v = value.trim();
    if (!v) return;
    const failure = await run(async () => {
      if (mode === "item" && !/^[0-9a-f]{32}$/i.test(v)) throw new Error("A Portal item ID is 32 hexadecimal characters.");
      const layer = mode === "url" ? await createLayerFromUrl(v) : await createLayerFromPortalItem(v);
      ctrl.addLayer(layer);
      setAdded((a) => [layer, ...a]);
      setValue("");
      notify("success", "Layer added", layer.title ?? undefined);
      void ctrl.goToLayer(layer);
    });
    if (failure) log("error", "layers", "Could not add layer", failure);
  };

  const pfLayers = layerRegistry.fabricLayers();

  return (
    <calcite-panel heading="Layers" description="Add, inspect and remove data">
      <div className="ps-panel-body">
        <h3 className="ps-section-title">Add data</h3>
        <calcite-segmented-control
          width="full"
          scale="s"
          oncalciteSegmentedControlChange={(e) => setMode((e.target as HTMLElement & { value: string }).value as Mode)}
        >
          <calcite-segmented-control-item value="url" checked={mode === "url" || undefined}>
            Service URL
          </calcite-segmented-control-item>
          <calcite-segmented-control-item value="item" checked={mode === "item" || undefined}>
            Portal item ID
          </calcite-segmented-control-item>
        </calcite-segmented-control>
        <calcite-label scale="s">
          {mode === "url" ? "ArcGIS Server service or layer URL (HTTPS)" : "Portal item ID"}
          <calcite-input-text
            scale="s"
            value={value}
            placeholder={mode === "url" ? "https://…/rest/services/…/FeatureServer/0" : "e.g. 3f2b…(32 chars)"}
            oncalciteInputTextInput={calciteInput(setValue)}
            onKeyDown={(e) => e.key === "Enter" && void add()}
          />
        </calcite-label>
        <ErrorNotice message={error} onClose={() => setError(null)} />
        <calcite-button scale="s" icon-start="add-layer" loading={isBusy || undefined} disabled={!value.trim() || isBusy || undefined} onClick={() => void add()}>
          Add to map
        </calcite-button>

        <h3 className="ps-section-title">Added this session</h3>
        {added.length === 0 ? (
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>
            Layers you add from a URL, a Portal item or the Catalog appear here.
          </p>
        ) : (
          <calcite-list label="Added layers" scale="s">
            {added.map((l) => (
              <calcite-list-item key={l.uid} label={l.title ?? "Layer"} description={l.type}>
                <calcite-action slot="actions-end" icon="zoom-to-object" text="Zoom to" onClick={() => void ctrl.goToLayer(l)} />
                <calcite-action slot="actions-end" icon="trash" text="Remove" onClick={() => setPendingRemove(l)} />
              </calcite-list-item>
            ))}
          </calcite-list>
        )}

        <h3 className="ps-section-title">Parcel Fabric service layers ({pfLayers.length})</h3>
        {pfLayers.length === 0 ? (
          <div className="ps-skel" style={{ width: "60%" }} />
        ) : (
          <calcite-list label="Parcel Fabric layers" scale="s">
            {pfLayers.map((i) => (
              <calcite-list-item
                key={i.key}
                label={i.name}
                description={`id ${i.serviceLayerId} · ${friendlyGeometryType(i.geometryType)}`}
                onClick={() => showProperties({ kind: "layer", layerKey: i.key })}
              >
                <calcite-icon slot="content-start" icon={geometryIcon(i.geometryType)} scale="s" />
                <calcite-action slot="actions-end" icon="table" text="Attribute table" onClick={(e) => { e.stopPropagation(); openBottomTab("table", i.key); }} />
              </calcite-list-item>
            ))}
          </calcite-list>
        )}
      </div>

      <ConfirmDialog
        open={!!pendingRemove}
        title="Remove layer?"
        message={`"${pendingRemove?.title ?? "Layer"}" will be removed from the map. The data on the server is not affected.`}
        confirmLabel="Remove"
        kind="danger"
        onCancel={() => setPendingRemove(null)}
        onConfirm={() => {
          if (pendingRemove) {
            ctrl.removeLayer(pendingRemove);
            setAdded((a) => a.filter((l) => l !== pendingRemove));
          }
          setPendingRemove(null);
        }}
      />
    </calcite-panel>
  );
}
