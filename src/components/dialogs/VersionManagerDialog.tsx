import { useEffect, useRef, useState } from "react";
import type { VersionIdentifier, VersionInfoExtended } from "@arcgis/core/versionManagement/support/jsonTypes.js";
import { useEditing, isDefaultVersion } from "../../stores/editingStore";
import { useApp, hasPermission } from "../../stores/appStore";
import { versionSession } from "../../gis/version-management/versionSession";
import { ConfirmDialog } from "./ConfirmDialog";
import { calciteInput } from "../../utils/calciteInput";
import { LaisTransactionsDialog } from "./LaisTransactionsDialog";

const fmt = (t?: number) => (t ? new Date(t).toLocaleString("en-GB") : "—");

type Pending =
  | { kind: "delete"; id: VersionIdentifier }
  | { kind: "reconcile"; withPost: boolean }
  | null;

/** Branch version manager: list, inspect, create, switch, delete, reconcile and post. */
export function VersionManagerDialog() {
  const open = useEditing((s) => s.versionDialogOpen);
  const versions = useEditing((s) => s.versions);
  const loading = useEditing((s) => s.versionsLoading);
  const current = useEditing((s) => s.current);
  const defaultVersion = useEditing((s) => s.defaultVersion);
  const session = useEditing((s) => s.session);
  const pending = useEditing((s) => s.pendingEdits);
  const busy = useEditing((s) => s.busy);
  const user = useApp((s) => s.user);
  const [selected, setSelected] = useState<VersionIdentifier | null>(null);
  const [details, setDetails] = useState<VersionInfoExtended | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ name: "", access: "private" as "private" | "protected" | "public", description: "" });
  const [showCreate, setShowCreate] = useState(false);
  const [laisOpen, setLaisOpen] = useState(false);
  const [confirm, setConfirm] = useState<Pending>(null);
  const [conflictDetection, setConflictDetection] = useState<"by-object" | "by-attribute">("by-object");
  const notify = useApp.getState().notify;
  const shownOnEntry = useRef(false);

  // Version first: when the workspace becomes ready after sign-in, open the Version Manager
  // so the user picks (or creates) the version to work in before doing anything else.
  useEffect(() => {
    if (shownOnEntry.current || session !== "reading") return;
    shownOnEntry.current = true;
    useEditing.getState().patch({ versionDialogOpen: true });
  }, [session]);

  useEffect(() => {
    if (open) {
      void versionSession.refreshVersions();
      setSelected(useEditing.getState().current);
    }
  }, [open]);

  useEffect(() => {
    setDetails(null);
    if (!selected || !open) return;
    let cancelled = false;
    versionSession
      .getVersionInfoExtended(selected)
      .then((d) => !cancelled && setDetails(d ?? null))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [selected, open, versions]);

  const close = () => useEditing.getState().patch({ versionDialogOpen: false });
  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const canManage = hasPermission(user, "versions:manage");
  const canPost = hasPermission(user, "versions:post");
  const onCurrent = !!selected && selected.guid === current?.guid;
  const selIsDefault = !!selected && selected.guid === defaultVersion?.guid;
  const owner = (name: string) => (name.includes(".") ? name.slice(0, name.lastIndexOf(".")) : "—");

  return (
    <calcite-dialog
      id="dlg-versions"
      open={open || undefined}
      modal
      width="l"
      heading="Version Manager"
      description={`Branch versions of the Parcel Fabric · active: ${current?.name ?? "—"}${session === "editing" ? " (editing)" : ""}`}
      loading={!!busy || undefined}
      oncalciteDialogClose={close}
    >
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1.2fr) minmax(0,1fr)", gap: 16, minHeight: 360 }}>
        <section>
          <div className="ps-row space" style={{ marginBottom: 8 }}>
            <strong>Versions ({versions.length})</strong>
            <div className="ps-row">
              {canManage && (
                <calcite-button scale="s" appearance="outline" icon-start="organization" onClick={() => setLaisOpen(true)}>
                  LAIS transactions
                </calcite-button>
              )}
              <calcite-button scale="s" appearance="transparent" icon-start="refresh" loading={loading || undefined} onClick={() => void versionSession.refreshVersions()}>
                Refresh
              </calcite-button>
              {canManage && (
                <calcite-button scale="s" appearance="outline" icon-start="plus" onClick={() => setShowCreate((s) => !s)}>
                  New version
                </calcite-button>
              )}
            </div>
          </div>
          {showCreate && (
            <div className="svc-card" style={{ marginBottom: 10 }}>
              <calcite-label scale="s">
                Name
                <calcite-input-text
                  scale="s"
                  value={form.name}
                  placeholder="e.g. Survey_2026_11"
                  oncalciteInputTextInput={calciteInput((name) => setForm((f) => ({ ...f, name })))}
                />
              </calcite-label>
              <calcite-label scale="s">
                Access
                <calcite-segmented-control
                  scale="s"
                  width="full"
                  oncalciteSegmentedControlChange={(e) => setForm({ ...form, access: (e.target as HTMLElement & { value: string }).value as typeof form.access })}
                >
                  {(["private", "protected", "public"] as const).map((a) => (
                    <calcite-segmented-control-item key={a} value={a} checked={form.access === a || undefined}>
                      {a}
                    </calcite-segmented-control-item>
                  ))}
                </calcite-segmented-control>
              </calcite-label>
              <calcite-label scale="s">
                Description
                <calcite-input-text
                  scale="s"
                  value={form.description}
                  oncalciteInputTextInput={calciteInput((description) => setForm((f) => ({ ...f, description })))}
                />
              </calcite-label>
              <calcite-button
                scale="s"
                icon-start="code-branch"
                disabled={!form.name.trim() || !!busy || undefined}
                onClick={() =>
                  void act(async () => {
                    const id = await versionSession.createVersion(form.name.trim(), form.access, form.description.trim());
                    setShowCreate(false);
                    setForm({ name: "", access: "private", description: "" });
                    setSelected(id);
                    notify("success", "Version created", id.name);
                  })
                }
              >
                Create from {defaultVersion?.name ?? "default"}
              </calcite-button>
            </div>
          )}
          <calcite-list label="Versions" scale="s" selection-mode="single-persist">
            {versions.map((v) => {
              const id = v.versionIdentifier;
              const isCur = id.guid === current?.guid;
              return (
                <calcite-list-item
                  key={id.guid}
                  label={id.name}
                  description={`${v.access ?? ""}${v.description ? ` · ${v.description}` : ""}`}
                  selected={selected?.guid === id.guid || undefined}
                  oncalciteListItemSelect={() => setSelected(id)}
                  onClick={() => setSelected(id)}
                >
                  <calcite-icon slot="content-start" icon={id.guid === defaultVersion?.guid ? "home" : "code-branch"} scale="s" />
                  {isCur && (
                    <calcite-chip slot="content-end" scale="s" kind="brand" label="Active">
                      Active
                    </calcite-chip>
                  )}
                </calcite-list-item>
              );
            })}
          </calcite-list>
        </section>

        <section>
          {!selected ? (
            <div className="ps-empty">
              <p>Select a version to see its properties.</p>
            </div>
          ) : (
            <>
              <strong className="mono">{selected.name}</strong>
              <div className="kv" style={{ marginTop: 8 }}>
                <Row k="Owner" v={owner(selected.name)} />
                <Row k="Access" v={details?.access ?? "—"} />
                <Row k="Parent" v={selIsDefault ? "—" : (defaultVersion?.name ?? "—")} />
                <Row k="Created" v={fmt(details?.creationDate)} />
                <Row k="Modified" v={fmt(details?.modifiedDate)} />
                <Row k="Last reconcile" v={fmt(details?.reconcileDate)} />
                <Row k="Being edited" v={details ? (details.isBeingEdited ? "yes" : "no") : "…"} />
                <Row k="Conflicts" v={details ? (details.hasConflicts ? `yes${details.hasUninspectedConflicts ? " (uninspected)" : ""}` : "no") : "…"} />
                <Row k="Locked" v={details ? (details.isLocked ? `yes${details.lockOwner ? ` by ${details.lockOwner}` : ""}` : "no") : "…"} />
                <Row k="Description" v={details?.description || "—"} />
              </div>

              {error && (
                <calcite-notice open kind="danger" scale="s" style={{ marginTop: 10 }}>
                  <div slot="message">{error}</div>
                </calcite-notice>
              )}

              <div className="ps-row" style={{ flexWrap: "wrap", gap: 6, marginTop: 12 }}>
                <calcite-button
                  scale="s"
                  icon-start="switch"
                  disabled={onCurrent || !!busy || (session === "editing" && pending > 0) || undefined}
                  title={session === "editing" && pending > 0 ? "Save or discard edits first" : undefined}
                  onClick={() => void act(() => versionSession.switchTo(selected))}
                >
                  Switch to this version
                </calcite-button>
                {canManage && !selIsDefault && (
                  <calcite-button scale="s" appearance="outline" kind="danger" icon-start="trash" disabled={onCurrent || !!busy || undefined} onClick={() => setConfirm({ kind: "delete", id: selected })}>
                    Delete
                  </calcite-button>
                )}
              </div>

              {onCurrent && !isDefaultVersion({ current, defaultVersion }) && canManage && (
                <div className="svc-card" style={{ marginTop: 12 }}>
                  <strong style={{ fontSize: 13 }}>Reconcile & post (active version)</strong>
                  <calcite-label scale="s">
                    Conflict detection
                    <calcite-segmented-control
                      scale="s"
                      oncalciteSegmentedControlChange={(e) => setConflictDetection((e.target as HTMLElement & { value: string }).value as typeof conflictDetection)}
                    >
                      <calcite-segmented-control-item value="by-object" checked={conflictDetection === "by-object" || undefined}>
                        By object
                      </calcite-segmented-control-item>
                      <calcite-segmented-control-item value="by-attribute" checked={conflictDetection === "by-attribute" || undefined}>
                        By attribute
                      </calcite-segmented-control-item>
                    </calcite-segmented-control>
                  </calcite-label>
                  <div className="ps-row" style={{ gap: 6, flexWrap: "wrap" }}>
                    <calcite-button scale="s" appearance="outline" icon-start="arrow-down" disabled={!!busy || pending > 0 || undefined} onClick={() => setConfirm({ kind: "reconcile", withPost: false })}>
                      Reconcile
                    </calcite-button>
                    {canPost && (
                      <calcite-button scale="s" icon-start="arrow-up" disabled={!!busy || pending > 0 || undefined} onClick={() => setConfirm({ kind: "reconcile", withPost: true })}>
                        Reconcile & post
                      </calcite-button>
                    )}
                  </div>
                  {pending > 0 && <div className="muted" style={{ fontSize: 12 }}>Save or discard your {pending} unsaved edit(s) first.</div>}
                  {!canPost && <div className="muted" style={{ fontSize: 12 }}>Posting to the default version requires the Administrator role.</div>}
                </div>
              )}
            </>
          )}
        </section>
      </div>

      <LaisTransactionsDialog open={laisOpen} onClose={() => setLaisOpen(false)} />
      <ConfirmDialog
        open={confirm?.kind === "delete"}
        title="Delete version?"
        message={confirm?.kind === "delete" ? `"${confirm.id.name}" and every unposted edit in it will be permanently deleted.` : ""}
        confirmLabel="Delete version"
        kind="danger"
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          const c = confirm;
          setConfirm(null);
          if (c?.kind === "delete")
            void act(async () => {
              await versionSession.deleteVersion(c.id);
              setSelected(useEditing.getState().current);
              notify("success", "Version deleted", c.id.name);
            });
        }}
      />
      <ConfirmDialog
        open={confirm?.kind === "reconcile"}
        title={confirm?.kind === "reconcile" && confirm.withPost ? "Reconcile and post?" : "Reconcile?"}
        message={
          confirm?.kind === "reconcile" && confirm.withPost
            ? `Changes in ${defaultVersion?.name} are merged into ${current?.name}; if there are no conflicts, the edits of ${current?.name} are then posted to ${defaultVersion?.name} and become visible to everyone. The operation is aborted if conflicts are found.`
            : `Changes made in ${defaultVersion?.name} since the last reconcile are merged into ${current?.name}. The operation is aborted if conflicts are found.`
        }
        confirmLabel={confirm?.kind === "reconcile" && confirm.withPost ? "Reconcile & post" : "Reconcile"}
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          const c = confirm;
          setConfirm(null);
          if (c?.kind === "reconcile")
            void act(async () => {
              const res = await versionSession.reconcile({ withPost: c.withPost, abortIfConflicts: true, conflictDetection });
              if (res.hasConflicts) notify("warning", "Conflicts found", "Reconcile was aborted. Conflict review arrives with Phase 5.");
              else if (!res.success) notify("danger", "Reconcile failed");
              else notify("success", c.withPost ? (res.didPost ? "Reconciled and posted" : "Reconciled (not posted)") : "Reconciled", current?.name);
              setDetails(null);
              await versionSession.refreshVersions();
            });
        }}
      />
    </calcite-dialog>
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
