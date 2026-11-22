import { useEffect } from "react";
import { useApp } from "../stores/appStore";
import { selectionService, type DrawTool } from "../gis/selection/selectionService";

const DRAW_TOOLS: Record<string, DrawTool> = {
  "select-rectangle": "rectangle",
  "select-polygon": "polygon",
  "select-lasso": "lasso",
};

/** Start/stop the sketch used by the rectangle, polygon and lasso selection tools. */
export function useToolEffects() {
  const tool = useApp((s) => s.tool);
  const ready = useApp((s) => s.mapStatus.ready);
  useEffect(() => {
    if (!ready) return;
    const draw = DRAW_TOOLS[tool];
    if (draw) void selectionService.draw(draw);
    else selectionService.cancelDraw();
  }, [tool, ready]);
}
