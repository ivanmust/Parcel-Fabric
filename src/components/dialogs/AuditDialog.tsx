import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "../../services/api/apiClient";
import { useApp } from "../../stores/appStore";
import { ROLE_LABELS, type AppRole } from "../../types/app";

/**
 * Activity audit (administrators, permission admin:audit): who did what, when, and whether it worked.
 * Reads the server audit trail (GET /api/audit): sign-ins, version and edit-session operations, feature
 * and Parcel Fabric edits, records, and LAIS API submissions.
 */

type Outcome = "success" | "failure" | "attempt";

interface AuditEvent {
  id: string;
  time: string;
  username: string;
  appRole: string;
  action: string;
  target?: string;
  outcome: Outcome;
  details?: Record<string, unknown>;
  ip?: string;
  requestId?: string;
}

const PAGE = 100;

/** Activity groups: the value is the start of the action names in the group. */
const CATEGORIES = [
  { value: "", label: "All activities" },
  { value: "auth.", label: "Sign-ins" },
  { value: "version.", label: "Versions" },
  { value: "edit-session.", label: "Edit sessions" },
  { value: "feature.", label: "Feature edits" },
  { value: "parcel-fabric.", label: "Parcel Fabric operations" },
  { value: "record.", label: "Records" },
  { value: "lais.", label: "LAIS API" },
  { value: "webhook.", label: "Subdivision webhook" },
];

const LABELS: Record<string, string> = {
  "auth.sign-in": "Signed in",
  "version.create": "Created version",
  "version.switch": "Switched version",
  "version.delete": "Deleted version",
  "version.reconcile": "Reconciled version",
  "version.reconcile-post": "Reconciled & posted",
  "edit-session.start": "Started editing",
  "edit-session.save": "Saved edits",
  "edit-session.discard": "Discarded edits",
  "feature.edit": "Edited features",
  "record.create": "Created record",
  "lais.transaction.submit": "LAIS transaction",
  "lais.editing-done": "Editing done (to LAIS)",
  "lais.editing-done.delivery": "Notification to LAIS",
  "lais.transaction.approve": "Registrar approval (LAIS)",
  "lais.transaction.reject": "Registrar rejection (LAIS)",
  "lais.transaction.post": "Posted after approval",
  "webhook.event.created": "Subdivision event created",
  "webhook.delivery": "Webhook delivery to App B",
  "webhook.dead-letter": "Webhook dead-lettered",
  "webhook.replay": "Webhook replayed",
};

/** Roles as shown; INTEGRATION is the LAIS API (a server, not a person). */
const roleLabel = (role: string) => (role === "INTEGRATION" ? "LAIS API" : (ROLE_LABELS[role as AppRole] ?? role));

const OUTCOME_CLASS: Record<Outcome, string> = { success: "lvl-success", failure: "lvl-error", attempt: "lvl-warning" };

export function activityLabel(action: string): string {
  if (LABELS[action]) return LABELS[action];
  if (action.startsWith("parcel-fabric.")) {
    const op = action.slice("parcel-fabric.".length).replace(/-/g, " ");
    return op.charAt(0).toUpperCase() + op.slice(1);
  }
  return action;
}

const list = (v: unknown) => (Array.isArray(v) ? v.join(", ") : v === undefined || v === null ? "" : String(v));
const has = (v: unknown) => list(v) !== "";
const count = (v: unknown) => (Array.isArray(v) ? v.length : typeof v === "number" ? v : 0);

