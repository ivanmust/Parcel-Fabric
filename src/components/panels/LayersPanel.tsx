import { useState } from "react";
import { useMapController } from "../../hooks/useMapController";
import { createLayerFromPortalItem, createLayerFromUrl } from "../../gis/layers/layerLoader";
import { useApp } from "../../stores/appStore";
import { calciteInput } from "../../utils/calciteInput";
import { useAsyncAction } from "../../hooks/useAsyncAction";
import { ErrorNotice } from "../common/ErrorNotice";

type Mode = "url" | "item";

export function LayersPanel() {
  const ctrl = useMapController();
  const [mode, setMode] = useState<Mode>("url");
  const [value, setValue] = useState("");
  const { isBusy, error, setError, run } = useAsyncAction();
  const { notify, log } = useApp.getState();

  const add = async () => {
    const v = value.trim();
    if (!v) return;
    const failure = await run(async () => {
      if (mode === "item" && !/^[0-9a-f]{32}$/i.test(v)) throw new Error("A Portal item ID is 32 hexadecimal characters.");
      const layer = mode === "url" ? await createLayerFromUrl(v) : await createLayerFromPortalItem(v);
      ctrl.addLayer(layer);
      setValue("");
      notify("success", "Layer added", layer.title ?? undefined);
      void ctrl.goToLayer(layer);
    });
    if (failure) log("error", "layers", "Could not add layer", failure);
  };

  return (
    <calcite-panel heading="Layers" description="Add data to the map">
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
      </div>
    </calcite-panel>
  );
}
