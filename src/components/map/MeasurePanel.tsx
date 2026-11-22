import { useEffect, useRef } from "react";
import type MapView from "@arcgis/core/views/MapView.js";
import { useApp } from "../../stores/appStore";

type Measurer = HTMLElement & { start(): Promise<void>; clear(): Promise<void>; componentOnReady?: () => Promise<unknown> };

/**
 * Geodesic distance and area/perimeter measurement using the SDK measurement
 * components (they compute geodetically in geographic/Web Mercator views).
 */
export function MeasurePanel({ view, tool }: { view: MapView; tool: "measure-distance" | "measure-area" }) {
  const ref = useRef<Measurer>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let cancelled = false;
    (async () => {
      await el.componentOnReady?.();
      if (!cancelled) await el.start().catch(() => undefined);
    })();
    return () => {
      cancelled = true;
    };
  }, [tool]);

  return (
    <div className="ps-float ps-measure">
      <div className="ps-row space" style={{ padding: "8px 8px 0 12px" }}>
        <strong style={{ fontSize: 13 }}>{tool === "measure-distance" ? "Measure distance" : "Measure area & perimeter"}</strong>
        <calcite-action text="Close" icon="x" scale="s" onClick={() => useApp.getState().setTool("explore")} />
      </div>
      {tool === "measure-distance" ? (
        <arcgis-distance-measurement-2d key="d" ref={ref as never} view={view} unit="metric" />
      ) : (
        <arcgis-area-measurement-2d key="a" ref={ref as never} view={view} unit="metric" />
      )}
    </div>
  );
}
