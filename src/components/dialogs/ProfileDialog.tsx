import { useApp } from "../../stores/appStore";
import { ROLE_LABELS } from "../../types/app";

/** Who the user is in Portal, and what that means in this application. */
export function ProfileDialog() {
  const open = useApp((s) => s.dialogs.profile);
  const user = useApp((s) => s.user);
  const setDialog = useApp((s) => s.setDialog);
  if (!user) return null;

  const editPrivs = user.privileges.filter((p) => p.startsWith("features:") || p.includes("edit"));

  return (
    <calcite-dialog open={open || undefined} modal heading="Profile & permissions" width="m" oncalciteDialogClose={() => setDialog("profile", false)}>
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div className="ps-row" style={{ gap: 12 }}>
          <calcite-avatar scale="l" full-name={user.fullName} username={user.username} thumbnail={user.thumbnailUrl} />
          <div>
            <div style={{ fontWeight: 600, fontSize: 16 }}>{user.fullName}</div>
            <div className="muted mono">{user.username}</div>
            {user.email && <div className="muted">{user.email}</div>}
          </div>
        </div>
        <div className="kv">
          <div className="k">Application role</div>
          <div>{ROLE_LABELS[user.appRole]}</div>
          <div className="k">Portal role</div>
          <div className="mono">{user.portalRole}</div>
          <div className="k">User type</div>
          <div className="mono">{user.userLicenseTypeId ?? "—"}</div>
          <div className="k">Feature editing (Portal)</div>
          <div>{user.canEditFeaturesInPortal ? "Granted" : "Not granted"}</div>
          <div className="k">Editing privileges</div>
          <div className="mono" style={{ fontSize: 12 }}>{editPrivs.join(", ") || "none"}</div>
        </div>
        <div>
          <h3 className="ps-section-title" style={{ marginBottom: 6 }}>
            Application permissions
          </h3>
          <div className="svc-caps">
            {user.permissions.map((p) => (
              <calcite-chip key={p} scale="s" label={p}>
                {p}
              </calcite-chip>
            ))}
          </div>
        </div>
        <calcite-notice open kind="info" scale="s" icon="information">
          <div slot="message">
            Application roles only control which tools are offered. Every edit is still authorised by ArcGIS Enterprise
            against your own Portal account; Parcel Fabric editing also requires the ArcGIS Advanced Editing user type
            extension.
          </div>
        </calcite-notice>
      </div>
    </calcite-dialog>
  );
}
