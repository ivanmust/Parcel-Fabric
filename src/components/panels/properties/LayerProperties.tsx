import { useEffect, useState } from "react";
import type FeatureLayer from "@arcgis/core/layers/FeatureLayer.js";
import { FABRIC_ROLE_LABEL, layerRegistry } from "../../../gis/layers/layerRegistry";
import { FIELD_TYPE_LABEL } from "../../../gis/layers/fieldFormat";
import { describeArcGISError, describeSpatialReference } from "../../../services/arcgis/serviceMetadata";
import { formatScale, friendlyGeometryType } from "../../../utils/format";
import { getMapController } from "../../../gis/map/MapController";
import { useApp } from "../../../stores/appStore";
import { asShownOnMap } from "../../../gis/layers/query";

/** Layer metadata exactly as published by the service. */
export function LayerProperties({ layerKey }: { layerKey: string }) {
  const info = layerRegistry.get(layerKey);
  const [layer, setLayer] = useState<FeatureLayer | null>(null);
  const [count, setCount] = useState<number | string>("…");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!info) return;
    let cancelled = false;
    setLayer(null);
    setCount("…");
    setError(null);
    info.layer
      .load()
      .then(async (l) => {
        if (cancelled) return;
        setLayer(l);
        try {
          const n = await l.queryFeatureCount(asShownOnMap(l, {}));
          if (!cancelled) setCount(n);
        } catch (e) {
          if (!cancelled) setCount(describeArcGISError(e));
        }
      })
      .catch((e) => !cancelled && setError(describeArcGISError(e)));
    return () => {
      cancelled = true;
    };
  }, [info]);

  if (!info) return <div className="ps-empty"><p>Layer is no longer in the map.</p></div>;
  if (error)
    return (
      <div className="ps-panel-body">
        <calcite-notice open kind="danger" scale="s">
          <div slot="title">{info.name}</div>
          <div slot="message">{error}</div>
        </calcite-notice>
      </div>
    );
  if (!layer)
    return (
      <div className="ps-panel-body">
        <div className="ps-skel" style={{ width: "70%" }} />
        <div className="ps-skel" style={{ width: "50%" }} />
      </div>
    );

  const src = (layer.sourceJSON ?? {}) as Record<string, unknown> & { [k: string]: never };
  const ops = layer.capabilities?.operations;
  const editing = ops
    ? [ops.supportsAdd && "add", ops.supportsUpdate && "update", ops.supportsDelete && "delete"].filter(Boolean).join(", ") || "none"
    : "unknown";

  const rows: [string, string][] = [
    ["Name", layer.title ?? info.name],
    ["Service layer ID", String(info.serviceLayerId ?? "—")],
    ["Parcel Fabric role", info.fabricRole ? FABRIC_ROLE_LABEL[info.fabricRole] : "—"],
    ["Type", info.kind === "table" ? "Table" : friendlyGeometryType(layer.geometryType)],
    ["Feature count", typeof count === "number" ? count.toLocaleString("en-US") : String(count)],
    ["Spatial reference", describeSpatialReference(layer.spatialReference?.toJSON())],
    ["Capabilities", (src.capabilities as string | undefined) ?? "—"],
    ["Edit operations (service)", editing],
    ["Editing enabled (client)", String(layer.editingEnabled)],
    ["Branch versioned data", String((src.isDataBranchVersioned as boolean | undefined) ?? "—")],
    ["gdbVersion", layer.gdbVersion ?? "default"],
    ["Has attachments", String(!!src.hasAttachments)],
    ["Relationships", String((src.relationships as unknown[] | undefined)?.length ?? 0)],
    ["Subtype field", layer.subtypeField || "—"],
    ["Object ID field", layer.objectIdField],
    ["Global ID field", layer.globalIdField ?? "—"],
    ["Display field", layer.displayField ?? "—"],
    ["Visible scale range", `${layer.minScale ? formatScale(layer.minScale) : "any"} → ${layer.maxScale ? formatScale(layer.maxScale) : "any"}`],
    ["URL", info.url],
  ];

  return (
    <>
      <div className="ps-panel-body">
        <div className="ps-row" style={{ gap: 6 }}>
          <calcite-button scale="s" appearance="outline" icon-start="zoom-to-object" onClick={() => void getMapController().goToLayer(layer)}>
            Zoom to
          </calcite-button>
          <calcite-button scale="s" appearance="outline" icon-start="table" onClick={() => useApp.getState().openBottomTab("table", layerKey)}>
            Attribute table
          </calcite-button>
        </div>
        <div className="kv">
          {rows.map(([k, v]) => (
            <Row key={k} k={k} v={v} />
          ))}
        </div>
      </div>
      <calcite-block heading="Fields" description={`${layer.fields.length} fields`} collapsible expanded>
        <div className="kv">
          {layer.fields.map((f) => (
            <Row
              key={f.name}
              k={f.alias || f.name}
              sub={f.name !== f.alias ? f.name : undefined}
              v={[
                FIELD_TYPE_LABEL[f.type] ?? f.type,
                f.length && f.type === "string" ? `(${f.length})` : "",
                f.nullable ? "" : "· required",
                f.editable ? "" : "· read-only",
                f.domain ? `· ${f.domain.type === "coded-value" ? "coded domain" : "range domain"} "${f.domain.name}"` : "",
              ]
                .filter(Boolean)
                .join(" ")}
            />
          ))}
        </div>
      </calcite-block>
      {!!layer.subtypes?.length && (
        <calcite-block heading="Subtypes" description={`${layer.subtypes.length} on ${layer.subtypeField}`} collapsible>
          <div className="kv">
            {layer.subtypes.map((s) => (
              <Row key={s.code} k={String(s.code)} v={s.name} />
            ))}
          </div>
        </calcite-block>
      )}
    </>
  );
}

function Row({ k, v, sub }: { k: string; v: string; sub?: string }) {
  return (
    <>
      <div className="k">
        {k}
        {sub && <small>{sub}</small>}
      </div>
      <div style={{ fontSize: 12.5 }}>{v}</div>
    </>
  );
}
