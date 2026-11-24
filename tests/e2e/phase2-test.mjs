// Phase 2 live end-to-end test. All edits happen in a throw-away named version
// that is deleted at the end; DEFAULT is never edited.
import { captureErrors, cleanupTestVersion, createActiveRecord, createVersionViaUI, launchBrowser, pageTools, signIn, sleep } from "./helpers.mjs";

const out = process.argv[2] || (await import("node:os")).tmpdir();
const TS = new Date().toISOString().replace(/\D/g, "").slice(4, 12);
const VERSION = `PS_E2E_${TS}`;
const RECORD = `E2E-REC-${TS}`;
const results = [];
const check = (name, ok, detail = "") => {
  results.push(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  console.log(results.at(-1));
};

const browser = await launchBrowser();
const page = await browser.newPage();
const errors = captureErrors(page);
page.on("console", (m) => (m.text().startsWith("[scale]") || m.text().startsWith("[plot]")) && console.log(m.text()));
const { deepClick, state, waitFor, count, typeInto, workflow, commitIfNeeded, key } = pageTools(page);
// Geometry summary (extent) of the test Plots created by the record, read at the layer's moment.
const plotsByRecord = (guid) =>
  page.evaluate(async (guid) => {
    const info = window.__ps.registry.all().find((i) => i.fabricRole === "parcel-polygon");
    const fs = await info.layer.queryFeatures(window.__ps.shown(info.layer, { where: `createdbyrecord = '${guid}'`, outFields: [info.layer.objectIdField], returnGeometry: true }));
    return fs.features.map((g) => ({ oid: g.attributes[info.layer.objectIdField], xmin: Math.round(g.geometry.extent.xmin * 100) / 100, ymin: Math.round(g.geometry.extent.ymin * 100) / 100 }));
  }, guid);
const selectPlots = (guid) =>
  page.evaluate(async (guid) => {
    const info = window.__ps.registry.all().find((i) => i.fabricRole === "parcel-polygon");
    const ids = await info.layer.queryObjectIds(window.__ps.shown(info.layer, { where: `createdbyrecord = '${guid}'` }));
    const sm = window.__ps.map.view.selectionManager;
    sm.clear();
    sm.add(info.layer, ids);
    return ids.length;
  }, guid);
// Screen position (page pixels) and half-width of the record's Plot, read at the layer's moment.
const plotOnScreen = (guid) =>
  page.evaluate(async (guid) => {
    const view = window.__ps.map.view;
    const info = window.__ps.registry.all().find((i) => i.fabricRole === "parcel-polygon");
    const fs = await info.layer.queryFeatures(window.__ps.shown(info.layer, { where: `createdbyrecord = '${guid}'`, returnGeometry: true, outSpatialReference: view.spatialReference }));
    const e = fs.features[0].geometry.extent;
    const c = view.toScreen(e.center);
    const left = view.toScreen({ x: e.xmin, y: e.center.y, spatialReference: view.spatialReference });
    const rect = view.container.getBoundingClientRect();
    return { x: rect.left + c.x, y: rect.top + c.y, half: Math.abs(c.x - left.x) };
  }, guid);
const confirmDialog = async (dialog, label, pendBefore, { timeout = 60000, detectErrors = true } = {}) => {
  await sleep(1200);
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const st = await page.evaluate((dialog, label) => {
      const d = document.querySelector(dialog);
      const btn = [...(d?.querySelectorAll("calcite-button") ?? [])].find((x) => x.textContent.trim() === label);
      return { open: !!d?.open, ready: !!btn && !btn.disabled, busy: !!d?.loading, error: d?.querySelector('calcite-notice[kind="danger"]')?.textContent?.trim() ?? null };
    }, dialog, label);
    if ((await state()).pending > pendBefore) return;
    if (detectErrors && st.error) throw new Error(`${label}: ${st.error}`);
    if (st.open && st.ready && !st.busy) await deepClick(label, { scope: dialog, tags: ["CALCITE-BUTTON"] });
    await sleep(5000);
  }
  throw new Error(`Timed out waiting for ${label}`);
};
const scale = (label) => page.evaluate((l) => console.log(`[scale] ${l}: 1:${Math.round(window.__ps.map.view.scale)}`), label);
let defaultPlots = null;
try {
  // ---- sign in
  await signIn(page);
  check("Signed in, version service ready", true, (await state()).current);
  await waitFor(async () => page.evaluate(() => window.__ps.editing.getState().versionDialogOpen), 15000, "version manager on entry").catch(() => undefined);
  await page.evaluate(() => window.__ps.editing.getState().patch({ versionDialogOpen: false }));
  await sleep(800);
  defaultPlots = await count("parcel-polygon", "1=1");
  check("DEFAULT Plot count readable", defaultPlots > 0, String(defaultPlots));

  // ---- create + switch version through the Version Manager UI
  await createVersionViaUI(page, { deepClick, typeInto, waitFor, state }, VERSION);
  check("Version created via UI", true, VERSION);
  check("Switched to new version", true, (await state()).current);
  const versionPlots = await count("parcel-polygon", "1=1");
  check("New version sees same data as DEFAULT", versionPlots === defaultPlots, `${versionPlots}`);

  // ---- start editing (keyboard)
  await key("E", ["Shift"]);
  await waitFor(async () => (await state()).session === "editing", 30000, "edit session");
  check("Edit session started (Shift+E)", true);
  await scale("after start editing");

  // ---- create + activate a parcel record (Editing panel UI)
  const rec = await createActiveRecord(page, { deepClick, waitFor, state }, RECORD);
  check("Record created and activated", true, `${rec.name} ${rec.globalId}`);
  await scale("after record");
  check("Record edit counted as pending", (await state()).pending >= 1, `pending=${(await state()).pending}`);

  // ---- create a Plot polygon with the Editor (draw on map)
  await key("n");
  await sleep(3500);
  await page.screenshot({ path: `${out}/p2-1-templates.png` });
  // Choose the Plot template through the Editor API (clicking Calcite list items from a script is
  // unreliable); drawing and saving below still go through the Editor create workflow.
  const picked = await page.evaluate(async () => {
    const ed = document.querySelector("arcgis-editor");
    const info = window.__ps.registry.all().find((i) => i.fabricRole === "parcel-polygon");
    const template = info.layer.templates?.[0] ?? info.layer.types?.[0]?.templates?.[0];
    await ed.startCreateFeaturesWorkflowAtFeatureCreation({ layer: info.layer, template });
    return `${template?.name ?? "default"} → ${ed.activeWorkflow?.type}`;
  });
  check("Plot template picked in Editor", /create/.test(picked), picked);
  await sleep(1500);
  const box = await (await page.$(".ps-map")).boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2 - 60;
  // Draw at a fixed street-level scale so the test parcel is small (about 80 m across).
  await page.evaluate(() => window.__ps.map.view.goTo({ scale: 4000 }, { duration: 0 }));
  await sleep(2500);
  await scale("before drawing");
  const before = (await state()).pending;
  for (const [dx, dy] of [[-40, -30], [40, -30], [40, 30], [-40, 30]]) {
    await page.mouse.click(cx + dx, cy + dy);
    await sleep(350);
  }
  await page.keyboard.press("Enter"); // finish the polygon (Editor shortcut)
  await sleep(4000);
  await page.screenshot({ path: `${out}/p2-2-created.png` });
  // The Editor may require confirming the form ("Create"/"Update" button).
  if ((await state()).pending === before) {
    for (const label of ["Create", "Update", "Save", "Done"]) {
      if (await deepClick(label, { scope: "arcgis-editor", tags: ["CALCITE-BUTTON"] })) break;
    }
    await sleep(3000);
  }
  await waitFor(async () => (await state()).pending > before, 45000, "Plot add");
  await scale("after create");
  console.log("[plot]", JSON.stringify(await page.evaluate(async () => { const i = window.__ps.registry.all().find((x) => x.fabricRole === "parcel-polygon"); const fs = await i.layer.queryFeatures({ where: "1=1", orderByFields: ["objectid DESC"], num: 1, returnGeometry: true, outFields: ["objectid"], historicMoment: i.layer.historicMoment ?? undefined }); const e = fs.features[0]?.geometry?.extent; return e && { w: Math.round(e.width), h: Math.round(e.height), sr: e.spatialReference?.wkid ?? "wkt" }; })));
  check("Plot polygon created through Editor", true, `pending=${(await state()).pending}`);
  await page.evaluate(() => { const ed = document.querySelector("arcgis-editor"); if (ed?.activeWorkflow) return ed.cancelWorkflow(); });
  await sleep(2500);
  const stamped = await count("parcel-polygon", `createdbyrecord = '${rec.globalId}'`);
  check("New Plot persisted in version with CreatedByRecord = active record", stamped === 1, `count=${stamped}`);

  // ---- modify: move the new Plot by dragging it (Editor update workflow, toolbar M)
  const beforeMove = (await plotsByRecord(rec.globalId))[0];
  await scale("before select");
  await selectPlots(rec.globalId);
  await sleep(1000);
  await scale("after select");
  await key("m");
  await waitFor(async () => !!(await workflow()), 15000, "modify workflow");
  check("Modify (M) opens the Editor update workflow", true, String(await workflow()));
  await scale("after M");
  await sleep(2500);
  let pend = (await state()).pending;
  const p0 = await plotOnScreen(rec.globalId);
  await page.mouse.move(p0.x, p0.y);
  await page.mouse.down();
  await page.mouse.move(p0.x + 30, p0.y + 20, { steps: 12 });
  await page.mouse.up();
  await commitIfNeeded(pend, ["Update", "Save", "Done"]);
  await page.screenshot({ path: `${out}/p2-2b-modified.png` });
  await waitFor(async () => (await state()).pending > pend, 45000, "modify applied");
  const afterMove = (await plotsByRecord(rec.globalId))[0];
  check("Modify moved the Plot on the server", !!afterMove && (afterMove.xmin !== beforeMove.xmin || afterMove.ymin !== beforeMove.ymin), `${JSON.stringify(beforeMove)} -> ${JSON.stringify(afterMove)}`);
  await page.evaluate(() => { const ed = document.querySelector("arcgis-editor"); if (ed?.activeWorkflow) return ed.cancelWorkflow(); });
  await sleep(1500);

  // ---- select by attributes (UI dialog)
  await key("A", ["Shift"]);
  await sleep(1200);
  await typeInto("#dlg-select-attributes calcite-text-area", 0, `createdbyrecord = '${rec.globalId}'`);
  await deepClick("Verify", { scope: "#dlg-select-attributes", tags: ["CALCITE-BUTTON"] });
  await sleep(2500);
  const verifyMsg = await page.evaluate(() => document.querySelector("#dlg-select-attributes calcite-notice")?.textContent ?? "");
  check("Where-clause verified by server", verifyMsg.includes("matches 1"), verifyMsg.trim());
  await deepClick("Apply", { scope: "#dlg-select-attributes", tags: ["CALCITE-BUTTON"] });
  await waitFor(async () => (await state()).selection.some((s) => s.count === 1), 15000, "selection");
  check("Select by attributes → 1 feature selected", true, JSON.stringify((await state()).selection));

  // ---- select by rectangle (toolbar tool) adds more features around it
  await key("r");
  await sleep(800);
  await page.mouse.move(cx - 80, cy - 70);
  await page.mouse.down();
  await page.mouse.move(cx + 80, cy + 70, { steps: 8 });
  await page.mouse.up();
  await sleep(4000);
  const rectSel = (await state()).selection;
  check("Select by rectangle selects features (server query)", rectSel.reduce((n, s) => n + s.count, 0) >= 1, JSON.stringify(rectSel));
  await key("Escape");
  await sleep(500);

  // ---- undo the move (Ctrl+Z): the Plot goes back to where it was drawn
  await page.mouse.click(5, 5);
  check("Undo available after the move", (await state()).canUndo);
  await key("z", ["Control"]);
  await sleep(4000);
  const afterUndo = (await plotsByRecord(rec.globalId))[0];
  check(
    "Undo (Ctrl+Z) restored the Plot's position",
    !!afterUndo && afterUndo.xmin === beforeMove.xmin && afterUndo.ymin === beforeMove.ymin,
    `${JSON.stringify(afterUndo)} (drawn at ${JSON.stringify(beforeMove)})`,
  );

  // ---- Parcel Fabric operations are refused while undone edits exist; Save clears them
  await selectPlots(rec.globalId);
  await sleep(800);
  await key("S", ["Shift"]);
  await waitFor(async () => page.evaluate(() => window.__ps.editing.getState().divideParcelOpen), 10000, "divide dialog (guard)");
  await waitFor(async () => page.evaluate(() => ![...document.querySelectorAll("#dlg-divide-parcel calcite-button")].find((x) => x.textContent.trim() === "Divide parcel")?.disabled), 20000, "divide ready (guard)");
  await sleep(1200);
  await deepClick("Divide parcel", { scope: "#dlg-divide-parcel", tags: ["CALCITE-BUTTON"] });
  await waitFor(async () => page.evaluate(() => /undid edits/.test(document.querySelector("#dlg-divide-parcel")?.innerText ?? "")), 20000, "undo guard message");
  check("Parcel Fabric operations are refused after an undo (save or discard first)", true);
  await deepClick("Cancel", { scope: "#dlg-divide-parcel", tags: ["CALCITE-BUTTON"] });
  await sleep(800);
  await page.mouse.click(5, 5);
  await key("s", ["Control"]);
  await waitFor(async () => { const st = await state(); return st.session === "editing" && st.pending === 0 && !st.busy; }, 60000, "save");
  check("Save (Ctrl+S) kept the edits in this version and started a clean session", (await count("parcel-polygon", `createdbyrecord = '${rec.globalId}'`)) === 1);

  // ---- UPI rules on plain attribute edits (the path the Editor form and the attribute table use)
  const upiEdit = (guid, name) =>
    page.evaluate(
      async (guid, name) => {
        const info = window.__ps.registry.all().find((i) => i.fabricRole === "parcel-polygon");
        const oidField = info.layer.objectIdField;
        const [oid] = await info.layer.queryObjectIds(window.__ps.shown(info.layer, { where: `createdbyrecord = '${guid}'` }));
        try {
          const r = await info.layer.applyEdits({ updateFeatures: [{ attributes: { [oidField]: oid, name } }] });
          const err = r.updateFeatureResults[0]?.error;
          if (err) return { ok: false, error: err.message };
        } catch (e) {
          return { ok: false, error: e.message };
        }
        const fs = await info.layer.queryFeatures(window.__ps.shown(info.layer, { objectIds: [oid], outFields: ["name"], returnGeometry: false }));
        return { ok: true, stored: fs.features[0]?.attributes.name ?? null };
      },
      guid,
      name,
    );
  const storedName = () =>
    page.evaluate(async (guid) => {
      const info = window.__ps.registry.all().find((i) => i.fabricRole === "parcel-polygon");
      const fs = await info.layer.queryFeatures(window.__ps.shown(info.layer, { where: `createdbyrecord = '${guid}'`, outFields: ["name"], returnGeometry: false }));
      return fs.features[0]?.attributes.name ?? null;
    }, rec.globalId);
  const nameBefore = await storedName();
  const badFormat = await upiEdit(rec.globalId, "ABC");
  check("Typed UPI with a wrong format is refused before it reaches the server", !badFormat.ok && /not a valid UPI/.test(badFormat.error) && (await storedName()) === nameBefore, JSON.stringify(badFormat));
  const takenUpi = await page.evaluate(async (guid) => {
    const info = window.__ps.registry.all().find((i) => i.fabricRole === "parcel-polygon");
    const fs = await info.layer.queryFeatures(window.__ps.shown(info.layer, { where: `name LIKE '_/__/__/__/%' AND (createdbyrecord IS NULL OR createdbyrecord <> '${guid}')`, outFields: ["name"], returnGeometry: false, num: 1 }));
    return fs.features[0]?.attributes.name;
  }, rec.globalId);
  const duplicate = await upiEdit(rec.globalId, takenUpi);
  check("Typed UPI already used by another parcel is refused", !duplicate.ok && /already used/.test(duplicate.error) && (await storedName()) === nameBefore, `${takenUpi}: ${JSON.stringify(duplicate)}`);
  const freeUpi = await page.evaluate(async (guid) => {
    const info = window.__ps.registry.all().find((i) => i.fabricRole === "parcel-polygon");
    const [oid] = await info.layer.queryObjectIds(window.__ps.shown(info.layer, { where: `createdbyrecord = '${guid}'` }));
    const { suggestUpisForParcels } = await import("/src/gis/parcel-fabric/upi.ts");
    return (await suggestUpisForParcels([oid], 1))?.upis[0];
  }, rec.globalId);
  const accepted = await upiEdit(rec.globalId, freeUpi);
  check("Typed UPI that is valid and free is saved", accepted.ok && accepted.stored === freeUpi, `${freeUpi}: ${JSON.stringify(accepted)}`);
  await sleep(1500);

  // ---- Parcel Fabric: divide into 3 parcels (Shift+S on a parcel opens the Divide dialog)
  const UPI_RE = /^\d\/\d{2}\/\d{2}\/\d{2}\/\d+$/;
  const lineageOf = (oid) =>
    page.evaluate(async (oid) => {
      const { parcelFabricService } = await import("/src/gis/parcel-fabric/parcelFabricService.ts");
      try {
        const l = await parcelFabricService.lineage(oid, null);
        return { found: true, historic: l.historic, createdBy: l.createdBy?.name ?? null, retiredBy: l.retiredBy?.name ?? null, predecessors: l.predecessors.length, successors: l.successors.length };
      } catch (e) {
        return { found: false, error: e.message };
      }
    }, oid);
  const currentByRecord = (guid) =>
    page.evaluate(async (guid) => {
      const info = window.__ps.registry.all().find((i) => i.fabricRole === "parcel-polygon");
      const fs = await info.layer.queryFeatures(window.__ps.shown(info.layer, { where: `createdbyrecord = '${guid}'`, outFields: ["objectid", "name", "parcel_number", "district", "sector", "cell", "village"], returnGeometry: false }));
      return fs.features.map((g) => g.attributes);
    }, guid);
  const selectOids = (oids) =>
    page.evaluate((oids) => {
      const info = window.__ps.registry.all().find((i) => i.fabricRole === "parcel-polygon");
      const sm = window.__ps.map.view.selectionManager;
      sm.clear();
      sm.add(info.layer, oids);
    }, oids);
  const original = (await plotsByRecord(rec.globalId))[0];
  await selectPlots(rec.globalId);
  await sleep(1000);
  await key("S", ["Shift"]);
  await waitFor(async () => page.evaluate(() => window.__ps.editing.getState().divideParcelOpen), 10000, "divide dialog");
  check("Split (Shift+S) on a parcel opens the Parcel Fabric Divide dialog", true);
  await waitFor(async () => page.evaluate(() => ![...document.querySelectorAll("#dlg-divide-parcel calcite-button")].find((x) => x.textContent.trim() === "Divide parcel")?.disabled), 20000, "divide ready");
  await page.evaluate(() => {
    const el = document.querySelector("#divide-parts");
    el.value = "3";
    el.dispatchEvent(new CustomEvent("calciteInputNumberInput", { bubbles: true, composed: true }));
  });
  pend = (await state()).pending;
  await confirmDialog("#dlg-divide-parcel", "Divide parcel", pend);
  await sleep(2000);
  await page.screenshot({ path: `${out}/p2-2c-divide.png` });
  const afterDivide = await plotsByRecord(rec.globalId);
  const origLineage = await lineageOf(original.oid);
  check("Divide: 3 new current parcels", afterDivide.length === 3, `current parcels by record: ${afterDivide.length}`);
  check("Divide: original parcel retired by the record and kept as history", origLineage.historic && origLineage.retiredBy === RECORD && origLineage.successors === 3, JSON.stringify(origLineage));

  // ---- Assign UPIs opens straight after the divide, with suggestions
  await waitFor(async () => page.evaluate(() => window.__ps.editing.getState().assignUpiTargets.length === 3), 20000, "assign UPI dialog");
  await waitFor(async () => page.evaluate(() => { const ins = [...document.querySelectorAll("#dlg-assign-upi calcite-input-text")]; return ins.length === 3 && ins.every((i) => i.value); }), 30000, "UPI suggestions");
  const suggested = await page.evaluate(() => [...document.querySelectorAll("#dlg-assign-upi calcite-input-text")].map((i) => i.value));
  check("Assign UPIs opens after divide with 3 valid, different suggestions", suggested.every((u) => UPI_RE.test(u)) && new Set(suggested).size === 3, suggested.join(", "));
  await page.screenshot({ path: `${out}/p2-2d-assign-upi.png` });
  pend = (await state()).pending;
  await confirmDialog("#dlg-assign-upi", "Save UPIs", pend);
  await sleep(1500);
  const named = await currentByRecord(rec.globalId);
  check(
    "UPIs saved with matching parcel numbers and location fields",
    named.length === 3 && named.every((r) => suggested.includes(r.name) && r.parcel_number === Number(String(r.name).split("/").pop()) && r.district && r.sector && r.cell),
    named.map((r) => `${r.name} #${r.parcel_number} ${r.district}/${r.sector}/${r.cell}/${r.village}`).join(" | "),
  );

  // ---- merge two of them (Shift+G): the next UPI is suggested; a bad UPI is refused
  await selectOids([named[0].objectid, named[1].objectid]);
  await sleep(1000);
  await key("G", ["Shift"]);
  await waitFor(async () => page.evaluate(() => window.__ps.editing.getState().mergeParcelsOpen), 10000, "merge dialog");
  check("Merge (Shift+G) on parcels opens the Parcel Fabric Merge dialog", true);
  await waitFor(async () => page.evaluate((re) => new RegExp(re).test(document.querySelector("#merge-new-upi")?.value ?? ""), UPI_RE.source), 30000, "merge UPI suggestion");
  const mergeSuggestion = await page.evaluate(() => document.querySelector("#merge-new-upi").value);
  const setMergeUpi = (v) =>
    page.evaluate((v) => {
      const el = document.querySelector("#merge-new-upi");
      el.value = v;
      el.dispatchEvent(new CustomEvent("calciteInputTextInput", { bubbles: true, composed: true }));
    }, v);
  await setMergeUpi("E2E-BAD-UPI");
  await sleep(500);
  const badRefused = await page.evaluate(() => !![...document.querySelectorAll("#dlg-merge-parcels calcite-button")].find((x) => x.textContent.trim() === "Merge parcels")?.disabled);
  await setMergeUpi(mergeSuggestion);
  await sleep(500);
  check("Merge suggests the next free UPI and refuses a badly formatted one", badRefused && !suggested.includes(mergeSuggestion), `suggested ${mergeSuggestion}; bad UPI refused=${badRefused}`);
  pend = (await state()).pending;
  await confirmDialog("#dlg-merge-parcels", "Merge parcels", pend);
  await sleep(2000);
  const afterMerge = await currentByRecord(rec.globalId);
  const merged = afterMerge.find((r) => r.name === mergeSuggestion);
  const third = afterMerge.find((r) => r.objectid === named[2].objectid);
  const mergedLineage = merged ? await lineageOf(merged.objectid) : null;
  check("Merge: new parcel has the suggested UPI and its location fields", !!merged && merged.parcel_number === Number(mergeSuggestion.split("/").pop()) && !!merged.district && afterMerge.length === 2, JSON.stringify(merged ?? afterMerge));
  check("Merge: the parents are kept as history (lineage through the record)", !!mergedLineage && !mergedLineage.historic && mergedLineage.createdBy === RECORD && mergedLineage.predecessors >= 2, JSON.stringify(mergedLineage));
  const stAfter = await state();
  check("Undo is disabled after a Parcel Fabric operation (Discard still available)", !stAfter.canUndo && stAfter.pending > 0, `canUndo=${stAfter.canUndo} pending=${stAfter.pending}`);

  // ---- lineage in the properties panel
  await page.evaluate((oid) => {
    const info = window.__ps.registry.all().find((i) => i.fabricRole === "parcel-polygon");
    window.__ps.app.getState().showProperties({ kind: "features", hits: [{ layerKey: info.key, objectId: oid }], index: 0 });
  }, merged?.objectid);
  // textContent: section titles are CSS upper-case (innerText would return "CAME FROM"); list labels are component properties
  await waitFor(async () => page.evaluate(() => (document.querySelector(".ps-side.right")?.textContent ?? "").includes("Came from")), 30000, "lineage block");
  const lineageUi = await page.evaluate(() => {
    const panel = document.querySelector(".ps-side.right");
    return { text: panel.textContent.replace(/\s+/g, " "), items: [...panel.querySelectorAll("calcite-list-item")].map((i) => ({ label: i.label, description: i.description })) };
  });
  const historicItems = lineageUi.items.filter((i) => /Historic/.test(i.description ?? ""));
  check("Properties show parcel lineage (status, record, earlier parcels)", lineageUi.text.includes("Current") && lineageUi.text.includes(RECORD) && historicItems.length >= 2, `earlier: ${historicItems.map((i) => i.label).join(", ")}`);
  await page.screenshot({ path: `${out}/p2-2e-lineage.png` });

  // ---- retire the third parcel (Delete → Retire): it stays as history
  await selectOids([third.objectid]);
  await sleep(800);
  await page.mouse.click(5, 5);
  await selectOids([third.objectid]);
  await sleep(800);
  await key("Delete");
  await waitFor(async () => page.evaluate(() => !!document.querySelector("#dlg-delete")?.open && /Retire/.test(document.querySelector("#dlg-delete")?.textContent ?? "")), 15000, "retire/delete dialog");
  await page.screenshot({ path: `${out}/p2-2f-retire-or-delete.png` });
  check("Delete on a parcel offers Retire (keep history) or Delete permanently", true);
  pend = (await state()).pending;
  await confirmDialog("#dlg-delete", "Retire (keep history)", pend, { detectErrors: false });
  await sleep(1500);
  const thirdLineage = await lineageOf(third.objectid);
  check("Retire keeps the parcel as history, retired by the record", thirdLineage.found && thirdLineage.historic && thirdLineage.retiredBy === RECORD, JSON.stringify(thirdLineage));

  // ---- delete the merged parcel permanently: no history is kept
  await selectOids([merged.objectid]);
  await sleep(800);
  await key("Delete");
  await waitFor(async () => page.evaluate(() => !!document.querySelector("#dlg-delete")?.open), 15000, "delete dialog");
  pend = (await state()).pending;
  await confirmDialog("#dlg-delete", "Delete permanently", pend, { detectErrors: false });
  await sleep(1500);
  const mergedGone = await lineageOf(merged.objectid);
  check("Delete permanently removes the parcel entirely (no history kept)", !mergedGone.found, JSON.stringify(mergedGone));

  // ---- topology validation of the map view (Editing panel → Parcel Fabric card)
  await page.evaluate(() => window.__ps.app.getState().openLeftPanel("editing"));
  await sleep(1500);
  await deepClick("Validate this map view", { scope: "#parcel-fabric-card", tags: ["CALCITE-BUTTON"] });
  await waitFor(async () => page.evaluate(() => !!document.querySelector("#parcel-fabric-status")), 60000, "validation status");
  const valText = await page.evaluate(() => document.querySelector("#parcel-fabric-status")?.innerText.replace(/\s+/g, " ") ?? "");
  check("Validate topology really validates the map view (no dirty areas left in it)", /Dirty areas None/.test(valText) && /Total errors/.test(valText), valText);

  // ---- attribute table is editable during the session
  await key("3", ["Alt"]);
  await sleep(4000);
  const chip = await page.evaluate(() => [...document.querySelectorAll(".ps-table-toolbar calcite-chip")].map((c) => c.textContent).join("|"));
  check("Attribute table editable during session", chip.includes("Editable"), chip);
  await page.screenshot({ path: `${out}/p2-4-table-editing.png` });

  // ---- editing history
  await page.evaluate(() => window.__ps.app.getState().openBottomTab("history"));
  await sleep(800);
  const hist = await page.evaluate(() => document.querySelector(".ps-log")?.innerText ?? "");
  check("Editing History records server-confirmed edits", hist.includes("Plot") && hist.includes("added"), hist.split("\n").slice(0, 6).join(" | "));
  await page.screenshot({ path: `${out}/p2-5-history.png` });

  // ---- discard everything (toolbar → confirm)
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("ps:confirm", { detail: "discard" })));
  await sleep(800);
  await deepClick("Discard edits", { scope: "#dlg-discard", tags: ["CALCITE-BUTTON"] });
  await waitFor(async () => { const s = await state(); return s.session === "editing" && s.pending === 0 && !s.busy; }, 30000, "discard");
  const afterDiscardPlots = await plotsByRecord(rec.globalId);
  const originalAfterDiscard = await lineageOf(original.oid);
  check(
    "Discard rolled back the Parcel Fabric operations (original parcel current again, merged parcel gone)",
    afterDiscardPlots.length === 1 && afterDiscardPlots[0].oid === original.oid && !originalAfterDiscard.historic,
    `current by record: ${afterDiscardPlots.map((p) => p.oid).join(",")} (original ${original.oid}); original historic=${originalAfterDiscard.historic}`,
  );

  // ---- stop editing with the Editing panel's Stop button (keyboard focus may still be in the table grid)
  await page.evaluate(() => window.__ps.app.getState().openLeftPanel("editing"));
  await sleep(800);
  await deepClick("Stop", { scope: ".ps-side.left", tags: ["CALCITE-BUTTON"] });
  await sleep(1000);
  await deepClick("Stop editing", { scope: "#dlg-stop", tags: ["CALCITE-BUTTON"] });
  await waitFor(async () => (await state()).session === "reading", 20000, "stop editing");
  check("Edit session stopped", true);
} catch (e) {
  check("Unexpected failure", false, e.message);
  await page.screenshot({ path: `${out}/p2-fail.png` });
} finally {
  // Cleanup: always return to DEFAULT and delete the test version.
  try {
    const cleanup = await cleanupTestVersion(page, VERSION);
    check("Cleanup: back on DEFAULT and test version deleted", !cleanup.stillThere, JSON.stringify(cleanup));
    const finalPlots = await count("parcel-polygon", "1=1");
    check("DEFAULT unchanged after test", defaultPlots === null || finalPlots === defaultPlots, `Plot count before ${defaultPlots}, after ${finalPlots}`);
  } catch (e) {
    check("Cleanup", false, e.message);
  }
  console.log("\n=== SUMMARY ===\n" + results.join("\n"));
  console.log("\nBrowser errors:\n" + (errors.join("\n") || "none"));
  await browser.close();
}
