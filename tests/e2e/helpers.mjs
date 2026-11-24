// Shared setup for the live end-to-end tests: test account, browser launch and sign-in.
import puppeteer from "puppeteer-core";
import { readFileSync } from "node:fs";

/** Test account from server/.env (git-ignored): ARCGIS_USERNAME / ARCGIS_PASSWORD. */
export const env = Object.fromEntries(
  readFileSync(new URL("../../server/.env", import.meta.url), "utf8")
    .split(/\r?\n/)
    .filter((l) => /^ARCGIS_(USERNAME|PASSWORD)=/.test(l))
    .map((l) => [l.split("=")[0], l.slice(l.indexOf("=") + 1).replace(/^"|"$/g, "")]),
);

export const APP_URL = process.env.APP_URL || "http://127.0.0.1:5174/";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Headless Chrome with GPU rendering (the ArcGIS map needs WebGL). Set CHROME_PATH if Chrome is elsewhere. */
export function launchBrowser() {
  return puppeteer.launch({
    executablePath: process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe",
    headless: "new",
    args: ["--use-angle=d3d11", "--enable-gpu", "--window-size=1600,950"],
    defaultViewport: { width: 1600, height: 950 },
    protocolTimeout: 240000,
  });
}

/**
 * Open the app and sign in through the Portal dialog, then wait until the version service is ready.
 * The Sign in button is clicked only once it is really usable: the Calcite element has started up,
 * it is not disabled and it reads "Sign in" (not "Connecting…"). Clicking earlier can be lost.
 */
export async function signIn(page, { readyTimeout = 120000 } = {}) {
  await page.goto(APP_URL, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForFunction(
    () => {
      const b = document.querySelector(".ps-signin calcite-button");
      return !!b && typeof b.setFocus === "function" && !b.disabled && b.textContent.trim() === "Sign in";
    },
    { timeout: 120000 },
  );
  await page.evaluate(() => document.querySelector(".ps-signin calcite-button").click());
  await page.waitForFunction(() => document.body.innerText.includes("Username:"), { timeout: 30000 });
  await sleep(800);
  await page.keyboard.type(env.ARCGIS_USERNAME);
  await page.keyboard.press("Tab");
  await page.keyboard.type(env.ARCGIS_PASSWORD);
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => window.__ps?.editing.getState().session === "reading", { timeout: readyTimeout });
}

/** Collect page errors and console errors (ArcGIS errors print as "[object r]"; their message and details are read). */
export function captureErrors(page) {
  const errors = [];
  page.on("pageerror", (e) => errors.push(`[pageerror] ${e.message.slice(0, 300)}`));
  page.on("console", async (m) => {
    if (m.type() !== "error") return;
    const parts = await Promise.all(
      m.args().map((h) =>
        h.evaluate((e) => (e && typeof e === "object" && ("message" in e || "details" in e) ? `${e.name ?? ""}: ${e.message ?? ""} ${JSON.stringify(e.details ?? {}, (k, v) => (k === "layer" || k === "view" ? undefined : v)).slice(0, 500)}` : String(e))).catch(() => "?"),
      ),
    );
    errors.push(`[console.error] ${parts.join(" | ").slice(0, 900)}`);
  });
  page.on("dialog", (d) => d.accept());
  return errors;
}

