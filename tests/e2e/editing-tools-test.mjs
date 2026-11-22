import { captureErrors, cleanupTestVersion, closeVersionManagerOnEntry, createActiveRecord, createVersionViaUI, launchBrowser, pageTools, signIn, sleep } from "./helpers.mjs";

const out = process.argv[2] || (await import("node:os")).tmpdir();
const TS = new Date().toISOString().replace(/\D/g, "").slice(4, 12);
const VERSION = `PS_E2E_${TS}`;
const RECORD = `E2E-TOOLS-${TS}`;
const results = [];
const check = (name, ok, detail = "") => {
  results.push(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  console.log(results.at(-1));
};

const browser = await launchBrowser();
const page = await browser.newPage();
const errors = captureErrors(page);
const tools = pageTools(page);
const { deepClick, state, waitFor, count, workflow, commitIfNeeded, key, cancelWorkflow } = tools;

// ---- page helpers (features are found by the test record; reads are at the layer's moment)
const oidsByRecord = (role, guid) =>
  page.evaluate(
    async (role, guid) => {
      const info = window.__ps.registry.all().find((i) => i.fabricRole === role);
      return (await info.layer.queryObjectIds(window.__ps.shown(info.layer, { where: `createdbyrecord = '${guid}'` }))).sort((a, b) => a - b);
    },
    role,
    guid,
  );
const select = (role, oids) =>
  page.evaluate(
    (role, oids) => {
      const info = window.__ps.registry.all().find((i) => i.fabricRole === role);
      const sm = window.__ps.map.view.selectionManager;
      sm.clear();
      sm.add(info.layer, oids);
    },
    role,
    oids,
  );
const startCreate = (role) =>
  page.evaluate(async (role) => {
    const ed = document.querySelector("arcgis-editor");
    const info = window.__ps.registry.all().find((i) => i.fabricRole === role);
    await ed.startCreateFeaturesWorkflowAtFeatureCreation({ layer: info.layer, template: info.layer.templates?.[0] ?? info.layer.types?.[0]?.templates?.[0] });
    return ed.activeWorkflow?.type ?? null;
  }, role);
/** Geometry of one feature in the view's spatial reference, with page-pixel positions for its vertices and extent. */
const geometryOf = (role, oid) =>
  page.evaluate(
    async (role, oid) => {
      const view = window.__ps.map.view;
      const info = window.__ps.registry.all().find((i) => i.fabricRole === role);
      const fs = await info.layer.queryFeatures(window.__ps.shown(info.layer, { objectIds: [oid], returnGeometry: true, outSpatialReference: view.spatialReference, outFields: ["*"] }));
      const f = fs.features[0];
      if (!f) return null;
      const rect = view.container.getBoundingClientRect();
      const px = (x, y) => {
        const s = view.toScreen({ x, y, spatialReference: view.spatialReference });
        return { x: rect.left + s.x, y: rect.top + s.y };
      };
      const g = f.geometry;
      const parts = g.rings ?? g.paths;
      const pts = parts[0].slice(0, g.rings ? -1 : undefined).map(([x, y]) => ({ x, y }));
      const e = g.extent;
      let area = 0;
      if (g.rings) for (let i = 0; i < pts.length; i++) area += pts[i].x * pts[(i + 1) % pts.length].y - pts[(i + 1) % pts.length].x * pts[i].y;
      return {
        pts,
        screen: pts.map((p) => px(p.x, p.y)),
        area: Math.abs(area / 2),
        width: e.width,
        height: e.height,
        box: { tl: px(e.xmin, e.ymax), br: px(e.xmax, e.ymin), c: px(e.center.x, e.center.y) },
        attributes: f.attributes,
        resolution: view.resolution,
      };
    },
    role,
    oid,
  );
/** Length of a line in the layer's own (projected, metre) coordinates. */
const nativeLength = (role, oid) =>
  page.evaluate(
    async (role, oid) => {
      const info = window.__ps.registry.all().find((i) => i.fabricRole === role);
      const fs = await info.layer.queryFeatures(window.__ps.shown(info.layer, { objectIds: [oid], returnGeometry: true }));
      const g = fs.features[0]?.geometry;
      let len = 0;
      for (const path of g?.paths ?? []) for (let i = 1; i < path.length; i++) len += Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]);
      return { len, wkid: g?.spatialReference?.wkid ?? "wkt" };
    },
    role,
    oid,
  );
