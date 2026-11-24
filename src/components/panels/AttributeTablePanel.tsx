import { useEffect, useRef, useState } from "react";
import * as reactiveUtils from "@arcgis/core/core/reactiveUtils.js";
import type Collection from "@arcgis/core/core/Collection.js";
import type { GeometryUnion } from "@arcgis/core/unionTypes.js";
import { useApp, hasPermission } from "../../stores/appStore";
import { useEditing } from "../../stores/editingStore";
import { useLayerRegistryVersion, useMapView } from "../../hooks/useMapController";
import { layerRegistry } from "../../gis/layers/layerRegistry";
import { friendlyGeometryType } from "../../utils/format";
import { asShownOnMap } from "../../gis/layers/query";

type TableEl = HTMLElement & {
  highlightIds: Collection<number | string>;
  filterGeometry: GeometryUnion | null;
  filterBySelectionEnabled: boolean;
  refresh(): Promise<void>;
};

/**
 * Attribute table backed by the SDK FeatureTable (server-side paging/sorting).
 * Selection is shared with the map (SelectionManager). Cells become editable
 * only during an edit session, for users allowed to edit attributes, on layers
 * whose service allows updates – the FeatureTable then validates against field
 * types, lengths, domains and nullability and applies edits to the active version.
 */
export function AttributeTablePanel() {
  useLayerRegistryVersion();
  const view = useMapView();
  const layerKey = useApp((s) => s.tableLayerId);
  const user = useApp((s) => s.user);
  const session = useEditing((s) => s.session);
  const [extentOnly, setExtentOnly] = useState(false);
  const [selectedOnly, setSelectedOnly] = useState(false);
  const tableRef = useRef<TableEl>(null);
  const items = layerRegistry.all();
  // Default to the parcel polygons, then records, then any feature layer.
  const info =
    (layerKey && layerRegistry.get(layerKey)) ||
    items.find((i) => i.fabricRole === "parcel-polygon") ||
    items.find((i) => i.fabricRole === "records") ||
    items.find((i) => i.kind === "feature") ||
    null;

  const canEditAttributes =
    session === "editing" && hasPermission(user, "attributes:edit") && !!info?.layer.capabilities?.operations.supportsUpdate && info.layer.editingEnabled !== false;

  // Filter-by-extent follows the map while enabled.
  useEffect(() => {
    const table = tableRef.current;
    if (!table || !view) return;
    if (!extentOnly) {
      table.filterGeometry = null;
      return;
    }
    const h = reactiveUtils.watch(
      () => (view.stationary ? view.extent : null),
      (ext) => {
        if (ext) table.filterGeometry = ext.clone();
      },
      { initial: true },
    );
    return () => h.remove();
  }, [extentOnly, view, info?.key]);

  useEffect(() => {
    if (tableRef.current) tableRef.current.filterBySelectionEnabled = selectedOnly;
  }, [selectedOnly, info?.key]);

  useEffect(() => {
    const on = () => setSelectedOnly(true);
    window.addEventListener("ps:table-selected-only", on);
    return () => window.removeEventListener("ps:table-selected-only", on);
  }, []);

  if (!items.length || !info) {
    return (
      <div className="ps-empty">
        <calcite-icon icon="table" scale="l" />
        <h4>No layers available yet</h4>
        <p>The attribute table lists Parcel Fabric layers once the feature service has loaded.</p>
      </div>
    );
  }

  const selectedIds = () => tableRef.current?.highlightIds.toArray().filter((x): x is number => typeof x === "number") ?? [];

  const onSelectionChange = () => {
    const ids = selectedIds();
    if (ids.length)
      useApp.getState().showProperties({
        kind: "features",
        hits: ids.slice(-500).map((objectId) => ({ layerKey: info.key, objectId })),
        index: Math.min(ids.length, 500) - 1,
      });
  };

  const zoomToSelection = async () => {
    const ids = selectedIds();
    if (!ids.length || !view) return;
    const res = await info.layer.queryExtent(asShownOnMap(info.layer, { objectIds: ids }));
    if (res.extent) await view.goTo(res.extent.expand(1.3), { duration: 400 }).catch(() => undefined);
  };

  return (
    <>
      <div className="ps-table-toolbar">
        <calcite-select
          scale="s"
          label="Layer"
          style={{ width: 300 }}
          oncalciteSelectChange={(e) => useApp.getState().openBottomTab("table", (e.target as HTMLElement & { value: string }).value)}
        >
          {items.map((i) => (
            <calcite-option key={i.key} value={i.key} selected={i.key === info.key || undefined}>
              {`${i.name} — ${friendlyGeometryType(i.geometryType)}`}
            </calcite-option>
          ))}
        </calcite-select>
        <calcite-label layout="inline" scale="s" style={{ margin: 0 }}>
          <calcite-switch
            scale="s"
            checked={extentOnly || undefined}
            disabled={info.kind === "table" || undefined}
            oncalciteSwitchChange={(e) => setExtentOnly((e.target as HTMLElement & { checked: boolean }).checked)}
          />
          Map extent
        </calcite-label>
        <calcite-label layout="inline" scale="s" style={{ margin: 0 }}>
          <calcite-switch scale="s" checked={selectedOnly || undefined} oncalciteSwitchChange={(e) => setSelectedOnly((e.target as HTMLElement & { checked: boolean }).checked)} />
          Selected only
        </calcite-label>
        <calcite-chip scale="s" kind={canEditAttributes ? "brand" : "neutral"} icon={canEditAttributes ? "pencil" : "lock"} label="Edit state">
          {canEditAttributes ? "Editable" : session === "editing" ? "Read-only layer" : "Read-only – start editing"}
        </calcite-chip>
        <span className="ps-grow" />
        <calcite-button scale="s" appearance="outline" icon-start="zoom-to-object" disabled={info.kind === "table" || undefined} onClick={() => void zoomToSelection()}>
          Zoom to selected
        </calcite-button>
        <calcite-button scale="s" appearance="transparent" icon-start="refresh" onClick={() => void tableRef.current?.refresh()}>
          Refresh
        </calcite-button>
      </div>
      <div className="ps-table-host">
        {view && (
          <arcgis-feature-table
            key={info.key}
            ref={tableRef as never}
            view={view}
            layer={info.layer}
            syncViewSelection
            editingEnabled={canEditAttributes}
            hideMenuItemsDeleteSelection
            onarcgisSelectionChange={onSelectionChange}
            onarcgisCellDblClick={() => void zoomToSelection()}
          />
        )}
      </div>
    </>
  );
}
