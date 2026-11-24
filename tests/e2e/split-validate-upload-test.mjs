// Live test: Shapefile upload, Check errors and Validate, manual parcel split.
// One throw-away version; never saved, never posted; deleted at the end. Checks results in the data, not only text.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureErrors, cleanupTestVersion, closeVersionManagerOnEntry, createActiveRecord, createVersionViaUI, launchBrowser, pageTools, signIn, sleep } from "./helpers.mjs";
import { dbf, shp, zip } from "../support/shapefile-fixture.mjs";

const out = process.argv[2] || tmpdir();
const TS = new Date().toISOString().replace(/\D/g, "").slice(4, 12);
const VERSION = `PS_E2E_${TS}`;
const RECORD = `E2E-SPLIT-${TS}`;
const PARCEL = "1/02/13/02/183";
const results = [];
const check = (name, ok, detail = "") => {
  results.push(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  console.log(results.at(-1));
};

const files = mkdtempSync(join(tmpdir(), "ps-shp-"));
const browser = await launchBrowser();
const page = await browser.newPage();
const errors = captureErrors(page);
const tools = pageTools(page);
const { deepClick, state, waitFor, count, key } = tools;

const openPanel = async (id) => {
  await page.evaluate((id) => {
    const app = window.__ps.app.getState();
    app.setPref("leftPanel", id);
    app.setPref("leftOpen", true);
  }, id);
  await sleep(1500);
};
const status = () =>
  page.evaluate(() => {
    const el = document.querySelector("#parcel-fabric-status");
    return {
      text: el?.innerText.replace(/\s+/g, " ") ?? "",
      problems: [...document.querySelectorAll("#parcel-fabric-problems calcite-list-item")].map((i) => i.label),
      failure: document.querySelector('#parcel-fabric-card calcite-notice[kind="danger"]')?.textContent.trim() ?? "",
    };
  });
const runCard = async (label) => {
  await deepClick(label, { scope: "#parcel-fabric-card", tags: ["CALCITE-BUTTON"] });
  await sleep(1500);
  await waitFor(() => page.evaluate(() => !document.querySelector("#parcel-fabric-card calcite-loader")), 120000, label);
  await sleep(800);
  return status();
};
const goTo = async (extent) => {
  await page.evaluate(async (e) => {
    const view = window.__ps.map.view;
    const target = view.extent.clone();
    Object.assign(target, e);
    await view.goTo(target.expand(1.3), { duration: 0 });
  }, extent);
  await sleep(3000);
};
/** Parcels, current or historic, with geometry in the map's coordinates and area in the data's. */
const parcels = (where) =>
  page.evaluate(async (where) => {
    const { sessionQuery } = await import("/src/gis/layers/query.ts");
    const info = window.__ps.registry.byRole("parcel-polygon");
    const q = sessionQuery(info, { where, returnGeometry: true, outFields: ["*"], outSpatialReference: window.__ps.map.view.spatialReference });
    const fs = await info.layer.queryFeatures(q);
    return fs.features.map((f) => ({ a: f.attributes, rings: f.geometry.rings, e: { xmin: f.geometry.extent.xmin, ymin: f.geometry.extent.ymin, xmax: f.geometry.extent.xmax, ymax: f.geometry.extent.ymax } }));
  }, where);
const toPage = (points) =>
  page.evaluate((points) => {
    const view = window.__ps.map.view;
    const r = view.container.getBoundingClientRect();
    return points.map(([x, y]) => {
      const s = view.toScreen({ x, y, spatialReference: view.spatialReference });
      return { x: r.left + s.x, y: r.top + s.y };
    });
  }, points);
const splitState = () => page.evaluate(() => window.__ps.editing.getState().manualSplit);
const openManual = async (objectId) => {
  await page.evaluate((oid) => {
    const info = window.__ps.registry.byRole("parcel-polygon");
    const sm = window.__ps.map.view.selectionManager;
    sm.clear();
    sm.add(info.layer, [oid]);
  }, objectId);
  await sleep(1000);
  await page.mouse.click(5, 5);
  await key("S", ["Shift"]);
  await waitFor(() => page.evaluate(() => window.__ps.editing.getState().divideParcelOpen), 15000, "divide dialog");
  await sleep(1500);
  await deepClick("Draw the line manually", { scope: "#dlg-divide-parcel", tags: ["CALCITE-SEGMENTED-CONTROL-ITEM"] });
  await sleep(700);
};
const beginDrawing = async () => {
  await waitFor(() => page.evaluate(() => !!document.querySelector("#manual-split-draw") && !document.querySelector("#manual-split-draw").disabled), 30000, "draw button");
  await page.evaluate(() => document.querySelector("#manual-split-draw").click());
  await waitFor(async () => (await splitState())?.phase === "drawing", 30000, "drawing");
  await sleep(2500); // zoom, sketch and snapping sources
};
const drawLine = async (mapPoints, { snap }) => {
  if (!snap) await page.keyboard.down("Control");
  for (const p of await toPage(mapPoints)) {
    await page.mouse.move(p.x, p.y, { steps: 5 });
    await sleep(700);
    await page.mouse.click(p.x, p.y);
    await sleep(400);
  }
  if (!snap) await page.keyboard.up("Control");
  await page.keyboard.press("Enter");
  await waitFor(async () => (await splitState())?.phase !== "drawing", 20000, "line finished");
  await sleep(1200);
  return splitState();
};
const commitSplit = async () => {
  await waitFor(() => page.evaluate(() => !!document.querySelector("#manual-split-commit") && !document.querySelector("#manual-split-commit").disabled), 15000, "split button");
  await page.evaluate(() => document.querySelector("#manual-split-commit").click());
  await waitFor(async () => {
    const s = await page.evaluate(() => ({
      targets: window.__ps.editing.getState().assignUpiTargets,
      error: document.querySelector('#dlg-divide-parcel calcite-notice[kind="danger"]')?.textContent.trim() ?? "",
    }));
    if (s.error) throw new Error(`split: ${s.error}`);
    return s.targets.length === 2;
  }, 120000, "split done");
  return page.evaluate(() => window.__ps.editing.getState().assignUpiTargets);
};

let defaults = null;
let created = false;
try {
  await signIn(page);
  await closeVersionManagerOnEntry(page, tools);
  await page.evaluate(() => Promise.all(window.__ps.registry.all().map((i) => i.layer.load().catch(() => null))));
  defaults = { plots: await count("parcel-polygon", "1=1"), lines: await count("parcel-line", "1=1") };

  // ================================================================ Upload Shapefile
  await openPanel("upload");
  const panel = await page.evaluate(() => document.querySelector(".ps-side.left .ps-panel-host:not([hidden])").innerText);
  check("Catalog content is gone; the page is the Shapefile upload", /Drop a Shapefile here/.test(panel) && !/Organisation|My content|Search services|items/.test(panel));

  const native = await page.evaluate(async (name) => {
    const { sessionQuery } = await import("/src/gis/layers/query.ts");
    const info = window.__ps.registry.byRole("parcel-polygon");
    const f = (await info.layer.queryFeatures(sessionQuery(info, { where: `name = '${name}' AND retiredbyrecord IS NULL`, returnGeometry: true, outSpatialReference: info.layer.spatialReference }))).features[0];
    return f && { rings: f.geometry.rings.map((r) => r.map(([x, y]) => [x, y])), wkt: info.layer.spatialReference.toJSON().wkt };
  }, PARCEL);
  if (!native) throw new Error(`${PARCEL} is not a current parcel any more; choose another test parcel`);
  const zipFile = join(files, "survey.zip");
  writeFileSync(zipFile, zip({ "survey.shp": shp(5, [native.rings]), "survey.dbf": dbf([["UPI", "C", 24]], [[PARCEL]]), "survey.prj": Buffer.from(native.wkt) }));
  await (await page.$("#shapefile-input")).uploadFile(zipFile);
  await waitFor(() => page.evaluate(() => !!document.querySelector("#shapefile-result")), 30000, "zip upload");
  const original = (await parcels(`name = '${PARCEL}' AND retiredbyrecord IS NULL`))[0];
  const uploaded = await page.evaluate(async () => {
    const info = window.__ps.registry.all().find((i) => i.source === "added" && i.name.startsWith("survey"));
    if (!info) return null;
    const fs = await info.layer.queryFeatures({ where: "1=1", outFields: ["*"], returnGeometry: true });
    const { isLayerEditable } = await import("/src/gis/editing/editorBridge.ts");
    const e = fs.features[0].geometry.extent;
    return { n: fs.features.length, upi: fs.features[0].attributes.UPI, editable: isLayerEditable(info), e: [e.xmin, e.ymin, e.xmax, e.ymax] };
  });
  const drift = uploaded ? Math.max(...[original.e.xmin, original.e.ymin, original.e.xmax, original.e.ymax].map((v, i) => Math.abs(v - uploaded.e[i]))) : Infinity;
  check("A .zip in ITRF 2005 TM lands exactly on its parcel, with attributes", uploaded?.n === 1 && uploaded.upi === PARCEL && drift < 0.05, `offset ${drift.toFixed(4)} m`);
  check("The uploaded layer is read-only", uploaded?.editable === false);

  const WGS84 = 'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]';
  const loose = { "gps.shp": shp(1, [[30.0955, -1.9503], [30.0961, -1.951]]), "gps.dbf": dbf([["ID", "N", 5]], [[1], [2]]), "gps.prj": Buffer.from(WGS84) };
  for (const [name, bytes] of Object.entries(loose)) writeFileSync(join(files, name), bytes);
  await (await page.$("#shapefile-input")).uploadFile(...Object.keys(loose).map((n) => join(files, n)));
  await waitFor(() => page.evaluate(() => /gps: 2 point/.test(document.querySelector("#shapefile-result")?.innerText ?? "")), 30000, "loose upload");
  const gps = await page.evaluate(async () => {
    const info = window.__ps.registry.all().find((i) => i.source === "added" && i.name.startsWith("gps"));
    const g = (await info.layer.queryFeatures({ where: "1=1", returnGeometry: true })).features[0].geometry;
    return [g.longitude, g.latitude];
  });
  check("Loose .shp/.dbf/.prj files in WGS 84 land in the right place", Math.abs(gps[0] - 30.0955) < 1e-6 && Math.abs(gps[1] + 1.9503) < 1e-6, gps.join(", "));

  writeFileSync(join(files, "noprj.shp"), shp(1, [[1, 1]]));
  await (await page.$("#shapefile-input")).uploadFile(join(files, "noprj.shp"));
  await waitFor(() => page.evaluate(() => /\.prj file is missing/.test(document.querySelector(".ps-side.left")?.innerText ?? "")), 15000, "missing prj error");
  check("A Shapefile without .prj is refused with the reason", true);
  await page.screenshot({ path: `${out}/three-1-upload.png` });

  // ================================================================ Check errors and Validate
  created = true;
  await createVersionViaUI(page, tools, VERSION);
  if (!((await state()).current ?? "").endsWith(VERSION)) throw new Error("not in the throw-away version");
  await openPanel("editing");
  const everything = await page.evaluate(async () => {
    const info = window.__ps.registry.byRole("parcel-polygon");
    const { extent } = await info.layer.queryExtent({ where: "1=1", outSpatialReference: window.__ps.map.view.spatialReference });
    return { xmin: extent.xmin, ymin: extent.ymin, xmax: extent.xmax, ymax: extent.ymax };
  });
  await goTo(everything);
  const dbCounts = () =>
    page.evaluate(async () => {
      const { sessionRows } = await import("/src/gis/layers/query.ts");
      const n = { dirty: 0, errors: 0 };
      for (const i of window.__ps.registry.allByRole("topology-error")) {
        const dirty = /dirty/i.test(i.name);
        const rows = await sessionRows(i, { where: dirty ? "isretired = 0" : "isexception = 0", outFields: ["objectid"] });
        n[dirty ? "dirty" : "errors"] += rows.length;
      }
      return n;
    });
  const stored = await dbCounts();
  const checked = await runCard("Check errors");
  check("Check errors works without editing", !!checked.text && !checked.failure, checked.text || checked.failure);
  check("Check errors lists what is stored in the version", checked.problems.length === stored.errors + stored.dirty, `${checked.problems.length} listed; stored ${JSON.stringify(stored)}`);
  const validateOff = await page.evaluate(() => [...document.querySelectorAll("#parcel-fabric-card calcite-button")].find((b) => b.textContent.trim() === "Validate this map view")?.disabled === true && !!document.querySelector("#validate-requirement"));
  check("Validate says why it is unavailable until editing starts", validateOff);

  await page.mouse.click(5, 5);
  await key("E", ["Shift"]);
  await waitFor(async () => (await state()).session === "editing", 45000, "edit session");
  await sleep(2000);
  await goTo(everything);
  const validated = await runCard("Validate this map view");
  const afterValidate = await dbCounts();
  check("Validate really clears the dirty areas in the data", !validated.failure && afterValidate.dirty === 0 && /Dirty areas None/.test(validated.text), `${stored.dirty} → ${afterValidate.dirty}; ${validated.failure}`);
  check("Every error validation finds is listed", validated.problems.length === afterValidate.errors, `errors ${stored.errors} → ${afterValidate.errors}; ${[...new Set(validated.problems)].join(" | ")}`);
  check("Errors are named by their topology rule", validated.problems.length > 0 && validated.problems.every((l) => !/^Topology rule/.test(l)));
  await page.screenshot({ path: `${out}/three-2-validate.png` });
  const scaleBefore = await page.evaluate(() => window.__ps.map.view.scale);
  await page.evaluate(() => document.querySelector("#parcel-fabric-problems calcite-list-item")?.click());
  await sleep(4000);
  const scaleAfter = await page.evaluate(() => window.__ps.map.view.scale);
  check("Clicking an error zooms to it", scaleAfter < scaleBefore / 4, `1:${Math.round(scaleBefore)} → 1:${Math.round(scaleAfter)}`);

  // ================================================================ Manual split
  const rec = await createActiveRecord(page, tools, RECORD);
  const parent = (await parcels(`name = '${PARCEL}' AND retiredbyrecord IS NULL`))[0];
  const oid = parent.a.objectid;
  const parentArea = parent.a.Shape__Area;
  const cx = (parent.e.xmin + parent.e.xmax) / 2;
  const cy = (parent.e.ymin + parent.e.ymax) / 2;

  await openManual(oid);
  await beginDrawing();
  await page.keyboard.press("Escape");
  await sleep(1500);
  check("Escape cancels drawing and changes nothing", !(await splitState()) && !(await parcels(`objectid = ${oid}`))[0].a.retiredbyrecord);

  await page.evaluate(() => window.__ps.editing.getState().patch({ divideParcelOpen: true }));
  await sleep(1000);
  await deepClick("Draw the line manually", { scope: "#dlg-divide-parcel", tags: ["CALCITE-SEGMENTED-CONTROL-ITEM"] });
  await beginDrawing();
  const inside = await drawLine([[cx - 3, cy], [cx + 3, cy]], { snap: false });
  check("A line that doesn't cross the parcel is refused with the reason", inside?.phase === "invalid" && /doesn't cross/.test(inside.message), JSON.stringify(inside));

  await beginDrawing();
  const bent = await drawLine([[cx, parent.e.ymin - 5], [cx + (parent.e.xmax - parent.e.xmin) * 0.04, cy], [cx, parent.e.ymax + 5]], { snap: false });
  const sum = bent?.areas?.reduce((a, b) => a + b, 0) ?? 0;
  check("A bent line previews two parts that add up to the parcel", bent?.phase === "ready" && Math.abs(sum - parentArea) < 0.1, `${JSON.stringify(bent?.areas)} of ${parentArea}`);
  await page.screenshot({ path: `${out}/three-3-preview.png` });

  const linesBefore = await count("parcel-line", "1=1");
  const parts = await commitSplit();
  const retired = (await parcels(`objectid = ${oid}`))[0].a;
  const same = (a, b) => String(a).toUpperCase() === String(b).toUpperCase();
  check("The original is kept as history, retired by the record", same(retired.retiredbyrecord, rec.globalId) && retired.name === PARCEL);
  const children = await parcels(`objectid IN (${parts.join(",")})`);
  check("Both parts are current parcels created by the record", children.length === 2 && children.every((c) => !c.a.retiredbyrecord && same(c.a.createdbyrecord, rec.globalId)));
  check("Neither part keeps the original's UPI or parcel number", children.every((c) => !c.a.name && !c.a.parcel_number));
  check("Both parts have the location and their own area", children.every((c) => c.a.cell === retired.cell && Math.abs(c.a.size - c.a.Shape__Area) < 0.05) && Math.abs(children[0].a.Shape__Area + children[1].a.Shape__Area - parentArea) < 0.1, children.map((c) => `${c.a.cell} ${c.a.size}`).join(" | "));
  check("The new boundary lines were built", (await count("parcel-line", "1=1")) > linesBefore);

  await waitFor(() => page.evaluate(() => [...document.querySelectorAll("#dlg-assign-upi calcite-input-text")].filter((i) => /^\d\/\d\d\/\d\d\/\d\d\/\d+$/.test(i.value)).length === 2), 30000, "UPI suggestions");
  await sleep(1000);
  const note = await page.evaluate(() => ({
    basis: document.querySelector("#dlg-assign-upi #upi-basis")?.textContent ?? "",
    warning: !!document.querySelector("#dlg-assign-upi #upi-warning"),
    upis: [...document.querySelectorAll("#dlg-assign-upi calcite-input-text")].map((i) => i.value),
  }));
  check("The split parts get the cell of the parcel they come from", /from the parcel it comes from/.test(note.basis) && note.upis.every((u) => u.startsWith("1/02/13/02/")), `${note.basis} ${note.upis.join(", ")}`);
  check("No numbering warning in a cell with a normal series", !note.warning);
  await deepClick("Save UPIs", { scope: "#dlg-assign-upi", tags: ["CALCITE-BUTTON"] });
  await waitFor(() => page.evaluate(() => window.__ps.editing.getState().assignUpiTargets.length === 0), 45000, "UPIs saved");
  const named = await parcels(`objectid IN (${parts.join(",")})`);
  check("Assign UPIs follows, and both parts get different UPIs", named.every((c) => !!c.a.name) && named[0].a.name !== named[1].a.name, named.map((c) => c.a.name).join(", "));

  await goTo(parent.e);
  const splitValid = await runCard("Validate this map view");
  check("The split parcels pass topology validation", /Total errors None/.test(splitValid.text) && !splitValid.failure, splitValid.text || splitValid.failure);

  // A second split: ends snapped ON the boundary, under a record that already has many other parcels.
  const busy = await page.evaluate(async () => {
    const { sessionRows } = await import("/src/gis/layers/query.ts");
    const info = window.__ps.registry.byRole("records");
    const rows = await sessionRows(info, { where: "parcelcount > 1", outFields: ["objectid", "globalid", "name", "parcelcount"], orderByFields: ["parcelcount DESC"], num: 1 });
    const r = rows[0];
    const { recordService } = await import("/src/gis/parcel-fabric/recordService.ts");
    recordService.setActive({ objectId: r.objectid, globalId: r.globalid, name: r.name });
    return r;
  });
  const target = named.sort((a, b) => b.a.Shape__Area - a.a.Shape__Area)[0];
  const ring = target.rings[0];
  const edges = ring.slice(0, -1).map((p, i) => ({ i, length: Math.hypot(ring[i + 1][0] - p[0], ring[i + 1][1] - p[1]), mid: [(p[0] + ring[i + 1][0]) / 2, (p[1] + ring[i + 1][1]) / 2] })).sort((a, b) => b.length - a.length);
  const first = edges[0];
  // the other end: of the longer edges, the one farthest from the first
  const second = edges.slice(1, 5).sort((a, b) => Math.hypot(b.mid[0] - first.mid[0], b.mid[1] - first.mid[1]) - Math.hypot(a.mid[0] - first.mid[0], a.mid[1] - first.mid[1]))[0];
  const othersBefore = { plots: await count("parcel-polygon", "1=1"), lines: await count("parcel-line", "1=1") };
  await openManual(target.a.objectid);
  await beginDrawing();
  const onEdge = await drawLine([first.mid, second.mid], { snap: true });
  check("A line whose ends snap onto the boundary cuts the parcel", onEdge?.phase === "ready", JSON.stringify(onEdge));
  if (onEdge?.phase === "ready") {
    await commitSplit();
    const growth = { plots: (await count("parcel-polygon", "1=1")) - othersBefore.plots, lines: (await count("parcel-line", "1=1")) - othersBefore.lines };
    check("Building in a large existing record changes only the split parcel", growth.plots === 1 && growth.lines >= 1 && growth.lines <= 6, `record with ${busy.parcelcount} parcels: ${JSON.stringify(growth)}`);
    await deepClick("Later", { scope: "#dlg-assign-upi", tags: ["CALCITE-BUTTON"] });
    await sleep(1000);
  }
  check("Undo is off after a split (Discard rolls back)", !(await state()).canUndo);

  /** Two touching current parcels: same cell ("same") or different cells ("different"), starting from a cell. */
  const touchingPair = (startCell, kind) =>
    page.evaluate(async (startCell, kind) => {
      const { sessionQuery, sessionRows } = await import("/src/gis/layers/query.ts");
      const info = window.__ps.registry.byRole("parcel-polygon");
      const fs = await info.layer.queryFeatures(sessionQuery(info, { where: `retiredbyrecord IS NULL AND name LIKE '${startCell}/%'`, returnGeometry: true, outFields: ["objectid", "name"], num: 400 }));
      for (const f of fs.features) {
        const other = kind === "same" ? `name LIKE '${startCell}/%'` : `name LIKE '_/__/__/__/%' AND name NOT LIKE '${startCell}/%'`;
        const rows = await sessionRows(info, { where: `retiredbyrecord IS NULL AND objectid <> ${f.attributes.objectid} AND ${other}`, geometry: f.geometry, outFields: ["objectid", "name"], num: 1 });
        if (rows[0]) return [{ oid: f.attributes.objectid, name: f.attributes.name }, { oid: rows[0].objectid, name: rows[0].name }];
      }
      return null;
    }, startCell, kind);
  const openMerge = async (pair) => {
    await page.evaluate((ids) => {
      const info = window.__ps.registry.byRole("parcel-polygon");
      const sm = window.__ps.map.view.selectionManager;
      sm.clear();
      sm.add(info.layer, ids);
    }, pair.map((p) => p.oid));
    await sleep(1000);
    await page.mouse.click(5, 5);
    await key("G", ["Shift"]);
    await waitFor(() => page.evaluate(() => window.__ps.editing.getState().mergeParcelsOpen), 15000, "merge dialog");
    await sleep(6000);
  };
  const mergeState = () =>
    page.evaluate(() => ({
      cells: [...document.querySelectorAll("#merge-cell calcite-segmented-control-item")].map((i) => i.value),
      upi: document.querySelector("#merge-new-upi")?.value ?? "",
      basis: document.querySelector("#dlg-merge-parcels #upi-basis")?.textContent ?? "",
      warning: document.querySelector("#dlg-merge-parcels #upi-warning")?.textContent.trim() ?? "",
      mergeDisabled: [...document.querySelectorAll("#dlg-merge-parcels calcite-button")].find((b) => b.textContent.trim() === "Merge parcels")?.disabled === true,
    }));
  const cancelMerge = async () => {
    await deepClick("Cancel", { scope: "#dlg-merge-parcels", tags: ["CALCITE-BUTTON"] });
    await waitFor(() => page.evaluate(() => !window.__ps.editing.getState().mergeParcelsOpen), 15000, "merge closed");
    await sleep(800);
  };

  const across = await touchingPair("1/02/08/01", "different");
  if (across) {
    await openMerge(across);
    const before = await mergeState();
    check("A merge across cells asks which cell, and Merge stays off until you choose", before.cells.length === 2 && before.mergeDisabled && !before.upi, `${across.map((p) => p.name).join(" + ")} → ${JSON.stringify(before)}`);
    const chosen = before.cells[1];
    await deepClick(chosen, { scope: "#merge-cell", tags: ["CALCITE-SEGMENTED-CONTROL-ITEM"] });
    await waitFor(async () => (await mergeState()).upi.startsWith(`${chosen}/`), 30000, "suggestion in the chosen cell");
    const after = await mergeState();
    check("After choosing, the UPI is suggested in that cell", /chosen by you/.test(after.basis) && !after.mergeDisabled, `${after.upi} — ${after.basis}`);
    await cancelMerge();
  } else check("A merge across cells asks which cell", false, "no touching parcels in different cells found");

  const kamukina = await touchingPair("1/02/08/01", "same");
  await openMerge(kamukina);
  const unusual = await mergeState();
  check("A cell with unusually high numbers shows a warning with them", /numbered up to about/.test(unusual.warning) && /18,373|18373/.test(unusual.warning), unusual.warning.slice(0, 220));
  await cancelMerge();

  const byName = await page.evaluate(async (oid) => {
    const { suggestUpis } = await import("/src/gis/parcel-fabric/upi.ts");
    return suggestUpis({ count: 1, parcels: [oid] });
  }, kamukina[0].oid);
  check("Without a parent, the cell comes from the parcel's cell name", /from the cell name "Kamukina"/i.test(byName?.basis ?? "") && byName.upis[0].startsWith("1/02/08/01/"), `${byName?.basis} → ${byName?.upis[0]}`);

  // Changing the active record again and again must reach every layer's templates (wrong lineage otherwise).
  const stamps = await page.evaluate(async (records) => {
    const { recordService } = await import("/src/gis/parcel-fabric/recordService.ts");
    const roles = ["parcel-polygon", "parcel-line", "points", "connection-lines"];
    const wrong = [];
    for (const r of records) {
      recordService.setActive(r);
      for (const role of roles) {
        const info = window.__ps.registry.byRole(role);
        const all = [...(info.layer.templates ?? []), ...(info.layer.types ?? []).flatMap((t) => t.templates ?? [])];
        for (const tpl of all) if ((tpl.prototype?.attributes?.createdbyrecord ?? null) !== (r?.globalId ?? null)) wrong.push(`${role}: ${r?.name ?? "cleared"}`);
      }
    }
    return wrong;
  }, [rec, null, { objectId: busy.objectid, globalId: busy.globalid, name: busy.name }, rec]);
  check("Changing the active record reaches every layer's templates", stamps.length === 0, stamps.join("; "));

  await goTo(parent.e);
  await page.evaluate(async () => {
    const ed = document.querySelector("arcgis-editor");
    if (ed.activeWorkflow) await ed.cancelWorkflow();
    const info = window.__ps.registry.byRole("parcel-polygon");
    await ed.startCreateFeaturesWorkflowAtFeatureCreation({ layer: info.layer, template: info.layer.templates[0] });
  });
  await sleep(2500);
  const currentIds = () => page.evaluate(async () => {
    const info = window.__ps.registry.byRole("parcel-polygon");
    return info.layer.queryObjectIds(window.__ps.shown(info.layer, { where: "1=1" }));
  });
  const idsBefore = new Set(await currentIds());
  const pendingBefore = (await state()).pending;
  await page.keyboard.down("Control");
  for (const p of await toPage([[cx - 8, cy - 8], [cx - 8, cy + 8], [cx + 8, cy + 8], [cx + 8, cy - 8]])) {
    await page.mouse.click(p.x, p.y);
    await sleep(500);
  }
  await page.keyboard.up("Control");
  await page.keyboard.press("Enter");
  await sleep(3000);
  await tools.commitIfNeeded(pendingBefore, ["Create"]);
  await waitFor(async () => (await state()).pending > pendingBefore, 45000, "parcel drawn");
  await sleep(1500);
  const drawnIds = (await currentIds()).filter((id) => !idsBefore.has(id));
  const drawn = drawnIds.length === 1 ? (await parcels(`objectid = ${drawnIds[0]}`))[0] : null;
  check("A parcel drawn after switching records carries the record shown", !!drawn && same(drawn.a.createdbyrecord, rec.globalId), String(drawn?.a.createdbyrecord));
  await tools.cancelWorkflow();

  await page.evaluate(() => window.__ps.versionSession.discard());
  await waitFor(async () => { const s = await state(); return s.session === "editing" && s.pending === 0 && !s.busy; }, 60000, "discard");
  check("Discard makes the original parcel current again", !(await parcels(`objectid = ${oid}`))[0].a.retiredbyrecord && (await count("parcel-polygon", "1=1")) === defaults.plots);
} catch (e) {
  check("Unexpected failure", false, e.message);
  await page.screenshot({ path: `${out}/three-fail.png` });
} finally {
  if (created) {
    try {
      const r = await cleanupTestVersion(page, VERSION);
      check("Cleanup: test version deleted", !r.stillThere, JSON.stringify(r));
      const after = { plots: await count("parcel-polygon", "1=1"), lines: await count("parcel-line", "1=1") };
      check("DEFAULT unchanged by this test", after.plots === defaults.plots && after.lines === defaults.lines, `${JSON.stringify(defaults)} → ${JSON.stringify(after)}`);
    } catch (e) {
      check("Cleanup", false, e.message);
    }
  }
  rmSync(files, { recursive: true, force: true });
  console.log("\n=== SUMMARY ===\n" + results.join("\n"));
  console.log("\nBrowser errors:\n" + (errors.join("\n") || "none"));
  await browser.close();
}
