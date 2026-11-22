import { useCallback, useEffect, useState } from "react";
import { apiFetch, ApiError } from "../services/api/apiClient";
import { checkExistingSignIn, initAuth, loadSession, signIn } from "../services/authentication/authService";
import { useApp } from "../stores/appStore";
import type { AppRuntimeConfig } from "../types/app";
import { applyTheme } from "./theme";
import { SignInScreen } from "../components/layout/SignInScreen";
import { Workspace } from "../components/layout/Workspace";
import { describeArcGISError } from "../services/arcgis/serviceMetadata";

type Phase =
  | { name: "booting" }
  | { name: "fatal"; message: string }
  | { name: "signed-out"; error?: string }
  | { name: "signing-in" }
  | { name: "ready" };

export function App() {
  const theme = useApp((s) => s.theme);
  const [phase, setPhase] = useState<Phase>({ name: "booting" });

  useEffect(() => {
    applyTheme(theme);
    if (theme !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyTheme("system");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [theme]);

  const establishSession = useCallback(async () => {
    const user = await loadSession();
    useApp.getState().setUser(user);
    useApp.getState().log("success", "auth", `Signed in as ${user.username} (${user.appRole})`);
    apiFetch("/auth/signed-in", { method: "POST" }).catch(() => undefined);
    setPhase({ name: "ready" });
  }, []);

  // Boot: load runtime config → configure IdentityManager → reuse existing sign-in if any.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let cfg: AppRuntimeConfig;
      try {
        cfg = await apiFetch<AppRuntimeConfig>("/config");
      } catch (e) {
        if (!cancelled) setPhase({ name: "fatal", message: (e as Error).message });
        return;
      }
      useApp.getState().setConfig(cfg);
      initAuth(cfg);
      const existing = await checkExistingSignIn();
      if (cancelled) return;
      if (!existing) return setPhase({ name: "signed-out" });
      try {
        await establishSession();
      } catch (e) {
        if (!cancelled) setPhase({ name: "signed-out", error: (e as Error).message });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [establishSession]);

  const handleSignIn = useCallback(async () => {
    setPhase({ name: "signing-in" });
    try {
      await signIn();
      await establishSession();
    } catch (e) {
      const msg =
        e instanceof ApiError
          ? e.message
          : (e as { name?: string }).name === "identity-manager:user-aborted"
            ? undefined
            : describeArcGISError(e);
      setPhase({ name: "signed-out", error: msg });
    }
  }, [establishSession]);

  if (phase.name === "ready") return <Workspace />;
  return (
    <SignInScreen
      busy={phase.name === "booting" || phase.name === "signing-in"}
      fatal={phase.name === "fatal" ? phase.message : undefined}
      error={phase.name === "signed-out" ? phase.error : undefined}
      onSignIn={handleSignIn}
    />
  );
}
