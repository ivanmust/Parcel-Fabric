import SnappingOptions from "@arcgis/core/views/interactive/snapping/SnappingOptions.js";
import { layerRegistry, type FabricRole } from "../layers/layerRegistry";

const SNAP_ROLES = new Set<FabricRole>(["parcel-polygon", "parcel-line", "points", "connection-lines", "records"]);

/** Snapping for drawing: the Parcel Fabric's layers, plus layers the user added (e.g. an uploaded survey Shapefile). */
export function createSnappingOptions() {
  return new SnappingOptions({
    enabled: true,
    featureEnabled: true,
    selfEnabled: true,
    distance: 10,
    featureSources: layerRegistry
      .all()
      .filter((i) => i.kind === "feature" && (i.source === "added" || (i.fabricRole && SNAP_ROLES.has(i.fabricRole))))
      .map((i) => ({ layer: i.layer, enabled: true })),
  });
}
