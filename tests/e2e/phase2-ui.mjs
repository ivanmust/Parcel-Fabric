// Phase 2 UI end-to-end test against the live services (throw-away version, no data edits).
import { cleanupTestVersion, launchBrowser, signIn, sleep } from "./helpers.mjs";

const out = process.argv[2] || (await import("node:os")).tmpdir();
const VERSION = `PS_E2E_${Date.now() % 100000000}`;
const results = [];
const check = (name, ok, detail = "") => {
  results.push(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  console.log(results.at(-1));
};

const browser = await launchBrowser();
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(`[pageerror] ${e.message.slice(0, 300)}`));
page.on("console", async (m) => {
  if (m.type() !== "error") return;
  // Resolve the SDK's error object so we can tell real failures from aborted requests.
  const detail = await Promise.all(m.args().slice(1).map((a) => a.evaluate((o) => (o && (o.name || o.message) ? `${o.name}: ${o.message}` : String(o))).catch(() => "?")));
  errors.push(`[console.error] ${m.text().slice(0, 160)} ${detail.join(" ")}`);
});

const click = (scope, text, tags = ["CALCITE-BUTTON"]) =>
  page.evaluate(
    (scope, text, tags) => {
      const root = document.querySelector(scope);
      const stack = root ? [root] : [];
      while (stack.length) {
        const n = stack.pop();
        for (const k of [...(n.children ?? []), ...(n.shadowRoot ? [...n.shadowRoot.children] : [])]) stack.push(k);
        if (n === root || !tags.includes(n.tagName) || !n.getClientRects().length) continue;
        if ((n.textContent || "").trim() === text || n.text === text) {
          n.click();
          return true;
        }
      }
      return false;
    },
    scope,
    text,
    tags,
  );
const typeInto = async (sel, index, text) => {
  await page.evaluate(
    async (sel, index) => {
      const els = [...document.querySelectorAll(sel)];
      await (index < 0 ? els[els.length + index] : els[index]).setFocus();
    },
    sel,
    index,
  );
  await sleep(200);
  await page.keyboard.type(text);
};
const ed = () =>
  page.evaluate(() => {
    const e = window.__ps.editing.getState();
    return { session: e.session, current: e.current?.name, selection: e.selection, adv: e.advancedEditing, versions: e.versions.map((v) => v.versionIdentifier.name), busy: e.busy };
  });
const waitFor = async (fn, ms, label) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return;
    await sleep(400);
  }
  throw new Error(`Timed out: ${label}`);
};
const key = async (k, mods = []) => {
  for (const m of mods) await page.keyboard.down(m);
  await page.keyboard.press(k);
  for (const m of [...mods].reverse()) await page.keyboard.up(m);
};
const total = (s) => s.selection.reduce((n, x) => n + x.count, 0);

