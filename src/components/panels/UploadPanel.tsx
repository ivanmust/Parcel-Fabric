import { useRef, useState } from "react";
import { useApp } from "../../stores/appStore";
import { useMapController } from "../../hooks/useMapController";
import { useAsyncAction } from "../../hooks/useAsyncAction";
import { createShapefileLayer } from "../../gis/layers/shapefileLayer";
import { MAX_UPLOAD_BYTES, readShapefiles } from "../../utils/shapefile";
import { ErrorNotice } from "../common/ErrorNotice";

/** Upload Shapefiles to the map. They stay in the browser; nothing is written to the Parcel Fabric. */
export function UploadPanel() {
  const ctrl = useMapController();
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [loaded, setLoaded] = useState<string[]>([]);
  const { isBusy, error, setError, run } = useAsyncAction();

  const upload = async (files: File[]) => {
    if (!files.length || isBusy) return;
    setLoaded([]);
    const failure = await run(async () => {
      if (files.reduce((n, f) => n + f.size, 0) > MAX_UPLOAD_BYTES) throw new Error("The files are too large (limit 100 MB).");
      const view = ctrl.view;
      if (!view) throw new Error("The map is not ready.");
      const datasets = await readShapefiles(await Promise.all(files.map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) }))));
      // Build every layer first, so a bad dataset doesn't leave half an upload on the map.
      const layers = await Promise.all(datasets.map((d) => createShapefileLayer(d, view.spatialReference)));
      layers.forEach((layer) => ctrl.addLayer(layer));
      setLoaded(datasets.map((d) => `${d.name}: ${d.features.length.toLocaleString("en-US")} ${d.kind} feature(s)${d.skipped ? `, ${d.skipped} empty or deleted record(s) skipped` : ""}`));
      useApp.getState().notify("success", "Shapefile added to the map", datasets.map((d) => d.name).join(", "));
      void ctrl.goToLayer(layers[0]!);
    });
    if (failure) useApp.getState().log("error", "upload", "Could not load the Shapefile", failure);
  };

  return (
    <calcite-panel heading="Upload Shapefile" description="Add .shp data to the map" loading={isBusy || undefined}>
      <div className="ps-panel-body">
        <div
          id="shapefile-drop"
          className={`ps-drop ${over ? "over" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            void upload([...e.dataTransfer.files]);
          }}
        >
          <calcite-icon icon="upload" scale="l" />
          <strong>Drop a Shapefile here</strong>
          <span>A .zip, or the .shp, .dbf, .shx and .prj files together. Up to 100 MB.</span>
          <calcite-button id="shapefile-browse" scale="s" icon-start="folder-open" disabled={isBusy || undefined} onClick={() => input.current?.click()}>
            Choose files
          </calcite-button>
          <input
            id="shapefile-input"
            ref={input}
            type="file"
            multiple
            hidden
            accept=".zip,.shp,.shx,.dbf,.prj,.cpg"
            onChange={(e) => {
              const files = [...(e.target.files ?? [])];
              e.target.value = ""; // allow choosing the same file again
              void upload(files);
            }}
          />
        </div>
        <ErrorNotice message={error} onClose={() => setError(null)} />
        {loaded.length > 0 && (
          <calcite-notice id="shapefile-result" open kind="success" scale="s">
            <div slot="title">Added to the map</div>
            <div slot="message">
              {loaded.map((text) => (
                <div key={text}>{text}</div>
              ))}
            </div>
          </calcite-notice>
        )}
        <p className="muted" style={{ margin: 0, fontSize: 12 }}>
          Uploaded data is for reference and snapping. It is not saved to ArcGIS or to the Parcel Fabric, and is cleared when you reload. Remove it from Contents.
        </p>
      </div>
    </calcite-panel>
  );
}
