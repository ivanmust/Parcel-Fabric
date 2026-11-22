import { useEffect } from "react";
import { runCommand } from "../app/commands";
import { commandForKey } from "../app/shortcuts";
import { useApp } from "../stores/appStore";
import { useEditing } from "../stores/editingStore";
import { isEditorWorkflowActive } from "../gis/editing/editorBridge";

function isTyping(e: KeyboardEvent): boolean {
  return e.composedPath().some((el) => {
    if (!(el instanceof HTMLElement)) return false;
    const tag = el.tagName;
    return (
      el.isContentEditable ||
      ["INPUT", "TEXTAREA", "SELECT", "CALCITE-INPUT", "CALCITE-INPUT-TEXT", "CALCITE-INPUT-NUMBER", "CALCITE-TEXT-AREA", "CALCITE-COMBOBOX", "CALCITE-INPUT-DATE-PICKER"].includes(tag)
    );
  });
}

export function useKeyboardShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const dialogs = useApp.getState().dialogs;
      const ed = useEditing.getState();
      if (Object.values(dialogs).some(Boolean) || ed.versionDialogOpen || ed.selectByAttributesOpen || ed.selectByLocationOpen) return;
      if (isTyping(e)) return;
      const cmd = commandForKey(e);
      if (!cmd) return;
      // While the Editor is sketching, it owns undo/redo and Delete (vertex editing).
      if (isEditorWorkflowActive() && ["undo", "redo", "delete"].includes(cmd)) return;
      e.preventDefault();
      runCommand(cmd);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
