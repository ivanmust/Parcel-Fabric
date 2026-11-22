import { useApp } from "../../stores/appStore";
import { formatDD, formatDMS, formatXY } from "../../gis/geometry/coordinates";
import { formatScale } from "../../utils/format";

export function StatusBar() {
  const s = useApp((st) => st.mapStatus);
  const fmt = useApp((st) => st.coordinateFormat);
  const tool = useApp((st) => st.tool);
  const bottomOpen = useApp((st) => st.bottomOpen);
  const setPref = useApp((st) => st.setPref);

  return (
    <footer className="ps-status" aria-label="Map status">
      <span className="item" title={s.updating ? "Drawing / requesting data" : "Map idle"}>
        <span className={`ps-status-dot ${s.updating || !s.ready ? "busy" : ""}`} />
        {!s.ready ? "Starting" : s.updating ? "Updating" : "Ready"}
      </span>
      <span className="item">
        <calcite-icon icon="cursor" scale="s" />
        {tool.replace("-", " ")}
      </span>
      <span className="item mono" title="Map scale">
        {formatScale(s.scale)}
      </span>
      <span className="item mono" title="Pointer location (WGS 84)">
        {s.pointer ? (fmt === "dms" ? formatDMS(s.pointer.lon, s.pointer.lat) : formatDD(s.pointer.lon, s.pointer.lat)) : "—"}
      </span>
      {s.pointer?.x !== undefined && s.pointer.y !== undefined && (
        <span className="item mono" title={`Pointer location in ${s.dataSrName ?? "data CRS"}`}>
          {formatXY(s.pointer.x, s.pointer.y, 2)}
        </span>
      )}
      <span className="grow" />
      {s.dataSrName && (
        <span className="item" title="Coordinate system of the Parcel Fabric data">
          <calcite-icon icon="globe" scale="s" /> Data: {s.dataSrName}
        </span>
      )}
      <span className="item" title="Map view coordinate system (basemap tiling scheme)">View: Web Mercator</span>
      <calcite-action
        scale="s"
        text={bottomOpen ? "Hide bottom workspace" : "Show bottom workspace"}
        icon={bottomOpen ? "chevron-down" : "chevron-up"}
        onClick={() => setPref("bottomOpen", !bottomOpen)}
      />
    </footer>
  );
}