/** A short line describing what happened; the full details are shown when the row is opened. */
export function summarize(e: AuditEvent): string {
  const d = e.details ?? {};
  const parts: string[] = [];
  if (e.action === "feature.edit" || e.action.startsWith("parcel-fabric.")) {
    const [a, u, x] = [count(d.adds), count(d.updates), count(d.deletes)];
    if (a) parts.push(`${a} added`);
    if (u) parts.push(`${u} updated`);
    if (x) parts.push(`${x} deleted`);
    if (count(d.failures)) parts.push(`${count(d.failures)} failed`);
    if (!parts.length) parts.push("no changes");
    if (has(d.record)) parts.push(`record ${list(d.record)}`);
    if (has(d.parcel)) parts.push(`parcel ${list(d.parcel)}`);
    if (has(d.parcels)) parts.push(`parcels ${list(d.parcels)}`);
    if (has(d.parents)) parts.push(`from ${list(d.parents)}`);
    if (has(d.newName)) parts.push(`new ${list(d.newName)}`);
  } else if (e.action === "version.switch") {
    if (d.from) parts.push(`from ${list(d.from)}`);
  } else if (e.action === "version.create") {
    if (d.access) parts.push(`${list(d.access)} access`);
  } else if (e.action.startsWith("edit-session.")) {
    if (d.pending !== undefined) parts.push(`${list(d.pending)} unsaved edit(s)`);
  } else if (e.action === "lais.editing-done" || e.action === "lais.editing-done.delivery") {
    if (d.record) parts.push(`record ${list(d.record)}`);
    if (d.parcels !== undefined) parts.push(`${list(d.parcels)} parcel(s)`);
    if (d.attempt !== undefined) parts.push(`attempt ${list(d.attempt)}`);
    if (d.status) parts.push(list(d.status));
    if (d.result) parts.push(list(d.result));
    if (d.message) parts.push(list(d.message));
    if (d.code) parts.push(list(d.code));
  } else if (e.action.startsWith("webhook.")) {
    if (d.attempt !== undefined) parts.push(`attempt ${list(d.attempt)}`);
    if (d.result) parts.push(list(d.result));
    if (d.parcels) parts.push(`UPIs ${list(d.parcels)}`);
    if (d.message) parts.push(list(d.message));
    if (d.reason) parts.push(list(d.reason));
    if (d.next_attempt_at) parts.push(`next try ${new Date(String(d.next_attempt_at)).toLocaleTimeString("en-GB")}`);
  } else if (e.action === "lais.transaction.approve" || e.action === "lais.transaction.reject" || e.action === "lais.transaction.post") {
    if (d.approved_by) parts.push(`by ${list(d.approved_by)}`);
    if (d.rejected_by) parts.push(`by ${list(d.rejected_by)}`);
    if (has(d.UPIs)) parts.push(`UPI ${list(d.UPIs)}`);
    if (d.reason) parts.push(list(d.reason));
    if (d.code) parts.push(list(d.code));
  } else if (e.action === "lais.transaction.submit") {
    parts.push(has(d.UPIs) ? `UPI ${list(d.UPIs)}` : "no parcel");
    if (d.version) parts.push(`version ${list(d.version)}`);
    if (d.duplicate) parts.push("duplicate");
    if (d.code) parts.push(list(d.code));
    if (d.errors) parts.push(list(d.errors));
    if (d.heldBy) parts.push(`held by ${list(d.heldBy)}`);
  }
  if (d.error) parts.push(list(d.error));
  if (!parts.length) {
    for (const [k, v] of Object.entries(d).slice(0, 4)) if (v !== null && typeof v !== "object") parts.push(`${k}: ${String(v)}`);
  }
  return parts.join(" · ");
}

const formatWhen = (iso: string) =>
  new Date(iso).toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

/** A local calendar day (yyyy-mm-dd) as the ISO instant it starts at; `nextDay` gives the end of that day. */
const dayStart = (day: string, nextDay = false) => {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y!, m! - 1, d! + (nextDay ? 1 : 0)).toISOString();
};

interface Filters {
  from: string;
  to: string;
  user: string;
  category: string;
  outcome: "" | Outcome;
  text: string;
}

const EMPTY: Filters = { from: "", to: "", user: "", category: "", outcome: "", text: "" };

