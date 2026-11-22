import { useState } from "react";
import Point from "@arcgis/core/geometry/Point.js";
import SpatialReference from "@arcgis/core/geometry/SpatialReference.js";
import { useApp } from "../../stores/appStore";
import { getMapController } from "../../gis/map/MapController";
import { ensureProjection, parseCoordinatePair } from "../../gis/geometry/coordinates";
import { calciteInput } from "../../utils/calciteInput";

type Crs = "wgs84" | "data" | "webmercator";

/** Navigate to a coordinate typed in WGS 84 (DD or DMS), the data CRS, or Web Mercator. */
export function GoToCoordinatesDialog() {
  const open = useApp((s) => s.dialogs.goTo);
  const srName = useApp((s) => s.mapStatus.dataSrName);
  const setDialog = useApp((s) => s.setDialog);
  const [crs, setCrs] = useState<Crs>("wgs84");
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const ctrl = getMapController();
  const dataSr = ctrl.dataSpatialReference;
  const dataIsProjected = !!dataSr && !dataSr.isGeographic && !dataSr.isWebMercator;

  const close = () => {
    setDialog("goTo", false);
    setError(null);
  };

  const submit = async () => {
    setError(null);
    const pair = parseCoordinatePair(text);
    if (!pair) return setError(crs === "wgs84" ? "Enter latitude, longitude — e.g. -1.9536, 30.0606 or 1°57'13\"S 30°03'38\"E" : "Enter X, Y — e.g. 500123.45, 4783210.12");
    let point: Point;
    if (crs === "wgs84") {
      const [lat, lon] = [pair.a, pair.b];
      if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return setError("Latitude must be within ±90 and longitude within ±180.");
      point = new Point({ latitude: lat, longitude: lon });
    } else if (crs === "webmercator") {
      point = new Point({ x: pair.a, y: pair.b, spatialReference: SpatialReference.WebMercator });
    } else {
      if (!dataSr) return setError("The data coordinate system is not known yet.");
      point = new Point({ x: pair.a, y: pair.b, spatialReference: dataSr });
    }
    try {
      await ensureProjection();
      await ctrl.goToPoint(point);
      close();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <calcite-dialog open={open || undefined} modal heading="Go to coordinates" width="s" oncalciteDialogClose={close}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <calcite-label>
          Coordinate system
          <calcite-select label="Coordinate system" oncalciteSelectChange={(e) => setCrs((e.target as HTMLElement & { value: string }).value as Crs)}>
            <calcite-option value="wgs84" selected={crs === "wgs84" || undefined}>
              WGS 84 — latitude, longitude
            </calcite-option>
            {dataIsProjected && (
              <calcite-option value="data" selected={crs === "data" || undefined}>
                {`Data CRS — ${srName ?? "service"} (X, Y)`}
              </calcite-option>
            )}
            <calcite-option value="webmercator" selected={crs === "webmercator" || undefined}>
              Web Mercator — X, Y (m)
            </calcite-option>
          </calcite-select>
        </calcite-label>
        <calcite-label>
          {crs === "wgs84" ? "Latitude, longitude (decimal or DMS)" : "X (easting), Y (northing)"}
          <calcite-input-text
            value={text}
            placeholder={crs === "wgs84" ? "-1.9536, 30.0606" : "x, y"}
            status={error ? "invalid" : undefined}
            oncalciteInputTextInput={calciteInput(setText)}
            onKeyDown={(e) => e.key === "Enter" && void submit()}
          />
          {error && (
            <calcite-input-message status="invalid" icon>
              {error}
            </calcite-input-message>
          )}
        </calcite-label>
      </div>
      <calcite-button slot="footer-end" appearance="outline" kind="neutral" onClick={close}>
        Cancel
      </calcite-button>
      <calcite-button slot="footer-end" icon-start="pin-tear" onClick={() => void submit()}>
        Go to
      </calcite-button>
    </calcite-dialog>
  );
}
