import { useEffect, useState, useSyncExternalStore } from "react";
import type MapView from "@arcgis/core/views/MapView.js";
import { getMapController } from "../gis/map/MapController";
import { layerRegistry } from "../gis/layers/layerRegistry";

export const useMapController = () => getMapController();

/** The MapView once it is ready (null before). */
export function useMapView(): MapView | null {
  const ctrl = getMapController();
  const [view, setView] = useState<MapView | null>(ctrl.view?.ready ? ctrl.view : null);
  useEffect(() => ctrl.onReady(setView), [ctrl]);
  return view;
}

/** Re-render when the layer registry changes; returns the registry version. */
export function useLayerRegistryVersion(): number {
  return useSyncExternalStore(
    (cb) => layerRegistry.subscribe(cb),
    () => layerRegistry.getVersion(),
  );
}
