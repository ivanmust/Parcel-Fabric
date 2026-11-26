import { useCallback, useEffect, useState } from "react";
import type { VersionInfo } from "@arcgis/core/versionManagement/support/jsonTypes.js";
import { versionSession } from "../../gis/version-management/versionSession";
import { isLaisVersion } from "../../gis/version-management/laisVersions";
import { useEditing } from "../../stores/editingStore";
import { useApp } from "../../stores/appStore";
import { describeStatus, listLaisTransactions, type LaisTransactionSummary } from "../../services/lais/editingDone";
import { EditingDoneDialog } from "./EditingDoneDialog";

/**
 * LAIS transactions awaiting review.
 *
 * The LAIS integration API creates one PUBLIC version per transaction, named
 * {TYPE}-{CASE_NUMBER}-{DATE} (e.g. SUBV-CASE123-20261125) with a description starting "LAIS ".
 * Editors open the version here and do the work. With "Editing done" switched on (server setting
 * LAIS_EDITING_DONE), they then send the work to LAIS for the registrar's approval instead of posting
 * it themselves; otherwise they reconcile and post it with the Version Manager.
 */
export function LaisTransactionsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const versions = useEditing((s) => s.versions);
  const loading = useEditing((s) => s.versionsLoading);
  const current = useEditing((s) => s.current);
  const enabled = useApp((s) => !!s.config?.features?.laisEditingDone);
  const canEdit = useApp((s) => !!s.user?.permissions.includes("features:edit"));
  const [workingGuid, setWorkingGuid] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [transactions, setTransactions] = useState<Map<string, LaisTransactionSummary>>(new Map());
  const [editingDoneFor, setEditingDoneFor] = useState<LaisTransactionSummary | null>(null);

  const loadTransactions = useCallback(async () => {
    if (!enabled || !canEdit) return;
    try {
      const r = await listLaisTransactions();
      setTransactions(new Map(r.transactions.map((t) => [t.version_name.toLowerCase(), t])));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [enabled, canEdit]);

  useEffect(() => {
    if (open) {
      setError(null);
      void versionSession.refreshVersions();
      void loadTransactions();
    }
  }, [open, loadTransactions]);

  const laisVersions = versions.filter(isLaisVersion);

  const openVersion = async (v: VersionInfo) => {
    setWorkingGuid(v.versionIdentifier.guid);
    setError(null);
    try {
      await versionSession.switchTo(v.versionIdentifier);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setWorkingGuid(null);
    }
  };

  const refresh = () => {
    void versionSession.refreshVersions();
    void loadTransactions();
  };

  return (
    <calcite-dialog
      open={open || undefined}
      modal
      width="m"
      heading="LAIS transactions for review"
      description={
        enabled
          ? "Open a transaction's version, do the work, save it, then press Editing done to send it to LAIS for the registrar's approval."
          : "Each validated LAIS transaction has its own public version. Open it, do the work, then reconcile and post it."
      }
      oncalciteDialogClose={onClose}
    >
      <div style={{ width: "min(100%, 760px)" }}>
        <div className="ps-row space" style={{ marginBottom: 12 }}>
          <strong>{laisVersions.length} LAIS version(s)</strong>
          <calcite-button scale="s" appearance="outline" icon-start="refresh" loading={loading || undefined} disabled={loading || !!workingGuid || undefined} onClick={refresh}>
            Refresh
          </calcite-button>
        </div>

        {error && (
          <calcite-notice open kind="danger" scale="s" style={{ marginBottom: 10 }}>
            <div slot="message">{error}</div>
          </calcite-notice>
        )}

        {loading && laisVersions.length === 0 ? (
          <div className="ps-empty">Loading versions…</div>
        ) : laisVersions.length === 0 ? (
          <div className="ps-empty">
            <calcite-icon icon="check-circle" scale="l" />
            <p>No LAIS transactions are waiting for review.</p>
          </div>
        ) : (
          <calcite-list label="LAIS versions" scale="m">
            {laisVersions.map((v) => {
              const isCurrent = current?.guid === v.versionIdentifier.guid;
              const tx = transactions.get(v.versionIdentifier.name.toLowerCase());
              const status = enabled && tx ? describeStatus(tx.editing_done, tx.decision) : null;
              const decided = tx?.decision?.kind === "approved" || tx?.decision?.kind === "approving";
              const rejected = tx?.decision?.kind === "rejected";
              const inFlight = tx?.editing_done?.status === "sending" || tx?.editing_done?.status === "retrying";
              // Delivered and not rejected: only revised work can be sent (the server checks it changed).
              const revision = tx?.editing_done?.status === "delivered" && !rejected;
              const sendLabel = decided
                ? "Approved by LAIS"
                : inFlight
                  ? "Sending to LAIS"
                  : !isCurrent
                    ? "Editing done (open the version first)"
                    : rejected
                      ? "Send the revised work to LAIS"
                      : revision
                        ? "Send a revision to LAIS (only if you changed the work)"
                        : "Editing done: send to LAIS";
              return (
                <calcite-list-item key={v.versionIdentifier.guid} label={v.versionIdentifier.name} description={status ? `${v.description ?? ""} · ${status.label}` : (v.description ?? "")}>
                  {isCurrent && (
                    <calcite-chip slot="content-end" kind="brand" scale="s" label="Current version">
                      Current
                    </calcite-chip>
                  )}
                  {status && status.tone !== "none" && (
                    <calcite-icon
                      slot="content-end"
                      scale="s"
                      icon={status.tone === "ok" ? "check-circle" : status.tone === "bad" ? "exclamation-mark-triangle" : "clock"}
                      text-label={status.label}
                      title={status.label}
                    />
                  )}
                  <calcite-action
                    slot="actions-end"
                    icon="code-branch"
                    text={workingGuid === v.versionIdentifier.guid ? "Opening version" : "Open version"}
                    disabled={isCurrent || !!workingGuid || loading || undefined}
                    onClick={() => void openVersion(v)}
                  />
                  {enabled && tx && canEdit && (
                    <calcite-action
                      slot="actions-end"
                      icon="send"
                      text={sendLabel}
                      disabled={!isCurrent || decided || inFlight || tx.posted || undefined}
                      onClick={() => setEditingDoneFor(tx)}
                    />
                  )}
                </calcite-list-item>
              );
            })}
          </calcite-list>
        )}
        <div className="muted" style={{ fontSize: 12, marginTop: 12 }}>
          {enabled
            ? "Opening a version switches your map to it. LAIS versions are posted when the registrar approves in LAIS; the LAIS API never posts to DEFAULT without that approval."
            : "Opening a version switches your map to it. Reconcile and post with the Version Manager when the review is complete; the LAIS API never posts to DEFAULT."}
        </div>
      </div>
      <EditingDoneDialog transaction={editingDoneFor} onClose={() => setEditingDoneFor(null)} onSent={() => void loadTransactions()} />
    </calcite-dialog>
  );
}
