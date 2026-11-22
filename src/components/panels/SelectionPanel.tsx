import { useEditing, type SelectionMode } from "../../stores/editingStore";
import { useApp } from "../../stores/appStore";
import { layerRegistry } from "../../gis/layers/layerRegistry";
import { selectionService } from "../../gis/selection/selectionService";
import { getMapController } from "../../gis/map/MapController";
import { editorBridge, isLayerEditable } from "../../gis/editing/editorBridge";
import { runCommand } from "../../app/commands";
import { describeArcGISError } from "../../services/arcgis/serviceMetadata";
import type { IconName } from "../../types/icons";
import type { MapTool } from "../../types/app";
import { asShownOnMap } from "../../gis/layers/query";

const TOOLS: { id: string; icon: IconName; label: string; tool?: MapTool }[] = [
  { id: "select-click", icon: "select", label: "Click", tool: "select-click" },
  { id: "select-rectangle", icon: "select-range", label: "Rectangle", tool: "select-rectangle" },
  { id: "select-polygon", icon: "polygon-vertices", label: "Polygon", tool: "select-polygon" },
  { id: "select-lasso", icon: "lasso-select", label: "Lasso", tool: "select-lasso" },
  { id: "select-attributes", icon: "select-by-attributes", label: "By attributes" },
  { id: "select-location", icon: "circle-intersection", label: "By location" },
];

export function SelectionPanel() {
  const selection = useEditing((s) => s.selection);
  const mode = useEditing((s) => s.selectionMode);
  const session = useEditing((s) => s.session);
  const tool = useApp((s) => s.tool);
  const total = selection.reduce((n, s) => n + s.count, 0);
  const { notify, openBottomTab, showProperties } = useApp.getState();

  const zoomTo = async (layerKey: string) => {
    const info = layerRegistry.get(layerKey);
    const view = getMapController().view;
    if (!info || !view) return;
    try {
      const { extent } = await info.layer.queryExtent(asShownOnMap(info.layer, { objectIds: selectionService.getIds(info) }));
      if (extent) await view.goTo(extent.expand(1.3), { duration: 400 });
    } catch (e) {
      notify("warning", "Zoom failed", describeArcGISError(e));
    }
  };

  return (
    <calcite-panel heading="Selection" description={total ? `${total.toLocaleString("en-US")} feature(s) selected` : "Nothing selected"}>
      <calcite-action slot="header-actions-end" icon="erase" text="Clear selection (Shift+C)" disabled={!total || undefined} onClick={() => runCommand("clear-selection")} />
      <div className="ps-panel-body">
        <h3 className="ps-section-title">Tools</h3>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 6 }}>
          {TOOLS.map((t) => (
            <calcite-button
              key={t.id}
              scale="s"
              appearance={t.tool && tool === t.tool ? "solid" : "outline"}
              kind="neutral"
              icon-start={t.icon}
              onClick={() => runCommand(t.id)}
            >
              {t.label}
            </calcite-button>
          ))}
        </div>
        <calcite-label scale="s" style={{ margin: 0 }}>
          Selection mode (Shift = add, Ctrl = remove)
          <calcite-segmented-control
            scale="s"
            width="full"
            oncalciteSegmentedControlChange={(e) => useEditing.getState().patch({ selectionMode: (e.target as HTMLElement & { value: string }).value as SelectionMode })}
          >
            {(["new", "add", "remove", "intersect"] as const).map((m) => (
              <calcite-segmented-control-item key={m} value={m} checked={mode === m || undefined}>
                {m === "new" ? "New" : m === "add" ? "Add" : m === "remove" ? "Remove" : "Within"}
              </calcite-segmented-control-item>
            ))}
          </calcite-segmented-control>
        </calcite-label>

        <h3 className="ps-section-title">Selected features</h3>
        {!selection.length ? (
          <div className="ps-empty">
            <calcite-icon icon="select" scale="l" />
            <h4>No selection</h4>
            <p>Use a selection tool on the map, or select by attributes or location. Only visible layers are searched.</p>
          </div>
        ) : (
          <calcite-list label="Selection by layer" scale="s">
            {selection.map((s) => {
              const info = layerRegistry.get(s.layerKey);
              const editable = session === "editing" && isLayerEditable(info);
              return (
                <calcite-list-item key={s.layerKey} label={s.name} description={`${s.count.toLocaleString("en-US")} selected`}>
                  <calcite-action slot="actions-end" icon="zoom-to-object" text="Zoom to selection" onClick={() => void zoomTo(s.layerKey)} />
                  <calcite-action
                    slot="actions-end"
                    icon="information"
                    text="Show in properties"
                    onClick={() =>
                      info &&
                      showProperties({ kind: "features", hits: selectionService.getIds(info).slice(0, 500).map((objectId) => ({ layerKey: s.layerKey, objectId })), index: 0 })
                    }
                  />
                  <calcite-action slot="actions-end" icon="table" text="Show selected in table" onClick={() => { openBottomTab("table", s.layerKey); window.dispatchEvent(new CustomEvent("ps:table-selected-only")); }} />
                  {editable && (
                    <calcite-action
                      slot="actions-end"
                      icon="pencil"
                      text="Edit selected (attributes / geometry)"
                      onClick={() => {
                        // The Editor works on one layer at a time: keep only this layer's selection.
                        for (const other of selection) {
                          const o = layerRegistry.get(other.layerKey);
                          if (other.layerKey !== s.layerKey && o) selectionService.clearLayer(o);
                        }
                        setTimeout(() => editorBridge.modify().catch((e: Error) => notify("warning", "Modify", e.message)), 50);
                      }}
                    />
                  )}
                  <calcite-action slot="actions-end" icon="x" text="Clear this layer's selection" onClick={() => info && selectionService.clearLayer(info)} />
                </calcite-list-item>
              );
            })}
          </calcite-list>
        )}
        {total > 0 && session === "editing" && (
          <calcite-button scale="s" appearance="outline" kind="danger" icon-start="trash" onClick={() => runCommand("delete")}>
            Delete selected…
          </calcite-button>
        )}
      </div>
    </calcite-panel>
  );
}
