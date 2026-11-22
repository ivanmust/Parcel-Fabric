import { useState } from "react";
import { useEditing, type SelectionMode } from "../../stores/editingStore";
import { useApp } from "../../stores/appStore";
import { layerRegistry } from "../../gis/layers/layerRegistry";
import { selectionService, type SpatialRelation } from "../../gis/selection/selectionService";
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

/** Select target-layer features by their spatial relationship to the selected features of a source layer. */
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
  const { isBusy, error, setError, run } = useAsyncAction();

  const target = layerRegistry.get(targetKey) ?? layers.find((l) => l.fabricRole === "points") ?? layers[0];
  const sources = selection.map((s) => layerRegistry.get(s.layerKey)).filter((x): x is NonNullable<typeof x> => !!x);
  const source = layerRegistry.get(sourceKey) ?? sources[0];
  const close = () => useEditing.getState().patch({ selectByLocationOpen: false });

  const apply = async () => {
    if (!target || !source) return;
    const d = Number(distance);
    if (!Number.isFinite(d) || d < 0) return setError("Search distance must be zero or a positive number of metres.");
    await run(async () => {
      const n = await selectionService.selectByLocation(target, source, relation, d, mode);
      useApp.getState().notify("success", "Selection updated", `${n.toLocaleString("en-US")} feature(s) in ${target.name}`);
      close();
    });
  };

  return (
    <calcite-dialog id="dlg-select-location" open={open || undefined} modal width="s" heading="Select by location" loading={isBusy || undefined} oncalciteDialogClose={close}>
      {!sources.length ? (
        <calcite-notice open kind="brand" scale="s" icon="information">
          <div slot="message">Select one or more source features first (any selection tool). They define the location used to select the target layer.</div>
        </calcite-notice>
      ) : (
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
            Source (selected features of)
            <calcite-select scale="s" label="Source layer" oncalciteSelectChange={(e) => setSourceKey((e.target as HTMLElement & { value: string }).value)}>
              {sources.map((l) => (
                <calcite-option key={l.key} value={l.key} selected={l.key === source?.key || undefined}>
                  {`${l.name} (${selection.find((s) => s.layerKey === l.key)?.count ?? 0} selected)`}
                </calcite-option>
              ))}
            </calcite-select>
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
      )}
      <calcite-button slot="footer-end" appearance="outline" kind="neutral" onClick={close}>
        Cancel
      </calcite-button>
      <calcite-button slot="footer-end" icon-start="circle-intersection" disabled={!sources.length || !target || undefined} onClick={() => void apply()}>
        Apply
      </calcite-button>
    </calcite-dialog>
  );
}
