import { useEffect, useRef, useState, type RefObject } from "react";
import type MapView from "@arcgis/core/views/MapView.js";
import type Point from "@arcgis/core/geometry/Point.js";
import { getMapController } from "../../gis/map/MapController";
import { project, toWgs84, formatDD, formatXY } from "../../gis/geometry/coordinates";
import { useApp } from "../../stores/appStore";
import { copyText } from "../../utils/format";

interface MenuState {
  x: number;
  y: number;
  screen: { x: number; y: number };
  mapPoint: Point;
}

/** Right-click menu on the map. */
export function MapContextMenu({ view, container }: { view: MapView; container: RefObject<HTMLDivElement | null> }) {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const ctrl = getMapController();

  useEffect(() => {
    const el = container.current;
    if (!el) return;
    const onContext = (e: MouseEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const screen = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      const mapPoint = view.toMap(screen);
      if (!mapPoint) return;
      setMenu({
        x: Math.min(e.clientX, window.innerWidth - 250),
        y: Math.min(e.clientY, window.innerHeight - 260),
        screen,
        mapPoint,
      });
    };
    el.addEventListener("contextmenu", onContext);
    return () => el.removeEventListener("contextmenu", onContext);
  }, [container, view]);

  useEffect(() => {
    if (!menu) return;
    ref.current?.querySelector("button")?.focus();
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== "Escape") return;
      if (e.type === "pointerdown" && ref.current?.contains(e.target as Node)) return;
      setMenu(null);
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", close);
    window.addEventListener("wheel", close, { passive: true });
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", close);
      window.removeEventListener("wheel", close);
    };
  }, [menu]);

  if (!menu) return null;
  const geo = toWgs84(menu.mapPoint);
  const dataSr = ctrl.dataSpatialReference;
  const dataPt = dataSr && !dataSr.isGeographic ? project(menu.mapPoint, dataSr) : null;
  const { notify, showProperties } = useApp.getState();

  const run = async (fn: () => unknown) => {
    setMenu(null);
    await fn();
  };
  const copy = async (text: string, what: string) => {
    const ok = await copyText(text);
    notify(ok ? "success" : "warning", ok ? `${what} copied` : "Clipboard unavailable", ok ? text : undefined);
  };

  return (
    <div ref={ref} className="ps-context-menu ps-float" style={{ left: menu.x, top: menu.y }} role="menu">
      {geo && <div className="hdr mono">{formatDD(geo.x, geo.y)}</div>}
      <button role="menuitem" onClick={() => run(() => ctrl.identify(menu.screen))}>
        <calcite-icon icon="information" scale="s" /> Identify features here
      </button>
      <button role="menuitem" onClick={() => run(() => ctrl.showCoordinateInfo(menu.mapPoint))}>
        <calcite-icon icon="crosshair" scale="s" /> Coordinate information
      </button>
      <hr />
      {geo && (
        <button role="menuitem" onClick={() => run(() => copy(`${geo.y.toFixed(7)}, ${geo.x.toFixed(7)}`, "WGS 84 coordinates"))}>
          <calcite-icon icon="copy-to-clipboard" scale="s" /> Copy lat, lon (WGS 84)
        </button>
      )}
      {dataPt && (
        <button role="menuitem" onClick={() => run(() => copy(`${dataPt.x.toFixed(3)}, ${dataPt.y.toFixed(3)}`, "Projected coordinates"))}>
          <calcite-icon icon="copy-to-clipboard" scale="s" /> Copy X, Y ({formatXY(dataPt.x, dataPt.y, 0)})
        </button>
      )}
      <hr />
      <button role="menuitem" onClick={() => run(() => view.goTo({ center: menu.mapPoint }, { duration: 300 }))}>
        <calcite-icon icon="center-horizontal" scale="s" /> Center map here
      </button>
      <button role="menuitem" onClick={() => run(() => view.goTo({ center: menu.mapPoint, scale: view.scale / 2 }, { duration: 300 }))}>
        <calcite-icon icon="magnifying-glass-plus" scale="s" /> Zoom in here
      </button>
      <button role="menuitem" onClick={() => run(() => { ctrl.clearMarkers(); ctrl.clearHighlight(); showProperties({ kind: "none" }); })}>
        <calcite-icon icon="erase" scale="s" /> Clear markers & highlight
      </button>
    </div>
  );
}
