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
const REFERER = "https://gis-api.test";
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
  { name: "objectid" }, { name: "name" }, { name: "transaction_id" },
  { name: "transaction_type", domain: { codedValues: ["Subdivision", "Merge", "CorrectBoundaries", "CreatePlot"].map((code) => ({ code })) } },
  { name: "transaction_status", domain: { codedValues: ["New", "InProgress", "Approved", "Rejected"].map((code) => ({ code })) } },
  { name: "transaction_date" },
  { name: "case_", domain: { codedValues: [{ code: "Yes" }, { code: "No" }] } },
  { name: "validation_message" },
  { name: "version_status", domain: { codedValues: [{ code: "Pending" }, { code: "VersionCreated" }] } },
  { name: "version_name" },
];

const fake = {
  calls: [] as Call[],
  plots: new Map<number, Attrs>(),
  versions: [] as FakeVersion[],
  branchVersioned: true,
  failNextApplyEdits: false,
  expireTokenOnce: false,
  refuseLicense: false,
  tokenSerial: 0,
  reset() {
    this.calls = [];
    this.plots = new Map([
      [1, { objectid: 1, name: "1/02/13/02/1001" }],
      [2, { objectid: 2, name: "1/02/13/02/2002" }],
      [3, { objectid: 3, name: "1/02/13/02/2002" }],
      [4, { objectid: 4, name: "1/02/13/02/3003" }],
    ]);
    this.versions = [];
    this.branchVersioned = true;
    this.failNextApplyEdits = false;
    this.expireTokenOnce = false;
    this.refuseLicense = false;
  },
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function viewOf(gdbVersion?: string): Map<number, Attrs> {
  const view = new Map([...fake.plots].map(([k, v]) => [k, { ...v }]));
  if (gdbVersion) {
    const v = fake.versions.find((x) => x.name === gdbVersion);
    if (!v) throw new Error(`unknown version ${gdbVersion}`);
    for (const [oid, a] of v.saved) view.set(oid, { ...view.get(oid), ...a });
  }
  return view;
}

function where(clause: string): (a: Attrs) => boolean {
  const m = /^(\w+) = '((?:[^']|'')*)'$/.exec(clause);
  if (!m) throw new Error(`unsupported where: ${clause}`);
  const value = m[2]!.replace(/''/g, "'");
  return (a) => a[m[1]!] === value;
}

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (!url.startsWith("https://fake-gis.test")) return realFetch(input, init);
  const params = Object.fromEntries(new URLSearchParams(String(init?.body ?? "")));
  const headers = new Headers(init?.headers);
  fake.calls.push({ url, params, referer: headers.get("referer") });

  if (url === `${PORTAL}/sharing/rest/generateToken`) {
    return json({ token: `tok-${++fake.tokenSerial}`, expires: Date.now() + 30 * 60_000 });
  }
  if (fake.expireTokenOnce) {
    fake.expireTokenOnce = false;
    return json({ error: { code: 498, message: "Invalid token." } });
  }
  if (url === PLOT) return json({ name: "Plot", isDataBranchVersioned: fake.branchVersioned, objectIdField: "objectid", fields: FIELDS });
  if (url === `${PLOT}/query`) {
    const match = where(params.where!);
    const features = [...viewOf(params.gdbVersion).values()].filter(match).map((attributes) => ({ attributes }));
    return json({ features });
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
  const vm = /\/versions\/([^/]+)\/(startReading|startEditing|stopEditing|stopReading)$/.exec(url);
  if (vm) {
    const v = fake.versions.find((x) => x.guid.replace(/[{}]/g, "") === vm[1]);
    if (!v) return json({ error: { code: 404, message: "no such version" } });
    if (vm[2] === "startEditing" && fake.refuseLicense) {
      return json({ error: { code: 500, message: "Unable to complete operation.", details: ["Error: You cannot edit as you have not been assigned required user type extensions: [Advanced Editing]."] } });
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
    return json({ updateResults: [{ success: true }] });
  }
  return json({ error: { code: 404, message: `fake: no handler for ${url}` } });
}) as typeof fetch;

// ------------------------------------------------------------------ app under test

let server: Server;
let base = "";
let resetLais: () => Promise<void>;
let resetToken: () => void;
let cfg: { LAIS_WRITE_MODE: "version-only" | "attributes" };

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
});

const valid = { UPI: "1/02/13/02/1001", Transaction_ID: "LAIS-SUB-2026-00125", Transaction_Type: "Subdivision", Transaction_Date: "2026-11-24T08:30:00+02:00" };

