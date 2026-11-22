import * as geodeticAreaOperator from "@arcgis/core/geometry/operators/geodeticAreaOperator.js";
import * as geodeticLengthOperator from "@arcgis/core/geometry/operators/geodeticLengthOperator.js";
import * as areaOperator from "@arcgis/core/geometry/operators/areaOperator.js";
import * as lengthOperator from "@arcgis/core/geometry/operators/lengthOperator.js";
import type Polygon from "@arcgis/core/geometry/Polygon.js";
import type Polyline from "@arcgis/core/geometry/Polyline.js";
import type { GeometryUnion } from "@arcgis/core/unionTypes.js";
import { formatArea, formatLength } from "../../utils/format";

export interface GeometryFacts {
  rows: [string, string][];
}

async function ensureGeodetic() {
  const loads: Promise<void>[] = [];
  if (!geodeticAreaOperator.isLoaded()) loads.push(geodeticAreaOperator.load());
  if (!geodeticLengthOperator.isLoaded()) loads.push(geodeticLengthOperator.load());
  await Promise.all(loads);
}

function vertexCount(g: GeometryUnion): number {
  if (g.type === "polygon") return (g as Polygon).rings.reduce((n, r) => n + r.length, 0);
  if (g.type === "polyline") return (g as Polyline).paths.reduce((n, p) => n + p.length, 0);
  if (g.type === "multipoint") return g.points.length;
  return 1;
}

/** Area/length (geodetic and, for projected data, planar in data units) + structure facts. */
export async function describeGeometry(g: GeometryUnion | null | undefined): Promise<GeometryFacts> {
  if (!g) return { rows: [["Geometry", "None (table or no shape)"]] };
  const rows: [string, string][] = [["Type", g.type]];
  const sr = g.spatialReference;
  const projected = sr && !sr.isGeographic && !sr.isWebMercator;
  try {
    await ensureGeodetic();
  } catch {
    /* geodetic operators unavailable – planar values only */
  }

  if (g.type === "polygon") {
    const poly = g as Polygon;
    rows.push(["Rings", String(poly.rings.length)]);
    try {
      rows.push(["Area (geodetic)", formatArea(Math.abs(geodeticAreaOperator.execute(poly, { unit: "square-meters" })))]);
    } catch {
      /* SR not supported for geodetic */
    }
    try {
      rows.push(["Perimeter (geodetic)", formatLength(geodeticLengthOperator.execute(poly, { unit: "meters" }))]);
    } catch {
      /* ignore */
    }
    if (projected) {
      rows.push(["Area (planar, data SR)", formatArea(Math.abs(areaOperator.execute(poly, { unit: "square-meters" })))]);
      rows.push(["Perimeter (planar)", formatLength(lengthOperator.execute(poly, { unit: "meters" }))]);
    }
  } else if (g.type === "polyline") {
    const line = g as Polyline;
    rows.push(["Paths", String(line.paths.length)]);
    try {
      rows.push(["Length (geodetic)", formatLength(geodeticLengthOperator.execute(line, { unit: "meters" }))]);
    } catch {
      /* ignore */
    }
    if (projected) rows.push(["Length (planar, data SR)", formatLength(lengthOperator.execute(line, { unit: "meters" }))]);
    if (line.hasM) rows.push(["Has M", "yes"]);
  } else if (g.type === "point") {
    rows.push(["X", g.x.toFixed(4)], ["Y", g.y.toFixed(4)]);
    if (g.hasZ && g.z !== undefined) rows.push(["Z", g.z.toFixed(3)]);
  }
  rows.push(["Vertices", String(vertexCount(g))]);
  if (g.hasZ) rows.push(["Has Z", "yes"]);
  if (sr) rows.push(["Spatial reference", sr.wkid ? `EPSG:${sr.latestWkid ?? sr.wkid}` : "Custom (WKT)"]);
  return { rows };
}