const storedAttr = (oid, field) =>
  page.evaluate(
    async (oid, field) => {
      const info = window.__ps.registry.all().find((i) => i.fabricRole === "parcel-polygon");
      const fs = await info.layer.queryFeatures(window.__ps.shown(info.layer, { objectIds: [oid], outFields: [field], returnGeometry: false }));
      return fs.features[0]?.attributes[field] ?? null;
    },
    oid,
    field,
  );
/** Click a Calcite action in the Editor by its `text` property (the SDK sets it as a property, not an attribute). */
const clickEditorAction = (text) =>
  page.evaluate((text) => {
    const stack = [document.querySelector("arcgis-editor")];
    while (stack.length) {
      const n = stack.pop();
      if (!n) continue;
      for (const k of [...(n.children ?? []), ...(n.shadowRoot ? [...n.shadowRoot.children] : [])]) stack.push(k);
      if (n.tagName === "CALCITE-ACTION" && n.text === text && n.getClientRects().length) {
        n.click();
        return true;
      }
    }
    return false;
  }, text);
/** Whether a Calcite action in the Editor (by its `text` property) is shown and enabled, e.g. Undo once a vertex exists. */
const editorActionEnabled = (text) =>
  page.evaluate((text) => {
    const stack = [document.querySelector("arcgis-editor")];
    while (stack.length) {
      const n = stack.pop();
      if (!n) continue;
      for (const k of [...(n.children ?? []), ...(n.shadowRoot ? [...n.shadowRoot.children] : [])]) stack.push(k);
      if (n.tagName === "CALCITE-ACTION" && n.text === text && n.getClientRects().length) return !n.disabled;
    }
    return false;
  }, text);
/** The Editor's state, e.g. drawing-splitter-geometry while splitting (the workflow itself is "update"). */
const editorState = () => page.evaluate(() => document.querySelector("arcgis-editor")?.state ?? "");
const noticeCount = (title) => page.evaluate((title) => window.__ps.app.getState().notices.filter((n) => n.title === title).length, title);
const lastNotice = (title) => page.evaluate((title) => window.__ps.app.getState().notices.find((n) => n.title === title)?.message ?? null, title);
/** Mouse drag in page pixels, in small steps so the SDK sees a real drag. */
const drag = async (from, to, { ctrl = false } = {}) => {
  if (ctrl) await page.keyboard.down("Control");
  await page.mouse.move(from.x, from.y, { steps: 4 });
  await sleep(300);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 8 });
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await sleep(200);
  await page.mouse.up();
  if (ctrl) await page.keyboard.up("Control");
};
const ctrlClick = async (p) => {
  await page.keyboard.down("Control");
  await page.mouse.click(p.x, p.y);
  await page.keyboard.up("Control");
  await sleep(350);
};
const mapCenter = () =>
  page.evaluate(() => {
    const r = window.__ps.map.view.container.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
  });
/** Finish a create workflow: the Editor may wait on its form's Create button. */
const finishCreate = async (pendBefore, label) => {
  await sleep(3000);
  if ((await state()).pending === pendBefore) await commitIfNeeded(pendBefore, ["Create", "Save", "Done"]);
  await waitFor(async () => (await state()).pending > pendBefore, 45000, label);
  await cancelWorkflow();
  await sleep(1500);
};
/** Start the Modify workflow (M) on one feature. */
const modify = async (role, oid) => {
  await cancelWorkflow();
  await select(role, [oid]);
  await sleep(800);
  await page.mouse.click(5, 5); // keyboard focus out of any input
  await key("m");
  await waitFor(async () => (await workflow()) === "update", 15000, "modify workflow");
  await sleep(2500);
};
/** After a geometry change in Modify: apply it (Update if the Editor waits for it) and leave the workflow. */
const applyUpdate = async (pendBefore, label) => {
  await commitIfNeeded(pendBefore, ["Update"]);
  await waitFor(async () => (await state()).pending > pendBefore, 45000, label);
  await cancelWorkflow();
  await sleep(1500);
};
/**
 * Type into a field of the Editor's attribute form, as a person would: focus the Calcite input
 * (labelled by field name, inside the Editor's shadow tree), replace its text, then Tab out.
 */
