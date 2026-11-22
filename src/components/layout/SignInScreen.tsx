import { useEffect, useState } from "react";
import { useApp } from "../../stores/appStore";
import { apiFetch } from "../../services/api/apiClient";

interface Props {
  busy: boolean;
  fatal?: string;
  error?: string;
  onSignIn(): void;
}

interface Health {
  arcgis: { reachable: boolean; version?: string; latencyMs?: number; error?: string };
}

export function SignInScreen({ busy, fatal, error, onSignIn }: Props) {
  const config = useApp((s) => s.config);
  const [health, setHealth] = useState<Health | null>(null);

  useEffect(() => {
    apiFetch<Health>("/health").then(setHealth, () => setHealth(null));
  }, []);

  return (
    <main className="ps-signin">
      <div className="ps-signin-bg" aria-hidden="true" />

      <section className="ps-signin-card" aria-labelledby="ps-signin-title">
        <div className="ps-signin-mark" aria-hidden="true">
          <calcite-icon icon="parcel-layer" scale="l" />
        </div>
        <h1 id="ps-signin-title">Rwanda Parcel Fabric</h1>

        {fatal && (
          <calcite-notice open kind="danger" icon="exclamation-mark-triangle" scale="s">
            <div slot="title">Application server unavailable</div>
            <div slot="message">{fatal}</div>
          </calcite-notice>
        )}
        {error && (
          <calcite-notice open kind="danger" icon="lock" closable scale="s">
            <div slot="title">Sign-in failed</div>
            <div slot="message">{error}</div>
          </calcite-notice>
        )}
        {/* Shown only when something is wrong, so users know why sign-in will fail. */}
        {health && !health.arcgis.reachable && (
          <calcite-notice open kind="warning" icon="x-circle" scale="s">
            <div slot="message">ArcGIS Enterprise unreachable from the application server</div>
          </calcite-notice>
        )}

        <calcite-button
          width="full"
          scale="l"
          icon-start="sign-in"
          loading={busy || undefined}
          disabled={busy || !!fatal || !config || undefined}
          onClick={onSignIn}
        >
          {busy ? "Connecting…" : "Sign in"}
        </calcite-button>
      </section>

      <small className="ps-signin-credit">Imagery: Esri World Imagery</small>
    </main>
  );
}
