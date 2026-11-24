import FeatureLayer from "@arcgis/core/layers/FeatureLayer.js";
import Graphic from "@arcgis/core/Graphic.js";
import Multipoint from "@arcgis/core/geometry/Multipoint.js";
import Point from "@arcgis/core/geometry/Point.js";
import Polygon from "@arcgis/core/geometry/Polygon.js";
import Polyline from "@arcgis/core/geometry/Polyline.js";
import SpatialReference from "@arcgis/core/geometry/SpatialReference.js";
import type { GeometryUnion } from "@arcgis/core/unionTypes.js";
import type { ShapeDataset, ShapeKind } from "../../utils/shapefile";
import { ensureProjection, project } from "../geometry/coordinates";

const COLOR = [255, 193, 7];
const OID = "__OID";

function geometryOf(kind: ShapeKind, parts: number[][][], spatialReference: SpatialReference): GeometryUnion {
  if (kind === "point") return new Point({ x: parts[0]![0]![0], y: parts[0]![0]![1], spatialReference });
  if (kind === "multipoint") return new Multipoint({ points: parts[0]!, spatialReference });
  if (kind === "polyline") return new Polyline({ paths: parts, spatialReference });
  return new Polygon({ rings: parts, spatialReference });
}

function rendererOf(kind: ShapeKind) {
  const symbol =
    kind === "polygon"
      ? { type: "simple-fill", color: [...COLOR, 0.12], outline: { color: COLOR, width: 2 } }
      : kind === "polyline"
        ? { type: "simple-line", color: COLOR, width: 2.5 }
        : { type: "simple-marker", color: COLOR, size: 8, outline: { color: [60, 45, 0], width: 1 } };
  return { type: "simple", symbol };
}

/**
 * A read-only, in-browser layer for a Shapefile, projected to the map. Nothing is sent to ArcGIS:
 * the layer can be viewed, queried, selected and snapped to, and is gone when the page reloads.
 */
export async function createShapefileLayer(data: ShapeDataset, mapReference: SpatialReference): Promise<FeatureLayer> {
  await ensureProjection();
  const from = new SpatialReference({ wkt: data.wkt });
  const source = data.features.map(({ parts, values }, i) => {
    const geometry = project(geometryOf(data.kind, parts, from), mapReference);
    if (!geometry || (geometry.type === "point" && !Number.isFinite(geometry.x)))
      throw new Error(`${data.name}: the coordinate system in the .prj could not be converted to the map's. Re-export the Shapefile in ITRF 2005 TM or WGS 84.`);
    return new Graphic({ geometry, attributes: { [OID]: i + 1, ...Object.fromEntries(data.fields.map((f, k) => [f.name, values[k] ?? null])) } });
  });
  const layer = new FeatureLayer({
    title: `${data.name} (uploaded)`,
    source,
    objectIdField: OID,
    fields: [
      { name: OID, alias: "Row", type: "oid" },
      ...data.fields.map((f) => ({ name: f.name, alias: f.alias, type: f.numeric ? ("double" as const) : ("string" as const) })),
    ],
    geometryType: data.kind,
    spatialReference: mapReference,
    outFields: ["*"],
    editingEnabled: false,
    renderer: rendererOf(data.kind) as never,
  });
  await layer.load();
  return layer;
}
