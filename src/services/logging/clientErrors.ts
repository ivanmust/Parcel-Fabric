import { apiFetch } from "../api/apiClient";
import { useApp } from "../../stores/appStore";

const MAX_REPORTS_PER_MINUTE = 10;
let sent: number[] = [];

function report(message: string, context?: string) {
  const now = Date.now();
  sent = sent.filter((t) => now - t < 60_000);
  if (sent.length >= MAX_REPORTS_PER_MINUTE) return;
  sent.push(now);
  // Strip anything that looks like a token before it leaves the browser.
  const scrub = (s?: string) => s?.replace(/([?&](?:token|access_token)=)[^&\s]*/gi, "$1[REDACTED]").slice(0, 3000);
  apiFetch("/client-log", { method: "POST", json: { level: "error", message: scrub(message), context: scrub(context) } }).catch(() => undefined);
}

/** Capture uncaught errors into the Logs tab and the server log. Returns an uninstall function. */
export function installClientErrorReporting(): () => void {
  const onError = (e: ErrorEvent) => {
    // ResizeObserver loop warnings are benign browser noise.
    if (e.message?.includes("ResizeObserver")) return;
    useApp.getState().log("error", "runtime", e.message, e.filename ? `${e.filename}:${e.lineno}` : undefined);
    report(e.message, e.error?.stack);
  };
  const onRejection = (e: PromiseRejectionEvent) => {
    const r = e.reason as { name?: string; message?: string; stack?: string } | undefined;
    // Cancelled requests are normal. "request:interceptor" is a request the app refused on purpose
    // (the UPI rules), already explained to the user, so it is not a runtime error.
    if (r?.name === "AbortError" || r?.name === "request:interceptor") return;
    useApp.getState().log("error", "runtime", r?.message ?? String(e.reason));
    report(r?.message ?? String(e.reason), r?.stack);
  };
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  return () => {
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
  };
}
