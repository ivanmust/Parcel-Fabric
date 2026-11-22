import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@esri/calcite-components/main.css";
import "./styles/app.css";
import { defineCustomElements as defineCalcite } from "@esri/calcite-components/loader";
import { defineCustomElements as defineMapComponents } from "@arcgis/map-components/loader";
import { App } from "./app/App";

// Register Calcite and ArcGIS map components (lazy-loaded on first use).
defineCalcite();
defineMapComponents();

// Development-only diagnostics handle for automated UI tests (stripped from production builds).
if (import.meta.env.DEV) {
  void Promise.all([
    import("./stores/appStore"),
    import("./stores/editingStore"),
    import("./gis/layers/layerRegistry"),
    import("./gis/version-management/versionSession"),
    import("./gis/map/MapController"),
    import("./gis/selection/selectionService"),
    import("./gis/layers/query"),
  ]).then(([app, editing, reg, vs, mc, sel, moment]) => {
    (window as unknown as Record<string, unknown>).__ps = {
      app: app.useApp,
      editing: editing.useEditing,
      registry: reg.layerRegistry,
      versionSession: vs.versionSession,
      map: mc.getMapController(),
      selection: sel.selectionService,
      shown: moment.asShownOnMap,
    };
  });
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
