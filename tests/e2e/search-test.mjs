// Live test of the map search: "UPI" and "Name" sources. Read-only (DEFAULT, no edits).
import { launchBrowser, signIn, sleep } from "./helpers.mjs";

const out = process.argv[2] || (await import("node:os")).tmpdir();
const results = [];
const check = (name, ok, detail = "") => {
  results.push(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  console.log(results.at(-1));
};
const browser = await launchBrowser();
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message.slice(0, 200)));

// Run a search through the component API, as the UI does, on a given source index.
const search = (sourceIndex, term) =>
  page.evaluate(
    async (sourceIndex, term) => {
      const el = document.querySelector("arcgis-search");
      el.activeSourceIndex = sourceIndex;
      const sug = await el.suggest(term);
      const suggestions = (sug?.results?.[0]?.results ?? []).map((r) => r.text);
      const res = await el.search(sug?.results?.[0]?.results?.[0] ?? term);
      const first = res?.results?.[0]?.results?.[0];
      await new Promise((r) => setTimeout(r, 2500));
      return { suggestions, result: first?.name ?? null, scale: Math.round(window.__ps.map.view.scale), props: window.__ps.app.getState().properties?.kind ?? null };
    },
    sourceIndex,
    term,
  );

try {
  await signIn(page);
  await page.evaluate(() => window.__ps.editing.getState().patch({ versionDialogOpen: false }));
  await page.waitForFunction(() => (document.querySelector("arcgis-search")?.allSources?.length ?? 0) > 0, { timeout: 60000 });
  await sleep(1500);

  const setup = await page.evaluate(() => {
    const el = document.querySelector("arcgis-search");
    return { sources: el.allSources.toArray().map((s) => s.name), active: el.activeSource?.name, placeholder: el.activeSource?.placeholder, allDisabled: el.searchAllDisabled };
  });
  check("Search offers exactly UPI and Name, UPI first", JSON.stringify(setup.sources) === '["UPI","Name"]' && setup.active === "UPI", JSON.stringify(setup));

  // ---- UPI
  let r = await search(0, "1/02/08/01/1246");
  check("UPI: full UPI finds that parcel and opens its properties", r.result === "1/02/08/01/1246" && r.props === "features", JSON.stringify(r));
  check("UPI: zoom shows the surroundings (not closer than 1:500)", r.scale >= 500, `1:${r.scale}`);
  r = await search(0, "02/13/02/1001");
  check("UPI: partial UPI suggests matching parcels", r.suggestions.length > 0 && r.suggestions.every((s) => s.includes("02/13/02/1001")), r.suggestions.slice(0, 3).join(" | "));
  r = await search(0, "1-02-13-02-1001");
  check("UPI: dashes are read as slashes", r.result === "1/02/13/02/1001", JSON.stringify(r));
  r = await page.evaluate(async () => {
    const el = document.querySelector("arcgis-search");
    el.activeSourceIndex = 0;
    const res = await el.search("1/02/13/02/2");
    return res?.results?.[0]?.results?.[0]?.name ?? null;
  });
  check("UPI: Enter on a typed UPI picks the exact match first", r === "1/02/13/02/2", String(r));
  r = await search(0, "9/99/99/99/99999");
  check("UPI: unknown UPI finds nothing", r.suggestions.length === 0 && r.result === null, JSON.stringify(r));

  // ---- Name
  r = await search(1, "Juru");
  check("Name: village 'Juru' zooms to its parcels", /Juru \(village\) — \d+/.test(r.result ?? ""), `${r.suggestions.slice(0, 3).join(" | ")} → ${r.result} @1:${r.scale}`);
  r = await search(1, "Nyarutarama");
  check("Name: cell 'Nyarutarama' found", r.suggestions.some((s) => s === "Nyarutarama — cell"), r.suggestions.join(" | "));
  r = await search(1, "kimihurura");
  check("Name: case-insensitive, each spelling listed once per level", r.suggestions.filter((s) => /— sector$/.test(s)).length === 1 && r.suggestions.filter((s) => /— cell$/.test(s)).length === 1, r.suggestions.join(" | "));
  r = await search(1, "Gasabo");
  check("Name: district 'Gasabo' found", /Gasabo \(district\) — \d+/.test(r.result ?? ""), String(r.result));
  r = await search(1, "Kacyiru_Kamatamu");
  check("Name: parcel record found and zoomed to its parcels", r.suggestions.some((s) => s.endsWith("— parcel record")) && !!r.result && r.scale >= 500, `${r.suggestions[0]} → ${r.result} @1:${r.scale}`);

  // ---- typing in the search box must not trigger map shortcuts (r = rectangle select, e = explore…)
  await page.evaluate(() => { const el = document.querySelector("arcgis-search"); el.activeSourceIndex = 1; el.searchTerm = ""; });
  await page.evaluate(() => document.querySelector("arcgis-search").setFocus());
  await sleep(500);
  const toolBefore = await page.evaluate(() => window.__ps.app.getState().tool);
  await page.keyboard.type("Juru", { delay: 80 });
  await sleep(2500);
  const typed = await page.evaluate(() => ({ tool: window.__ps.app.getState().tool, term: document.querySelector("arcgis-search").searchTerm }));
  check("Typing in the search box doesn't trigger shortcuts", typed.tool === toolBefore && typed.term === "Juru", JSON.stringify({ toolBefore, ...typed }));
  await page.screenshot({ path: `${out}/search-suggestions.png` });
} catch (e) {
  check("Unexpected failure", false, e.message);
  await page.screenshot({ path: `${out}/search-fail.png` });
} finally {
  console.log("\n=== SUMMARY ===\n" + results.join("\n"));
  console.log("\nPage errors:\n" + (errors.join("\n") || "none"));
  await browser.close();
}