async function submit(body: unknown, headers: Record<string, string> = { "x-api-key": KEY }) {
  const res = await fetch(`${base}/transactions`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}
const codes = (body: Record<string, any>) => (body.errors as Array<{ code: string }>).map((e) => e.code);
const gisCalls = (suffix: string) => fake.calls.filter((c) => c.url.endsWith(suffix));

// ------------------------------------------------------------------ tests

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
    assert.deepEqual(r.body.errors.map((e: any) => e.field).sort(), ["Transaction_Date", "Transaction_ID", "Transaction_Type", "UPI"]);
    assert.ok(codes(r.body).every((c) => c === "REQUIRED_FIELD"));
  });
  test("case or unknown fields are rejected", async () => {
    const r = await submit({ ...valid, case: "Yes", extra: 1 });
    assert.equal(r.status, 422);
    assert.deepEqual(codes(r.body), ["UNKNOWN_FIELD", "UNKNOWN_FIELD"]);
  });
  test("bad type, status, UPI, date, length", async () => {
    const r = await submit({ UPI: "abc", Transaction_ID: "X".repeat(51), Transaction_Type: "Sell", Transaction_Date: "2026-02-30T08:30:00+02:00", Transaction_Status: "Done" });
    assert.equal(r.status, 422);
    assert.deepEqual(codes(r.body).sort(), ["INVALID_DATE", "INVALID_TRANSACTION_STATUS", "INVALID_TRANSACTION_TYPE", "INVALID_UPI_FORMAT", "TOO_LONG"]);
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
    assert.match(r.body.data.version_name, /^svc_lais\.LAIS_LAIS_SUB_2026_00125_[0-9A-F]{8}$/);
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

  test("identical retry → 200 duplicate, no new version or edit", async () => {
    await submit(valid);
    fake.calls = [];
    const r = await submit(valid);
    assert.equal(r.status, 200);
    assert.equal(r.body.data.duplicate, true);
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
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 200, 201]);
    assert.equal(fake.versions.length, 1);
  });

  test("Transaction_ID already posted to DEFAULT → duplicate (posted) or conflict", async () => {
    Object.assign(fake.plots.get(1)!, { transaction_id: "POSTED-1", transaction_type: "Merge", transaction_date: Date.parse(valid.Transaction_Date), case_: "Yes" });
    let r = await submit({ ...valid, Transaction_ID: "POSTED-1", Transaction_Type: "Merge" });
    assert.equal(r.status, 200);
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
    const res = await fetch(`${base}/transactions/${encodeURIComponent(id)}`, { headers: { "x-api-key": KEY } });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };

  test("creates the public version and makes no edit calls at all", async () => {
    fake.refuseLicense = true; // an unlicensed account must still work in this mode
    const r = await submit(valid);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.case, "Yes");
    assert.equal(r.body.data.version_status, "VersionCreated");
    assert.match(r.body.data.version_name, /^svc_lais\.LAIS_/);
    assert.equal(gisCalls("/create")[0]!.params.accessPermission, "public");
    assert.deepEqual(editCalls(), []);
    assert.equal(fake.plots.get(1)!.transaction_id, undefined, "DEFAULT must be untouched");
    assert.ok(fake.calls.every((c) => c.referer === `${REFERER}/`));
  });

  test("identical retry → 200, different payload → 409, status → InReview", async () => {
    await submit(valid);
    let r = await submit(valid);
    assert.equal(r.status, 200);
    assert.equal(r.body.data.duplicate, true);
    r = await submit({ ...valid, Transaction_Type: "Merge" });
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
    assert.equal(r.status, 200);
    assert.equal(r.body.data.stage, "Closed");
    assert.equal(fake.versions.length, 0);
  });

  test("a version that exists without an API record is not adopted silently → 409", async () => {
    fake.versions.push({ name: `${OWNER}.${(await import("../src/lais/laisService.js")).versionNameFor(valid.Transaction_ID)}`, guid: "{00000000-0000-0000-0000-000000000001}", access: "public", saved: new Map(), pending: null });
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

describe("status endpoint", () => {
  test("returns the recorded transaction, or 404", async () => {
    await submit(valid);
    let res = await fetch(`${base}/transactions/${encodeURIComponent(valid.Transaction_ID)}`, { headers: { "x-api-key": KEY } });
    let body = (await res.json()) as Record<string, any>;
    assert.equal(res.status, 200);
    assert.equal(body.data.UPI, valid.UPI);
    assert.equal(body.data.Transaction_Type, "Subdivision");
    assert.equal(body.data.case, "Yes");
    assert.equal(body.data.version_status, "VersionCreated");
    assert.equal(body.data.stage, "InReview");
    assert.equal(body.data.Transaction_Date, new Date(Date.parse(valid.Transaction_Date)).toISOString());

    res = await fetch(`${base}/transactions/UNKNOWN-1`, { headers: { "x-api-key": KEY } });
    body = (await res.json()) as Record<string, any>;
    assert.equal(res.status, 404);
    assert.deepEqual(codes(body), ["NOT_FOUND"]);
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
