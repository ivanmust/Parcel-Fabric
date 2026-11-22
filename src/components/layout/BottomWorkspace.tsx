import type { IconName } from "../../types/icons";
import { useApp } from "../../stores/appStore";
import type { BottomTabId } from "../../types/app";
import { Resizer } from "../common/Resizer";
import { AttributeTablePanel } from "../panels/AttributeTablePanel";
import { LogPanel } from "../panels/LogPanel";
import { EditHistoryPanel } from "../panels/EditHistoryPanel";

/** Validation Results and Geoprocessing Results tabs are added with Phases 5 and 6. */
const TABS: { id: BottomTabId; label: string; icon: IconName }[] = [
  { id: "table", label: "Attribute Table", icon: "table" },
  { id: "history", label: "Editing History", icon: "clock" },
  { id: "messages", label: "Messages", icon: "speech-bubble" },
  { id: "logs", label: "Logs", icon: "file-text" },
];

export function BottomWorkspace() {
  const open = useApp((s) => s.bottomOpen);
  const tab = useApp((s) => s.bottomTab);
  const unreadErrors = useApp((s) => s.logs.filter((l) => l.level === "error").length);
  const { openBottomTab, setPref } = useApp.getState();

  return (
    <section className={`ps-bottom ${open ? "" : "closed"}`} aria-label="Bottom workspace">
      <Resizer cssVar="--ps-bottom-h" axis="y" min={160} max={Math.round(window.innerHeight * 0.7)} direction={-1} label="Resize bottom workspace" />
      <div className="ps-bottom-tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.id} role="tab" className="ps-tab" aria-selected={tab === t.id} onClick={() => openBottomTab(t.id)}>
            <calcite-icon icon={t.icon} scale="s" />
            {t.label}
            {t.id === "logs" && unreadErrors > 0 && (
              <calcite-chip scale="s" kind="inverse" label="errors">
                {unreadErrors}
              </calcite-chip>
            )}
          </button>
        ))}
        <span className="ps-grow" />
        <calcite-action icon="chevron-down" text="Hide bottom workspace (Alt+3)" scale="s" onClick={() => setPref("bottomOpen", false)} />
      </div>
      <div className="ps-bottom-body" role="tabpanel">
        {/* The table stays mounted while hidden so it keeps its state. */}
        <div style={{ display: tab === "table" ? "contents" : "none" }}>{open && <AttributeTablePanel />}</div>
        {tab === "history" && <EditHistoryPanel />}
        {tab === "messages" && <LogPanel mode="messages" />}
        {tab === "logs" && <LogPanel mode="logs" />}
      </div>
    </section>
  );
}