try {
  await signIn(page);
  await waitFor(async () => (await ed()).adv !== "unknown", 20000, "licence probe");
  check("Signed in; version service ready", true, (await ed()).current);
  await waitFor(async () => page.evaluate(() => window.__ps.editing.getState().versionDialogOpen), 15000, "version manager on entry").catch(() => undefined);
  check("Version Manager opens first after sign-in", await page.evaluate(() => window.__ps.editing.getState().versionDialogOpen));
  await page.evaluate(() => window.__ps.editing.getState().patch({ versionDialogOpen: false }));
  await sleep(800);

  // ---- licence gating: depends on whether the test account has ArcGIS Advanced Editing
  const s0 = await ed();
  const licensed = s0.adv === "yes" || s0.adv === "not-required";
  check(`Advanced Editing licence detected (${licensed ? "licensed account" : "unlicensed account"})`, s0.adv !== "unknown", s0.adv);
  const toggle = await page.evaluate(() => {
    const a = [...document.querySelectorAll(".ps-toolbar calcite-action")].find((x) => (x.text ?? "").startsWith("Start editing"));
    return { disabled: !!a?.disabled, text: a?.text };
  });
  if (licensed) check("Toolbar 'Start editing' not blocked by the licence", !/Advanced Editing/.test(toggle.text ?? ""), toggle.text);
  else check("Toolbar 'Start editing' disabled with licence reason", toggle.disabled && /Advanced Editing/.test(toggle.text ?? ""), toggle.text);
  await page.evaluate(() => window.__ps.app.getState().openLeftPanel("editing"));
  await sleep(1500);
  const panelTxt = await page.evaluate(() => document.querySelector(".ps-side.left")?.innerText ?? "");
  if (licensed) check("Editing panel shows no licence warning", !panelTxt.includes("Advanced Editing licence required"), "");
  else check("Editing panel explains the licence prerequisite", panelTxt.includes("Advanced Editing licence required"), "");
  await page.screenshot({ path: `${out}/ui-1-editing-panel.png` });

  // ---- Version Manager: create + switch via UI
  await page.click("button.ps-version-chip");
  await sleep(1500);
  await click("#dlg-versions", "New version");
  await sleep(500);
  await typeInto("#dlg-versions calcite-input-text", 0, VERSION);
  await sleep(800);
  await page.evaluate(() => [...document.querySelectorAll("#dlg-versions calcite-button")].find((b) => b.textContent.trim().startsWith("Create from"))?.click());
  await waitFor(async () => (await ed()).versions.some((v) => v.endsWith(VERSION)), 30000, "version created");
  check("Version created via Version Manager UI", true, VERSION);
  await sleep(1500);
  await click("#dlg-versions", "Switch to this version");
  await waitFor(async () => ((await ed()).current ?? "").endsWith(VERSION), 30000, "switched");
  check("Switched to the new version via UI", true, (await ed()).current);
  const chip = await page.evaluate(() => document.querySelector("button.ps-version-chip")?.textContent ?? "");
  check("Header shows active version", chip.includes(VERSION), chip.trim());

  // ---- role rules are enforced by the version service itself, not only by hidden buttons
  const denied = await page.evaluate(async () => {
    const app = window.__ps.app.getState();
    const user = app.user;
    app.setUser({ ...user, permissions: user.permissions.filter((p) => p !== "versions:post" && p !== "versions:manage") });
    const out = {};
    try {
      await window.__ps.versionSession.reconcile({ withPost: true, abortIfConflicts: true, conflictDetection: "by-object" });
      out.post = "ALLOWED";
    } catch (e) {
      out.post = e.message;
    }
    try {
      await window.__ps.versionSession.createVersion("PS_E2E_NOT_ALLOWED", "private", "");
      out.create = "ALLOWED";
    } catch (e) {
      out.create = e.message;
    }
    app.setUser(user);
    return out;
  });
  check(
    "Without the permissions, the service refuses Reconcile & post and New version",
    /does not allow posting/.test(denied.post) && /does not allow version management/.test(denied.create),
    JSON.stringify(denied),
  );
  await page.screenshot({ path: `${out}/ui-2-version-manager.png` });
  await page.evaluate(() => window.__ps.editing.getState().patch({ versionDialogOpen: false }));
  await sleep(800);

  // ---- select by attributes (dialog)
  await key("A", ["Shift"]);
  await sleep(1200);
  await typeInto("#dlg-select-attributes calcite-text-area", 0, "name LIKE '1/02/08/01/17%'");
  await click("#dlg-select-attributes", "Verify");
  await sleep(2500);
  const verify = await page.evaluate(() => document.querySelector("#dlg-select-attributes calcite-notice")?.textContent?.trim() ?? "");
  const expected = Number((verify.match(/matches ([\d,]+)/)?.[1] ?? "0").replace(/,/g, ""));
  check("Where clause verified by server", expected > 0, verify);
  await click("#dlg-select-attributes", "Apply");
  await waitFor(async () => total(await ed()) > 0, 20000, "attribute selection");
  const sa = await ed();
  check("Select by attributes selects the server-matched features", total(sa) === expected, JSON.stringify(sa.selection));

  // ---- select by location: Points within the selected Plots
  await key("L", ["Shift"]);
  await sleep(1200);
  await page.evaluate(() => {
    const sel = document.querySelector("#dlg-select-location calcite-select");
    const opt = [...sel.querySelectorAll("calcite-option")].find((o) => o.textContent.startsWith("Points"));
    if (opt) {
      opt.selected = true;
      sel.dispatchEvent(new CustomEvent("calciteSelectChange", { bubbles: true }));
    }
  });
  await sleep(500);
  await click("#dlg-select-location", "Apply");
  await sleep(5000);
  const sl = await ed();
  const pts = sl.selection.find((s) => s.name === "Points");
  check("Select by location (Points intersecting selected Plots)", !!pts && pts.count > 0, JSON.stringify(sl.selection));

  // ---- selection panel + table "selected only"
  await page.evaluate(() => window.__ps.app.getState().openLeftPanel("selection"));
  await sleep(1200);
  const selItems = await page.evaluate(() =>
    [...document.querySelectorAll(".ps-side.left calcite-list-item")].filter((i) => i.getClientRects().length).map((i) => `${i.label}: ${i.description}`),
  );
  check("Selection panel lists layers with counts", selItems.some((t) => t.startsWith("Points:")) && selItems.some((t) => t.startsWith("Plot:")), selItems.join(" | "));
  await page.evaluate(() => {
    const app = window.__ps.app.getState();
    const plot = window.__ps.registry.all().find((i) => i.fabricRole === "parcel-polygon");
    app.openBottomTab("table", plot.key);
    window.dispatchEvent(new CustomEvent("ps:table-selected-only"));
  });
  await sleep(6000);
  const tableTitle = await page.evaluate(() => {
    const t = document.querySelector("arcgis-feature-table");
    // Concatenate text across all nested shadow roots, then match the header.
    const text = (n) => [...(n.shadowRoot ? n.shadowRoot.childNodes : []), ...n.childNodes].map((c) => (c.nodeType === 3 ? c.textContent : c.nodeType === 1 ? text(c) : "")).join(" ");
    const all = t ? text(t).replace(/\s+/g, " ") : "";
    return all.match(/Plot \(Total: [\d,]+ \| Selection: [\d,]+\)/)?.[0] ?? null;
  });
  check("Attribute table synced with map selection", !!tableTitle && tableTitle.includes(`Selection: ${expected}`), tableTitle ?? "n/a");
  await page.screenshot({ path: `${out}/ui-3-selection.png` });

  // ---- rectangle selection (new) then clear
  await key("Escape");
  await page.mouse.click(5, 5); // move focus out of the table grid
  await key("r");
  await sleep(2500); // the sketch tool code loads on first use
  const box = await (await page.$(".ps-map")).boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2 - 80;
  await page.mouse.move(cx - 60, cy - 40);
  await page.mouse.down();
  await page.mouse.move(cx + 60, cy + 40, { steps: 10 });
  await page.mouse.up();
  await sleep(5000);
  const sr = await ed();
  const changed = JSON.stringify(sr.selection) !== JSON.stringify(sl.selection);
  check("Rectangle selection replaces selection (server query, visible layers)", total(sr) > 0 && changed, JSON.stringify(sr.selection));
  await page.screenshot({ path: `${out}/ui-4-rectangle.png` });
  await key("Escape");
  await key("C", ["Shift"]);
  await sleep(1000);
  check("Clear selection (Shift+C)", total(await ed()) === 0);

  // ---- a parcel clicked with Explore is highlighted but not selected: the toolbar's Clear selection clears it
  const clearButton = () =>
    page.evaluate(() => {
      const a = [...document.querySelectorAll(".ps-toolbar calcite-action")].find((x) => (x.text ?? "").startsWith("Clear selection"));
      return a ? { enabled: !a.disabled, text: a.text } : null;
    });
  await key("e");
  await sleep(800);
  // Click until a parcel is hit (a click can land on a road between parcels).
  const highlightedNow = () => page.evaluate(() => window.__ps.app.getState().mapStatus.highlighted);
  for (const [dx, dy] of [[0, 0], [40, 30], [-60, 20], [80, -50], [-30, -70], [120, 60]]) {
    await page.mouse.click(cx + dx, cy + dy);
    await waitFor(highlightedNow, 4000, "identify highlight").catch(() => undefined);
    if (await highlightedNow()) break;
  }
  const before = await clearButton();
  check("Clear selection is enabled while a clicked parcel is highlighted", !!before?.enabled && total(await ed()) === 0, JSON.stringify(before));
  await page.evaluate(() => [...document.querySelectorAll(".ps-toolbar calcite-action")].find((x) => (x.text ?? "").startsWith("Clear selection"))?.click());
  await sleep(800);
  const after = await page.evaluate(() => ({ highlighted: window.__ps.app.getState().mapStatus.highlighted, properties: window.__ps.app.getState().properties.kind }));
  check("Clear selection removes the highlight and closes the parcel details", !after.highlighted && after.properties === "none" && !(await clearButton())?.enabled, JSON.stringify(after));

  // ---- switch back + delete via UI
  await page.click("button.ps-version-chip");
  await sleep(1500);
  await page.evaluate(() => {
    const items = [...document.querySelectorAll("#dlg-versions calcite-list-item")];
    items.find((i) => i.label === "sde.DEFAULT")?.click();
  });
  await sleep(1200);
  await click("#dlg-versions", "Switch to this version");
  await waitFor(async () => (await ed()).current === "sde.DEFAULT", 30000, "back to default");
  check("Switched back to DEFAULT (read lock released)", true);
  await page.evaluate((v) => {
    const items = [...document.querySelectorAll("#dlg-versions calcite-list-item")];
    items.find((i) => (i.label ?? "").endsWith(v))?.click();
  }, VERSION);
  await sleep(1500);
  await click("#dlg-versions", "Delete");
  await sleep(800);
  await click("#dlg-versions", "Delete version");
  await waitFor(async () => !(await ed()).versions.some((v) => v.endsWith(VERSION)), 30000, "version deleted");
  check("Test version deleted via UI (with confirmation)", true);
} catch (e) {
  check("Unexpected failure", false, e.message);
  await page.screenshot({ path: `${out}/ui-fail.png` });
} finally {
  // If the run stopped before deleting its test version, remove it now.
  const left = await page.evaluate((v) => window.__ps?.editing.getState().versions.some((x) => x.versionIdentifier.name.endsWith(v)), VERSION).catch(() => false);
  if (left)
    await cleanupTestVersion(page, VERSION).then(
      (r) => check("Cleanup after failure: test version deleted", !r.stillThere, JSON.stringify(r)),
      (e) => check("Cleanup after failure", false, e.message),
    );
  console.log("\n=== SUMMARY ===\n" + results.join("\n"));
  console.log("\nBrowser errors:\n" + (errors.join("\n") || "none"));
  await browser.close();
}
