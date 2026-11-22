import esriConfig from "@arcgis/core/config.js";
import { urlPattern } from "../../utils/requestParams";

/**
 * Client-side tidy-up of published layer metadata, display only (the service is not changed).
 *
 * The Parcel Fabric's Records layer is a polygon layer whose label class uses a *line* placement
 * (esriServerLinePlacementAboveAlong). The SDK then logs "Found invalid label placement type
 * above-along for esriGeometryPolygon. Defaulting to always-horizontal". We apply that same
 * fallback before the SDK reads the JSON, so labels look identical and the console stays clean.
 *
 * Labels on the Plot layer use the desktop font Tahoma, which Esri's web font service doesn't have
 * (404 on the glyphs, then "Font tahoma-bold is not available on the web, using Arial Unicode MS").
 * We switch to that same Arial Unicode MS fallback up front, keeping the weight.
 * The proper fix is to correct the label classes in ArcGIS Pro and republish the service.
 */
const POLYGON_PLACEMENT = "esriServerPolygonPlacementAlwaysHorizontal";

interface LabelClassJson {
  labelPlacement?: string;
  symbol?: { font?: { family?: string } };
}
/** Desktop fonts the web font service does not provide, mapped to the SDK's own fallback. */
const WEB_FONT_FALLBACK: Record<string, string> = { tahoma: "Arial Unicode MS" };
interface LayerJson {
  geometryType?: string;
  drawingInfo?: { labelingInfo?: LabelClassJson[] };
}

function fixLayer(layer: LayerJson | null | undefined) {
  for (const lc of layer?.drawingInfo?.labelingInfo ?? []) {
    const font = lc.symbol?.font;
    const replacement = font?.family ? WEB_FONT_FALLBACK[font.family.toLowerCase()] : undefined;
    if (font && replacement) font.family = replacement;
    if (layer?.geometryType === "esriGeometryPolygon" && lc.labelPlacement && !lc.labelPlacement.startsWith("esriServerPolygonPlacement"))
      lc.labelPlacement = POLYGON_PLACEMENT;
  }
}

let installed = false;

/** Install once, for the given ArcGIS Server services root (e.g. https://host/server/rest/services/ParcelFabric). */
export function installServiceMetadataFixes(serviceRoot: string) {
  if (installed) return;
  installed = true;
  const root = urlPattern(serviceRoot);
  esriConfig.request.interceptors?.push({
    // layer metadata (…/FeatureServer/3, …/MapServer/13) and the multi-layer listing (…/layers)
    urls: new RegExp(`^${root}/(FeatureServer|MapServer)/(\\d+|layers)/?$`, "i"),
    after(response) {
      const data = response.data as (LayerJson & { layers?: LayerJson[] }) | null;
      if (!data || typeof data !== "object") return;
      fixLayer(data);
      data.layers?.forEach(fixLayer);
    },
  });
}
