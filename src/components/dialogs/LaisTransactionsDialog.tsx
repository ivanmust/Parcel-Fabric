import { useEffect, useState } from "react";
import type { VersionInfo } from "@arcgis/core/versionManagement/support/jsonTypes.js";
import { versionSession } from "../../gis/version-management/versionSession";
import { useEditing } from "../../stores/editingStore";

/**
 * LAIS transactions awaiting review.
 *
 * The LAIS integration API creates one PUBLIC version per transaction (LAIS_<id>_<hash>)
 * and records the transaction fields on the Plot inside it. Editors open the version
 * here, review the Plot, and reconcile/post it with the normal Version Manager tools.
 */
const isLaisVersion = (v: VersionInfo) => /(^|\.)LAIS_/i.test(v.versionIdentifier.name);

export function LaisTransactionsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const versions = useEditing((s) => s.versions);
  const loading = useEditing((s) => s.versionsLoading);
  const current = useEditing((s) => s.current);
  const [workingGuid, setWorkingGuid] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setError(null);
      void versionSession.refreshVersions();
    }
  }, [open]);

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

  return (
    <calcite-dialog
      open={open || undefined}
      modal
      width="m"
      heading="LAIS transactions for review"
      description="Each validated LAIS transaction has its own public version with the transaction recorded on the Plot."
      oncalciteDialogClose={onClose}
    >
      <div style={{ width: "min(100%, 760px)" }}>
        <div className="ps-row space" style={{ marginBottom: 12 }}>
          <strong>{laisVersions.length} LAIS version(s)</strong>
          <calcite-button scale="s" appearance="outline" icon-start="refresh" loading={loading || undefined} disabled={loading || !!workingGuid || undefined} onClick={() => void versionSession.refreshVersions()}>
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
              return (
                <calcite-list-item key={v.versionIdentifier.guid} label={v.versionIdentifier.name} description={v.description ?? ""}>
                  {isCurrent && (
                    <calcite-chip slot="content-end" kind="brand" scale="s" label="Current version">
                      Current
                    </calcite-chip>
                  )}
                  <calcite-action
                    slot="actions-end"
                    icon="code-branch"
                    text={workingGuid === v.versionIdentifier.guid ? "Opening version" : "Open version"}
                    disabled={isCurrent || !!workingGuid || loading || undefined}
                    onClick={() => void openVersion(v)}
                  />
                </calcite-list-item>
              );
            })}
          </calcite-list>
        )}
        <div className="muted" style={{ fontSize: 12, marginTop: 12 }}>
          Opening a version switches your map to it. Reconcile and post with the Version Manager when the review is complete; the LAIS API never posts to DEFAULT.
        </div>
      </div>
    </calcite-dialog>
  );
}
