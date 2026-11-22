import type { IconName } from "../../types/icons";
import { useApp } from "../../stores/appStore";
import { useEditing } from "../../stores/editingStore";
import { ROLE_LABELS, type ThemeMode } from "../../types/app";
import { signOut } from "../../services/authentication/authService";
import { formatTime } from "../../utils/format";

const THEME_NEXT: Record<ThemeMode, ThemeMode> = { light: "dark", dark: "system", system: "light" };
const THEME_ICON: Record<ThemeMode, IconName> = { light: "brightness", dark: "moon", system: "contrast" };

export function AppHeader() {
  const user = useApp((s) => s.user);
  const versionName = useApp((s) => s.activeVersionName);
  const session = useEditing((s) => s.session);
  const pending = useEditing((s) => s.pendingEdits);
  const theme = useApp((s) => s.theme);
  const notices = useApp((s) => s.notices);
  const unread = notices.filter((n) => !n.read).length;
  const { setPref, setDialog, markNoticesRead, clearNotices } = useApp.getState();

  return (
    <header className="ps-header">
      <div className="ps-brand">
        <div className="ps-brand-mark">
          <calcite-icon icon="parcel-layer" scale="s" />
        </div>
        Parcel Fabric
      </div>
      <div className="ps-crumbs" aria-label="Project">
        <span className="sep">/</span>
        <span>Rwanda</span>
        <span className="sep">/</span>
        <span>Cadastral workspace</span>
      </div>
      <div className="ps-header-spacer" />

      <button
        className={`ps-version-chip ${session === "editing" ? "" : "readonly"}`}
        title="Active geodatabase version – open the Version Manager"
        onClick={() => useEditing.getState().patch({ versionDialogOpen: true })}
      >
        <span className="dot" />
        <calcite-icon icon="code-branch" scale="s" />
        <span className="mono">{versionName ?? "Default version"}</span>
        <span className="muted">· {session === "editing" ? `editing${pending ? ` (${pending} unsaved)` : ""}` : "read"}</span>
      </button>

      <calcite-action
        id="ps-notif-trigger"
        text="Notifications"
        icon="bell"
        indicator={unread > 0 || undefined}
        onClick={() => setTimeout(markNoticesRead, 1500)}
      />
      <calcite-popover referenceElement="ps-notif-trigger" placement="bottom-end" label="Notifications" auto-close pointer-disabled>
        <div style={{ width: 360, maxHeight: 420, overflow: "auto" }}>
          <div className="ps-row space" style={{ padding: "10px 12px", borderBottom: "1px solid var(--calcite-color-border-3)" }}>
            <strong>Notifications</strong>
            <calcite-button appearance="transparent" scale="s" disabled={!notices.length || undefined} onClick={clearNotices}>
              Clear
            </calcite-button>
          </div>
          {notices.length === 0 ? (
            <div className="ps-empty">
              <calcite-icon icon="bell" scale="l" />
              <p>No notifications yet.</p>
            </div>
          ) : (
            <calcite-list label="Notifications">
              {notices.map((n) => (
                <calcite-list-item key={n.id} label={n.title} description={`${formatTime(n.time)}${n.message ? ` · ${n.message}` : ""}`}>
                  <calcite-icon
                    slot="content-start"
                    scale="s"
                    icon={n.kind === "danger" ? "exclamation-mark-triangle" : n.kind === "success" ? "check-circle" : n.kind === "warning" ? "exclamation-mark-circle" : "information"}
                  />
                </calcite-list-item>
              ))}
            </calcite-list>
          )}
        </div>
      </calcite-popover>

      <calcite-action text="Keyboard shortcuts & help" icon="question" onClick={() => setDialog("shortcuts", true)} />
      <calcite-action text="Settings" icon="gear" onClick={() => setDialog("settings", true)} />
      <calcite-action
        text={`Theme: ${theme}`}
        icon={THEME_ICON[theme]}
        onClick={() => setPref("theme", THEME_NEXT[theme])}
      />

      {user && (
        <>
          <button id="ps-user-trigger" className="ps-user-btn" aria-label="User menu">
            <calcite-avatar scale="s" full-name={user.fullName} username={user.username} thumbnail={user.thumbnailUrl} />
            <span className="ps-user-meta">
              {user.fullName}
              <small>{ROLE_LABELS[user.appRole]}</small>
            </span>
          </button>
          <calcite-popover referenceElement="ps-user-trigger" placement="bottom-end" label="User" auto-close>
            <div style={{ width: 260 }}>
              <div style={{ padding: 12, borderBottom: "1px solid var(--calcite-color-border-3)" }}>
                <strong>{user.fullName}</strong>
                <div className="muted mono" style={{ fontSize: 12 }}>
                  {user.username}
                </div>
              </div>
              <calcite-list label="User actions">
                <calcite-list-item label="Profile & permissions" onClick={() => setDialog("profile", true)}>
                  <calcite-icon slot="content-start" icon="user" scale="s" />
                </calcite-list-item>
                <calcite-list-item label="Sign out" onClick={() => void signOut()}>
                  <calcite-icon slot="content-start" icon="sign-out" scale="s" />
                </calcite-list-item>
              </calcite-list>
            </div>
          </calcite-popover>
        </>
      )}
    </header>
  );
}
