import { useEditing } from "../../stores/editingStore";
import { formatTime } from "../../utils/format";

/** Server-confirmed edit operations and session / version events for this browser session. */
export function EditHistoryPanel() {
  const history = useEditing((s) => s.history);
  const clear = useEditing((s) => s.clearHistory);

  const exportCsv = () => {
    const head = "time,kind,version,layer,action,adds,updates,deletes,failures,ok,detail";
    const rows = history.map((h) =>
      [h.time.toISOString(), h.kind, h.version, h.layer ?? "", h.action, h.adds ?? "", h.updates ?? "", h.deletes ?? "", h.failures ?? "", h.ok, (h.detail ?? "").replace(/"/g, '""')]
        .map((v) => `"${v}"`)
        .join(","),
    );
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([[head, ...rows].join("\n")], { type: "text/csv" }));
    a.download = `editing-history-${new Date().toISOString().slice(0, 19).replace(/:/g, "")}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <>
      <div className="ps-table-toolbar">
        <span className="muted" style={{ fontSize: 12 }}>
          {history.length} operation(s) · also written to the server audit log
        </span>
        <span className="ps-grow" />
        <calcite-button scale="s" appearance="transparent" icon-start="download" disabled={!history.length || undefined} onClick={exportCsv}>
          Export CSV
        </calcite-button>
        <calcite-button scale="s" appearance="transparent" icon-start="trash" disabled={!history.length || undefined} onClick={clear}>
          Clear
        </calcite-button>
      </div>
      <div className="ps-log">
        {!history.length ? (
          <div className="ps-empty">
            <calcite-icon icon="clock" scale="l" />
            <p>Edits, saves, discards and version operations appear here once confirmed by the server.</p>
          </div>
        ) : (
          <table>
            <tbody>
              {history.map((h) => (
                <tr key={h.id}>
                  <td className="time mono">{formatTime(h.time)}</td>
                  <td>
                    <span className={`lvl ${h.ok ? (h.kind === "edit" ? "lvl-success" : "lvl-info") : "lvl-error"}`}>{h.kind}</span>
                  </td>
                  <td className="src mono">{h.version}</td>
                  <td>
                    {h.layer ? <strong>{h.layer}: </strong> : null}
                    {h.action}
                    {h.kind === "edit" && (
                      <span className="muted">
                        {" "}
                        — {h.adds} added, {h.updates} updated, {h.deletes} deleted{h.failures ? `, ${h.failures} failed` : ""}
                      </span>
                    )}
                    {h.detail && <div className="detail mono">{h.detail}</div>}
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
