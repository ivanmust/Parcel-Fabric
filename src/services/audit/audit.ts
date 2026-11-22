import { apiFetch } from "../api/apiClient";
import { useApp } from "../../stores/appStore";


export function audit(action: string, outcome: "success" | "failure" | "attempt", target?: string, details?: Record<string, unknown>): void {
  apiFetch("/audit", { method: "POST", json: { action, outcome, target, details } }).catch((e: Error) =>
    useApp.getState().log("warning", "audit", `Audit event "${action}" not recorded`, e.message),
  );
}
