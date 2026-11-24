import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "../../services/api/apiClient";
import { versionSession } from "../../gis/version-management/versionSession";
import { useEditing } from "../../stores/editingStore";

interface LaisTransaction {
  objectId: number;
  attributes: {
    UPI?: string;
    Transaction_ID?: string;
    Transaction_Status?: string;
    Transaction_Date?: string | number;
    case?: string;
    version_status?: string;
    version_name?: string;
  };
}

interface PendingResponse {
  transactions: LaisTransaction[];
}

function makeVersionName(transactionId: string): string {
  // ArcGIS version names allow letters, digits and underscores (max 62 chars).
  // Include a stable suffix so two long IDs that truncate alike remain distinct.
  let hash = 2166136261;
  for (let i = 0; i < transactionId.length; i++) {
    hash ^= transactionId.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const suffix = (hash >>> 0).toString(36).toUpperCase().slice(0, 7);
  const base = transactionId.replace(/[^A-Za-z0-9_]/g, "_").replace(/_+/g, "_").replace(/^\d/, "T$&").slice(0, 46);
  return `LAIS_${base}_${suffix}`;
}

function formatDate(value: string | number | undefined): string {
  if (value === undefined || value === null || value === "") return "—";
  const date = typeof value === "number" ? new Date(value) : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString("en-GB");
}

export function LaisTransactionsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [transactions, setTransactions] = useState<LaisTransaction[]>([]);
  const [loading, setLoading] = useState(false);
  const [workingId, setWorkingId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await apiFetch<PendingResponse>("/lais-workflow/pending");
      setTransactions(result.transactions ?? []);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) {
      setMessage(null);
      void load();
    }
  }, [open, load]);

  const createVersion = async (transaction: LaisTransaction) => {
    const transactionId = transaction.attributes.Transaction_ID;
    if (!transactionId) {
      setError("This transaction has no Transaction_ID. Correct the GIS table record before proceeding.");
      return;
    }
    setWorkingId(transaction.objectId);
    setError(null);
    setMessage(null);
    const versionName = makeVersionName(transactionId);
    try {
      // Recover safely if the version was created previously but recording its
      // name in the transaction table failed: do not create a duplicate.
      await versionSession.refreshVersions();
      const existing = useEditing.getState().versions.find((v) => v.versionIdentifier.name === versionName);
      if (!existing) {
        const description = `LAIS transaction ${transactionId}; UPI ${transaction.attributes.UPI ?? "unknown"}`;
        await versionSession.createVersion(versionName, "private", description);
      }

      await apiFetch(`/lais-workflow/${encodeURIComponent(String(transaction.objectId))}/version`, {
        method: "POST",
        json: { versionName },
      });
      setMessage(`Created and recorded version ${versionName} for transaction ${transactionId}.`);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setWorkingId(null);
    }
  };

  return (
    <calcite-dialog
      open={open || undefined}
      modal
      width="m"
      heading="LAIS transactions awaiting versions"
      description="Only transactions validated by the LAIS integration API (case = Yes) appear here."
      oncalciteDialogClose={onClose}
    >
      <div style={{ minWidth: 520, maxWidth: 760 }}>
        <div className="ps-row space" style={{ marginBottom: 12 }}>
          <strong>{transactions.length} pending transaction(s)</strong>
          <calcite-button scale="s" appearance="outline" icon-start="refresh" loading={loading || undefined} disabled={loading || !!workingId || undefined} onClick={() => void load()}>
            Refresh
          </calcite-button>
        </div>

        {error && (
          <calcite-notice open kind="danger" scale="s" style={{ marginBottom: 10 }}>
            <div slot="message">{error}</div>
          </calcite-notice>
        )}
        {message && (
          <calcite-notice open kind="success" scale="s" style={{ marginBottom: 10 }}>
            <div slot="message">{message}</div>
          </calcite-notice>
        )}

        {loading && transactions.length === 0 ? (
          <div className="ps-empty">Loading transactions…</div>
        ) : transactions.length === 0 ? (
          <div className="ps-empty">
            <calcite-icon icon="check-circle" scale="l" />
            <p>No validated LAIS transactions are waiting for version generation.</p>
          </div>
        ) : (
          <calcite-list label="Pending LAIS transactions" scale="m">
            {transactions.map((transaction) => {
              const a = transaction.attributes;
              return (
                <calcite-list-item
                  key={transaction.objectId}
                  label={a.Transaction_ID ?? `GIS record ${transaction.objectId}`}
                  description={`UPI: ${a.UPI ?? "—"} · ${a.Transaction_Status ?? "—"} · ${formatDate(a.Transaction_Date)}`}
                >
                  <calcite-chip slot="content-end" kind="success" scale="s">Validated</calcite-chip>
                  <calcite-button
                    slot="actions-end"
                    scale="s"
                    icon-start="code-branch"
                    loading={workingId === transaction.objectId || undefined}
                    disabled={!!workingId || loading || undefined}
                    onClick={() => void createVersion(transaction)}
                  >
                    Generate version
                  </calcite-button>
                </calcite-list-item>
              );
            })}
          </calcite-list>
        )}
        <div className="muted" style={{ fontSize: 12, marginTop: 12 }}>
          Versions are created as private named versions using your signed-in ArcGIS account. The app does not automatically switch your active editing session.
        </div>
      </div>
    </calcite-dialog>
  );
}
