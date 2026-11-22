import type { IconName } from "../../types/icons";
import { useEffect } from "react";
import { useApp } from "../../stores/appStore";
import type { Notice } from "../../types/app";

const ICON: Record<Notice["kind"], IconName> = {
  info: "information",
  success: "check-circle",
  warning: "exclamation-mark-circle",
  danger: "exclamation-mark-triangle",
};

function Toast({ n }: { n: Notice }) {
  const dismiss = useApp((s) => s.dismissToast);
  useEffect(() => {
    // Errors stay until dismissed; everything else fades after a few seconds.
    if (n.kind === "danger") return;
    const t = setTimeout(() => dismiss(n.id), n.kind === "warning" ? 7000 : 4000);
    return () => clearTimeout(t);
  }, [n, dismiss]);
  return (
    <div className={`ps-toast ps-float ${n.kind}`} role={n.kind === "danger" ? "alert" : "status"}>
      <calcite-icon icon={ICON[n.kind]} scale="s" />
      <div style={{ minWidth: 0 }}>
        <strong>{n.title}</strong>
        {n.message && <span>{n.message}</span>}
      </div>
      <calcite-action icon="x" text="Dismiss" scale="s" onClick={() => dismiss(n.id)} />
    </div>
  );
}

export function Toasts() {
  const toasts = useApp((s) => s.toasts);
  return (
    <div className="ps-toasts" aria-live="polite">
      {toasts.map((n) => (
        <Toast key={n.id} n={n} />
      ))}
    </div>
  );
}
