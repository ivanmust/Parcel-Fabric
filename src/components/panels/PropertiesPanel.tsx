import { useApp } from "../../stores/appStore";
import { Resizer } from "../common/Resizer";
import { FeatureProperties } from "./properties/FeatureProperties";
import { LayerProperties } from "./properties/LayerProperties";
import { CoordinateProperties } from "./properties/CoordinateProperties";

export function PropertiesPanel({ open }: { open: boolean }) {
  const target = useApp((s) => s.properties);
  const close = () => useApp.getState().setPref("rightOpen", false);

  return (
    <aside className={`ps-side right ${open ? "" : "closed"}`} aria-label="Properties" aria-hidden={!open}>
      <Resizer cssVar="--ps-right-w" axis="x" min={280} max={720} direction={-1} label="Resize properties panel" />
      <calcite-panel
        heading="Properties"
        description={
          target.kind === "features" ? "Selected feature" : target.kind === "layer" ? "Layer" : target.kind === "coordinates" ? "Location" : undefined
        }
      >
        <calcite-action slot="header-actions-end" icon="x" text="Close panel" onClick={close} />
        {target.kind === "none" && (
          <div className="ps-empty">
            <calcite-icon icon="cursor-click" scale="l" />
            <h4>Nothing selected</h4>
            <p>
              Click a feature on the map with the Explore tool (<span className="ps-kbd">E</span>), or open layer
              properties from the Contents panel.
            </p>
          </div>
        )}
        {target.kind === "features" && <FeatureProperties hits={target.hits} index={target.index} />}
        {target.kind === "layer" && <LayerProperties layerKey={target.layerKey} />}
        {target.kind === "coordinates" && <CoordinateProperties lon={target.lon} lat={target.lat} />}
      </calcite-panel>
    </aside>
  );
}
