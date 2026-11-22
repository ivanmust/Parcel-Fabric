import esriConfig from "@arcgis/core/config.js";
import IdentityManager from "@arcgis/core/identity/IdentityManager.js";
import OAuthInfo from "@arcgis/core/identity/OAuthInfo.js";
import type Credential from "@arcgis/core/identity/Credential.js";
import type { AppRuntimeConfig, SessionUser } from "../../types/app";
import { apiFetch, setApiTokenProvider } from "../api/apiClient";


const STORAGE_KEY = "parcel-studio.identity";

let portalUrl = "";
const sharingUrl = () => `${portalUrl}/sharing`;

export function initAuth(cfg: AppRuntimeConfig): void {
  portalUrl = cfg.portalUrl;
  esriConfig.portalUrl = cfg.portalUrl;
  esriConfig.request.useIdentity = true;

  if (cfg.oauthAppId) {
    IdentityManager.registerOAuthInfos([
      new OAuthInfo({ appId: cfg.oauthAppId, portalUrl: cfg.portalUrl, popup: false, flowType: "auto" }),
    ]);
  } else {
    restoreStoredCredentials();
    IdentityManager.on("credential-create", persistCredentials);
  }
  setApiTokenProvider(() => getPortalToken());
}

function restoreStoredCredentials(): void {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const json = JSON.parse(raw) as { credentials?: { expires?: number }[] };
    const now = Date.now();
    const valid = (json.credentials ?? []).filter((c) => !c.expires || c.expires > now + 60_000);
    if (valid.length) IdentityManager.initialize({ ...json, credentials: valid });
    else sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    sessionStorage.removeItem(STORAGE_KEY);
  }
}

function persistCredentials(): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(IdentityManager.toJSON()));
  } catch {
    /* storage unavailable (private mode) – session simply won't survive reloads */
  }
}

/** The current Portal token, if signed in. Never log or display this value. */
export function getPortalToken(): string | undefined {
  return IdentityManager.findCredential(sharingUrl())?.token;
}

/** Returns an existing credential without prompting, or null. */
export async function checkExistingSignIn(): Promise<Credential | null> {
  try {
    return await IdentityManager.checkSignInStatus(sharingUrl());
  } catch {
    return null;
  }
}

/** Prompt the user to sign in (OAuth redirect or the SDK sign-in dialog). */
export async function signIn(): Promise<Credential> {
  // Without the Portal address the SDK would ask for credentials for this web server instead.
  if (!portalUrl) throw new Error("Sign-in isn't ready yet: the server configuration hasn't loaded. Reload the page and try again.");
  const credential = await IdentityManager.getCredential(sharingUrl());
  persistCredentials();
  return credential;
}

/** Resolve the application session (role + permissions) from the backend. */
export async function loadSession(): Promise<SessionUser> {
  const { user } = await apiFetch<{ user: SessionUser }>("/auth/session");
  return user;
}

export async function signOut(): Promise<void> {
  try {
    // Release version locks held by this session before the token is destroyed.
    const { versionSession } = await import("../../gis/version-management/versionSession");
    await versionSession.releaseLocks();
  } catch {
    /* best effort */
  }
  try {
    await apiFetch("/auth/signed-out", { method: "POST" });
  } catch {
    /* sign out locally even if the API is down */
  }
  IdentityManager.destroyCredentials();
  sessionStorage.removeItem(STORAGE_KEY);
  window.location.reload();
}
