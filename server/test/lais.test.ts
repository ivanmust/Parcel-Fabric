/**
 * LAIS API tests against an in-memory fake ArcGIS Enterprise (no network, no real GIS).
 * Run: npm test   (from server/)
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- loose JSON response bodies in assertions */
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

const KEY = "test-lais-key-0123456789abcdef0123456789abcdef";
const PORTAL = "https://fake-gis.test/portal";
const SERVER = "https://fake-gis.test/server";
const PLOT = `${SERVER}/rest/services/ParcelFabric/FeatureServer/17`;
const VMS = `${SERVER}/rest/services/ParcelFabric/VersionManagementServer`;
const RECORDS = `${SERVER}/rest/services/ParcelFabric/FeatureServer/2`;
const REFERER = "https://gis-api.test";
const WEBHOOK = "https://lais-webhook.test/editing-done";
const WEBHOOK_KEY = "key-issued-by-lais-0123456789";
const OWNER = "svc_lais";
const auditDir = mkdtempSync(path.join(tmpdir(), "lais-audit-"));

Object.assign(process.env, {
  NODE_ENV: "test",
  LOG_LEVEL: "fatal",
  PORTAL_URL: PORTAL,
  ARCGIS_SERVER_URL: SERVER,
  LAIS_API_KEY: KEY,
  LAIS_ARCGIS_USERNAME: OWNER,
  LAIS_ARCGIS_PASSWORD: "not-a-real-password",
  LAIS_ARCGIS_REFERER: REFERER,
  LAIS_PARCEL_LAYER_URL: "",
  AUDIT_DIR: auditDir,
  LAIS_DATA_DIR: path.join(auditDir, "lais"),
  API_DOCS: "false",
});

// ------------------------------------------------------------------ fake ArcGIS

type Attrs = Record<string, unknown>;
interface Call { url: string; params: Record<string, string>; referer: string | null }
interface FakeVersion { name: string; guid: string; access: string; saved: Map<number, Attrs>; pending: Map<number, Attrs> | null }

const FIELDS = [
  { name: "objectid" }, { name: "name" }, { name: "transaction_id", length: 50 },
  { name: "transaction_type", domain: { codedValues: ["Subdivision", "Merge", "CorrectBoundaries", "CreatePlot"].map((code) => ({ code })) } },
  { name: "transaction_status", domain: { codedValues: ["New", "InProgress", "Approved", "Rejected"].map((code) => ({ code })) } },
  { name: "transaction_date", type: "esriFieldTypeDate" },
  { name: "case_", domain: { codedValues: [{ code: "Yes" }, { code: "No" }] } },
  { name: "validation_message" },
  { name: "version_status", domain: { codedValues: [{ code: "Pending" }, { code: "VersionCreated" }] } },
  { name: "version_name" },
  { name: "retiredbyrecord" },
  { name: "createdbyrecord" },
  { name: "size" },
  { name: "Shape__Area" },
  { name: "province" },
  { name: "district" },
  { name: "sector" },
  { name: "cell" },
  { name: "village" },
  { name: "parcel_number" },
  { name: "globalid" },
  { name: "last_edited_date", type: "esriFieldTypeDate" },
];
const RECORD_FIELDS = [{ name: "objectid" }, { name: "name" }, { name: "recordeddate" }, { name: "globalid" }, { name: "transaction_id" }];

const fake = {
  calls: [] as Call[],
  plots: new Map<number, Attrs>(),
  /** Parcel Fabric records in DEFAULT (a record reaches DEFAULT when its version is posted). */
  records: [] as Attrs[],
  /** Records created inside a version (by full version name), not yet posted. */
  versionRecords: new Map<string, Attrs[]>(),
  /** What the LAIS "editing done" endpoint received, and the answers it gives (then 200). */
  webhook: { calls: [] as Array<{ headers: Headers; body: Record<string, any> }>, answers: [] as Array<{ status: number; body?: unknown } | "timeout"> },
  versions: [] as FakeVersion[],
  branchVersioned: true,
  failNextApplyEdits: false,
  expireTokenOnce: false,
  refuseLicense: false,
  /** Reconcile finds conflicts (nothing is posted). */
  reconcileConflict: false,
  /** Another session holds the version (startEditing refused). */
  versionLocked: false,
  /** DEFAULT parcels posted after the versions' last reconcile: versions do not see them. */
  hiddenFromVersions: new Set<number>(),
  tokenSerial: 0,
  reset() {
    this.calls = [];
    this.plots = new Map([
      [1, { objectid: 1, name: "1/02/13/02/1001" }],
      [2, { objectid: 2, name: "1/02/13/02/2002" }],
      [3, { objectid: 3, name: "1/02/13/02/2002" }],
      [4, { objectid: 4, name: "1/02/13/02/3003" }],
      // historic parcels (retired by a merge or subdivision) keep their UPI as history
      [5, { objectid: 5, name: "1/02/13/02/4004", retiredbyrecord: "{MERGE-RECORD}" }],
      [6, { objectid: 6, name: "1/02/13/02/1001", retiredbyrecord: "{OLD-RECORD}" }],
      // 7 replaced 5 (created by the record that retired 5, covering it)
      [7, { objectid: 7, name: "1/02/13/02/7007", createdbyrecord: "{MERGE-RECORD}" }],
      [8, { objectid: 8, name: "1/02/13/02/8008" }],
      [9, { objectid: 9, name: "1/02/13/02/9009" }],
      [10, { objectid: 10, name: "1/02/13/02/1010" }],
    ]);
    this.records = [];
    this.versionRecords = new Map();
    this.webhook = { calls: [], answers: [] };
    this.versions = [];
    this.branchVersioned = true;
    this.failNextApplyEdits = false;
    this.expireTokenOnce = false;
    this.refuseLicense = false;
    this.reconcileConflict = false;
    this.versionLocked = false;
    this.hiddenFromVersions = new Set();
  },
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function viewOf(gdbVersion?: string): Map<number, Attrs> {
  const view = new Map([...fake.plots].map(([k, v]) => [k, { ...v }]));
  if (gdbVersion) {
    const v = fake.versions.find((x) => x.name === gdbVersion);
    if (!v) throw new Error(`unknown version ${gdbVersion}`);
    for (const oid of fake.hiddenFromVersions) view.delete(oid);
    for (const [oid, a] of v.saved) view.set(oid, { ...view.get(oid), ...a });
  }
  return view;
}

/**
 * Parcel shapes as rectangles [xmin, ymin, xmax, ymax]:
 *   10 (corner)
 *    1  4  9      1–4 and 4–9 share sides; 10 touches 1 only at a corner
 *   8 far away; 2 and 3 elsewhere; 5 (historic) inside 7
 */
type Box = [number, number, number, number];
const BOXES: Record<number, Box> = {
  1: [0, 0, 10, 10], 4: [10, 0, 20, 10], 9: [20, 0, 30, 10], 10: [10, 10, 20, 20],
  8: [100, 100, 110, 110], 2: [300, 0, 310, 10], 3: [320, 0, 330, 10],
  5: [200, 0, 210, 10], 6: [0, 0, 10, 10], 7: [200, 0, 220, 10],
  // parcels the completion tests "post": 11+12 split 1; 13 is 1+4 merged; 14 a new plot far away
  11: [0, 0, 5, 10], 12: [5, 0, 10, 10], 13: [0, 0, 20, 10], 14: [500, 500, 510, 510],
};
const ringsOf = ([x0, y0, x1, y1]: Box) => ({ rings: [[[x0, y0], [x0, y1], [x1, y1], [x1, y0], [x0, y0]]] });
const boxOf = (ring: number[][]): Box => [Math.min(...ring.map((p) => p[0]!)), Math.min(...ring.map((p) => p[1]!)), Math.max(...ring.map((p) => p[0]!)), Math.max(...ring.map((p) => p[1]!))];
/** The two DE-9IM relations the API uses, for rectangles. */
function relates(a: Box, b: Box, relation: string): boolean {
  const overlapX = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  const overlapY = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  if (relation === "T********") return overlapX > 0 && overlapY > 0;
  if (relation === "F***1****") return (overlapX === 0 && overlapY > 0) || (overlapY === 0 && overlapX > 0); // a shared side, not a corner
  throw new Error(`fake: unsupported relation ${relation}`);
}

function where(clause: string): (a: Attrs) => boolean {
  const alternatives = clause.split(" OR ").map(conjunction);
  return (a) => alternatives.some((t) => t(a));
}
function conjunction(clause: string): (a: Attrs) => boolean {
  const tests = clause.split(" AND ").map((part) => {
    const upperIn = /^UPPER\((\w+)\) IN \((.*)\)$/.exec(part);
    if (upperIn) {
      const values = [...upperIn[2]!.matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1]!.replace(/''/g, "'"));
      return (a: Attrs) => values.includes(String(a[upperIn[1]!] ?? "").toUpperCase());
    }
    const upperEq = /^UPPER\((\w+)\) = '((?:[^']|'')*)'$/.exec(part);
    if (upperEq) return (a: Attrs) => String(a[upperEq[1]!] ?? "").toUpperCase() === upperEq[2]!.replace(/''/g, "'");
    const like = /^(\w+) LIKE '((?:[^']|'')*)'$/.exec(part);
    if (like) {
      const pattern = new RegExp(`^${like[2]!.replace(/''/g, "'").replace(/[.*+?^${}()|[\]\\/]/g, "\\$&").replace(/%/g, ".*")}$`);
      return (a: Attrs) => pattern.test(String(a[like[1]!] ?? ""));
    }
    const notIn = /^(\w+) NOT IN \((.*)\)$/.exec(part);
    if (notIn) {
      const values = [...notIn[2]!.matchAll(/'((?:[^']|'')*)'|(-?\d+)/g)].map((m) => (m[1] !== undefined ? m[1].replace(/''/g, "'") : Number(m[2])));
      return (a: Attrs) => !values.includes(a[notIn[1]!] as never);
    }
    const eq = /^(\w+) = '((?:[^']|'')*)'$/.exec(part);
    if (eq) return (a: Attrs) => a[eq[1]!] === eq[2]!.replace(/''/g, "'");
    const isNull = /^(\w+) IS (NOT )?NULL$/.exec(part);
    if (isNull) return (a: Attrs) => (a[isNull[1]!] == null) !== !!isNull[2];
    const inList = /^(\w+) IN \((.*)\)$/.exec(part);
    if (inList) {
      const values = [...inList[2]!.matchAll(/'((?:[^']|'')*)'|(-?\d+)/g)].map((m) => (m[1] !== undefined ? m[1].replace(/''/g, "'") : Number(m[2])));
      return (a: Attrs) => values.includes(a[inList[1]!] as never);
    }
    throw new Error(`unsupported where: ${clause}`);
  });
  return (a) => tests.every((t) => t(a));
}

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url === WEBHOOK) {
    fake.webhook.calls.push({ headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
    const answer = fake.webhook.answers.shift() ?? { status: 200, body: { received: true } };
    if (answer === "timeout") throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    return json(answer.body ?? {}, answer.status);
  }
  if (!url.startsWith("https://fake-gis.test")) return realFetch(input, init);
  const params = Object.fromEntries(new URLSearchParams(String(init?.body ?? "")));
  const headers = new Headers(init?.headers);
  fake.calls.push({ url, params, referer: headers.get("referer") });

  if (url === `${PORTAL}/sharing/rest/community/self`) {
    // Web-app users: "editor-*" tokens can edit features; anything else is a viewer.
    const editor = params.token?.startsWith("editor-");
    return json({ username: editor ? "editor.one" : "viewer.one", fullName: "Test User", role: "org_user", privileges: editor ? ["features:user:edit"] : [] });
  }
  if (url === `${PORTAL}/sharing/rest/generateToken`) {
    return json({ token: `tok-${++fake.tokenSerial}`, expires: Date.now() + 30 * 60_000 });
  }
  if (fake.expireTokenOnce) {
    fake.expireTokenOnce = false;
    return json({ error: { code: 498, message: "Invalid token." } });
  }
  if (url === PLOT) {
    return json({
      name: "Plot", isDataBranchVersioned: fake.branchVersioned, objectIdField: "objectid", globalIdField: "globalid", fields: FIELDS,
      editFieldsInfo: { editDateField: "last_edited_date" },
      relationships: [{ keyField: "CreatedByRecord", relatedTableId: 2 }],
    });
  }
  if (url === RECORDS) return json({ name: "Records", objectIdField: "objectid", globalIdField: "globalid", fields: RECORD_FIELDS });
  if (url === `${RECORDS}/query`) {
    const visible = [...fake.records, ...(params.gdbVersion ? (fake.versionRecords.get(params.gdbVersion) ?? []) : [])];
    return json({ features: visible.filter(where(params.where!)).map((attributes) => ({ attributes })) });
  }
  if (url === `${PLOT}/query`) {
    if (Number(params.resultOffset ?? 0) > 0) return json({ features: [] }); // the fake answers in one page
    const match = where(params.where!);
    let rows = [...viewOf(params.gdbVersion).values()].filter(match);
    if (params.spatialRel === "esriSpatialRelRelation") {
      const shape = boxOf(JSON.parse(params.geometry!).rings[0]);
      rows = rows.filter((r) => relates(shape, BOXES[r.objectid as number]!, params.relationParam!));
    }
    if (params.returnCountOnly === "true") return json({ count: rows.length });
    const geometry = params.returnGeometry === "true";
    const features = rows.map((attributes) => ({ attributes, ...(geometry ? { geometry: ringsOf(BOXES[attributes.objectid as number]!) } : {}) }));
    return json({ features, ...(geometry ? { spatialReference: { wkid: 32735 } } : {}) });
  }
  if (url === `${VMS}/versionInfos`) {
    return json({ versions: fake.versions.filter((v) => v.name.startsWith(`${params.ownerFilter}.`)).map((v) => ({ versionName: v.name, versionGuid: v.guid, access: v.access })) });
  }
  if (url === `${VMS}/create`) {
    const name = `${OWNER}.${params.versionName}`;
    if (fake.versions.some((v) => v.name.toLowerCase() === name.toLowerCase())) return json({ error: { code: 500, message: "Version already exists" } });
    const v: FakeVersion = { name, guid: `{${crypto.randomUUID().toUpperCase()}}`, access: params.accessPermission!, saved: new Map(), pending: null };
    fake.versions.push(v);
    return json({ success: true, versionInfo: { versionName: v.name, versionGuid: v.guid, access: v.access } });
  }
  const vm = /\/versions\/([^/]+)\/(startReading|startEditing|stopEditing|stopReading|reconcile)$/.exec(url);
  if (vm) {
    const v = fake.versions.find((x) => x.guid.replace(/[{}]/g, "") === vm[1]);
    if (!v) return json({ error: { code: 404, message: "no such version" } });
    if (vm[2] === "startEditing" && fake.refuseLicense) {
      return json({ error: { code: 500, message: "Unable to complete operation.", details: ["Error: You cannot edit as you have not been assigned required user type extensions: [Advanced Editing]."] } });
    }
    if (vm[2] === "startEditing" && fake.versionLocked) {
      return json({ error: { code: 500, message: "Unable to complete operation.", details: ["The version is locked by another user."] } });
    }
    if (vm[2] === "reconcile") {
      if (!v.pending) return json({ error: { code: 400, message: "reconcile needs an edit session" } });
      if (fake.reconcileConflict) return json({ success: true, hasConflicts: true, didPost: false });
      if (params.withPost === "true") {
        // Post: the version's saved edits and its records reach DEFAULT.
        for (const [oid, a] of v.saved) fake.plots.set(oid, { ...fake.plots.get(oid), ...a });
        fake.records.push(...(fake.versionRecords.get(v.name) ?? []));
        fake.versionRecords.delete(v.name);
        v.saved = new Map();
      }
      return json({ success: true, hasConflicts: false, didPost: params.withPost === "true", moment: Date.now() });
    }
    if (vm[2] === "startEditing") v.pending = new Map();
    if (vm[2] === "stopEditing") {
      if (params.saveEdits === "true") for (const [k, a] of v.pending ?? []) v.saved.set(k, { ...v.saved.get(k), ...a });
      v.pending = null;
    }
    return json({ success: true });
  }
  if (url === `${PLOT}/applyEdits`) {
    if (!params.gdbVersion) return json({ error: { code: 400, message: "TEST GUARD: applyEdits without gdbVersion would edit DEFAULT" } });
    const v = fake.versions.find((x) => x.name === params.gdbVersion);
    if (!v?.pending) return json({ error: { code: 400, message: "not in an edit session" } });
    if (fake.failNextApplyEdits) {
      fake.failNextApplyEdits = false;
      return json({ updateResults: [{ success: false, error: { description: "simulated failure" } }] });
    }
    for (const u of JSON.parse(params.updates!) as Array<{ attributes: Attrs }>) v.pending.set(Number(u.attributes.objectid), u.attributes);
    return json({ updateResults: JSON.parse(params.updates!).map(() => ({ success: true })) });
  }
  return json({ error: { code: 404, message: `fake: no handler for ${url}` } });
}) as typeof fetch;