/** Page helpers shared by the editing suites. Searches go through shadow roots (Calcite, Editor). */
export function pageTools(page) {
  const deepClick = (text, { scope = "body", exact = true, tags = null } = {}) =>
    page.evaluate(
      (text, scope, exact, tags) => {
        const root = document.querySelector(scope);
        if (!root) return false;
        const stack = [root];
        while (stack.length) {
          const n = stack.pop();
          const kids = [...(n.children ?? []), ...(n.shadowRoot ? [...n.shadowRoot.children] : [])];
          for (const k of kids) stack.push(k);
          if (n === root || (tags && !tags.includes(n.tagName))) continue;
          const own = (n.getAttribute?.("label") || n.getAttribute?.("heading") || n.getAttribute?.("text") || n.textContent || "").trim();
          if (exact ? own === text : own.includes(text)) {
            if (!n.getClientRects().length) continue;
            n.click();
            return n.tagName;
          }
        }
        return false;
      },
      text,
      scope,
      exact,
      tags,
    );
  const state = () =>
    page.evaluate(() => {
      const e = window.__ps.editing.getState();
      return { session: e.session, current: e.current?.name, pending: e.pendingEdits, canUndo: e.canUndo, selection: e.selection, record: e.activeRecord, busy: e.busy };
    });
  const waitFor = async (fn, ms = 30000, label = "condition") => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (await fn()) return true;
      await sleep(400);
    }
    throw new Error(`Timed out waiting for ${label}`);
  };
  /** Count features in a layer (by fabric role) in the active version, read at the layer's moment so unsaved edits count. */
  const count = (role, where) =>
    page.evaluate(
      async (role, where) => {
        const info = window.__ps.registry.all().find((i) => i.fabricRole === role);
        return info.layer.queryFeatureCount(window.__ps.shown(info.layer, { where }));
      },
      role,
      where,
    );
  /** Focus a Calcite input (its <input> lives in a shadow root) and type into it. */
  const typeInto = async (sel, index, text) => {
    await page.evaluate(
      async (sel, index) => {
        const els = [...document.querySelectorAll(sel)];
        const el = index < 0 ? els[els.length + index] : els[index];
        await el.setFocus();
      },
      sel,
      index,
    );
    await sleep(200);
    await page.keyboard.type(text);
  };
  const workflow = () => page.evaluate(() => document.querySelector("arcgis-editor")?.activeWorkflow?.type ?? null);
  /** Some Editor workflows apply on their own, others wait for a confirm button. */
  const commitIfNeeded = async (pendBefore, labels) => {
    await sleep(3000);
    if ((await state()).pending > pendBefore) return;
    const buttons = await page.evaluate(() => {
      const out = [];
      const stack = [document.querySelector("arcgis-editor")];
      while (stack.length) {
        const n = stack.pop();
        if (!n) continue;
        for (const k of [...(n.children ?? []), ...(n.shadowRoot ? [...n.shadowRoot.children] : [])]) stack.push(k);
        if (["CALCITE-BUTTON", "CALCITE-ACTION", "BUTTON"].includes(n.tagName) && n.getClientRects().length)
          out.push(`${n.tagName.toLowerCase()}:"${(n.textContent || n.text || n.label || "").trim()}"${n.disabled ? "(disabled)" : ""}`);
      }
      return out;
    });
    console.log("[editor buttons]", buttons.join(", "));
    let clicked = false;
    for (const label of labels) if ((clicked = !!(await deepClick(label, { scope: "arcgis-editor", tags: ["CALCITE-BUTTON"] })))) break;
    // Split and merge confirm with "Submit (n)".
    if (!clicked) await deepClick("Submit", { scope: "arcgis-editor", exact: false, tags: ["CALCITE-BUTTON"] });
    await sleep(3000);
  };
  const key = async (k, mods = []) => {
    for (const m of mods) await page.keyboard.down(m);
    await page.keyboard.press(k);
    for (const m of [...mods].reverse()) await page.keyboard.up(m);
  };
  /** Cancel whatever Editor workflow is running. */
  const cancelWorkflow = () =>
    page.evaluate(() => {
      const ed = document.querySelector("arcgis-editor");
      if (ed?.activeWorkflow) return ed.cancelWorkflow();
    });
  return { deepClick, state, waitFor, count, typeInto, workflow, commitIfNeeded, key, cancelWorkflow };
}

