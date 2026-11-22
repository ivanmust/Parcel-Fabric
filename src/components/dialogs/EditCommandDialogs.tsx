import { useEffect, useState } from "react";
import { useEditing } from "../../stores/editingStore";
import { useApp } from "../../stores/appStore";
import { versionSession } from "../../gis/version-management/versionSession";
import { deleteSelected, planDeleteSelected, type DeletePlan, type ParcelDeleteMode } from "../../gis/editing/editOperations";

type Kind = "delete-selected" | "discard" | "stop-editing" | "start-default";

/** Confirmations for consequential edit commands (raised via the "ps:confirm" event). */
export function EditCommandDialogs() {
  const [kind, setKind] = useState<Kind | null>(null);
  const [plan, setPlan] = useState<DeletePlan | null>(null);
  const [busy, setBusy] = useState(false);
  const current = useEditing((s) => s.current);
  const pending = useEditing((s) => s.pendingEdits);
  const record = useEditing((s) => s.activeRecord);
  const { notify } = useApp.getState();

  useEffect(() => {
    const on = (e: Event) => {
      const k = (e as CustomEvent<Kind>).detail;
      if (k === "delete-selected") setPlan(planDeleteSelected());
      setKind(k);
    };
    window.addEventListener("ps:confirm", on);
    return () => window.removeEventListener("ps:confirm", on);
  }, []);

  const close = () => {
    if (!busy) setKind(null);
  };
  const run = async (fn: () => Promise<void>, failTitle: string) => {
    setBusy(true);
    try {
      await fn();
      setKind(null);
    } catch (e) {
      notify("danger", failTitle, (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const runDelete = async (mode: ParcelDeleteMode) => {
    const r = await deleteSelected(mode);
    const verb = mode === "retire" ? "processed" : "deleted";
    if (r.failed) notify("warning", `${r.deleted} done, ${r.failed} failed`, r.errors.join(" · "));
    else notify("success", plan?.hasParcels && mode === "retire" ? "Parcels retired" : "Features deleted", `${r.deleted} feature(s) ${verb} (unsaved)`);
  };

  const footer = (confirmLabel: string, onConfirm: () => void, danger = false, extra?: React.ReactNode, confirmDisabled = false) => (
    <>
      <calcite-button slot="footer-end" appearance="outline" kind="neutral" disabled={busy || undefined} onClick={close}>
        Cancel
      </calcite-button>
      {extra}
      <calcite-button slot="footer-end" kind={danger ? "danger" : "brand"} loading={busy || undefined} disabled={confirmDisabled || undefined} onClick={onConfirm}>
        {confirmLabel}
      </calcite-button>
    </>
  );

  return (
    <>
      <calcite-dialog id="dlg-delete" open={kind === "delete-selected" || undefined} modal width="s" heading={plan?.hasParcels ? "Retire or delete parcels?" : "Delete selected features?"} kind="danger" oncalciteDialogClose={close}>
        {plan && (
          <>
            <p style={{ marginTop: 0 }}>
              {plan.total.toLocaleString("en-US")} feature(s) will be deleted from <strong className="mono">{current?.name}</strong>. You can undo or discard
              until you save.
            </p>
            <div className="kv">
              {plan.layers.map((l) => (
                <Row key={l.layerKey} k={l.name} v={!l.editable ? `${l.count} selected – not editable, skipped` : l.parcels ? `${l.count} parcel(s)` : `${l.count} to delete`} />
              ))}
            </div>
            {plan.hasParcels && (
              <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 10 }}>
                <calcite-notice open kind="brand" scale="s" icon="clock">
                  <div slot="title">Retire (recommended)</div>
                  <div slot="message">The parcels become historic, retired by the active record{record ? ` (${record.name})` : ""}. Their history is kept.</div>
                </calcite-notice>
                <calcite-notice open kind="danger" scale="s" icon="trash">
                  <div slot="title">Delete permanently</div>
                  <div slot="message">For mistakes only. No history is kept; the parcels' unused lines and points are deleted too.</div>
                </calcite-notice>
                {!record && <div className="muted" style={{ fontSize: 12 }}>Choose the active parcel record to retire parcels.</div>}
              </div>
            )}
          </>
        )}
        {plan?.hasParcels
          ? footer(
              "Retire (keep history)",
              () => void run(() => runDelete("retire"), "Retire failed"),
              false,
              <calcite-button slot="footer-end" appearance="outline" kind="danger" disabled={busy || undefined} onClick={() => void run(() => runDelete("delete"), "Delete failed")}>
                Delete permanently
              </calcite-button>,
              !record,
            )
          : footer("Delete", () => void run(() => runDelete("delete"), "Delete failed"), true)}
      </calcite-dialog>

      <calcite-dialog id="dlg-discard" open={kind === "discard" || undefined} modal width="s" heading="Discard edits?" kind="danger" oncalciteDialogClose={close}>
        <p style={{ margin: 0 }}>
          All {pending} edit(s) made in <strong className="mono">{current?.name}</strong> since the last save will be rolled back on the server. This
          cannot be undone.
        </p>
        {footer("Discard edits", () => void run(() => versionSession.discard(), "Discard failed"), true)}
      </calcite-dialog>

      <calcite-dialog id="dlg-stop" open={kind === "stop-editing" || undefined} modal width="s" heading="Stop editing" oncalciteDialogClose={close}>
        <p style={{ margin: 0 }}>
          {pending > 0 ? `You have ${pending} unsaved edit(s) in ${current?.name}. Save them before stopping?` : `Stop the edit session on ${current?.name}?`}
        </p>
        {pending > 0
          ? footer(
              "Save and stop",
              () => void run(() => versionSession.stopEditing(true), "Save failed"),
              false,
              <calcite-button slot="footer-end" appearance="outline" kind="danger" disabled={busy || undefined} onClick={() => void run(() => versionSession.stopEditing(false), "Discard failed")}>
                Discard and stop
              </calcite-button>,
            )
          : footer("Stop editing", () => void run(() => versionSession.stopEditing(true, { silent: true }), "Stop failed"))}
      </calcite-dialog>

      <calcite-dialog id="dlg-start-default" open={kind === "start-default" || undefined} modal width="s" heading="Edit the default version?" kind="warning" oncalciteDialogClose={close}>
        <p style={{ marginTop: 0 }}>
          Edits to <strong className="mono">{current?.name}</strong> are immediately visible to every user and bypass reconcile/post review. The
          recommended workflow is to create or switch to a named version first.
        </p>
        <calcite-button
          slot="footer-start"
          appearance="transparent"
          icon-start="code-branch"
          onClick={() => {
            setKind(null);
            useEditing.getState().patch({ versionDialogOpen: true });
          }}
        >
          Choose a version
        </calcite-button>
        {footer("Edit default anyway", () => void run(() => versionSession.startEditing(), "Cannot start editing"), true)}
      </calcite-dialog>
    </>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <>
      <div className="k">{k}</div>
      <div style={{ fontSize: 12.5 }}>{v}</div>
    </>
  );
}
