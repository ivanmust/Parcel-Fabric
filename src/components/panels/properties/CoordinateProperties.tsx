import Point from "@arcgis/core/geometry/Point.js";
import SpatialReference from "@arcgis/core/geometry/SpatialReference.js";
import { formatDD, formatDMS, formatXY, project } from "../../../gis/geometry/coordinates";
import { getMapController } from "../../../gis/map/MapController";
import { useApp } from "../../../stores/appStore";
import { copyText } from "../../../utils/format";

/** Coordinate information for a clicked location in every relevant CRS. */
export function CoordinateProperties({ lon, lat }: { lon: number; lat: number }) {
  const ctrl = getMapController();
  const srName = useApp((s) => s.mapStatus.dataSrName);
  const p = new Point({ longitude: lon, latitude: lat });
  const wm = project(p, SpatialReference.WebMercator);
  const dataSr = ctrl.dataSpatialReference;
  const data = dataSr && !dataSr.isGeographic && !dataSr.isWebMercator ? project(p, dataSr) : null;

  const rows: { label: string; value: string; copy: string }[] = [
    { label: "WGS 84 (decimal degrees)", value: formatDD(lon, lat, 7), copy: `${lat.toFixed(7)}, ${lon.toFixed(7)}` },
    { label: "WGS 84 (DMS)", value: formatDMS(lon, lat), copy: formatDMS(lon, lat) },
  ];
  if (data) rows.push({ label: `Data CRS · ${srName ?? "service"}`, value: formatXY(data.x, data.y), copy: `${data.x.toFixed(3)}, ${data.y.toFixed(3)}` });
  if (wm) rows.push({ label: "Web Mercator (EPSG:3857)", value: formatXY(wm.x, wm.y, 2), copy: `${wm.x.toFixed(2)}, ${wm.y.toFixed(2)}` });

  return (
    <div className="ps-panel-body">
      {rows.map((r) => (
        <div key={r.label} className="svc-card">
          <div className="ps-row space">
            <span className="muted" style={{ fontSize: 12 }}>{r.label}</span>
            <calcite-action
              icon="copy-to-clipboard"
              text="Copy"
              scale="s"
              onClick={async () => {
                const ok = await copyText(r.copy);
                useApp.getState().notify(ok ? "success" : "warning", ok ? "Copied" : "Clipboard unavailable", ok ? r.copy : undefined);
              }}
            />
          </div>
          <div className="mono" style={{ fontSize: 14 }}>{r.value}</div>
        </div>
      ))}
      {!data && dataSr && !dataSr.isGeographic && !dataSr.isWebMercator && (
        <calcite-notice open kind="warning" scale="s">
          <div slot="message">The client projection engine could not project to the data coordinate system.</div>
        </calcite-notice>
      )}
    </div>
  );
}
