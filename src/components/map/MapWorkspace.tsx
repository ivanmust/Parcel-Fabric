import { useEffect, useMemo, useRef, useState } from "react";
import LocalBasemapsSource from "@arcgis/core/widgets/BasemapGallery/support/LocalBasemapsSource.js";
import Collection from "@arcgis/core/core/Collection.js";
import type { SearchViewModelSelectResultEvent } from "@arcgis/core/widgets/Search/SearchViewModel.js";
import { useApp } from "../../stores/appStore";
import { getMapController } from "../../gis/map/MapController";
import { useLayerRegistryVersion, useMapView } from "../../hooks/useMapController";
import { layerRegistry } from "../../gis/layers/layerRegistry";
import { useEditing } from "../../stores/editingStore";
import { manualSplit } from "../../gis/parcel-fabric/manualSplit";
import { MapContextMenu } from "./MapContextMenu";
import { MeasurePanel } from "./MeasurePanel";
import { createParcelSearchSources } from "../../gis/search/parcelSearch";

let mounted = false;

export function MapWorkspace() {
  const containerRef = useRef<HTMLDivElement>(null);
  const config = useApp((s) => s.config);
  const tool = useApp((s) => s.tool);
  const ready = useApp((s) => s.mapStatus.ready);
  const updating = useApp((s) => s.mapStatus.updating);
  const view = useMapView();
  const ctrl = getMapController();
  const registryVersion = useLayerRegistryVersion();
  const [basemapOpen, setBasemapOpen] = useState(false);

  // Mount the MapView exactly once (StrictMode runs effects twice in development).
  useEffect(() => {
    if (!containerRef.current || !config) return;
    if (mounted) {
      if (ctrl.view) ctrl.view.container = containerRef.current;
      return;
    }
    mounted = true;
    ctrl.mount(containerRef.current, config).catch((e: Error) => {
      useApp.getState().notify("danger", "Map failed to start", e.message);
    });
  }, [config, ctrl]);

  // Pan tool disables identify; explore keeps panning + click-to-identify.
  useEffect(() => {
    if (!view) return;
    view.popupEnabled = false;
  }, [view, tool]);

  // Drawing a split line ends when editing stops or another map tool is chosen.
  const splitting = useEditing((s) => s.manualSplit?.phase === "drawing");
  const editing = useEditing((s) => s.session === "editing");
  useEffect(() => {
    if (splitting && (!editing || (tool !== "explore" && tool !== "pan"))) manualSplit.cancel();
  }, [splitting, editing, tool]);

  const basemapSource = useMemo(() => new LocalBasemapsSource({ basemaps: ctrl.basemaps }), [ctrl]);

  // Two search choices: "UPI" (default) and "Name" (place or record). No world geocoder, no "All".
  // The sources look layers up when they search, so they are built once the Plot layer exists and
  // kept across registry updates (the typed text and chosen source survive layer loading).
  void registryVersion; // re-render when layers register, so plotLayer is picked up
  const plotLayer = layerRegistry.byRole("parcel-polygon")?.layer;
  const searchSources = useMemo(() => new Collection(plotLayer ? createParcelSearchSources() : []), [plotLayer]);

  const onSearchSelect = (e: CustomEvent<SearchViewModelSelectResultEvent>) => {
    const feature = e.detail.result?.feature;
    const info = layerRegistry.findByLayer(feature?.layer as never);
    const oid = feature?.getObjectId();
    if (info && typeof oid === "number") {
      useApp.getState().showProperties({ kind: "features", hits: [{ layerKey: info.key, objectId: oid }], index: 0 });
      void ctrl.highlightFeature({ layerKey: info.key, objectId: oid });
    }
  };

  return (
    <div className="ps-map-wrap">
      {updating && <div className="ps-updating-bar" aria-hidden="true" />}
      <div ref={containerRef} className={`ps-map tool-${tool}`} aria-label="Map" />

      <div className={`ps-map-loading ${ready ? "done" : ""}`} aria-hidden={ready}>
        <calcite-loader label="Loading map" text="Loading map…" />
      </div>

      {splitting && (
        <div id="manual-split-hint" className="ps-draw-hint" role="status">
          <span>Click across the parcel, starting and ending on or outside its boundary. Enter or double-click to finish. Tab types a length in metres.</span>
          <calcite-button scale="s" appearance="outline" kind="neutral" onClick={() => manualSplit.cancel()}>
            Cancel
          </calcite-button>
        </div>
      )}

      {view && (
        <>
          <div className="ps-overlay top-left">
            <div className="ps-float">
              <arcgis-compass view={view} />
            </div>
          </div>
          <div className="ps-overlay top-right">
            <div className="ps-float ps-search">
              <arcgis-search
                view={view}
                sources={searchSources as never}
                includeDefaultSourcesDisabled
                searchAllDisabled
                activeSourceIndex={0}
                popupDisabled
                onarcgisSelectResult={onSearchSelect as never}
              />
            </div>
            {(tool === "measure-distance" || tool === "measure-area") && <MeasurePanel view={view} tool={tool} />}
          </div>
          <div className="ps-overlay bottom-left">
            <div className="ps-scalebar">
              <arcgis-scale-bar view={view} barStyle="line" unit="metric" />
            </div>
          </div>
          <div className="ps-overlay bottom-right">
            {basemapOpen && (
              <div className="ps-float" style={{ width: 280, maxHeight: "50vh", overflow: "auto" }}>
                <arcgis-basemap-gallery view={view} source={basemapSource} />
              </div>
            )}
            <div className="ps-float">
              <calcite-action
                text="Basemap"
                icon="basemap"
                active={basemapOpen || undefined}
                onClick={() => setBasemapOpen((o) => !o)}
              />
            </div>
          </div>
          <MapContextMenu view={view} container={containerRef} />
        </>
      )}
    </div>
  );
}
