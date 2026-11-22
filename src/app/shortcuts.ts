/** Single source of truth for keyboard shortcuts (used by handler, toolbar tooltips and help dialog). */
export interface ShortcutDef {
  id: string;
  keys: string; // display form
  label: string;
  group: string;
}

export const SHORTCUTS: ShortcutDef[] = [
  { id: "explore", keys: "E", label: "Explore / identify", group: "Navigation" },
  { id: "pan", keys: "H", label: "Pan", group: "Navigation" },
  { id: "zoom-in", keys: "+", label: "Zoom in", group: "Navigation" },
  { id: "zoom-out", keys: "−", label: "Zoom out", group: "Navigation" },
  { id: "back", keys: "Alt+←", label: "Previous extent", group: "Navigation" },
  { id: "forward", keys: "Alt+→", label: "Next extent", group: "Navigation" },
  { id: "full", keys: "F", label: "Full extent", group: "Navigation" },
  { id: "goto", keys: "G", label: "Go to coordinates", group: "Navigation" },
  { id: "select-click", keys: "S", label: "Select (click; Shift adds, Ctrl removes)", group: "Selection" },
  { id: "select-rectangle", keys: "R", label: "Select by rectangle", group: "Selection" },
  { id: "select-polygon", keys: "P", label: "Select by polygon", group: "Selection" },
  { id: "select-lasso", keys: "L", label: "Select by lasso", group: "Selection" },
  { id: "select-attributes", keys: "Shift+A", label: "Select by attributes", group: "Selection" },
  { id: "select-location", keys: "Shift+L", label: "Select by location", group: "Selection" },
  { id: "clear-selection", keys: "Shift+C", label: "Clear selection", group: "Selection" },
  { id: "toggle-editing", keys: "Shift+E", label: "Start / stop editing", group: "Editing" },
  { id: "create", keys: "N", label: "Create features", group: "Editing" },
  { id: "modify", keys: "M", label: "Modify selected (move, rotate, scale, vertices, attributes)", group: "Editing" },
  { id: "split", keys: "Shift+S", label: "Split selected feature", group: "Editing" },
  { id: "merge", keys: "Shift+G", label: "Merge selected features", group: "Editing" },
  { id: "delete", keys: "Delete", label: "Delete selected features", group: "Editing" },
  { id: "undo", keys: "Ctrl+Z", label: "Undo", group: "Editing" },
  { id: "redo", keys: "Ctrl+Y", label: "Redo", group: "Editing" },
  { id: "save", keys: "Ctrl+S", label: "Save edits", group: "Editing" },
  { id: "measure-distance", keys: "D", label: "Measure distance", group: "Measurement" },
  { id: "measure-area", keys: "Shift+D", label: "Measure area & perimeter", group: "Measurement" },
  { id: "coordinate-info", keys: "I", label: "Coordinate information", group: "Measurement" },
  { id: "toggle-left", keys: "Alt+1", label: "Toggle left panel", group: "Workspace" },
  { id: "toggle-right", keys: "Alt+2", label: "Toggle properties panel", group: "Workspace" },
  { id: "toggle-bottom", keys: "Alt+3", label: "Toggle bottom workspace", group: "Workspace" },
  { id: "escape", keys: "Esc", label: "Cancel tool / workflow, clear identify", group: "Workspace" },
  { id: "help", keys: "?", label: "Show shortcuts", group: "Workspace" },
];

export const shortcutKeys = (id: string) => SHORTCUTS.find((s) => s.id === id)?.keys;

/** Map a keyboard event to a command id (or null). */
export function commandForKey(e: KeyboardEvent): string | null {
  if (e.ctrlKey || e.metaKey) {
    const k = e.key.toLowerCase();
    if (k === "z" && !e.shiftKey) return "undo";
    if (k === "y" || (k === "z" && e.shiftKey)) return "redo";
    if (k === "s") return "save";
    return null;
  }
  if (e.altKey) {
    if (e.key === "ArrowLeft") return "back";
    if (e.key === "ArrowRight") return "forward";
    if (e.code === "Digit1") return "toggle-left";
    if (e.code === "Digit2") return "toggle-right";
    if (e.code === "Digit3") return "toggle-bottom";
    return null;
  }
  if (e.shiftKey) {
    switch (e.key.toUpperCase()) {
      case "A":
        return "select-attributes";
      case "L":
        return "select-location";
      case "C":
        return "clear-selection";
      case "E":
        return "toggle-editing";
      case "S":
        return "split";
      case "G":
        return "merge";
      case "D":
        return "measure-area";
      case "?":
        return "help";
    }
    if (e.key === "+") return "zoom-in";
    if (e.key === "_") return "zoom-out";
    return null;
  }
  switch (e.key) {
    case "e":
      return "explore";
    case "h":
      return "pan";
    case "+":
    case "=":
      return "zoom-in";
    case "-":
      return "zoom-out";
    case "f":
      return "full";
    case "g":
      return "goto";
    case "s":
      return "select-click";
    case "r":
      return "select-rectangle";
    case "p":
      return "select-polygon";
    case "l":
      return "select-lasso";
    case "n":
      return "create";
    case "m":
      return "modify";
    case "d":
      return "measure-distance";
    case "i":
      return "coordinate-info";
    case "Delete":
      return "delete";
    case "?":
      return "help";
    case "Escape":
      return "escape";
  }
  return null;
}
