import { useEffect, useState } from "react";
import { useEditing } from "../../stores/editingStore";
import { useApp } from "../../stores/appStore";
import { formatNumber } from "../../utils/format";
import {
  describeStatus,
  previewEditingDone,
  sendEditingDone,
  type EditingDonePreview,
  type EditingDoneView,
  type LaisTransactionSummary,
  type ParcelInfo,
} from "../../services/lais/editingDone";

/**
 * "Editing done": the editor checks what GIS will send to LAIS for the registrar's approval, then sends
 * it. GIS reads the work from the transaction's version on the server, so edits must be saved first.
 */
export function EditingDoneDialog({ transaction, onClose, onSent }: { transaction: LaisTransactionSummary | null; onClose: () => void; onSent: () => void }) {
  const current = useEditing((s) => s.current);
  const pending = useEditing((s) => s.pendingEdits);
  const notify = useApp((s) => s.notify);
  const [preview, setPreview] = useState<EditingDonePreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<EditingDoneView | null>(null);

  const open = !!transaction;
  const onVersion = !!transaction && current?.name === transaction.version_name;

  const load = async () => {
    if (!transaction) return;
    setLoading(true);
    setError(null);
    try {
      setPreview(await previewEditingDone(transaction.Transaction_ID));
    } catch (e) {
      setPreview(null);
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setResult(null);
    setPreview(null);
    if (open) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload only when another transaction is opened
  }, [transaction?.Transaction_ID]);

  const send = async () => {
    if (!transaction) return;
    setSending(true);
    setError(null);
    try {
      const r = await sendEditingDone(transaction.Transaction_ID);
      setResult(r.editing_done);
      const s = describeStatus(r.editing_done);
      notify(s.tone === "ok" ? "success" : s.tone === "bad" ? "danger" : "warning", s.label, transaction.Transaction_ID);
      onSent();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  };

  const p = preview?.payload;
  const blocked = loading || sending || !p || !!preview?.problems.length || pending > 0 || !onVersion || !!result;
  const blockReason = !onVersion
    ? "Open this transaction's version first."
    : pending > 0
      ? `Save your ${pending} unsaved edit(s) first: GIS sends what is saved in the version.`
      : null;
  const areaDiff = p ? Math.round((p.totals.proposed_area_sqm - p.totals.parent_area_sqm) * 100) / 100 : 0;

  return (
    <calcite-dialog
      open={open || undefined}
      modal
      width="m"
      heading="Editing done: send to LAIS"
      description={transaction ? `${transaction.Transaction_Type} ${transaction.Transaction_ID} · ${transaction.UPIs.join(", ") || "new plot"}` : ""}
      oncalciteDialogClose={onClose}
    >
      <div className="ps-editing-done">
        {blockReason && !result && (
          <calcite-notice open kind="warning" scale="s" icon="exclamation-mark-triangle">
            <div slot="message">{blockReason}</div>
          </calcite-notice>
        )}
        {error && (
          <calcite-notice open kind="danger" scale="s">
            <div slot="message">{error}</div>
          </calcite-notice>
        )}
        {loading && <div className="ps-empty">Reading the version…</div>}

        {preview && preview.problems.length > 0 && (
          <calcite-notice open kind="danger" scale="s" icon="x-octagon">
            <div slot="title">Not ready to send</div>
            <div slot="message">
              <ul className="ps-editing-done-list">
                {preview.problems.map((m) => (
                  <li key={m}>{m}</li>
                ))}
              </ul>
            </div>
          </calcite-notice>
        )}
        {preview && preview.warnings.length > 0 && (
          <calcite-notice open kind="warning" scale="s">
            <div slot="title">Check before sending</div>
            <div slot="message">
              <ul className="ps-editing-done-list">
                {preview.warnings.map((m) => (
                  <li key={m}>{m}</li>
                ))}
              </ul>
            </div>
          </calcite-notice>
        )}

        {p && (
          <>
            <div className="kv">
              <div className="k">Record</div>
              <div className="mono">{p.record_name}</div>
              <div className="k">Version</div>
              <div className="mono">{p.version_name}</div>
              <div className="k">Area before → after</div>
              <div>
                {formatNumber(p.totals.parent_area_sqm)} m² → {formatNumber(p.totals.proposed_area_sqm)} m²
                {areaDiff !== 0 && <span className="ps-editing-done-diff"> ({areaDiff > 0 ? "+" : ""}{formatNumber(areaDiff)} m²)</span>}
              </div>
            </div>
            <ParcelTable title={`Replaced (${p.parent_parcels.length})`} parcels={p.parent_parcels} />
            <ParcelTable title={`Proposed (${p.proposed_parcels.length})`} parcels={p.proposed_parcels} proposed />
          </>
        )}

        {result && (
          <calcite-notice open kind={result.status === "delivered" ? "success" : result.status === "refused" || result.status === "failed" ? "danger" : "warning"} scale="s">
            <div slot="message">{describeStatus(result).label}</div>
          </calcite-notice>
        )}
        <div className="muted" style={{ fontSize: 12 }}>
          After sending, do not reconcile and post this version yourself: it is posted when the registrar approves in LAIS, and GIS then creates the new UPIs.
        </div>
      </div>

      <calcite-button slot="footer-start" appearance="transparent" icon-start="refresh" disabled={loading || sending || undefined} onClick={() => void load()}>
        Check again
      </calcite-button>
      <calcite-button slot="footer-end" appearance="outline" kind="neutral" onClick={onClose}>
        {result ? "Close" : "Cancel"}
      </calcite-button>
      {!result && (
        <calcite-button slot="footer-end" icon-start="send" loading={sending || undefined} disabled={blocked || undefined} onClick={() => void send()}>
          Send to LAIS
        </calcite-button>
      )}
    </calcite-dialog>
  );
}

function ParcelTable({ title, parcels, proposed = false }: { title: string; parcels: ParcelInfo[]; proposed?: boolean }) {
  return (
    <div>
      <h3 className="ps-section-title" style={{ margin: "4px 0 6px" }}>
        {title}
      </h3>
      {parcels.length === 0 ? (
        <div className="muted" style={{ fontSize: 12 }}>
          None
        </div>
      ) : (
        <div className="ps-log ps-editing-done-table">
          <table>
            <thead>
              <tr>
                <th>UPI</th>
                <th>Area (m²)</th>
                <th>Location</th>
              </tr>
            </thead>
            <tbody>
              {parcels.map((x, i) => (
                <tr key={i}>
                  <td className="mono">{x.UPI ?? (proposed ? <span className="muted">new: UPI at approval</span> : "—")}</td>
                  <td className="mono">{x.area_sqm === null ? "—" : formatNumber(x.area_sqm)}</td>
                  <td>{[x.village, x.cell, x.sector, x.district].filter(Boolean).join(", ") || <span className="muted">missing</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
