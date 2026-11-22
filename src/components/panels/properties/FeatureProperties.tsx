import { useEffect, useState } from "react";
import type Graphic from "@arcgis/core/Graphic.js";
import type FeatureLayer from "@arcgis/core/layers/FeatureLayer.js";
import { layerRegistry } from "../../../gis/layers/layerRegistry";
import { formatAttribute, FIELD_TYPE_LABEL } from "../../../gis/layers/fieldFormat";
import { describeGeometry } from "../../../gis/geometry/geometryInfo";
import { getMapController } from "../../../gis/map/MapController";
import { describeArcGISError } from "../../../services/arcgis/serviceMetadata";
import { useApp } from "../../../stores/appStore";
import { copyText } from "../../../utils/format";
import { useEditing } from "../../../stores/editingStore";
import { editorBridge, isLayerEditable } from "../../../gis/editing/editorBridge";
import { asShownOnMap } from "../../../gis/layers/query";
import { ParcelLineage } from "./ParcelLineage";

interface Props {
  hits: { layerKey: string; objectId: number }[];
  index: number;
}

type Load =
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "ready"; layer: FeatureLayer; feature: Graphic; geometryRows: [string, string][] };

/**
 * Shows the full record for an identified feature. The feature is re-queried
 * from the service (all fields, full-resolution geometry in the layer's native
 * spatial reference) rather than trusting the generalised display graphic.
 */
export function FeatureProperties({ hits, index }: Props) {
  const hit = hits[index]!;
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [filter, setFilter] = useState("");
  const ctrl = getMapController();

  useEffect(() => {
    let cancelled = false;
    setLoad({ state: "loading" });
    (async () => {
      const info = layerRegistry.get(hit.layerKey);
      if (!info) throw new Error("The layer is no longer in the map.");
      const layer = info.layer;
      await layer.load();
      const res = await layer.queryFeatures(asShownOnMap(layer, { objectIds: [hit.objectId], outFields: ["*"], returnGeometry: true }));
      const feature = res.features[0];
      if (!feature) throw new Error(`Feature ${hit.objectId} was not found (it may have been deleted).`);
      const facts = await describeGeometry(feature.geometry as never);
      if (!cancelled) setLoad({ state: "ready", layer, feature, geometryRows: facts.rows });
    })().catch((e) => !cancelled && setLoad({ state: "error", message: describeArcGISError(e) }));
    void ctrl.highlightFeature(hit);
    return () => {
      cancelled = true;
    };
  }, [hit.layerKey, hit.objectId, ctrl, hit]);

  const go = (d: number) =>
    useApp.getState().showProperties({ kind: "features", hits, index: (index + d + hits.length) % hits.length });

  const info = layerRegistry.get(hit.layerKey);

  return (
    <>
      <div className="ps-panel-body" style={{ paddingBottom: 0 }}>
        <div className="ps-row space">
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 600 }}>{info?.name ?? "Feature"}</div>
            <div className="muted mono" style={{ fontSize: 12 }}>
              OBJECTID {hit.objectId}
            </div>
          </div>
          {hits.length > 1 && (
            <div className="ps-row">
              <calcite-action icon="chevron-left" text="Previous result" scale="s" onClick={() => go(-1)} />
              <span className="muted" style={{ fontSize: 12 }}>
                {index + 1} / {hits.length}
              </span>
              <calcite-action icon="chevron-right" text="Next result" scale="s" onClick={() => go(1)} />
            </div>
          )}
        </div>
      </div>

      {load.state === "loading" && (
        <div className="ps-panel-body">
          {[80, 60, 72, 50, 66].map((w, i) => (
            <div key={i} className="ps-skel" style={{ width: `${w}%` }} />
          ))}
        </div>
      )}
      {load.state === "error" && (
        <div className="ps-panel-body">
          <calcite-notice open kind="danger" scale="s">
            <div slot="title">Could not load feature</div>
            <div slot="message">{load.message}</div>
          </calcite-notice>
        </div>
      )}
      {load.state === "ready" && (
        <ReadyView
          layer={load.layer}
          feature={load.feature}
          geometryRows={load.geometryRows}
          filter={filter}
          setFilter={setFilter}
          layerKey={hit.layerKey}
        />
      )}
    </>
  );
}