// ------------------------------------------------------------------ app under test

let server: Server;
let base = "";
let resetLais: () => Promise<void>;
// Each test is its own client (the API trusts X-Forwarded-For from localhost), so the per-client rate limit is per test.
let clientIp = "10.0.0.1";
let clientNo = 1;
const client = () => ({ "X-Forwarded-For": clientIp });
let resetToken: () => void;
let cfg: {
  LAIS_WRITE_MODE: "version-only" | "attributes";
  LAIS_API_KEY_PREVIOUS: string;
  LAIS_EDITING_DONE: "true" | "false";
  LAIS_WEBHOOK_URL: string;
  LAIS_WEBHOOK_KEY: string;
};

before(async () => {
  const { createApp } = await import("../src/app.js");
  ({ config: cfg } = await import("../src/config/env.js"));
  ({ resetLaisCachesForTests: resetLais } = await import("../src/lais/laisService.js"));
  ({ resetServiceTokenForTests: resetToken } = await import("../src/lais/arcgisClient.js"));
  server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/lais`;
});
after(() => {
  server?.close();
  rmSync(auditDir, { recursive: true, force: true });
});
// Most suites exercise the full "attributes" mode; the "version-only" suite switches to the default mode.
beforeEach(async () => {
  fake.reset();
  await resetLais();
  resetToken();
  cfg.LAIS_WRITE_MODE = "attributes";
  cfg.LAIS_API_KEY_PREVIOUS = "";
  cfg.LAIS_EDITING_DONE = "false";
  cfg.LAIS_WEBHOOK_URL = WEBHOOK;
  cfg.LAIS_WEBHOOK_KEY = WEBHOOK_KEY;
  clientIp = `10.0.${Math.floor(++clientNo / 250)}.${clientNo % 250}`;
});

const valid = { UPI: "1/02/13/02/1001", Transaction_ID: "LAIS-SUB-2026-00125", Transaction_Type: "Subdivision", Transaction_Date: "2026-11-24T08:30:00+02:00" };

async function submit(body: unknown, headers: Record<string, string> = { "x-api-key": KEY }) {
  const res = await fetch(`${base}/transactions`, { method: "POST", headers: { "Content-Type": "application/json", ...client(), ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}
const codes = (body: Record<string, any>) => (body.errors as Array<{ code: string }>).map((e) => e.code);
const gisCalls = (suffix: string) => fake.calls.filter((c) => c.url.endsWith(suffix));

// ------------------------------------------------------------------ tests

describe("version name {TYPE}-{CASE_NUMBER}-{DATE}", () => {
  test("type code, case number and transaction date", async () => {
    const { versionNameFor } = await import("../src/lais/laisService.js");
    const at = "2026-11-25T10:00:00+02:00";
    assert.equal(versionNameFor({ Transaction_ID: "CASE123", Transaction_Type: "Subdivision", Transaction_Date: at }), "SUBV-CASE123-20261125");
    assert.equal(versionNameFor({ Transaction_ID: "CASE456", Transaction_Type: "Merge", Transaction_Date: at }), "MERG-CASE456-20261125");
    assert.equal(versionNameFor({ Transaction_ID: "CASE789", Transaction_Type: "CorrectBoundaries", Transaction_Date: at }), "CORB-CASE789-20261125");
    assert.equal(versionNameFor({ Transaction_ID: "CASE000", Transaction_Type: "CreatePlot", Transaction_Date: at }), "CRPL-CASE000-20261125");
    // the date is the one LAIS wrote, not shifted to UTC
    assert.equal(versionNameFor({ Transaction_ID: "C1", Transaction_Type: "Merge", Transaction_Date: "2026-11-25T00:30:00+02:00" }), "MERG-C1-20261125");
  });
  test("unsafe characters become '-', and the name never exceeds 62 characters", async () => {
    const { versionNameFor } = await import("../src/lais/laisService.js");
    assert.equal(versionNameFor({ Transaction_ID: "RW/2026:0012.A", Transaction_Type: "Subdivision", Transaction_Date: "2026-11-25T10:00:00Z" }), "SUBV-RW-2026-0012-A-20261125");
    const long = versionNameFor({ Transaction_ID: "X".repeat(50), Transaction_Type: "Subdivision", Transaction_Date: "2026-11-25T10:00:00Z" });
    assert.equal(long.length, 62);
    assert.match(long, /^SUBV-X+-20261125$/);
  });
});

describe("authentication", () => {
  test("missing or wrong key → 401 in LAIS shape, no GIS calls", async () => {
    for (const headers of [{}, { "x-api-key": "wrong" }, { Authorization: `Bearer ${KEY}` }]) {
      const r = await submit(valid, headers);
      assert.equal(r.status, 401);
      assert.equal(r.body.success, false);
      assert.equal(r.body.case, "No");
      assert.deepEqual(codes(r.body), ["UNAUTHORIZED"]);
    }
    assert.equal(fake.calls.length, 0);
  });
});

describe("validation (no GIS calls)", () => {
  test("missing fields → REQUIRED_FIELD per field", async () => {
    const r = await submit({});
    assert.equal(r.status, 422);
    // UPI can only be required once the type is known (a CreatePlot may have none)
    assert.deepEqual(r.body.errors.map((e: any) => e.field).sort(), ["Transaction_Date", "Transaction_ID", "Transaction_Type"]);
    assert.ok(codes(r.body).every((c) => c === "REQUIRED_FIELD"));
  });
  test("case or unknown fields are rejected", async () => {
    const r = await submit({ ...valid, case: "Yes", extra: 1 });
    assert.equal(r.status, 422);
    assert.deepEqual(codes(r.body), ["UNKNOWN_FIELD", "UNKNOWN_FIELD"]);
  });
  test("bad type, status, UPI, date, length", async () => {
    const r = await submit({ UPI: "1/02/13/02/" + "1".repeat(95), Transaction_ID: "X1", Transaction_Type: "Sell", Transaction_Date: "2026-02-30T08:30:00+02:00", Transaction_Status: "Done" });
    assert.equal(r.status, 422);
    assert.deepEqual(codes(r.body).sort(), ["INVALID_DATE", "INVALID_TRANSACTION_STATUS", "INVALID_TRANSACTION_TYPE", "TOO_LONG"]);
    assert.equal(fake.calls.length, 0);
  });
  test("wrong JSON types → INVALID_TYPE; date without timezone → INVALID_DATE", async () => {
    let r = await submit({ ...valid, UPI: 5 });
    assert.deepEqual(codes(r.body), ["INVALID_TYPE"]);
    r = await submit({ ...valid, Transaction_Date: "2026-11-24T08:30:00" });
    assert.deepEqual(codes(r.body), ["INVALID_DATE"]);
  });
  test("malformed JSON → 400, oversized body → 413, both in LAIS shape", async () => {
    let r = await submit("{bad");
    assert.equal(r.status, 400);
    assert.deepEqual(codes(r.body), ["INVALID_JSON"]);
    r = await submit({ UPI: "a".repeat(300_000) });
    assert.equal(r.status, 413);
    assert.deepEqual(codes(r.body), ["PAYLOAD_TOO_LARGE"]);
  });
});

describe("parcel lookup", () => {
  test("unknown UPI → 422 PARCEL_NOT_FOUND, no version created", async () => {
    const r = await submit({ ...valid, UPI: "1/02/13/02/9999" });
    assert.equal(r.status, 422);
    assert.deepEqual(codes(r.body), ["PARCEL_NOT_FOUND"]);
    assert.equal(gisCalls("/create").length, 0);
  });
  test("UPI of a historic (merged/subdivided) parcel → 422 UPI_EXPIRED, no version created", async () => {
    const r = await submit({ ...valid, UPI: "1/02/13/02/4004" });
    assert.equal(r.status, 422);
    assert.deepEqual(codes(r.body), ["UPI_EXPIRED"]);
    assert.equal(gisCalls("/create").length, 0);
  });
  test("a historic parcel sharing a current parcel's UPI is ignored: the current parcel is used", async () => {
    const r = await submit(valid);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(JSON.parse(gisCalls("/applyEdits")[0]!.params.updates!)[0].attributes.objectid, 1);
  });
  test("duplicated UPI in GIS → 422 UPI_NOT_UNIQUE", async () => {
    const r = await submit({ ...valid, UPI: "1/02/13/02/2002" });
    assert.deepEqual(codes(r.body), ["UPI_NOT_UNIQUE"]);
    assert.equal(gisCalls("/create").length, 0);
  });
});

describe("successful submission", () => {
  test("creates a PUBLIC version and records the fields on that Plot inside it — never in DEFAULT", async () => {
    const r = await submit({ ...valid, Transaction_Type: "subdivision", Transaction_Status: "new" });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.success, true);
    assert.equal(r.body.case, "Yes");
    assert.equal(r.body.data.Transaction_Type, "Subdivision");
    assert.equal(r.body.data.Transaction_Status, "New");
    assert.equal(r.body.data.version_status, "VersionCreated");
    assert.equal(r.body.data.version_name, "svc_lais.SUBV-LAIS-SUB-2026-00125-20261124");
    assert.equal(r.body.data.stage, "InReview");

    const [create] = gisCalls("/create");
    assert.equal(create!.params.accessPermission, "public");
    const [edit] = gisCalls("/applyEdits");
    assert.equal(edit!.params.gdbVersion, r.body.data.version_name);
    assert.ok(edit!.params.sessionID, "applyEdits must carry the edit session id");
    const update = JSON.parse(edit!.params.updates!)[0].attributes;
    assert.deepEqual(
      { ...update, transaction_date: typeof update.transaction_date },
      { objectid: 1, transaction_id: valid.Transaction_ID, transaction_type: "Subdivision", transaction_status: "New", transaction_date: "number", case_: "Yes", validation_message: "Validated by the LAIS integration API", version_status: "VersionCreated", version_name: r.body.data.version_name },
    );
    assert.equal(update.transaction_date, Date.parse(valid.Transaction_Date));
    assert.equal(JSON.parse(edit!.params.updates!).length, 1);

    const order = fake.calls.map((c) => c.url.split("/").pop()).filter((s) => /^(startReading|startEditing|applyEdits|stopEditing|stopReading)$/.test(s!));
    assert.deepEqual(order, ["startReading", "startEditing", "applyEdits", "stopEditing", "stopReading"]);
    assert.equal(gisCalls("/stopEditing")[0]!.params.saveEdits, "true");
    assert.equal(fake.plots.get(1)!.transaction_id, undefined, "DEFAULT must be untouched");
    assert.ok(fake.calls.every((c) => c.referer === `${REFERER}/`), "every ArcGIS call must send the token's Referer");
  });

  test("Transaction_Status is optional and then not written", async () => {
    const r = await submit(valid);
    assert.equal(r.status, 201);
    const update = JSON.parse(gisCalls("/applyEdits")[0]!.params.updates!)[0].attributes;
    assert.equal("transaction_status" in update, false);
  });

  test("identical retry → 409 ALREADY_RECORDED with the transaction in data, no new version or edit", async () => {
    await submit(valid);
    fake.calls = [];
    const r = await submit(valid);
    assert.equal(r.status, 409);
    assert.equal(r.body.success, false);
    assert.equal(r.body.case, "No");
    assert.deepEqual(codes(r.body), ["ALREADY_RECORDED"]);
    assert.equal(r.body.data.Transaction_ID, valid.Transaction_ID);
    assert.equal(r.body.data.stage, "InReview");
    assert.equal(gisCalls("/create").length + gisCalls("/applyEdits").length, 0);
  });

  test("same Transaction_ID with a different payload → 409", async () => {
    await submit(valid);
    const r = await submit({ ...valid, UPI: "1/02/13/02/3003" });
    assert.equal(r.status, 409);
    assert.deepEqual(codes(r.body), ["DUPLICATE_TRANSACTION_ID"]);
  });

  test("concurrent identical submissions create one version", async () => {
    const results = await Promise.all([submit(valid), submit(valid), submit(valid)]);
    assert.deepEqual(results.map((r) => r.status).sort(), [201, 409, 409]);
    assert.equal(fake.versions.length, 1);
  });

  test("Transaction_ID already posted to DEFAULT → duplicate (posted) or conflict", async () => {
    Object.assign(fake.plots.get(1)!, { transaction_id: "POSTED-1", transaction_type: "CorrectBoundaries", transaction_date: Date.parse(valid.Transaction_Date), case_: "Yes" });
    let r = await submit({ ...valid, Transaction_ID: "POSTED-1", Transaction_Type: "CorrectBoundaries" });
    assert.equal(r.status, 409);
    assert.deepEqual(codes(r.body), ["ALREADY_RECORDED"]);
    assert.equal(r.body.data.stage, "Posted");
    r = await submit({ ...valid, Transaction_ID: "POSTED-1" });
    assert.equal(r.status, 409);
    assert.equal(fake.versions.length, 0);
  });
});

describe("failure handling", () => {
  test("failed edit discards the session (saveEdits=false), returns 502; retry reuses the version", async () => {
    fake.failNextApplyEdits = true;
    let r = await submit(valid);
    assert.equal(r.status, 502);
    assert.equal(r.body.case, "No");
    assert.deepEqual(codes(r.body), ["GIS_UNAVAILABLE"]);
    assert.equal(gisCalls("/stopEditing")[0]!.params.saveEdits, "false");
    assert.equal(gisCalls("/stopReading").length, 1);
    assert.equal(fake.versions.length, 1);

    r = await submit(valid);
    assert.equal(r.status, 201);
    assert.equal(fake.versions.length, 1, "retry must reuse the orphaned version");
    assert.equal(gisCalls("/create").length, 1);
  });

  test("expired token → refreshed once and the request succeeds", async () => {
    await submit({ ...valid, UPI: "1/02/13/02/9999" }); // primes the token cache
    fake.expireTokenOnce = true;
    const r = await submit(valid);
    assert.equal(r.status, 201);
  });

  test("account lacks the Advanced Editing licence → 503 (not retryable 502), DEFAULT untouched", async () => {
    fake.refuseLicense = true;
    const r = await submit(valid);
    assert.equal(r.status, 503);
    assert.deepEqual(codes(r.body), ["GIS_NOT_CONFIGURED"]);
    assert.equal(gisCalls("/applyEdits").length, 0);
    assert.equal(gisCalls("/stopReading").length, 1, "read lock must be released");
    assert.equal(fake.plots.get(1)!.transaction_id, undefined);
  });

  test("layer not branch versioned → 503, nothing created", async () => {
    fake.branchVersioned = false;
    const r = await submit(valid);
    assert.equal(r.status, 503);
    assert.deepEqual(codes(r.body), ["GIS_NOT_CONFIGURED"]);
    assert.equal(gisCalls("/create").length, 0);
  });
});

describe("version-only mode (default: LAIS account can read and create versions, not edit)", () => {
  beforeEach(() => {
    cfg.LAIS_WRITE_MODE = "version-only";
  });
  const editCalls = () => fake.calls.filter((c) => /\/(startEditing|applyEdits|stopEditing)$/.test(c.url));
  const status = async (id: string) => {
    const res = await fetch(`${base}/transactions/${encodeURIComponent(id)}`, { headers: { "x-api-key": KEY, ...client() } });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };

  test("creates the public version and makes no edit calls at all", async () => {
    fake.refuseLicense = true; // an unlicensed account must still work in this mode
    const r = await submit(valid);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.case, "Yes");
    assert.equal(r.body.data.version_status, "VersionCreated");
    assert.match(r.body.data.version_name, /^svc_lais\.SUBV-LAIS-SUB-2026-00125-20261124$/);
    assert.equal(gisCalls("/create")[0]!.params.accessPermission, "public");
    assert.deepEqual(editCalls(), []);
    assert.equal(fake.plots.get(1)!.transaction_id, undefined, "DEFAULT must be untouched");
    assert.ok(fake.calls.every((c) => c.referer === `${REFERER}/`));
  });

  test("identical retry → 409 ALREADY_RECORDED, different payload → 409, status → InReview", async () => {
    await submit(valid);
    let r = await submit(valid);
    assert.equal(r.status, 409);
    assert.deepEqual(codes(r.body), ["ALREADY_RECORDED"]);
    r = await submit({ ...valid, Transaction_Type: "CorrectBoundaries" });
    assert.equal(r.status, 409);
    const s = await status(valid.Transaction_ID);
    assert.equal(s.status, 200);
    assert.equal(s.body.data.stage, "InReview");
    assert.equal(s.body.data.UPI, valid.UPI);
    assert.equal(fake.versions.length, 1);
  });

  test("after GIS removes the version: status Closed, resubmission does not recreate it", async () => {
    await submit(valid);
    fake.versions = [];
    const s = await status(valid.Transaction_ID);
    assert.equal(s.body.data.stage, "Closed");
    const r = await submit(valid);
    assert.equal(r.status, 409);
    assert.deepEqual(codes(r.body), ["ALREADY_RECORDED"]);
    assert.equal(r.body.data.stage, "Closed");
    assert.equal(fake.versions.length, 0);
  });

  test("a version that exists without an API record is not adopted silently → 409", async () => {
    fake.versions.push({ name: `${OWNER}.${(await import("../src/lais/laisService.js")).versionNameFor(valid)}`, guid: "{00000000-0000-0000-0000-000000000001}", access: "public", saved: new Map(), pending: null });
    const r = await submit(valid);
    assert.equal(r.status, 409);
  });

  test("version creation failure → 502; retry completes with one version", async () => {
    const original = globalThis.fetch;
    let failed = false;
    globalThis.fetch = (async (input: any, init?: any) => {
      if (!failed && String(input).endsWith("/VersionManagementServer/create")) {
        failed = true;
        return new Response(JSON.stringify({ error: { code: 500, message: "simulated outage" } }), { status: 200 });
      }
      return original(input, init);
    }) as typeof fetch;
    try {
      let r = await submit(valid);
      assert.equal(r.status, 502);
      r = await submit(valid);
      assert.equal(r.status, 201);
      assert.equal(fake.versions.length, 1);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("several parcels: UPIs (Merge, CorrectBoundaries, CreatePlot)", () => {
  const merge = { UPIs: ["1/02/13/02/1001", "1/02/13/02/3003"], Transaction_ID: "MRG-1", Transaction_Type: "Merge", Transaction_Date: "2026-11-25T10:00:00+02:00" };
  const field = (body: Record<string, any>) => body.errors.map((e: any) => `${e.field}:${e.code}`);

  test("Merge of neighbouring parcels → 201: one MERG version, the transaction on every parcel", async () => {
    const r = await submit(merge);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual(r.body.data.UPIs, merge.UPIs);
    assert.equal(r.body.data.UPI, merge.UPIs[0]);
    assert.equal(r.body.data.version_name, "svc_lais.MERG-MRG-1-20261125");
    assert.match(gisCalls("/create")[0]!.params.description!, /^LAIS Merge UPI 1\/02\/13\/02\/1001 \+1 MRG-1/);
    const updates = JSON.parse(gisCalls("/applyEdits")[0]!.params.updates!).map((u: any) => u.attributes);
    assert.deepEqual(updates.map((a: any) => a.objectid).sort(), [1, 4]);
    assert.ok(updates.every((a: any) => a.transaction_id === "MRG-1" && a.transaction_type === "Merge" && a.case_ === "Yes"));
  });

  test("a chain of neighbours (1–4–9) is one connected group", async () => {
    const r = await submit({ ...merge, UPIs: ["1/02/13/02/1001", "1/02/13/02/3003", "1/02/13/02/9009"] });
    assert.equal(r.status, 201, JSON.stringify(r.body));
  });

  test("Merge of parcels that are not neighbours → 422 NOT_NEIGHBOURS, nothing created", async () => {
    for (const UPIs of [
      ["1/02/13/02/1001", "1/02/13/02/9009"], // apart
      ["1/02/13/02/1001", "1/02/13/02/1010"], // corner only
      ["1/02/13/02/1001", "1/02/13/02/3003", "1/02/13/02/8008"], // not one group
    ]) {
      const r = await submit({ ...merge, UPIs });
      assert.equal(r.status, 422, JSON.stringify(r.body));
      assert.deepEqual(field(r.body), ["UPIs:NOT_NEIGHBOURS"]);
    }
    const group = await submit({ ...merge, UPIs: ["1/02/13/02/1001", "1/02/13/02/3003", "1/02/13/02/8008"] });
    assert.match(group.body.errors[0].message, /not one connected group/);
    assert.equal(gisCalls("/create").length, 0);
  });

  test("parcel counts per type: Merge ≥ 2, Subdivision exactly 1, CorrectBoundaries ≥ 1", async () => {
    let r = await submit({ ...merge, UPIs: ["1/02/13/02/1001"] });
    assert.deepEqual(field(r.body), ["UPIs:MERGE_NEEDS_TWO_UPIS"]);
    r = await submit({ ...valid, Transaction_Type: "Merge" });
    assert.deepEqual(field(r.body), ["UPIs:MERGE_NEEDS_TWO_UPIS"]);
    r = await submit({ ...merge, Transaction_Type: "Subdivision" });
    assert.deepEqual(field(r.body), ["UPIs:SUBDIVISION_NEEDS_ONE_UPI"]);
    const { UPI: _u, ...noUpi } = valid;
    r = await submit(noUpi);
    assert.deepEqual(field(r.body), ["UPI:SUBDIVISION_NEEDS_ONE_UPI"]);
    r = await submit({ ...noUpi, Transaction_Type: "CorrectBoundaries" });
    assert.deepEqual(field(r.body), ["UPI:REQUIRED_FIELD"]);
    assert.equal(fake.calls.length, 0);
  });

  test("UPIs list rules: not both UPI and UPIs, strings in the right format, no repeats", async () => {
    let r = await submit({ ...merge, UPI: "1/02/13/02/1001" });
    assert.deepEqual(field(r.body), ["UPIs:CONFLICTING_FIELDS"]);
    r = await submit({ ...merge, UPIs: ["1/02/13/02/1001", "1/02/13/02/1001"] });
    assert.deepEqual(field(r.body), ["UPIs[1]:DUPLICATE_UPI"]);
    r = await submit({ ...merge, UPIs: ["1/02/13/02/1001", "bad", 7] });
    assert.deepEqual(field(r.body), ["UPIs[1]:INVALID_UPI_FORMAT", "UPIs[2]:INVALID_TYPE"]);
    r = await submit({ ...merge, UPIs: "1/02/13/02/1001" });
    assert.deepEqual(field(r.body), ["UPIs:INVALID_TYPE"]);
  });

  test("an expired UPI in the list names its position and the current UPI that replaced it", async () => {
    const r = await submit({ ...merge, UPIs: ["1/02/13/02/1001", "1/02/13/02/4004"] });
    assert.equal(r.status, 422);
    assert.deepEqual(field(r.body), ["UPIs[1]:UPI_EXPIRED"]);
    assert.deepEqual(r.body.errors[0].replacedBy, ["1/02/13/02/7007"]);
    assert.match(r.body.errors[0].message, /It is now 1\/02\/13\/02\/7007/);
  });

  test("resending the same Merge (UPIs in any order) → 409 ALREADY_RECORDED; other UPIs → 409", async () => {
    await submit(merge);
    let r = await submit({ ...merge, UPIs: [...merge.UPIs].reverse() });
    assert.equal(r.status, 409);
    assert.deepEqual(codes(r.body), ["ALREADY_RECORDED"]);
    r = await submit({ ...merge, UPIs: ["1/02/13/02/3003", "1/02/13/02/9009"] });
    assert.equal(r.status, 409);
  });

  test("CreatePlot without a parent parcel → 201, a CRPL version and no Plot edits", async () => {
    const r = await submit({ Transaction_ID: "NEW-1", Transaction_Type: "CreatePlot", Transaction_Date: "2026-11-25T10:00:00Z" });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual(r.body.data.UPIs, []);
    assert.equal(r.body.data.version_name, "svc_lais.CRPL-NEW-1-20261125");
    assert.match(gisCalls("/create")[0]!.params.description!, /new plot/);
    assert.equal(gisCalls("/applyEdits").length, 0);
  });
});

describe("one open transaction per UPI", () => {
  beforeEach(() => {
    cfg.LAIS_WRITE_MODE = "version-only";
  });
  const other = { ...valid, Transaction_ID: "LAIS-COR-2026-00200", Transaction_Type: "CorrectBoundaries" };

  test("a new Transaction_ID on a UPI that GIS has not finished → 409 UPI_IN_TRANSACTION, nothing created", async () => {
    assert.equal((await submit(valid)).status, 201);
    const r = await submit(other);
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.success, false);
    assert.deepEqual(r.body.errors.map((e: any) => `${e.field}:${e.code}:${e.transactionId}`), [`UPI:UPI_IN_TRANSACTION:${valid.Transaction_ID}`]);
    assert.match(r.body.errors[0].message, /SUBV-LAIS-SUB-2026-00125-20261124/);
    assert.equal(fake.versions.length, 1);
    const s = await fetch(`${base}/transactions/${other.Transaction_ID}`, { headers: { "x-api-key": KEY, ...client() } });
    assert.equal(s.status, 404, "the refused transaction is not recorded");
  });

  test("a Merge naming a held parcel is refused at that parcel's position", async () => {
    await submit(valid);
    const r = await submit({ UPIs: ["1/02/13/02/3003", "1/02/13/02/1001"], Transaction_ID: "MRG-9", Transaction_Type: "Merge", Transaction_Date: "2026-11-25T10:00:00Z" });
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.deepEqual(r.body.errors.map((e: any) => `${e.field}:${e.code}`), ["UPIs[1]:UPI_IN_TRANSACTION"]);
  });

  test("once the holding version is removed (Closed), the UPI is free again", async () => {
    await submit(valid);
    fake.versions = [];
    const r = await submit(other);
    assert.equal(r.status, 201, JSON.stringify(r.body));
  });

  test("once the holding transaction is posted (version kept), the UPI is free again", async () => {
    await submit(other);
    fake.records.push({ globalid: "{COR-REC-2}", name: "CORB-LAIS-COR-2026-00200-20261124" });
    const r = await submit({ ...valid, Transaction_ID: "LAIS-COR-2026-00201", Transaction_Type: "CorrectBoundaries" });
    assert.equal(r.status, 201, JSON.stringify(r.body));
  });

  test("two new transactions on the same UPI at the same time: one 201, one 409", async () => {
    const results = await Promise.all([submit(valid), submit(other)]);
    assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
    assert.equal(fake.versions.length, 1);
  });

  test("a CreatePlot without parcels never conflicts", async () => {
    const plot = { Transaction_ID: "NEW-7", Transaction_Type: "CreatePlot", Transaction_Date: "2026-11-25T10:00:00Z" };
    assert.equal((await submit(plot)).status, 201);
    assert.equal((await submit({ ...plot, Transaction_ID: "NEW-8" })).status, 201);
  });
});

describe("Transaction_ID has no maximum length", () => {
  const longId = "CASE-" + "1234567890".repeat(12); // 125 characters
  test("a long Transaction_ID is accepted; the version name is shortened to 62 characters", async () => {
    cfg.LAIS_WRITE_MODE = "version-only";
    const r = await submit({ ...valid, Transaction_ID: longId });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.data.Transaction_ID, longId);
    const short = r.body.data.version_name.split(".").pop();
    assert.ok(short.length <= 62 && /^SUBV-CASE-1234567890.*-20261124$/.test(short), short);
    const s = await fetch(`${base}/transactions/${encodeURIComponent(longId)}`, { headers: { "x-api-key": KEY, ...client() } });
    assert.equal(s.status, 200);
  });
  test("attributes mode refuses an ID longer than the Plot's transaction_id field, before creating anything", async () => {
    const r = await submit({ ...valid, Transaction_ID: longId });
    assert.equal(r.status, 422);
    assert.deepEqual(codes(r.body), ["TOO_LONG_FOR_GIS"]);
    assert.equal(gisCalls("/create").length, 0);
  });
});

describe("API key change without downtime", () => {
  const OLD = "previous-lais-key-0123456789abcdef0123456789abcdef";
  test("the previous key works only while LAIS_API_KEY_PREVIOUS holds it; short keys never", async () => {
    let r = await submit({}, { "x-api-key": OLD });
    assert.equal(r.status, 401);
    cfg.LAIS_API_KEY_PREVIOUS = OLD;
    r = await submit({}, { "x-api-key": OLD });
    assert.equal(r.status, 422, "old key accepted during the change");
    r = await submit({}, { "x-api-key": KEY });
    assert.equal(r.status, 422, "new key accepted too");
    cfg.LAIS_API_KEY_PREVIOUS = "short";
    r = await submit({}, { "x-api-key": "short" });
    assert.equal(r.status, 401);
  });
});

describe("status endpoint", () => {
  test("returns the recorded transaction, or 404", async () => {
    await submit(valid);
    let res = await fetch(`${base}/transactions/${encodeURIComponent(valid.Transaction_ID)}`, { headers: { "x-api-key": KEY, ...client() } });
    let body = (await res.json()) as Record<string, any>;
    assert.equal(res.status, 200);
    assert.equal(body.data.UPI, valid.UPI);
    assert.equal(body.data.Transaction_Type, "Subdivision");
    assert.equal(body.data.case, "Yes");
    assert.equal(body.data.version_status, "VersionCreated");
    assert.equal(body.data.stage, "InReview");
    assert.equal(body.data.Transaction_Date, new Date(Date.parse(valid.Transaction_Date)).toISOString());

    res = await fetch(`${base}/transactions/UNKNOWN-1`, { headers: { "x-api-key": KEY, ...client() } });
    body = (await res.json()) as Record<string, any>;
    assert.equal(res.status, 404);
    assert.deepEqual(codes(body), ["NOT_FOUND"]);
  });
});

describe("completion: LAIS sees when GIS has posted the change, and the resulting parcels", () => {
  beforeEach(() => {
    cfg.LAIS_WRITE_MODE = "version-only"; // works without the editing licence
  });
  const get = async (pathAndQuery: string) => {
    const res = await fetch(`${base}${pathAndQuery}`, { headers: { "x-api-key": KEY, ...client() } });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  const status = (id: string) => get(`/transactions/${encodeURIComponent(id)}`);
  const EDITED = Date.parse("2026-11-26T09:15:00Z");
  /** What an editor's Subdivision of plot 1 looks like in DEFAULT after Reconcile & Post. */
  function postSubdivision(secondUpi: string | null) {
    Object.assign(fake.plots.get(1)!, { retiredbyrecord: "{SUB-REC}", last_edited_date: EDITED });
    fake.plots.set(11, { objectid: 11, name: "1/02/13/02/1101", createdbyrecord: "{SUB-REC}", size: 500.123, district: "Gasabo", last_edited_date: EDITED });
    fake.plots.set(12, { objectid: 12, name: secondUpi, createdbyrecord: "{SUB-REC}", size: 589.8, district: "Gasabo", last_edited_date: EDITED });
    fake.records.push({ globalid: "{SUB-REC}", name: "SUBV-LAIS-SUB-2026-00125-20261124", recordeddate: Date.parse("2026-11-26T00:00:00Z") });
  }

  test("not yet posted → InReview with no result", async () => {
    await submit(valid);
    const s = await status(valid.Transaction_ID);
    assert.equal(s.body.data.stage, "InReview");
    assert.equal(s.body.data.result, null);
    assert.deepEqual(s.body.data.warnings, []);
    assert.ok(s.body.data.updated_at);
  });

  test("Subdivision posted and its version deleted → Posted with the new parcels; UPI_MISSING until GIS assigns it", async () => {
    await submit(valid);
    postSubdivision(null);
    fake.versions = [];
    let s = await status(valid.Transaction_ID);
    assert.equal(s.status, 200, JSON.stringify(s.body));
    assert.equal(s.body.data.stage, "Posted");
    const result = s.body.data.result;
    assert.deepEqual(result.parcels.map((p: any) => p.UPI), ["1/02/13/02/1101", null]);
    assert.deepEqual(result.parcels[0], { UPI: "1/02/13/02/1101", current: true, area_sqm: 500.12, province: null, district: "Gasabo", sector: null, cell: null, village: null });
    assert.deepEqual(result.retired_parcels, [{ UPI: valid.UPI }]);
    assert.deepEqual(result.records, [{ name: "SUBV-LAIS-SUB-2026-00125-20261124", recorded_date: "2026-11-26T00:00:00.000Z" }]);
    assert.equal(result.completed_at, new Date(EDITED).toISOString());
    assert.deepEqual(s.body.data.warnings.map((w: any) => w.code), ["UPI_MISSING"]);
    const firstUpdate = s.body.data.updated_at;

    // asking again without a change does not move updated_at
    s = await status(valid.Transaction_ID);
    assert.equal(s.body.data.updated_at, firstUpdate);

    // GIS assigns the missing UPI: the warning goes and updated_at moves
    await new Promise((r) => setTimeout(r, 5));
    fake.plots.get(12)!.name = "1/02/13/02/1102";
    s = await status(valid.Transaction_ID);
    assert.deepEqual(s.body.data.result.parcels.map((p: any) => p.UPI), ["1/02/13/02/1101", "1/02/13/02/1102"]);
    assert.deepEqual(s.body.data.warnings, []);
    assert.ok(Date.parse(s.body.data.updated_at) > Date.parse(firstUpdate));
  });

  test("resubmitting a posted Subdivision → 409 ALREADY_RECORDED with stage Posted, not UPI_EXPIRED", async () => {
    await submit(valid);
    postSubdivision("1/02/13/02/1102");
    const r = await submit(valid);
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.deepEqual(codes(r.body), ["ALREADY_RECORDED"]);
    assert.equal(r.body.data.stage, "Posted");
    assert.equal(r.body.data.result.parcels.length, 2);
  });

  test("Merge found through Parcel Fabric lineage, with the version still kept after posting", async () => {
    const merge = { UPIs: ["1/02/13/02/1001", "1/02/13/02/3003"], Transaction_ID: "MRG-2", Transaction_Type: "Merge", Transaction_Date: "2026-11-26T10:00:00+02:00" };
    assert.equal((await submit(merge)).status, 201);
    for (const id of [1, 4]) fake.plots.get(id)!.retiredbyrecord = "{MRG-REC}";
    // a parcel made in the editor has no `size` yet: the area comes from the shape
    fake.plots.set(13, { objectid: 13, name: "1/02/13/02/1313", createdbyrecord: "{MRG-REC}", size: null, Shape__Area: 2000.456 });
    // no record named for the version: the lineage alone tells
    const s = await status("MRG-2");
    assert.equal(s.body.data.stage, "Posted");
    assert.deepEqual(s.body.data.result.parcels.map((p: any) => p.UPI), ["1/02/13/02/1313"]);
    assert.equal(s.body.data.result.parcels[0].area_sqm, 2000.46);
    assert.deepEqual(s.body.data.result.retired_parcels.map((p: any) => p.UPI).sort(), merge.UPIs);
    assert.equal(fake.versions.length, 1, "the API never deletes versions");
  });

  test("CreatePlot without a parent: found through the record named for its version (any case)", async () => {
    await submit({ Transaction_ID: "NEW-2", Transaction_Type: "CreatePlot", Transaction_Date: "2026-11-25T10:00:00Z" });
    assert.equal((await status("NEW-2")).body.data.stage, "InReview");
    fake.records.push({ globalid: "{NEW-REC}", name: "crpl-new-2-20261125" });
    fake.plots.set(14, { objectid: 14, name: "1/02/13/02/1414", createdbyrecord: "{NEW-REC}" });
    const s = await status("NEW-2");
    assert.equal(s.body.data.stage, "Posted");
    assert.deepEqual(s.body.data.result.parcels.map((p: any) => p.UPI), ["1/02/13/02/1414"]);
    assert.deepEqual(s.body.data.result.retired_parcels, []);
  });

  test("CorrectBoundaries edited in place: its posted record → Posted with the corrected parcel", async () => {
    await submit({ UPI: "1/02/13/02/3003", Transaction_ID: "COR-1", Transaction_Type: "CorrectBoundaries", Transaction_Date: "2026-11-26T10:00:00Z" });
    fake.records.push({ globalid: "{COR-REC}", name: "CORB-COR-1-20261126" });
    const s = await status("COR-1");
    assert.equal(s.body.data.stage, "Posted");
    assert.deepEqual(s.body.data.result.parcels.map((p: any) => p.UPI), ["1/02/13/02/3003"]);
    assert.deepEqual(s.body.data.warnings, []);
  });

  test("version deleted without posting → Closed", async () => {
    await submit(valid);
    fake.versions = [];
    const s = await status(valid.Transaction_ID);
    assert.equal(s.body.data.stage, "Closed");
    assert.equal(s.body.data.result, null);
  });

  test("list: all transactions oldest change first, stage filter, polling with next_updated_since", async () => {
    await submit(valid);
    await submit({ Transaction_ID: "NEW-3", Transaction_Type: "CreatePlot", Transaction_Date: "2026-11-25T10:00:00Z" });
    let l = await get("/transactions");
    assert.equal(l.status, 200, JSON.stringify(l.body));
    assert.deepEqual(l.body.data.transactions.map((t: any) => t.stage), ["InReview", "InReview"]);
    assert.equal(l.body.data.has_more, false);
    const since = l.body.data.next_updated_since;

    l = await get(`/transactions?updatedSince=${encodeURIComponent(since)}`);
    assert.deepEqual(l.body.data.transactions, [], "nothing changed since");

    await new Promise((r) => setTimeout(r, 5));
    postSubdivision("1/02/13/02/1102");
    l = await get(`/transactions?updatedSince=${encodeURIComponent(since)}`);
    assert.deepEqual(l.body.data.transactions.map((t: any) => `${t.Transaction_ID}:${t.stage}`), [`${valid.Transaction_ID}:Posted`]);
    assert.equal(l.body.data.transactions[0].result.parcels.length, 2);

    l = await get("/transactions?stage=inreview");
    assert.deepEqual(l.body.data.transactions.map((t: any) => t.Transaction_ID), ["NEW-3"]);
    l = await get("/transactions?limit=1");
    assert.equal(l.body.data.transactions.length, 1);
    assert.equal(l.body.data.has_more, true);
    assert.equal(l.body.data.next_updated_since, l.body.data.transactions[0].updated_at);
  });

  test("list: a settled transaction is answered from the ledger without asking GIS", async () => {
    await submit(valid);
    postSubdivision("1/02/13/02/1102");
    await get("/transactions"); // finds it posted
    fake.calls = [];
    const l = await get("/transactions");
    assert.equal(l.body.data.transactions[0].stage, "Posted");
    assert.equal(gisCalls("/query").length, 0);
  });

  test("list: invalid query → 400 with one error per parameter", async () => {
    const l = await get("/transactions?updatedSince=yesterday&stage=Done&limit=0&page=2");
    assert.equal(l.status, 400);
    assert.deepEqual(l.body.errors.map((e: any) => `${e.field}:${e.code}`).sort(), ["limit:INVALID_LIMIT", "page:UNKNOWN_FIELD", "stage:INVALID_STAGE", "updatedSince:INVALID_DATE"]);
  });
});

describe("editing done: GIS tells LAIS the work is ready for the registrar", () => {
  let deliverDue: (now?: number) => Promise<void>;
  const VERSION = "svc_lais.SUBV-LAIS-SUB-2026-00125-20261124";
  const RECORD = "SUBV-LAIS-SUB-2026-00125-20261124";
  const PLACE = { province: "Kigali City", district: "Gasabo", sector: "Remera", cell: "Nyarutarama", village: "Kamahwa" };
  const editingBase = () => base.replace(/\/lais$/, "/lais-editing");
  const editing = async (pathAndQuery: string, init: RequestInit & { token?: string } = {}) => {
    const { token = "editor-token", ...rest } = init;
    const res = await fetch(`${editingBase()}${pathAndQuery}`, {
      ...rest,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...client(), ...(rest.headers as Record<string, string>) },
    });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  const done = (id = valid.Transaction_ID, body: unknown = {}) => editing(`/transactions/${encodeURIComponent(id)}/editing-done`, { method: "POST", body: JSON.stringify(body) });
  const laisView = async () => (await (await fetch(`${base}/transactions/${valid.Transaction_ID}`, { headers: { "x-api-key": KEY, ...client() } })).json()) as Record<string, any>;
  /** The editor's subdivision of plot 1 into 11 + 12, saved in the transaction's version (not posted). */
  function subdivideInVersion(opts: { recordName?: string; parcels?: number[]; retire?: number } = {}) {
    const v = fake.versions.find((x) => x.name === VERSION)!;
    Object.assign(fake.plots.get(1)!, { size: 100, ...PLACE });
    v.saved.set(opts.retire ?? 1, { retiredbyrecord: "{REC-1}" });
    for (const id of opts.parcels ?? [11, 12]) v.saved.set(id, { objectid: id, globalid: `{G-${id}}`, name: null, createdbyrecord: "{REC-1}", size: 50, ...PLACE });
    fake.versionRecords.set(VERSION, [{ globalid: "{REC-1}", name: opts.recordName ?? RECORD }]);
  }
  const startOver = async () => {
    fake.reset();
    await resetLais();
    resetToken();
    cfg.LAIS_WRITE_MODE = "version-only";
    assert.equal((await submit(valid)).status, 201);
  };

  before(async () => {
    ({ deliverDueEditingDone: deliverDue } = await import("../src/lais/editingDone.js"));
  });
  beforeEach(async () => {
    cfg.LAIS_EDITING_DONE = "true";
    await startOver();
  });

  test("switched off by default: the web app is told, and nothing can be sent", async () => {
    cfg.LAIS_EDITING_DONE = "false";
    subdivideInVersion();
    const list = await editing("/transactions");
    assert.equal(list.status, 200);
    assert.equal(list.body.enabled, false);
    const r = await done();
    assert.equal(r.status, 503);
    assert.equal(r.body.error.code, "feature_disabled");
    assert.equal(fake.webhook.calls.length, 0);
    const config = (await (await fetch(base.replace(/\/lais$/, "/config"))).json()) as Record<string, any>;
    assert.deepEqual(config.features, { laisEditingDone: false });
  });

  test("only signed-in editors: no token 401, a viewer 403", async () => {
    assert.equal((await fetch(`${editingBase()}/transactions`, { headers: client() })).status, 401);
    assert.equal((await editing("/transactions", { token: "viewer-token" })).status, 403);
  });

  test("preview: the agreed format, built from the version, and nothing sent", async () => {
    subdivideInVersion();
    const r = await editing(`/transactions/${valid.Transaction_ID}/preview`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.problems, []);
    const p = r.body.payload;
    assert.deepEqual(Object.keys(p), ["event_type", "Transaction_ID", "Transaction_Type", "version_name", "record_name", "edited_by", "parent_parcels", "proposed_parcels", "totals"]);
    assert.equal(p.version_name, VERSION);
    assert.equal(p.record_name, RECORD);
    assert.equal(p.edited_by, "editor.one");
    assert.deepEqual(p.parent_parcels, [{ UPI: "1/02/13/02/1001", area_sqm: 100, ...PLACE }]);
    assert.deepEqual(p.proposed_parcels.map((x: any) => [x.parcel_ref, x.UPI, x.area_sqm]), [["{G-11}", null, 50], ["{G-12}", null, 50]]);
    assert.deepEqual(Object.keys(p.proposed_parcels[0]), ["parcel_ref", "UPI", "area_sqm", "province", "district", "sector", "cell", "village", "geometry"]);
    // GeoJSON: outer ring counter-clockwise (ArcGIS gives it clockwise)
    assert.deepEqual(p.proposed_parcels[0].geometry, { type: "Polygon", coordinates: [[[0, 0], [5, 0], [5, 10], [0, 10], [0, 0]]] });
    assert.deepEqual(p.totals, { parent_area_sqm: 100, proposed_area_sqm: 100 });
    assert.equal(fake.webhook.calls.length, 0);
    const recordReads = fake.calls.filter((c) => c.url === `${RECORDS}/query`);
    assert.ok(recordReads.length && recordReads.every((c) => c.params.gdbVersion === VERSION), "records are read in the version");
    assert.ok(gisCalls("/applyEdits").length === 0 && gisCalls("/startEditing").length === 0, "nothing is edited");
  });

  test("editing done: LAIS receives exactly the agreed message once; LAIS's view of the transaction does not change", async () => {
    subdivideInVersion();
    const before = await laisView();
    const r = await done();
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.editing_done.status, "delivered");
    assert.equal(fake.webhook.calls.length, 1);
    const call = fake.webhook.calls[0]!;
    assert.equal(call.headers.get("x-api-key"), WEBHOOK_KEY);
    assert.equal(call.headers.get("x-gis-event-type"), "editing.completed");
    assert.equal(call.headers.get("x-gis-event-id"), call.body.event_id);
    assert.deepEqual(Object.keys(call.body), ["event_id", "event_type", "sent_at", "Transaction_ID", "Transaction_Type", "version_name", "record_name", "edited_by", "parent_parcels", "proposed_parcels", "totals"]);
    assert.equal(call.body.event_id, r.body.editing_done.event_id);
    assert.ok(!Number.isNaN(Date.parse(call.body.sent_at)));

    const again = await done();
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, "already_sent");
    assert.equal(fake.webhook.calls.length, 1, "never sent twice");

    const list = await editing("/transactions");
    assert.equal(list.body.transactions[0].editing_done.status, "delivered");
    assert.equal(list.body.transactions[0].editing_done.parcels, 2);
    const after = await laisView();
    assert.equal(after.data.updated_at, before.data.updated_at, "LAIS's polling must not see a change");
  });

  test("the record named by the editor is used when it is not named after the version", async () => {
    subdivideInVersion({ recordName: "Remera split 2026-11" });
    let r = await done();
    assert.equal(r.status, 422);
    assert.match(r.body.error.message, /No Parcel Fabric record named "SUBV-LAIS-SUB-2026-00125-20261124"/);
    r = await done(valid.Transaction_ID, { recordName: "remera SPLIT 2026-11" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(fake.webhook.calls[0]!.body.record_name, "Remera split 2026-11");
  });

  test("work that does not match the transaction is refused with what to fix, and nothing is sent", async () => {
    let r = await done();
    assert.equal(r.status, 422, "no record yet");
    assert.equal(r.body.error.code, "not_ready");
    assert.ok(r.body.error.details.problems.length);

    subdivideInVersion({ parcels: [11] });
    r = await done();
    assert.match(r.body.error.message, /at least 2 parcels; the record .* has 1/);

    await startOver();
    subdivideInVersion({ retire: 4 });
    r = await done();
    assert.equal(r.status, 422);
    assert.match(r.body.error.message, /1\/02\/13\/02\/1001 is not replaced by the record/);
    assert.equal(fake.webhook.calls.length, 0);
  });

  test("LAIS down: retried with the same event_id on schedule, then delivered", async () => {
    subdivideInVersion();
    fake.webhook.answers.push({ status: 503, body: { message: "maintenance" } });
    const t0 = Date.now();
    const r = await done();
    assert.equal(r.status, 202);
    assert.equal(r.body.editing_done.status, "retrying");
    assert.equal(r.body.editing_done.last_result, "HTTP 503");
    assert.ok(Math.abs(Date.parse(r.body.editing_done.next_attempt_at) - (t0 + 60_000)) < 5_000, "next try after about a minute");

    await deliverDue(t0 + 30_000);
    assert.equal(fake.webhook.calls.length, 1, "not due yet");
    await deliverDue(t0 + 61_000);
    assert.equal(fake.webhook.calls.length, 2);
    assert.equal(fake.webhook.calls[1]!.body.event_id, fake.webhook.calls[0]!.body.event_id);
    assert.notEqual(fake.webhook.calls[1]!.body.sent_at, fake.webhook.calls[0]!.body.sent_at);
    const list = await editing("/transactions");
    assert.equal(list.body.transactions[0].editing_done.status, "delivered");
    assert.equal(list.body.transactions[0].editing_done.attempts, 2);
    assert.equal((await done()).status, 409, "a delivered notification is never resent");
  });

  test("a timeout counts as not delivered", async () => {
    subdivideInVersion();
    fake.webhook.answers.push("timeout");
    const r = await done();
    assert.equal(r.body.editing_done.status, "retrying");
    assert.equal(r.body.editing_done.last_result, "timeout");
  });

  test("while a notification is waiting for a retry, pressing again does not send a duplicate", async () => {
    subdivideInVersion();
    fake.webhook.answers.push({ status: 503 });
    await done();
    const again = await done();
    assert.equal(again.status, 202);
    assert.equal(again.body.editing_done.status, "retrying");
    assert.equal(fake.webhook.calls.length, 1);
  });

  test("LAIS refuses (4xx): the editor sees LAIS's message and can send again, as a new event", async () => {
    subdivideInVersion();
    fake.webhook.answers.push({ status: 400, body: { message: "Unknown Transaction_ID" } });
    const r = await done();
    assert.equal(r.status, 202);
    assert.equal(r.body.editing_done.status, "refused");
    assert.equal(r.body.editing_done.last_message, "Unknown Transaction_ID");
    await deliverDue(Date.now() + 2 * 60 * 60_000);
    assert.equal(fake.webhook.calls.length, 1, "a refusal is not retried");
    const again = await done();
    assert.equal(again.body.editing_done.status, "delivered");
    assert.notEqual(fake.webhook.calls[1]!.body.event_id, fake.webhook.calls[0]!.body.event_id);
  });

  test("gives up after 24 hours without a 2xx", async () => {
    subdivideInVersion();
    fake.webhook.answers.push({ status: 503 }, { status: 503 });
    await done();
    await deliverDue(Date.now() + 25 * 60 * 60_000);
    const list = await editing("/transactions");
    assert.equal(list.body.transactions[0].editing_done.status, "failed");
  });

  test("unknown transaction 404; LAIS endpoint not configured 503; version removed 409", async () => {
    subdivideInVersion();
    assert.equal((await done("NO-SUCH")).status, 404);
    cfg.LAIS_WEBHOOK_KEY = "";
    assert.equal((await done()).body.error.code, "not_configured");
    cfg.LAIS_WEBHOOK_KEY = WEBHOOK_KEY;
    fake.versions = [];
    const r = await done();
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, "version_gone");
  });
});

describe("registrar's decision (LAIS → GIS): approve assigns UPIs and posts; reject sends the work back", () => {
  const PLACE = { province: "Kigali City", district: "Gasabo", sector: "Remera", cell: "Nyarutarama", village: "Kamahwa" };
  const second = { UPI: "1/02/13/02/8008", Transaction_ID: "LAIS-SUB-2026-00126", Transaction_Type: "Subdivision", Transaction_Date: "2026-11-24T08:30:00+02:00" };
  const versionOf = (t: { Transaction_ID: string }) => `${OWNER}.SUBV-${t.Transaction_ID}-20261124`;
  const editingBase = () => base.replace(/\/lais$/, "/lais-editing");
  const editing = async (p: string, init: RequestInit = {}) => {
    const res = await fetch(`${editingBase()}${p}`, { ...init, headers: { Authorization: "Bearer editor-token", "Content-Type": "application/json", ...client() } });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  const sendDone = async (t = valid) => {
    const r = await editing(`/transactions/${t.Transaction_ID}/editing-done`, { method: "POST", body: "{}" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.editing_done.event_id as string;
  };
  const decide = async (action: "approve" | "reject", body: unknown, t = valid, headers: Record<string, string> = { "x-api-key": KEY }) => {
    const res = await fetch(`${base}/transactions/${t.Transaction_ID}/${action}`, { method: "POST", headers: { "Content-Type": "application/json", ...client(), ...headers }, body: JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  const laisView = async (t = valid) => (await (await fetch(`${base}/transactions/${t.Transaction_ID}`, { headers: { "x-api-key": KEY, ...client() } })).json()) as Record<string, any>;
  /** The editor's subdivision of `parent` into `children`, saved in the transaction's version (not posted). */
  function subdivide(t = valid, parent = 1, children = [11, 12], record = "{REC-1}") {
    const v = fake.versions.find((x) => x.name === versionOf(t))!;
    Object.assign(fake.plots.get(parent)!, { size: 100, globalid: `{G-${parent}}`, ...PLACE });
    v.saved.set(parent, { retiredbyrecord: record });
    for (const id of children) v.saved.set(id, { objectid: id, globalid: `{G-${id}}`, name: null, createdbyrecord: record, size: 50, ...PLACE });
    fake.versionRecords.set(v.name, [{ globalid: record, name: versionOf(t).split(".")[1] }]);
  }
  /** A transaction whose work LAIS has received: its event_id. */
  const ready = async () => {
    subdivide();
    return sendDone();
  };

  beforeEach(async () => {
    cfg.LAIS_WRITE_MODE = "version-only";
    cfg.LAIS_EDITING_DONE = "true";
    assert.equal((await submit(valid)).status, 201);
  });

  test("LAIS key required; switched off → FLOW_NOT_ENABLED; body checked field by field", async () => {
    assert.equal((await decide("approve", {}, valid, {})).status, 401);
    cfg.LAIS_EDITING_DONE = "false";
    let r = await decide("approve", { event_id: crypto.randomUUID(), approved_by: "registrar.one" });
    assert.deepEqual([r.status, codes(r.body)], [409, ["FLOW_NOT_ENABLED"]]);
    cfg.LAIS_EDITING_DONE = "true";
    r = await decide("approve", { approved_by: 5, extra: 1, cell: "1/2" });
    assert.equal(r.status, 422);
    assert.deepEqual(codes(r.body).sort(), ["INVALID_CELL", "INVALID_TYPE", "REQUIRED", "UNKNOWN_FIELD"]);
    r = await decide("reject", { event_id: "not-a-uuid", rejected_by: "registrar.one" });
    assert.deepEqual(codes(r.body).sort(), ["INVALID_EVENT_ID", "REQUIRED"]);
    assert.equal(gisCalls("/reconcile").length, 0);
  });

  test("approve: the next UPIs of the cell are written in the version, the version is posted, LAIS gets the UPIs by parcel_ref", async () => {
    const eventId = await ready();
    const before = await laisView();
    const r = await decide("approve", { event_id: eventId, approved_by: "registrar.one" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.success, true);
    // 9009 is the highest number in cell 1/02/13/02 (current and historic parcels)
    assert.deepEqual(r.body.data.approval.upis, [{ parcel_ref: "{G-11}", UPI: "1/02/13/02/9010" }, { parcel_ref: "{G-12}", UPI: "1/02/13/02/9011" }]);
    assert.deepEqual([r.body.data.approval.status, r.body.data.approval.approved_by, r.body.data.approval.cell], ["approved", "registrar.one", "1/02/13/02"]);
    assert.equal(r.body.data.stage, "Posted");
    assert.deepEqual(r.body.data.result.parcels.map((p: any) => p.UPI), ["1/02/13/02/9010", "1/02/13/02/9011"]);
    assert.deepEqual(r.body.data.result.retired_parcels, [{ UPI: "1/02/13/02/1001" }]);

    // in sde.DEFAULT now: the new parcels with their UPIs and numbers, the parent retired
    assert.deepEqual([fake.plots.get(11)!.name, fake.plots.get(11)!.parcel_number, fake.plots.get(12)!.name], ["1/02/13/02/9010", 9010, "1/02/13/02/9011"]);
    assert.equal(fake.plots.get(1)!.retiredbyrecord, "{REC-1}");
    const reconcile = gisCalls("/reconcile");
    assert.equal(reconcile.length, 1);
    assert.deepEqual([reconcile[0]!.params.withPost, reconcile[0]!.params.abortIfConflicts], ["true", "true"]);
    assert.ok(gisCalls("/applyEdits").every((c) => c.params.gdbVersion === versionOf(valid)), "UPIs are written in the version, never in DEFAULT");
    assert.notEqual((await laisView()).data.updated_at, before.data.updated_at, "LAIS's polling sees the change");

    // never twice: a repeat is a clear failure that still carries the UPIs; the editor cannot send again
    const again = await decide("approve", { event_id: eventId, approved_by: "registrar.one" });
    assert.deepEqual([again.status, codes(again.body)], [409, ["ALREADY_APPROVED"]]);
    assert.equal(again.body.data.approval.upis.length, 2);
    assert.equal(gisCalls("/reconcile").length, 1);
    const list = await editing("/transactions");
    assert.deepEqual([list.body.transactions[0].decision.kind, list.body.transactions[0].decision.upis], ["approved", ["1/02/13/02/9010", "1/02/13/02/9011"]]);
    assert.equal((await editing(`/transactions/${valid.Transaction_ID}/editing-done`, { method: "POST", body: "{}" })).body.error.code, "already_approved");
  });

  test("only the work LAIS received can be approved: unknown 404, nothing sent yet, another event_id", async () => {
    assert.equal((await decide("approve", { event_id: crypto.randomUUID(), approved_by: "r" }, second)).status, 404);
    let r = await decide("approve", { event_id: crypto.randomUUID(), approved_by: "r" });
    assert.deepEqual([r.status, codes(r.body)], [409, ["NOT_SUBMITTED"]]);
    const eventId = await ready();
    r = await decide("approve", { event_id: crypto.randomUUID(), approved_by: "r" });
    assert.deepEqual([r.status, codes(r.body), r.body.errors[0].field, r.body.data.latest_event_id], [409, ["EVENT_MISMATCH"], "event_id", eventId]);
    assert.equal(gisCalls("/reconcile").length, 0);
  });

  test("changed after sending: nothing is posted; the editor sends the revision and LAIS approves that one", async () => {
    const first = await ready();
    fake.versions.find((x) => x.name === versionOf(valid))!.saved.get(11)!.size = 60; // the editor kept working
    let r = await decide("approve", { event_id: first, approved_by: "r" });
    assert.deepEqual([r.status, codes(r.body)], [409, ["CHANGED_SINCE_SUBMISSION"]]);
    assert.equal(gisCalls("/reconcile").length, 0);
    assert.equal(fake.plots.get(11), undefined, "nothing reached DEFAULT");

    const revised = await sendDone(); // allowed: the work changed
    assert.notEqual(revised, first);
    assert.deepEqual(codes((await decide("approve", { event_id: first, approved_by: "r" })).body), ["EVENT_MISMATCH"]);
    r = await decide("approve", { event_id: revised, approved_by: "r" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  });

  test("reconcile conflict or version in use: nothing posted; a retry reuses the same UPIs and posts", async () => {
    const eventId = await ready();
    fake.reconcileConflict = true;
    let r = await decide("approve", { event_id: eventId, approved_by: "r" });
    assert.deepEqual([r.status, codes(r.body)], [409, ["RECONCILE_CONFLICT"]]);
    assert.equal(fake.plots.get(11), undefined, "nothing reached DEFAULT");
    let list = await editing("/transactions");
    assert.equal(list.body.transactions[0].decision.kind, "approving");
    assert.match(list.body.transactions[0].decision.error, /conflicts/);
    const writes = gisCalls("/applyEdits").length;

    fake.reconcileConflict = false;
    fake.versionLocked = true;
    r = await decide("approve", { event_id: eventId, approved_by: "r" });
    assert.deepEqual([r.status, codes(r.body)], [409, ["VERSION_IN_USE"]]);

    fake.versionLocked = false;
    r = await decide("approve", { event_id: eventId, approved_by: "r" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.data.approval.upis.map((u: any) => u.UPI), ["1/02/13/02/9010", "1/02/13/02/9011"], "the same UPIs as the first attempt");
    assert.equal(gisCalls("/applyEdits").length, writes, "the UPIs were already in the version");
    list = await editing("/transactions");
    assert.equal(list.body.transactions[0].decision.kind, "approved");
  });

  test("numbering sees UPIs posted to DEFAULT after the version was made (a version shows DEFAULT as of its last reconcile)", async () => {
    const eventId = await ready();
    fake.plots.set(15, { objectid: 15, name: "1/02/13/02/9500" });
    fake.hiddenFromVersions.add(15);
    const r = await decide("approve", { event_id: eventId, approved_by: "r" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.data.approval.upis.map((u: any) => u.UPI), ["1/02/13/02/9501", "1/02/13/02/9502"]);
  });

  test("UPIs planned by an approval that failed stay reserved: another approval in the cell skips them, the retry gets them", async () => {
    assert.equal((await submit(second)).status, 201);
    subdivide();
    subdivide(second, 8, [13, 14], "{REC-2}");
    const [a, b] = [await sendDone(), await sendDone(second)];
    fake.reconcileConflict = true;
    assert.deepEqual(codes((await decide("approve", { event_id: a, approved_by: "r" })).body), ["RECONCILE_CONFLICT"]);
    fake.reconcileConflict = false;
    const rb = await decide("approve", { event_id: b, approved_by: "r" }, second);
    assert.deepEqual(rb.body.data.approval.upis.map((u: any) => u.UPI), ["1/02/13/02/9012", "1/02/13/02/9013"], "9010 and 9011 are reserved for the first");
    const ra = await decide("approve", { event_id: a, approved_by: "r" });
    assert.equal(ra.status, 200, JSON.stringify(ra.body));
    assert.deepEqual(ra.body.data.approval.upis.map((u: any) => u.UPI), ["1/02/13/02/9010", "1/02/13/02/9011"]);
  });

  test("posted but not recorded (the server stopped right after posting): the retry finds it in DEFAULT and completes without posting again", async () => {
    const eventId = await ready();
    fake.reconcileConflict = true;
    await decide("approve", { event_id: eventId, approved_by: "r" }); // UPIs saved in the version, not posted
    // the post went through outside this attempt's knowledge
    const v = fake.versions.find((x) => x.name === versionOf(valid))!;
    for (const [oid, a] of v.saved) fake.plots.set(oid, { ...fake.plots.get(oid), ...a });
    fake.records.push(...(fake.versionRecords.get(v.name) ?? []));
    fake.versionRecords.delete(v.name);
    v.saved = new Map();
    fake.reconcileConflict = false;
    const reconciles = gisCalls("/reconcile").length;
    const r = await decide("approve", { event_id: eventId, approved_by: "r" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.data.approval.upis.map((u: any) => u.UPI), ["1/02/13/02/9010", "1/02/13/02/9011"]);
    assert.equal(gisCalls("/reconcile").length, reconciles, "not posted again");
    assert.equal(r.body.data.stage, "Posted");
  });

  test("the LAIS account without the Advanced Editing licence: 503, nothing posted", async () => {
    const eventId = await ready();
    fake.refuseLicense = true;
    const r = await decide("approve", { event_id: eventId, approved_by: "r" });
    assert.deepEqual([r.status, codes(r.body)], [503, ["GIS_NOT_CONFIGURED"]]);
    assert.equal(fake.plots.get(11), undefined);
  });

  test("LAIS may choose the cell; numbering then starts in that cell", async () => {
    const eventId = await ready();
    const r = await decide("approve", { event_id: eventId, approved_by: "r", cell: "1/02/13/05" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.data.approval.upis.map((u: any) => u.UPI), ["1/02/13/05/1", "1/02/13/05/2"]);
  });

  test("two approvals in the same cell at once never get the same numbers; the same approval twice at once posts once", async () => {
    assert.equal((await submit(second)).status, 201);
    subdivide();
    subdivide(second, 8, [13, 14], "{REC-2}");
    const [a, b] = [await sendDone(), await sendDone(second)];
    const [ra, rb, rc] = await Promise.all([
      decide("approve", { event_id: a, approved_by: "r" }),
      decide("approve", { event_id: b, approved_by: "r" }, second),
      decide("approve", { event_id: a, approved_by: "r" }),
    ]);
    assert.deepEqual([ra.status, rb.status, rc.status].sort(), [200, 200, 409]);
    const upis = [...ra.body.data.approval.upis, ...rb.body.data.approval.upis].map((u: any) => u.UPI);
    assert.deepEqual(upis.slice().sort(), ["1/02/13/02/9010", "1/02/13/02/9011", "1/02/13/02/9012", "1/02/13/02/9013"]);
    assert.equal(gisCalls("/reconcile").length, 2);
  });

  test("reject: recorded once with the reason; nothing in GIS changes; the editor sends again and LAIS approves the new work", async () => {
    const first = await ready();
    const before = await laisView();
    const reason = "The boundary between the two new parcels does not follow the survey plan.";
    let r = await decide("reject", { event_id: first, rejected_by: "registrar.one", reason });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([r.body.data.rejection.event_id, r.body.data.rejection.reason], [first, reason]);
    assert.equal((await laisView()).data.updated_at, before.data.updated_at, "LAIS decided it; its view does not change");
    assert.equal(gisCalls("/startEditing").length, 0);

    assert.deepEqual(codes((await decide("reject", { event_id: first, rejected_by: "registrar.one", reason })).body), ["ALREADY_REJECTED"]);
    assert.deepEqual(codes((await decide("approve", { event_id: first, approved_by: "registrar.one" })).body), ["ALREADY_REJECTED"]);
    const list = await editing("/transactions");
    assert.deepEqual([list.body.transactions[0].decision.kind, list.body.transactions[0].decision.reason], ["rejected", reason]);

    const revised = await sendDone(); // allowed after a rejection, even unchanged
    assert.notEqual(revised, first);
    r = await decide("approve", { event_id: revised, approved_by: "registrar.one" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(codes((await decide("reject", { event_id: revised, rejected_by: "registrar.one", reason })).body), ["ALREADY_APPROVED"]);
  });
});

describe("rate limiting", () => {
  test("over 60/min → 429 JSON in LAIS shape", async () => {
    let last: Awaited<ReturnType<typeof submit>> | undefined;
    for (let i = 0; i < 65; i++) last = await submit({}, {});
    assert.equal(last!.status, 429);
    assert.deepEqual(codes(last!.body), ["RATE_LIMITED"]);
  });
});