function queryString(f: Filters, before?: string): string {
  const p = new URLSearchParams({ limit: String(PAGE) });
  // Accept the two days in either order.
  const [first, last] = f.from && f.to && f.from > f.to ? [f.to, f.from] : [f.from, f.to];
  if (first) p.set("from", dayStart(first));
  if (last) p.set("to", dayStart(last, true));
  if (f.user.trim()) p.set("username", f.user.trim());
  if (f.category) p.set("action", f.category);
  if (f.outcome) p.set("outcome", f.outcome);
  if (f.text.trim()) p.set("q", f.text.trim());
  if (before) p.set("before", before);
  return p.toString();
}

const csvCell = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;

export function AuditDialog() {
  const open = useApp((s) => s.dialogs.audit);
  const setDialog = useApp((s) => s.setDialog);
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const request = useRef(0);

  const load = useCallback(async (f: Filters, more: { before: string } | null) => {
    const id = ++request.current;
    setLoading(true);
    setError(null);
    try {
      const page = await apiFetch<{ events: AuditEvent[]; hasMore: boolean }>(`/audit?${queryString(f, more?.before)}`);
      if (id !== request.current) return; // a newer search replaced this one
      setEvents((prev) => (more ? [...prev, ...page.events] : page.events));
      setHasMore(page.hasMore);
    } catch (e) {
      if (id === request.current) setError((e as Error).message);
    } finally {
      if (id === request.current) setLoading(false);
    }
  }, []);

  // Reload when the dialog opens or a filter changes (typed text waits until typing pauses).
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => void load(filters, null), 300);
    return () => clearTimeout(t);
  }, [open, filters, load]);

  const set = <K extends keyof Filters>(k: K, v: Filters[K]) => setFilters((f) => ({ ...f, [k]: v }));
  const value = (e: Event) => (e.target as HTMLElement & { value: string }).value ?? "";

  const exportCsv = () => {
    const header = ["Time", "User", "Role", "Activity", "Action", "Target", "Result", "Summary", "IP", "Request ID", "Details"];
    const rows = events.map((e) => [e.time, e.username, roleLabel(e.appRole), activityLabel(e.action), e.action, e.target, e.outcome, summarize(e), e.ip, e.requestId, e.details ? JSON.stringify(e.details) : ""]);
    const blob = new Blob(["﻿" + [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `parcel-fabric-audit-${new Date().toISOString().slice(0, 19).replace(/:/g, "")}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const filtered = JSON.stringify(filters) !== JSON.stringify(EMPTY);

  return (
    <calcite-dialog
      id="dlg-audit"
      open={open || undefined}
      modal
      width="l"
      heading="Activity audit"
      description="Who did what in the Parcel Fabric application and the LAIS API, newest first."
      oncalciteDialogClose={() => setDialog("audit", false)}
    >
      <div className="ps-audit">
        <div className="ps-audit-filters">
          <calcite-label scale="s">
            From
            <calcite-input type="date" scale="s" value={filters.from} oncalciteInputChange={(e) => set("from", value(e))} />
          </calcite-label>
          <calcite-label scale="s">
            To
            <calcite-input type="date" scale="s" value={filters.to} oncalciteInputChange={(e) => set("to", value(e))} />
          </calcite-label>
          <calcite-label scale="s">
            User
            <calcite-input-text scale="s" icon="user" placeholder="Any user" clearable value={filters.user} oncalciteInputTextInput={(e) => set("user", value(e))} />
          </calcite-label>
          <calcite-label scale="s">
            Activity
            <calcite-select scale="s" label="Activity" oncalciteSelectChange={(e) => set("category", value(e))}>
              {CATEGORIES.map((c) => (
                <calcite-option key={c.value} value={c.value} selected={filters.category === c.value || undefined}>
                  {c.label}
                </calcite-option>
              ))}
            </calcite-select>
          </calcite-label>
          <calcite-label scale="s">
            Result
            <calcite-select scale="s" label="Result" oncalciteSelectChange={(e) => set("outcome", value(e) as Filters["outcome"])}>
              {[
                ["", "Any result"],
                ["success", "Success"],
                ["failure", "Failure"],
                ["attempt", "Attempt"],
              ].map(([v, l]) => (
                <calcite-option key={v} value={v} selected={filters.outcome === v || undefined}>
                  {l}
                </calcite-option>
              ))}
            </calcite-select>
          </calcite-label>
          <calcite-label scale="s" className="ps-audit-search">
            Search
            <calcite-input-text scale="s" icon="search" placeholder="Version, UPI, record, transaction…" clearable value={filters.text} oncalciteInputTextInput={(e) => set("text", value(e))} />
          </calcite-label>
        </div>

        <div className="ps-table-toolbar">
          <span className="muted" style={{ fontSize: 12 }}>
            {loading && !events.length ? "Loading…" : `${events.length}${hasMore ? "+" : ""} event${events.length === 1 ? "" : "s"}${filtered ? " matching the filters" : ""}`}
          </span>
          <span className="ps-grow" />
          <calcite-button scale="s" appearance="transparent" icon-start="reset" disabled={!filtered || undefined} onClick={() => setFilters(EMPTY)}>
            Clear filters
          </calcite-button>
          <calcite-button scale="s" appearance="transparent" icon-start="refresh" loading={loading || undefined} onClick={() => void load(filters, null)}>
            Refresh
          </calcite-button>
          <calcite-button scale="s" appearance="transparent" icon-start="download" disabled={!events.length || undefined} onClick={exportCsv}>
            Export CSV
          </calcite-button>
        </div>

        {error && (
          <calcite-notice open kind="danger" scale="s" style={{ margin: "8px 0" }}>
            <div slot="message">{error}</div>
          </calcite-notice>
        )}

        <div className="ps-log ps-audit-table">
          {!loading && !error && events.length === 0 ? (
            <div className="ps-empty">
              <calcite-icon icon="clock" scale="l" />
              <p>{filtered ? "No activity matches these filters." : "No activity has been recorded yet."}</p>
            </div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Time</th>
                  <th>User</th>
                  <th>Activity</th>
                  <th>Version / target</th>
                  <th>Result</th>
                  <th>Details</th>
                </tr>
              </thead>
              <tbody>
                {events.map((e) => {
                  const isOpen = expanded === e.id;
                  return (
                    <Fragment key={e.id}>
                      <tr className={`ps-audit-row${isOpen ? " open" : ""}`} onClick={() => setExpanded(isOpen ? null : e.id)} title="Show all details">
                        <td className="time mono">{formatWhen(e.time)}</td>
                        <td className="src">
                          {e.username}
                          <div className="detail">{roleLabel(e.appRole)}</div>
                        </td>
                        <td className="activity">{activityLabel(e.action)}</td>
                        <td className="mono target">{e.target ?? ""}</td>
                        <td className="result">
                          <span className={`lvl ${OUTCOME_CLASS[e.outcome] ?? "lvl-info"}`}>{e.outcome}</span>
                        </td>
                        <td>{summarize(e)}</td>
                      </tr>
                      {isOpen && (
                        <tr className="ps-audit-more">
                          <td colSpan={6}>
                            <div className="kv">
                              <div className="k">Action</div>
                              <div className="mono">{e.action}</div>
                              <div className="k">Time (UTC)</div>
                              <div className="mono">{e.time}</div>
                              <div className="k">IP address</div>
                              <div className="mono">{e.ip ?? "—"}</div>
                              <div className="k">Request ID</div>
                              <div className="mono">{e.requestId ?? "—"}</div>
                            </div>
                            {e.details && <pre className="ps-audit-json">{JSON.stringify(e.details, null, 2)}</pre>}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {hasMore && (
          <div style={{ textAlign: "center", marginTop: 8 }}>
            <calcite-button scale="s" appearance="outline" loading={loading || undefined} disabled={loading || undefined} onClick={() => void load(filters, { before: events[events.length - 1]!.id })}>
              Load {PAGE} more
            </calcite-button>
          </div>
        )}
      </div>
    </calcite-dialog>
  );
}