function ReadyView({
  layer,
  feature,
  geometryRows,
  filter,
  setFilter,
  layerKey,
}: {
  layer: FeatureLayer;
  feature: Graphic;
  geometryRows: [string, string][];
  filter: string;
  setFilter(v: string): void;
  layerKey: string;
}) {
  const ctrl = getMapController();
  const editing = useEditing((s) => s.session) === "editing";
  const f = filter.trim().toLowerCase();
  const fields = layer.fields.filter(
    (fl) => fl.type !== "geometry" && (!f || fl.name.toLowerCase().includes(f) || (fl.alias ?? "").toLowerCase().includes(f)),
  );
  const gid = layer.globalIdField ? feature.attributes?.[layer.globalIdField] : null;

  const zoomTo = () => {
    if (feature.geometry && ctrl.view) void ctrl.view.goTo(feature.geometry, { duration: 400 }).catch(() => undefined);
  };
  const openPopup = () => {
    if (!ctrl.view) return;
    feature.layer = layer;
    feature.popupTemplate = layer.popupTemplate ?? layer.createPopupTemplate();
    void ctrl.view.openPopup({ features: [feature], location: feature.geometry?.extent?.center ?? undefined });
  };
  const copyAttributes = async () => {
    const ok = await copyText(JSON.stringify(feature.attributes, null, 2));
    useApp.getState().notify(ok ? "success" : "warning", ok ? "Attributes copied as JSON" : "Clipboard unavailable");
  };

  return (
    <>
      <div className="ps-panel-body">
        <div className="ps-row" style={{ flexWrap: "wrap", gap: 6 }}>
          <calcite-button scale="s" appearance="outline" icon-start="zoom-to-object" disabled={!feature.geometry || undefined} onClick={zoomTo}>
            Zoom to
          </calcite-button>
          <calcite-button scale="s" appearance="outline" icon-start="popup" onClick={openPopup}>
            Popup
          </calcite-button>
          <calcite-button scale="s" appearance="outline" icon-start="table" onClick={() => useApp.getState().openBottomTab("table", layerKey)}>
            Table
          </calcite-button>
          <calcite-button scale="s" appearance="transparent" icon-start="copy-to-clipboard" onClick={() => void copyAttributes()}>
            Copy
          </calcite-button>
          <calcite-button
            scale="s"
            appearance="outline"
            icon-start="select"
            onClick={() => {
              const oid = feature.attributes?.[layer.objectIdField];
              if (typeof oid === "number") ctrl.view?.selectionManager.add(layer, [oid]);
            }}
          >
            Select
          </calcite-button>
          {editing && isLayerEditable(layerRegistry.get(layerKey)) && (
            <calcite-button
              scale="s"
              icon-start="pencil"
              onClick={() => {
                const oid = feature.attributes?.[layer.objectIdField];
                editorBridge.editFeature(layerKey, oid).catch((e: Error) => useApp.getState().notify("warning", "Edit", e.message));
              }}
            >
              Edit
            </calcite-button>
          )}
        </div>
        {gid && (
          <div className="kv">
            <div className="k">GlobalID</div>
            <div className="mono" style={{ fontSize: 12 }}>{String(gid)}</div>
          </div>
        )}
      </div>

      <calcite-block heading="Attributes" description={`${layer.fields.length} fields`} expanded collapsible>
        <calcite-input-text
          scale="s"
          icon="filter"
          placeholder="Filter fields"
          clearable
          value={filter}
          oncalciteInputTextInput={(e) => setFilter((e.target as HTMLElement & { value: string }).value)}
          style={{ marginBottom: 8 }}
        />
        <div className="kv">
          {fields.map((fl) => {
            const v = formatAttribute(layer, fl, feature);
            return (
              <AttrRow
                key={fl.name}
                label={fl.alias || fl.name}
                name={fl.name}
                type={FIELD_TYPE_LABEL[fl.type] ?? fl.type}
                value={v.text}
                raw={v.raw}
                isNull={v.isNull}
              />
            );
          })}
        </div>
      </calcite-block>

      {layerRegistry.get(layerKey)?.fabricRole === "parcel-polygon" && typeof feature.attributes?.[layer.objectIdField] === "number" && (
        <ParcelLineage layerKey={layerKey} objectId={feature.attributes[layer.objectIdField] as number} geometry={feature.geometry ?? null} />
      )}

      <calcite-block heading="Geometry" expanded collapsible>
        <div className="kv">
          {geometryRows.map(([k, v]) => (
            <AttrRow key={k} label={k} value={v} />
          ))}
        </div>
      </calcite-block>
    </>
  );
}

function AttrRow({ label, name, type, value, raw, isNull }: { label: string; name?: string; type?: string; value: string; raw?: string; isNull?: boolean }) {
  return (
    <>
      <div className="k" title={name}>
        {label}
        {name && name !== label && <small>{name}</small>}
        {type && <small>{type}</small>}
      </div>
      <div className={isNull ? "null" : undefined} title={raw ? `Stored value: ${raw}` : undefined}>
        {value}
      </div>
    </>
  );
}
