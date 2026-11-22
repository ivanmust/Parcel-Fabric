import Basemap from "@arcgis/core/Basemap.js";
import TileLayer from "@arcgis/core/layers/TileLayer.js";
import OpenStreetMapLayer from "@arcgis/core/layers/OpenStreetMapLayer.js";

/**
 * Basemaps built from Esri's public raster tile services (no API key needed).
 * Thumbnails are the z13 tile covering central Kigali.
 */
const AGOL = "https://services.arcgisonline.com/ArcGIS/rest/services";
const KIGALI_TILE = "13/4140/4780"; // level/row/col

function tiled(id: string, title: string, service: string, reference?: string): Basemap {
  return new Basemap({
    id,
    title,
    thumbnailUrl: `${AGOL}/${service}/MapServer/tile/${KIGALI_TILE}`,
    baseLayers: [new TileLayer({ url: `${AGOL}/${service}/MapServer` })],
    referenceLayers: reference ? [new TileLayer({ url: `${AGOL}/${reference}/MapServer` })] : [],
  });
}

export function createBasemaps(): Basemap[] {
  return [
    tiled("imagery", "Imagery with labels", "World_Imagery", "Reference/World_Boundaries_and_Places"),
    tiled("imagery-plain", "Imagery", "World_Imagery"),
    tiled("streets", "Streets", "World_Street_Map"),
    tiled("topo", "Topographic", "World_Topo_Map"),
    tiled("light-gray", "Light gray canvas", "Canvas/World_Light_Gray_Base", "Canvas/World_Light_Gray_Reference"),
    tiled("dark-gray", "Dark gray canvas", "Canvas/World_Dark_Gray_Base", "Canvas/World_Dark_Gray_Reference"),
    new Basemap({
      id: "osm",
      title: "OpenStreetMap",
      thumbnailUrl: `https://tile.openstreetmap.org/13/4780/4140.png`,
      baseLayers: [new OpenStreetMapLayer()],
    }),
  ];
}