const setFormField = async (field, value) => {
  const found = await page.evaluate(async (field) => {
    const stack = [document.querySelector("arcgis-editor")];
    while (stack.length) {
      const n = stack.pop();
      if (!n) continue;
      for (const k of [...(n.children ?? []), ...(n.shadowRoot ? [...n.shadowRoot.children] : [])]) stack.push(k);
      if (n.tagName === "CALCITE-INPUT" && n.label === field && n.getClientRects().length) {
        n.scrollIntoView({ block: "center" });
        await n.setFocus();
        await n.selectText?.();
        return true;
      }
    }
    return false;
  }, field);
  if (!found) return false;
  await sleep(300);
  await page.keyboard.down("Control");
  await page.keyboard.press("a");
  await page.keyboard.up("Control");
  await page.keyboard.type(value);
  await page.keyboard.press("Tab");
  await sleep(800);
  return true;
};

let defaultCounts = null;
try {
  await signIn(page);
  await closeVersionManagerOnEntry(page, tools);
  defaultCounts = { plots: await count("parcel-polygon", "1=1"), lines: await count("parcel-line", "1=1") };
  check("Signed in; DEFAULT counts read", defaultCounts.plots > 0, JSON.stringify(defaultCounts));
  await createVersionViaUI(page, tools, VERSION);
  check("Throw-away version created and active", ((await state()).current ?? "").endsWith(VERSION), (await state()).current);
  await key("E", ["Shift"]);
  await waitFor(async () => (await state()).session === "editing", 30000, "edit session");
  const rec = await createActiveRecord(page, tools, RECORD);
  check("Edit session started with an active record", !!rec?.globalId, rec?.name);
  await page.evaluate(() => window.__ps.map.view.goTo({ scale: 2000 }, { duration: 0 }));
  await sleep(3000);

  // ================================================================ 13.2 snapping
  // Pick an existing parcel corner near the middle of the map, start a new Plot about 5 px away from it.
  const target = await page.evaluate(async () => {
    const view = window.__ps.map.view;
    const info = window.__ps.registry.all().find((i) => i.fabricRole === "parcel-polygon");
    const inner = view.extent.clone().expand(0.5);
    const fs = await info.layer.queryFeatures(window.__ps.shown(info.layer, { geometry: inner, returnGeometry: true, outSpatialReference: view.spatialReference, num: 200 }));
    const c = view.center;
    let best = null;
    for (const f of fs.features)
      for (const ring of f.geometry.rings)
        for (const [x, y] of ring) {
          if (x < inner.xmin || x > inner.xmax || y < inner.ymin || y > inner.ymax) continue;
          const d = Math.hypot(x - c.x, y - c.y);
          if (!best || d < best.d) best = { x, y, d };
        }
    if (!best) return null;
    const rect = view.container.getBoundingClientRect();
    const s = view.toScreen({ x: best.x, y: best.y, spatialReference: view.spatialReference });
    return { x: best.x, y: best.y, sx: rect.left + s.x, sy: rect.top + s.y, resolution: view.resolution };
  });
  if (!target) throw new Error("No parcel corner in view to snap to");
  const before = await oidsByRecord("parcel-polygon", rec.globalId);
  check("Create Plot workflow starts", (await startCreate("parcel-polygon")) === "create-features");
  await sleep(1500);
  let pend = (await state()).pending;
  const off = { x: target.sx + 5, y: target.sy + 4 };
  // Snapping needs the parcel layer drawn; wait for the map to settle. Retry the click if the sketch did not take it.
  await waitFor(async () => page.evaluate(() => !window.__ps.map.view.updating), 30000, "map drawn");
  for (let attempt = 0; attempt < 3 && !(await editorActionEnabled("Undo")); attempt++) {
    await page.mouse.move(off.x - 20, off.y - 20, { steps: 3 });
    await page.mouse.move(off.x, off.y, { steps: 6 });
    await sleep(900);
    await page.mouse.click(off.x, off.y); // snapping on: no Ctrl
    await sleep(700);
  }
  // the other corners away from the target, snapping off (Ctrl held)
  const far = target.sx > (await mapCenter()).x ? -1 : 1;
  for (const [dx, dy] of [[70 * far, 0], [70 * far, 70], [0, 70]]) await ctrlClick({ x: off.x + dx, y: off.y + dy });
  await page.keyboard.press("Enter");
  await finishCreate(pend, "snapped Plot");
  const snappedOid = (await oidsByRecord("parcel-polygon", rec.globalId)).find((o) => !before.includes(o));
  const snapped = await geometryOf("parcel-polygon", snappedOid);
  const gap = Math.min(...snapped.pts.map((p) => Math.hypot(p.x - target.x, p.y - target.y)));
  const clickedAway = Math.hypot(5, 4) * target.resolution;
  check("Snapping: the corner clicked ~5 px away lands exactly on the existing parcel corner", gap < 0.05 && clickedAway > 1, `gap ${gap.toFixed(3)} m (the click was ${clickedAway.toFixed(2)} m away)`);

  // ================================================================ 13.2 typed distance (tooltip input) on a Plot line
  const center = await mapCenter();
  const lineStart = { x: center.x - Math.min(260, center.w * 0.3), y: center.y + Math.min(150, center.h * 0.25) };
  check("Create line workflow starts (Plot_Lines)", (await startCreate("parcel-line")) === "create-features");
  await sleep(1500);
  pend = (await state()).pending;
  await ctrlClick(lineStart);
  const focusedField = () =>
    page.evaluate(() => {
      let a = document.activeElement;
      while (a?.shadowRoot?.activeElement) a = a.shadowRoot.activeElement;
      // The <input> sits inside a calcite-input's shadow root; the field and its title are around that host.
      let el = a;
      while (el && !el.closest?.(".esri-tooltip-editable-field")) el = el.getRootNode?.().host ?? null;
      const fieldEl = el?.closest?.(".esri-tooltip-editable-field");
      const title = fieldEl?.querySelector(".esri-tooltip-editable-field__title")?.textContent?.trim() ?? "";
      return { inTooltip: !!fieldEl, tag: a?.tagName, label: title };
    });
  // Tab opens typed input only while the map has keyboard focus and shows the drawing tooltip; retry if focus went elsewhere.
  let field = { inTooltip: false };
  for (let attempt = 0; attempt < 4 && !field.inTooltip; attempt++) {
    await page.mouse.move(lineStart.x + 60 + attempt * 3, lineStart.y - 5, { steps: 6 });
    await sleep(800);
    await page.evaluate(() => window.__ps.map.view.focus());
    await sleep(300);
    await page.keyboard.press("Tab");
    await sleep(700);
    field = await focusedField();
  }
  const tooltipText = await page.evaluate(() => document.querySelector(".esri-tooltip")?.innerText.replace(/\s+/g, " ") ?? "");
  console.log("[tooltip]", JSON.stringify(field), tooltipText);
  // The first field is the direction (or deflection); Tab moves to the next until Distance.
  for (let i = 0; i < 3 && field.inTooltip && !/distance/i.test(field.label); i++) {
    await page.keyboard.press("Tab");
    await sleep(400);
    field = await focusedField();
  }
  check("Tab opens typed input in the drawing tooltip", field.inTooltip && /distance/i.test(field.label), JSON.stringify(field));
  const unit = /Distance[^\d-]*-?[\d.,]+\s*([a-zA-Z]+)/.exec(tooltipText)?.[1] ?? "m";
  const toMetres = { m: 1, km: 1000, ft: 0.3048, "ft-us": 0.3048006, yd: 0.9144, mi: 1609.344 }[unit] ?? 1;
  await page.keyboard.down("Control");
  await page.keyboard.press("a");
  await page.keyboard.up("Control");
  const TYPED = 80;
  await page.keyboard.type(String(TYPED));
  await page.keyboard.press("Enter"); // locks the distance (lock icon in the tooltip)
  await sleep(1000);
  const locked = await page.evaluate(() => document.querySelector(".esri-tooltip")?.innerText.replace(/\s+/g, " ") ?? "");
  // Click in the direction of the line: the point is placed at the locked distance, wherever the click is.
  await ctrlClick({ x: lineStart.x + 120, y: lineStart.y });
  await sleep(800);
  await page.evaluate(() => window.__ps.map.view.focus());
  await page.keyboard.press("Enter"); // finish the line
  await finishCreate(pend, "typed line");
  const [lineOid] = await oidsByRecord("parcel-line", rec.globalId);
  const typed = await nativeLength("parcel-line", lineOid);
  const expected = TYPED * toMetres;
  check(
    "Typed distance: the new line is exactly the typed length",
    !!lineOid && Math.abs(typed.len - expected) < Math.max(0.1, expected * 0.002),
    `typed ${TYPED} ${unit} (${expected.toFixed(2)} m), line is ${typed.len.toFixed(2)} m; tooltip: ${locked}`,
  );

  // ================================================================ 13.6 split and merge on a non-parcel layer (Editor)
  await select("parcel-line", [lineOid]);
  await sleep(800);
  await page.mouse.click(5, 5);
  await key("S", ["Shift"]);
  await waitFor(async () => /split/i.test(await editorState()), 15000, "split tool");
  check("Split (Shift+S) on a line opens the Editor split tool (not the parcel Divide)", true, await editorState());
  await sleep(2000);
  pend = (await state()).pending;
  const line = await geometryOf("parcel-line", lineOid);
  const [a, b] = [line.screen[0], line.screen.at(-1)];
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const nrm = { x: -(b.y - a.y) / len, y: (b.x - a.x) / len };
  // The split tool starts with the point splitter; cut with a line drawn across instead.
  check("Split tool offers a polyline splitter", await clickEditorAction("Draw a polyline"));
  await sleep(800);
  // Draw the cut across the line. If a click is lost the Editor says the sketch could not split; draw it again.
  for (let attempt = 0; attempt < 3 && (await state()).pending === pend; attempt++) {
    for (let i = 0; i < 3 && !(await editorActionEnabled("Undo")); i++) await ctrlClick({ x: mid.x + nrm.x * 40, y: mid.y + nrm.y * 40 });
    await ctrlClick({ x: mid.x - nrm.x * 40, y: mid.y - nrm.y * 40 });
    await page.keyboard.press("Enter");
    await commitIfNeeded(pend, ["Split", "Submit"]);
  }
  await waitFor(async () => (await state()).pending > pend, 45000, "split applied");
  await cancelWorkflow();
  await sleep(1500);
  const pieces = await oidsByRecord("parcel-line", rec.globalId);
  check("Split cut the line into 2 lines", pieces.length === 2, `lines: ${pieces.join(", ")}`);

  await select("parcel-line", pieces);
  await sleep(800);
  await page.mouse.click(5, 5);
  await key("G", ["Shift"]);
  await waitFor(async () => /merg|key-feature/i.test(await editorState()), 15000, "merge tool").catch(async (e) => {
    console.log("[merge state]", await editorState(), await workflow());
    throw e;
  });
  check("Merge (Shift+G) on lines opens the Editor merge tool (not the parcel Merge)", true, await editorState());
  await sleep(2000);
  pend = (await state()).pending;
  await commitIfNeeded(pend, ["Merge", "Submit"]);
  await waitFor(async () => (await state()).pending > pend, 45000, "merge applied");
  await cancelWorkflow();
  await sleep(1500);
  const merged = await oidsByRecord("parcel-line", rec.globalId);
  const mergedLen = merged.length === 1 ? (await nativeLength("parcel-line", merged[0])).len : 0;
  check("Merge joined them into 1 line of the original length", merged.length === 1 && Math.abs(mergedLen - typed.len) < 0.05, `lines: ${merged.join(", ")}; length ${mergedLen.toFixed(2)} m`);

  // ================================================================ 13.4 scale, rotate, reshape on a diamond Plot
  // A diamond: its box corners are empty space, so the corner handle can only scale.
  const c2 = await mapCenter();
  const dc = { x: c2.x + Math.min(220, c2.w * 0.25), y: c2.y - Math.min(90, c2.h * 0.15) };
  const beforeDiamond = await oidsByRecord("parcel-polygon", rec.globalId);
  await startCreate("parcel-polygon");
  await sleep(1500);
  pend = (await state()).pending;
  for (const [dx, dy] of [[0, -40], [40, 0], [0, 40], [-40, 0]]) await ctrlClick({ x: dc.x + dx, y: dc.y + dy });
  await page.keyboard.press("Enter");
  await finishCreate(pend, "diamond Plot");
  const diamondOid = (await oidsByRecord("parcel-polygon", rec.globalId)).find((o) => !beforeDiamond.includes(o));
  const d0 = await geometryOf("parcel-polygon", diamondOid);
  check("Diamond test Plot created (4 corners)", d0?.pts.length === 4, `oid ${diamondOid}`);

  // scale: drag the top-right box handle outwards
  await modify("parcel-polygon", diamondOid);
  pend = (await state()).pending;
  await drag({ x: d0.box.br.x, y: d0.box.tl.y }, { x: d0.box.br.x + 30, y: d0.box.tl.y - 30 });
  await applyUpdate(pend, "scale applied");
  const d1 = await geometryOf("parcel-polygon", diamondOid);
  const allMoved = d1.pts.every((p, i) => Math.hypot(p.x - d0.pts[i].x, p.y - d0.pts[i].y) > 0.05);
  check("Scale: dragging a box corner enlarges the parcel (every corner moves)", d1.area / d0.area > 1.3 && allMoved, `area ×${(d1.area / d0.area).toFixed(2)}`);

  // rotate: drag the rotate handle (20 px above the top-middle handle) by 45 degrees around the centre
  await modify("parcel-polygon", diamondOid);
  pend = (await state()).pending;
  const handle = { x: d1.box.c.x, y: d1.box.tl.y - 20 };
  const r = d1.box.c.y - handle.y;
  await drag(handle, { x: d1.box.c.x + r * Math.SQRT1_2, y: d1.box.c.y - r * Math.SQRT1_2 });
  await applyUpdate(pend, "rotate applied");
  const d2 = await geometryOf("parcel-polygon", diamondOid);
  check(
    "Rotate: the rotate handle turns the parcel (same area, new orientation)",
    Math.abs(d2.area / d1.area - 1) < 0.02 && Math.abs(d2.width / d1.width - 1) > 0.15,
    `area ×${(d2.area / d1.area).toFixed(3)}, width ${d1.width.toFixed(1)} → ${d2.width.toFixed(1)} m`,
  );

  // reshape: click the parcel to switch to vertex editing, then drag one corner outwards
  await modify("parcel-polygon", diamondOid);
  pend = (await state()).pending;
  await page.mouse.click(d2.box.c.x, d2.box.c.y);
  await sleep(1500);
  const v = d2.screen[0];
  const outward = { x: v.x - d2.box.c.x, y: v.y - d2.box.c.y };
  const ol = Math.hypot(outward.x, outward.y);
  await drag(v, { x: v.x + (outward.x / ol) * 25, y: v.y + (outward.y / ol) * 25 });
  await applyUpdate(pend, "reshape applied");
  const d3 = await geometryOf("parcel-polygon", diamondOid);
  const moved = d3.pts.map((p) => d2.pts.some((q) => Math.hypot(p.x - q.x, p.y - q.y) < 0.02) ? 0 : 1).reduce((s, x) => s + x, 0);
  check("Reshape: one corner moved, the others stayed put", d3.pts.length === d2.pts.length && moved === 1, `${moved} corner(s) moved of ${d3.pts.length}`);

  // ================================================================ 13.5 attribute edits in the Editor form
  await modify("parcel-polygon", diamondOid);
  pend = (await state()).pending;
  check("Attribute form shows the parcel's fields", await setFormField("village", "E2E Village"));
  await deepClick("Update", { scope: "arcgis-editor", tags: ["CALCITE-BUTTON"] });
  await waitFor(async () => (await state()).pending > pend, 45000, "form update");
  check("Attribute form: a changed field is saved (village)", (await storedAttr(diamondOid, "village")) === "E2E Village", String(await storedAttr(diamondOid, "village")));
  await cancelWorkflow();
  await sleep(1000);

  await modify("parcel-polygon", diamondOid);
  let notices = await noticeCount("UPI not saved");
  await setFormField("name", "ABC");
  await deepClick("Update", { scope: "arcgis-editor", tags: ["CALCITE-BUTTON"] });
  await waitFor(async () => (await noticeCount("UPI not saved")) > notices, 30000, "UPI refusal (form)");
  check("Attribute form: a badly formatted UPI is refused with a message", (await storedAttr(diamondOid, "name")) === null, await lastNotice("UPI not saved"));
  // The Editor also shows the reason in its own panel ("Edits could not be saved: …", Ignore / Retry).
  await sleep(1500);
  const editorSays = await page.evaluate(() => {
    const parts = [];
    const stack = [document.querySelector("arcgis-editor")];
    while (stack.length) {
      const n = stack.pop();
      if (!n) continue;
      for (const k of [...(n.children ?? []), ...(n.shadowRoot ? [...n.shadowRoot.children] : [])]) stack.push(k);
      if (n.nodeType === 1 && !n.children.length && /could not be saved/i.test(n.textContent ?? "")) parts.push(n.textContent.trim());
    }
    return parts[0] ?? "";
  });
  check("Attribute form: the Editor panel shows why the edit was not saved", /not a valid UPI/.test(editorSays), editorSays);
  await deepClick("Ignore", { scope: "arcgis-editor", tags: ["CALCITE-BUTTON"] });
  await sleep(800);
  await cancelWorkflow();
  await sleep(1000);

  // ================================================================ 13.5 attribute edits in the table
  await page.evaluate(() => {
    const info = window.__ps.registry.all().find((i) => i.fabricRole === "parcel-polygon");
    window.__ps.app.getState().openBottomTab("table", info.key);
  });
  await select("parcel-polygon", [diamondOid]);
  await sleep(4000);
  await page.evaluate(() => {
    document.querySelector("arcgis-feature-table").filterBySelectionEnabled = true;
  });
  await sleep(3000);
  /** The Name cell of the only row shown (selected only), in page pixels. */
  const nameCell = () =>
    page.evaluate(() => {
      const cells = [];
      const stack = [document.querySelector("arcgis-feature-table")];
      while (stack.length) {
        const n = stack.pop();
        if (!n) continue;
        for (const k of [...(n.children ?? []), ...(n.shadowRoot ? [...n.shadowRoot.children] : [])]) stack.push(k);
        if (n.tagName === "VAADIN-GRID-CELL-CONTENT" && n.getClientRects().length) {
          const r = n.getBoundingClientRect();
          cells.push({ text: (n.textContent ?? "").trim(), x: r.x + r.width / 2, y: r.y + r.height / 2, left: r.x });
        }
      }
      const header = cells.find((c) => /^Name\s*Sort/i.test(c.text));
      if (!header) return null;
      const rows = cells.filter((c) => Math.abs(c.left - header.left) < 3 && c.y > header.y + 5).sort((a, b) => a.y - b.y);
      return rows[0] ?? null;
    });
  const typeInCell = async (value) => {
    // The table can show its count before the row is drawn; wait for the row.
    await waitFor(async () => !!(await nameCell()), 30000, "the parcel's row in the attribute table");
    // Double-click opens a Calcite input in the cell; give it keyboard focus before typing (retry the double-click).
    const focusCellInput = () => page.evaluate(async () => {
      const stack = [document.querySelector("arcgis-feature-table")];
      while (stack.length) {
        const n = stack.pop();
        if (!n) continue;
        for (const k of [...(n.children ?? []), ...(n.shadowRoot ? [...n.shadowRoot.children] : [])]) stack.push(k);
        if (n.tagName === "CALCITE-INPUT" && n.getClientRects().length) {
          await n.setFocus();
          return true;
        }
      }
      return false;
    });
    let focused = false;
    // Enter on a focused cell opens its editor (the table's own key), double-click does too.
    for (let attempt = 0; attempt < 4 && !focused; attempt++) {
      const cell = await nameCell();
      if (attempt % 2 === 0) {
        await page.mouse.click(cell.x, cell.y);
        await sleep(500);
        await page.keyboard.press("Enter");
      } else await page.mouse.click(cell.x, cell.y, { clickCount: 2 });
      await sleep(1200);
      focused = await focusCellInput();
    }
    if (!focused) throw new Error("The table cell did not open for editing");
    await sleep(300);
    await page.keyboard.down("Control");
    await page.keyboard.press("a");
    await page.keyboard.up("Control");
    await page.keyboard.type(value);
    await page.keyboard.press("Enter");
  };
  notices = await noticeCount("UPI not saved");
  await typeInCell("ABC");
  await waitFor(async () => (await noticeCount("UPI not saved")) > notices, 30000, "UPI refusal (table)");
  check("Attribute table: a badly formatted UPI is refused with a message", (await storedAttr(diamondOid, "name")) === null, await lastNotice("UPI not saved"));
  await page.keyboard.press("Escape");
  await sleep(1500);
  const freeUpi = await page.evaluate(async (oid) => {
    const { suggestUpisForParcels } = await import("/src/gis/parcel-fabric/upi.ts");
    return (await suggestUpisForParcels([oid], 1))?.upis[0];
  }, diamondOid);
  pend = (await state()).pending;
  await typeInCell(freeUpi);
  await waitFor(async () => (await state()).pending > pend, 45000, "table update");
  check("Attribute table: a valid, free UPI is saved", (await storedAttr(diamondOid, "name")) === freeUpi, `${freeUpi} → ${await storedAttr(diamondOid, "name")}`);
  await page.screenshot({ path: `${out}/tools-table.png` });
} catch (e) {
  check("Unexpected failure", false, e.message);
  await page.screenshot({ path: `${out}/tools-fail.png` });
  const recent = await page
    .evaluate(() => {
      const s = window.__ps.app.getState();
      return [...s.notices.slice(0, 4).map((n) => `notice ${n.kind}: ${n.title} — ${n.message ?? ""}`), ...s.logs.slice(0, 6).map((l) => `log ${l.level} ${l.source}: ${l.message} ${l.detail ?? ""}`)];
    })
    .catch(() => []);
  console.log("[app messages at failure]\n" + recent.join("\n"));
} finally {
  try {
    const cleanup = await cleanupTestVersion(page, VERSION);
    check("Cleanup: edits discarded, back on DEFAULT, test version deleted", !cleanup.stillThere, JSON.stringify(cleanup));
    const after = { plots: await count("parcel-polygon", "1=1"), lines: await count("parcel-line", "1=1") };
    check("DEFAULT unchanged after test", !defaultCounts || (after.plots === defaultCounts.plots && after.lines === defaultCounts.lines), `before ${JSON.stringify(defaultCounts)}, after ${JSON.stringify(after)}`);
  } catch (e) {
    check("Cleanup", false, e.message);
  }
  console.log("\n=== SUMMARY ===\n" + results.join("\n"));
  console.log("\nBrowser errors:\n" + (errors.join("\n") || "none"));
  await browser.close();
}
