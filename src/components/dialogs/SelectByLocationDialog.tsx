import { useState } from "react";
import { useEditing, type SelectionMode } from "../../stores/editingStore";
import { useApp } from "../../stores/appStore";
import { layerRegistry } from "../../gis/layers/layerRegistry";
import { selectionService, type SourceScope, type SpatialRelation } from "../../gis/selection/selectionService";
import { useLayerRegistryVersion } from "../../hooks/useMapController";
import { friendlyGeometryType } from "../../utils/format";
import { calciteInput } from "../../utils/calciteInput";
import { useAsyncAction } from "../../hooks/useAsyncAction";
import { ErrorNotice } from "../common/ErrorNotice";

const RELATIONS: { value: SpatialRelation; label: string }[] = [
  { value: "intersects", label: "Intersect the source features" },
  { value: "within", label: "Are within the source features" },
  { value: "contains", label: "Contain the source features" },
  { value: "touches", label: "Touch the boundary of the source" },
  { value: "crosses", label: "Cross the source features" },
  { value: "overlaps", label: "Overlap the source features" },
  { value: "envelope-intersects", label: "Envelope intersects the source" },
];

/** Select target-layer features by their spatial relationship to a source layer: its selected features, or those in the map view. */
export function SelectByLocationDialog() {
  useLayerRegistryVersion();
  const open = useEditing((s) => s.selectByLocationOpen);
  const selection = useEditing((s) => s.selection);
  const layers = layerRegistry.all().filter((i) => i.kind === "feature");
  const [targetKey, setTargetKey] = useState("");
  const [sourceKey, setSourceKey] = useState("");
  const [relation, setRelation] = useState<SpatialRelation>("intersects");
  const [distance, setDistance] = useState("0");
  const [mode, setMode] = useState<SelectionMode>("new");
  const [scopeChoice, setScopeChoice] = useState<SourceScope | null>(null);
  const { isBusy, error, setError, run } = useAsyncAction();

  const target = layerRegistry.get(targetKey) ?? layers.find((l) => l.fabricRole === "points") ?? layers[0];
  // Any layer can be the source; by default the first one with selected features, else the parcels.
  const selectedIn = (key: string | undefined) => selection.find((s) => s.layerKey === key)?.count ?? 0;
  const source =
    layerRegistry.get(sourceKey) ??
    layers.find((l) => selectedIn(l.key) > 0 && l.key !== target?.key) ??
    layers.find((l) => l.fabricRole === "parcel-polygon") ??
    layers[0];
  const selectedCount = selectedIn(source?.key);
  // Selected features when there are some, otherwise the features in the map view.
  const scope: SourceScope = selectedCount ? (scopeChoice ?? "selected") : "view";
  const close = () => {
    useEditing.getState().patch({ selectByLocationOpen: false });
    setScopeChoice(null);
    setError(null);
  };

  const apply = async () => {
    if (!target || !source) return;
    const d = Number(distance);
    if (!Number.isFinite(d) || d < 0) return setError("Search distance must be zero or a positive number of metres.");
    await run(async () => {
      const n = await selectionService.selectByLocation(target, source, relation, d, mode, scope);
      useApp.getState().notify("success", "Selection updated", `${n.toLocaleString("en-US")} feature(s) in ${target.name}`);
      close();
    });
  };

  return (
    <calcite-dialog id="dlg-select-location" open={open || undefined} modal width="s" heading="Select by location" loading={isBusy || undefined} oncalciteDialogClose={close}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <calcite-label scale="s">
          Select features from
          <calcite-select scale="s" label="Target layer" oncalciteSelectChange={(e) => setTargetKey((e.target as HTMLElement & { value: string }).value)}>
            {layers.map((l) => (
              <calcite-option key={l.key} value={l.key} selected={l.key === target?.key || undefined}>
                {`${l.name} — ${friendlyGeometryType(l.geometryType)}`}
              </calcite-option>
            ))}
          </calcite-select>
        </calcite-label>
        <calcite-label scale="s">
          that
          <calcite-select scale="s" label="Relationship" oncalciteSelectChange={(e) => setRelation((e.target as HTMLElement & { value: string }).value as SpatialRelation)}>
            {RELATIONS.map((r) => (
              <calcite-option key={r.value} value={r.value} selected={r.value === relation || undefined}>
                {r.label}
              </calcite-option>
            ))}
          </calcite-select>
        </calcite-label>
        <calcite-label scale="s">
          Source layer
          <calcite-select
            id="sbl-source"
            scale="s"
            label="Source layer"
            oncalciteSelectChange={(e) => {
              setSourceKey((e.target as HTMLElement & { value: string }).value);
              setScopeChoice(null);
            }}
          >
            {layers.map((l) => (
              <calcite-option key={l.key} value={l.key} selected={l.key === source?.key || undefined}>
                {`${l.name}${selectedIn(l.key) ? ` (${selectedIn(l.key)} selected)` : ""}`}
              </calcite-option>
            ))}
          </calcite-select>
        </calcite-label>
        <calcite-label scale="s">
          Use
          <calcite-segmented-control id="sbl-scope" scale="s" width="full" oncalciteSegmentedControlChange={(e) => setScopeChoice((e.target as HTMLElement & { value: string }).value as SourceScope)}>
            <calcite-segmented-control-item value="selected" checked={scope === "selected" || undefined} disabled={!selectedCount || undefined}>
              {`Selected features (${selectedCount})`}
            </calcite-segmented-control-item>
            <calcite-segmented-control-item value="view" checked={scope === "view" || undefined}>
              Features in this map view
            </calcite-segmented-control-item>
          </calcite-segmented-control>
        </calcite-label>
        <calcite-label scale="s">
          Search distance (metres, optional)
          <calcite-input-number scale="s" min={0} value={distance} oncalciteInputNumberInput={calciteInput(setDistance)} />
        </calcite-label>
        <calcite-label scale="s">
          Selection mode
          <calcite-segmented-control scale="s" width="full" oncalciteSegmentedControlChange={(e) => setMode((e.target as HTMLElement & { value: string }).value as SelectionMode)}>
            {(["new", "add", "remove", "intersect"] as const).map((m) => (
              <calcite-segmented-control-item key={m} value={m} checked={mode === m || undefined}>
                {m === "new" ? "New" : m === "add" ? "Add" : m === "remove" ? "Remove" : "Within"}
              </calcite-segmented-control-item>
            ))}
          </calcite-segmented-control>
        </calcite-label>
        <ErrorNotice message={error} />
      </div>
      <calcite-button slot="footer-end" appearance="outline" kind="neutral" onClick={close}>
        Cancel
      </calcite-button>
      <calcite-button slot="footer-end" icon-start="circle-intersection" disabled={!source || !target || isBusy || undefined} onClick={() => void apply()}>
        Apply
      </calcite-button>
    </calcite-dialog>
  );
}
