import type { IconName } from "../../types/icons";
import { runCommand } from "../../app/commands";
import { shortcutKeys } from "../../app/shortcuts";
import { useApp } from "../../stores/appStore";
import { useEditing } from "../../stores/editingStore";
import type { MapTool } from "../../types/app";
import { versionSession } from "../../gis/version-management/versionSession";

interface ToolDef {
  id: string;
  icon: IconName;
  label: string;
  /** Tool buttons stay pressed while active. */
  tool?: MapTool;
}

const NAVIGATE: ToolDef[] = [
  { id: "explore", icon: "cursor-click", label: "Explore / identify", tool: "explore" },
  { id: "pan", icon: "move", label: "Pan", tool: "pan" },
  { id: "zoom-in", icon: "magnifying-glass-plus", label: "Zoom in" },
  { id: "zoom-out", icon: "magnifying-glass-minus", label: "Zoom out" },
  { id: "back", icon: "chevron-left", label: "Previous extent" },
  { id: "forward", icon: "chevron-right", label: "Next extent" },
  { id: "full", icon: "extent", label: "Full extent (parcel data)" },
  { id: "locate", icon: "gps-on", label: "Locate me" },
  { id: "goto", icon: "pin-tear", label: "Go to coordinates" },
];

const SELECT: ToolDef[] = [
  { id: "select-click", icon: "select", label: "Select", tool: "select-click" },
  { id: "select-rectangle", icon: "select-range", label: "Select by rectangle", tool: "select-rectangle" },
  { id: "select-polygon", icon: "polygon-vertices", label: "Select by polygon", tool: "select-polygon" },
  { id: "select-lasso", icon: "lasso-select", label: "Select by lasso", tool: "select-lasso" },
  { id: "select-attributes", icon: "select-by-attributes", label: "Select by attributes" },
  { id: "select-location", icon: "circle-intersection", label: "Select by location" },
  { id: "clear-selection", icon: "selection-x", label: "Clear selection" },
];

const EDIT: ToolDef[] = [
  { id: "create", icon: "plus-square", label: "Create features" },
  { id: "modify", icon: "pencil", label: "Modify (move · rotate · scale · vertices · attributes)" },
  { id: "split", icon: "split-geometry", label: "Split" },
  { id: "merge", icon: "merge", label: "Merge" },
  { id: "delete", icon: "trash", label: "Delete selected" },
  { id: "undo", icon: "undo", label: "Undo" },
  { id: "redo", icon: "redo", label: "Redo" },
  { id: "save", icon: "save", label: "Save edits" },
  { id: "discard", icon: "reset", label: "Discard edits" },
];

const MEASURE: ToolDef[] = [
  { id: "measure-distance", icon: "measure-line", label: "Measure distance", tool: "measure-distance" },
  { id: "measure-area", icon: "measure-area", label: "Measure area & perimeter", tool: "measure-area" },
  { id: "coordinate-info", icon: "crosshair", label: "Coordinate information", tool: "coordinate-info" },
];

export function MainToolbar() {
  const tool = useApp((s) => s.tool);
  const canBack = useApp((s) => s.mapStatus.canGoBack);
  const canForward = useApp((s) => s.mapStatus.canGoForward);
  const ready = useApp((s) => s.mapStatus.ready);
  const user = useApp((s) => s.user);
  const session = useEditing((s) => s.session);
  const selection = useEditing((s) => s.selection);
  const highlighted = useApp((s) => s.mapStatus.highlighted);
  const canUndo = useEditing((s) => s.canUndo);
  const canRedo = useEditing((s) => s.canRedo);
  const fabricOps = useEditing((s) => s.fabricOpsInSession) > 0;
  const pending = useEditing((s) => s.pendingEdits);
  const busy = useEditing((s) => s.busy);
  // Re-render when licence / version state changes (used by canEditCurrentVersion).
  useEditing((s) => s.advancedEditing);
  useEditing((s) => s.current);

  const editing = session === "editing";
  const canEditRole = !!user?.permissions.includes("features:edit");
  const selCount = selection.reduce((n, s) => n + s.count, 0);
  const oneLayer = selection.length === 1;

  /** Returns a reason string when the tool is unavailable, or null. */
  const unavailable = (id: string): string | null => {
    if (!ready) return "Map is loading";
    if (id === "back" && !canBack) return "No previous extent";
    if (id === "forward" && !canForward) return "No next extent";
    if (EDIT.some((t) => t.id === id)) {
      if (!canEditRole) return "Your role does not include editing";
      if (!editing) return "Start editing first";
      if (busy) return busy;
      switch (id) {
        case "split":
          return oneLayer && selCount === 1 ? null : "Select exactly one line or polygon";
        case "merge":
          return oneLayer && selCount >= 2 ? null : "Select two or more features in one layer";
        case "delete":
          return selCount ? null : "Select features to delete";
        case "undo":
          return canUndo ? null : fabricOps ? "Not available after a Parcel Fabric operation; use Discard to roll back" : "Nothing to undo";
        case "redo":
          return canRedo ? null : fabricOps ? "Not available after a Parcel Fabric operation" : "Nothing to redo";
        case "save":
        case "discard":
          return pending ? null : "No unsaved edits";
      }
    }
    if (id === "clear-selection" && !selCount && !highlighted) return "Nothing selected";
    return null;
  };

  const renderGroup = (label: string, tools: ToolDef[], extra?: React.ReactNode) => (
    <div className="ps-tool-group" role="group" aria-label={label} key={label}>
      <span className="ps-tool-group-label">{label}</span>
      {extra}
      {tools.map((t) => {
        const keys = shortcutKeys(t.id);
        const reason = unavailable(t.id);
        const text = `${t.label}${keys ? ` (${keys})` : ""}${reason ? ` — ${reason}` : ""}`;
        return (
          <calcite-action
            key={t.id}
            text={text}
            label={text}
            title={text}
            icon={t.icon}
            scale="s"
            active={(t.tool && tool === t.tool) || undefined}
            disabled={!!reason || undefined}
            onClick={() => runCommand(t.id)}
          />
        );
      })}
    </div>
  );

  const startCheck = versionSession.canEditCurrentVersion();
  // Starting on DEFAULT asks for confirmation (handled by the command), so only hard blocks disable the button.
  const startBlocked = !editing && !startCheck.ok && !/default version/i.test(startCheck.reason ?? "");
  const editToggleText = editing ? "Stop editing (Shift+E)" : `Start editing (Shift+E)${startBlocked ? ` — ${startCheck.reason}` : ""}`;

  return (
    <nav className="ps-toolbar" aria-label="Map tools">
      {renderGroup("Navigate", NAVIGATE)}
      {renderGroup(`Select${selCount ? ` · ${selCount}` : ""}`, SELECT)}
      {renderGroup(
        `Edit${editing && pending ? ` · ${pending} unsaved` : ""}`,
        EDIT,
        <calcite-action
          text={editToggleText}
          title={editToggleText}
          icon={editing ? "pencil-square" : "pencil-mark"}
          scale="s"
          active={editing || undefined}
          loading={session === "starting" || session === "stopping" || undefined}
          disabled={!ready || startBlocked || session === "unavailable" || !!busy || undefined}
          onClick={() => runCommand("toggle-editing")}
        />,
      )}
      {renderGroup("Measure", MEASURE)}
    </nav>
  );
}
