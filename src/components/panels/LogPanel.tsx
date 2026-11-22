import { useMemo, useState } from "react";
import { useApp } from "../../stores/appStore";
import { formatTime } from "../../utils/format";
import type { LogLevel } from "../../types/app";

/** "messages" = user-facing notifications; "logs" = full application log. */
export function LogPanel({ mode }: { mode: "messages" | "logs" }) {
  const logs = useApp((s) => s.logs);
  const notices = useApp((s) => s.notices);
  const [level, setLevel] = useState<LogLevel | "all">("all");
  const [q, setQ] = useState("");
  const { clearLogs, clearNotices } = useApp.getState();

  const rows = useMemo(() => {
    if (mode === "messages")
      return notices.map((n) => ({
        id: n.id,
        time: n.time,
        level: (n.kind === "danger" ? "error" : n.kind) as LogLevel,
        source: "app",
        message: n.title,
        detail: n.message,
      }));
    const s = q.trim().toLowerCase();
    return logs.filter(
      (l) => (level === "all" || l.level === level) && (!s || `${l.source} ${l.message} ${l.detail ?? ""}`.toLowerCase().includes(s)),
    );
  }, [mode, notices, logs, level, q]);

  const exportLog = () => {
    const blob = new Blob([rows.map((r) => `${r.time.toISOString()}\t${r.level}\t${r.source}\t${r.message}\t${r.detail ?? ""}`).join("\n")], {
      type: "text/plain",
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `parcel-studio-${mode}-${new Date().toISOString().slice(0, 19).replace(/:/g, "")}.log`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <>
      <div className="ps-table-toolbar">
        {mode === "logs" && (
          <>
            <calcite-select
              scale="s"
              label="Level"
              style={{ width: 140 }}
              oncalciteSelectChange={(e) => setLevel((e.target as HTMLElement & { value: string }).value as LogLevel | "all")}
            >
              {["all", "error", "warning", "success", "info", "debug"].map((l) => (
                <calcite-option key={l} value={l} selected={level === l || undefined}>
                  {l === "all" ? "All levels" : l}
                </calcite-option>
              ))}
            </calcite-select>
            <calcite-input-text
              scale="s"
              icon="filter"
              placeholder="Filter"
              clearable
              value={q}
              style={{ width: 240 }}
              oncalciteInputTextInput={(e) => setQ((e.target as HTMLElement & { value: string }).value)}
            />
          </>
        )}
        <span className="muted" style={{ fontSize: 12 }}>
          {rows.length} {mode === "messages" ? "messages" : "entries"}
        </span>
        <span className="ps-grow" />
        <calcite-button scale="s" appearance="transparent" icon-start="download" disabled={!rows.length || undefined} onClick={exportLog}>
          Export
        </calcite-button>
        <calcite-button scale="s" appearance="transparent" icon-start="trash" disabled={!rows.length || undefined} onClick={mode === "logs" ? clearLogs : clearNotices}>
          Clear
        </calcite-button>
      </div>
      <div className="ps-log">
        {rows.length === 0 ? (
          <div className="ps-empty">
            <calcite-icon icon={mode === "messages" ? "speech-bubble" : "file-text"} scale="l" />
            <p>Nothing here yet.</p>
          </div>
        ) : (
          <table>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="time mono">{formatTime(r.time)}</td>
                  <td>
                    <span className={`lvl lvl-${r.level}`}>{r.level}</span>
                  </td>
                  <td className="src">{r.source}</td>
                  <td>
                    {r.message}
                    {r.detail && <div className="detail mono">{r.detail}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
