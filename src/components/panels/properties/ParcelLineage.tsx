import { useEffect, useState } from "react";
import type Geometry from "@arcgis/core/geometry/Geometry.js";
import type { GeometryUnion } from "@arcgis/core/unionTypes.js";
import { parcelFabricService } from "../../../gis/parcel-fabric/parcelFabricService";
import { getMapController } from "../../../gis/map/MapController";
import { useApp } from "../../../stores/appStore";
import { useEditing } from "../../../stores/editingStore";

type Lineage = Awaited<ReturnType<typeof parcelFabricService.lineage>>;
type Related = Lineage["predecessors"][number];

/**
 * Parcel history through its records: which record created and retired this parcel, and the
 * overlapping parcels that came before (retired by its creating record) and after (created by its
 * retiring record). Historic parcels are hidden on the map, so they are outlined on demand.
 */
export function ParcelLineage({ layerKey, objectId, geometry }: { layerKey: string; objectId: number; geometry: Geometry | null }) {
  const [state, setState] = useState<{ lineage?: Lineage; error?: string }>({});
  // Re-read after edits in this session (merge / divide change the lineage).
  const pending = useEditing((s) => s.pendingEdits);

  useEffect(() => {
    let stale = false;
    setState({});
    parcelFabricService
      .lineage(objectId, geometry)
      .then((lineage) => !stale && setState({ lineage }))
      .catch((e: Error) => !stale && setState({ error: e.message }));
    return () => {
      stale = true;
    };
  }, [objectId, geometry, pending]);

  const open = async (p: Related) => {
    if (!p.historic) {
      useApp.getState().showProperties({ kind: "features", hits: [{ layerKey, objectId: p.objectId }], index: 0 });
      return;
    }
    const ctrl = getMapController();
    const g = ctrl.view ? await parcelFabricService.parcelGeometry(p.objectId, ctrl.view.spatialReference) : null;
    if (g) await ctrl.showOutline(g as GeometryUnion);
    else useApp.getState().notify("warning", "Historic parcel", "Its geometry could not be read.");
  };

  const { lineage, error } = state;
  return (
    <calcite-block heading="Parcel lineage" description={lineage ? (lineage.historic ? "Historic parcel" : "Current parcel") : undefined} expanded collapsible>
      {error && <div className="muted">{error}</div>}
      {!lineage && !error && <calcite-loader inline label="Loading lineage" scale="s" />}
      {lineage && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div className="kv">
            <div className="k">Status</div>
            <div>
              <calcite-chip scale="s" kind={lineage.historic ? "neutral" : "brand"} label="Status">
                {lineage.historic ? "Historic" : "Current"}
              </calcite-chip>
            </div>
            <div className="k">Created by record</div>
            <div>{lineage.createdBy?.name ?? "—"}</div>
            <div className="k">Retired by record</div>
            <div>{lineage.retiredBy?.name ?? "—"}</div>
          </div>
          <RelatedList title="Came from" caption="Overlapping parcels retired by the record that created this parcel." empty="No earlier parcels recorded for this parcel." items={lineage.predecessors} onOpen={open} />
          {lineage.historic && (
            <RelatedList title="Replaced by" caption="Overlapping parcels created by the record that retired this parcel." empty="No later parcels found." items={lineage.successors} onOpen={open} />
          )}
        </div>
      )}
    </calcite-block>
  );
}

function RelatedList({ title, caption, empty, items, onOpen }: { title: string; caption: string; empty: string; items: Related[]; onOpen(p: Related): void }) {
  return (
    <div>
      <div className="ps-section-title">{title}</div>
      <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>{caption}</div>
      {items.length === 0 ? (
        <div className="muted" style={{ fontSize: 12 }}>{empty}</div>
      ) : (
        <calcite-list label={title} scale="s">
          {items.map((p) => (
            <calcite-list-item key={p.objectId} label={p.name ?? `OBJECTID ${p.objectId} (no UPI yet)`} description={p.historic ? "Historic: outline on map" : "Current: open details"} onClick={() => onOpen(p)}>
              <calcite-icon slot="content-start" icon={p.historic ? "clock" : "parcel-layer"} scale="s" />
            </calcite-list-item>
          ))}
        </calcite-list>
      )}
    </div>
  );
}
