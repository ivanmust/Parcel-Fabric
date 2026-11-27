// Live test: the app shows topology errors (what is wrong, the parcels at each, all drawn on the map)
// and offers no way to fix them: fixing is the surveyor's job. Read-only: DEFAULT, no edit session,
// no version, nothing written.
import { captureErrors, launchBrowser, pageTools, signIn, sleep } from "./helpers.mjs";

const results = [];
const check = (name, ok, detail = "") => {
  results.push(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  console.log(results.at(-1));
};

const browser = await launchBrowser();
const page = await browser.newPage();
const errors = captureErrors(page);
const { deepClick, state, waitFor } = pageTools(page);

const idle = async (what) => {
  await sleep(1200);
  await waitFor(() => page.evaluate(() => !document.querySelector("#parcel-fabric-card calcite-loader")), 180000, what);
  await sleep(800);
};

try {
  await signIn(page);
  await page.evaluate(() => window.__ps.editing.getState().patch({ versionDialogOpen: false }));
  await page.evaluate(() => {
    const app = window.__ps.app.getState();
    app.setPref("leftPanel", "editing");
    app.setPref("leftOpen", true);
  });
  await sleep(1500);
  const before = await state();
  check("Starts in DEFAULT without an edit session", before.session !== "editing", JSON.stringify({ session: before.session, version: before.current }));

  // Zoom to all the errors stored in DEFAULT.
  const stored = await page.evaluate(async () => {
    const sr = window.__ps.map.view.spatialReference;
    const out = { count: 0, extent: null };
    for (const i of window.__ps.registry.allByRole("topology-error").filter((l) => !/dirty/i.test(l.name))) {
      const fs = (await i.layer.queryFeatures({ where: "isexception = 0 OR isexception IS NULL", returnGeometry: true, outSpatialReference: sr })).features;
      out.count += fs.length;
      for (const f of fs) {
        const e = f.geometry.extent ?? { xmin: f.geometry.x, ymin: f.geometry.y, xmax: f.geometry.x, ymax: f.geometry.y };
        out.extent = out.extent
          ? { xmin: Math.min(out.extent.xmin, e.xmin), ymin: Math.min(out.extent.ymin, e.ymin), xmax: Math.max(out.extent.xmax, e.xmax), ymax: Math.max(out.extent.ymax, e.ymax) }
          : { xmin: e.xmin, ymin: e.ymin, xmax: e.xmax, ymax: e.ymax };
      }
    }
    return out;
  });
  if (!stored.count) throw new Error("DEFAULT has no topology errors to show");
  await page.evaluate(async (e) => {
    const view = window.__ps.map.view;
    const target = Object.assign(view.extent.clone(), e).expand(1.5);
    await view.goTo(target, { duration: 0 });
  }, stored.extent);
  await sleep(2000);

  await deepClick("Check errors", { scope: "#parcel-fabric-card", tags: ["CALCITE-BUTTON"] });
  await idle("Check errors");
  const listed = await page.evaluate(() =>
    [...document.querySelectorAll("#parcel-fabric-problems calcite-list-item")].map((i) => ({ label: i.label, description: i.description })),
  );
  const errorsListed = listed.filter((i) => i.label !== "Not validated yet");
  check("Check errors lists every stored error", errorsListed.length === stored.count, `${errorsListed.length} listed, ${stored.count} stored`);
  for (const i of errorsListed) console.log(`      ${i.label}: ${i.description}`);
  check("Each error says which parcels and what is wrong", errorsListed.every((i) => /·/.test(i.description) && !/Parcels unknown/.test(i.description)), "");

  const drawn = await page.evaluate(() => window.__ps.map.topologyErrorLayer.graphics.length);
  check("All listed errors are drawn on the map in red", drawn === errorsListed.length, `${drawn} drawn`);

  // Open each kind of error once: explanation, parcels, what to check, and no buttons.
  const kinds = [...new Set(errorsListed.map((i) => i.label))];
  for (const kind of kinds) {
    await page.evaluate((kind) => [...document.querySelectorAll("#parcel-fabric-problems calcite-list-item")].find((i) => i.label === kind)?.click(), kind);
    await idle(kind);
    const detail = await page.evaluate(() => {
      const el = document.querySelector("#topology-error-detail");
      return { text: el?.innerText.replace(/\s+/g, " ") ?? "", buttons: el ? el.querySelectorAll("calcite-button").length : -1 };
    });
    check(`"${kind}": details show the parcels and what the surveyor must check, with no fix buttons`, /Parcels:/.test(detail.text) && /To check:/.test(detail.text) && detail.buttons === 0, detail.text.slice(0, 300));
  }

  const card = await page.evaluate(() => [...document.querySelectorAll("#parcel-fabric-card calcite-button")].map((b) => b.textContent.trim()));
  check("No fix or exception button anywhere in the card", !card.some((t) => /fix|exception|create the missing|delete the loose|build/i.test(t)), card.join(" | "));

  const after = await state();
  check("Nothing was edited", after.session === before.session && !after.pending, JSON.stringify({ session: after.session, pending: after.pending }));
  check("No page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
} catch (e) {
  check("Test ran to the end", false, e.message);
} finally {
  await browser.close();
  console.log(`\n${results.filter((r) => r.startsWith("PASS")).length}/${results.length} passed`);
  process.exitCode = results.some((r) => r.startsWith("FAIL")) ? 1 : 0;
}