/** The Version Manager opens by itself after sign-in; wait for it, then close it. */
export async function closeVersionManagerOnEntry(page, tools) {
  await tools.waitFor(async () => page.evaluate(() => window.__ps.editing.getState().versionDialogOpen), 15000, "version manager on entry").catch(() => undefined);
  await page.evaluate(() => window.__ps.editing.getState().patch({ versionDialogOpen: false }));
  await sleep(800);
}

/** Create a named version through the Version Manager UI and switch to it. */
export async function createVersionViaUI(page, tools, name) {
  const { deepClick, typeInto, waitFor, state } = tools;
  await page.click("button.ps-version-chip");
  await sleep(1500);
  await deepClick("New version", { scope: "#dlg-versions" });
  await sleep(500);
  await typeInto("#dlg-versions calcite-input-text", 0, name);
  await sleep(300);
  await deepClick("Create from", { scope: "#dlg-versions", exact: false, tags: ["CALCITE-BUTTON"] });
  await waitFor(async () => page.evaluate((v) => window.__ps.editing.getState().versions.some((x) => x.versionIdentifier.name.endsWith(v)), name), 30000, "version listed");
  await sleep(1500);
  await deepClick("Switch to this version", { scope: "#dlg-versions", tags: ["CALCITE-BUTTON"] });
  await waitFor(async () => ((await state()).current ?? "").endsWith(name), 30000, "switch");
  await page.evaluate(() => window.__ps.editing.getState().patch({ versionDialogOpen: false }));
  await sleep(800);
}

/** Create a parcel record in the Editing panel and make it the active record. */
export async function createActiveRecord(page, tools, name) {
  const { deepClick, waitFor, state } = tools;
  // openLeftPanel toggles; set it open instead, in case the panel is already showing.
  await page.evaluate(() => {
    const app = window.__ps.app.getState();
    app.setPref("leftPanel", "editing");
    app.setPref("leftOpen", true);
  });
  await sleep(2000);
  await deepClick("New record", { scope: ".ps-side.left", tags: ["CALCITE-BUTTON"] });
  await sleep(500);
  // Set the name on the field directly. Typing is unsafe: if the field is not focused yet,
  // keystrokes reach the map shortcuts ("-" in the name zooms the map out).
  await waitFor(async () => page.evaluate(() => !![...document.querySelectorAll(".ps-side.left calcite-input-text")].at(-1)?.getClientRects().length), 15000, "record name field");
  await page.evaluate((name) => {
    const el = [...document.querySelectorAll(".ps-side.left calcite-input-text")].at(-1);
    el.value = name;
    el.dispatchEvent(new CustomEvent("calciteInputTextInput", { bubbles: true, composed: true }));
  }, name);
  await sleep(300);
  await deepClick("Create & activate", { scope: ".ps-side.left", tags: ["CALCITE-BUTTON"] });
  await waitFor(async () => (await state()).record?.name === name, 30000, "active record");
  return (await state()).record;
}

/** Always run at the end: stop editing without saving, go back to DEFAULT and delete the test version. */
export function cleanupTestVersion(page, name) {
  return page.evaluate(async (vname) => {
    const vs = window.__ps.versionSession;
    const ed = window.__ps.editing.getState();
    if (ed.session === "editing") await vs.stopEditing(false, { silent: true });
    if (ed.current?.guid !== ed.defaultVersion?.guid) await vs.switchTo(ed.defaultVersion);
    const versions = await vs.refreshVersions();
    const v = versions.find((x) => x.versionIdentifier.name.endsWith(vname));
    if (v) await vs.deleteVersion(v.versionIdentifier);
    const after = await vs.refreshVersions();
    // A page that reloaded mid-run may not have the version service yet: an empty list proves nothing.
    if (!after?.some((x) => /DEFAULT$/i.test(x.versionIdentifier.name)))
      throw new Error(`Could not read the version list; check for a leftover ${vname} and run test:e2e:cleanup`);
    return { back: window.__ps.editing.getState().current?.name, stillThere: after.some((x) => x.versionIdentifier.name.endsWith(vname)) };
  }, name);
}
