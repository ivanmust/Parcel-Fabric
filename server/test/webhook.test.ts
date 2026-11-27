/**
 * Webhook building blocks: signing, backoff, the durable outbox, the dispatcher (against a real local
 * HTTP receiver) and the worker lock. No ArcGIS. Run: npm test (from server/).
 */
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

const dir = mkdtempSync(path.join(tmpdir(), "webhook-"));
process.env.AUDIT_DIR = path.join(dir, "audit");
process.env.LOG_LEVEL = "fatal";

type Signing = typeof import("../src/modules/webhooks/domain/signing.js");
type Backoff = typeof import("../src/modules/webhooks/domain/backoff.js");
type Outbox = typeof import("../src/modules/webhooks/domain/outbox.js");
type Dispatcher = typeof import("../src/modules/webhooks/domain/dispatcher.js");
type Lock = typeof import("../src/modules/webhooks/domain/worker-lock.js");
let signing: Signing, backoff: Backoff, outboxMod: Outbox, dispatcher: Dispatcher, lock: Lock;

const SECRET = "s".repeat(32) + "-current";
const OLD_SECRET = "o".repeat(32) + "-previous";

// ------------------------------------------------------------------ a real HTTP receiver ("App B")
interface Received { headers: IncomingHttpHeaders; body: string }
const receiver = {
  calls: [] as Received[],
  /** Answers in order, then 200. "hang" never answers (client timeout). */
  answers: [] as Array<{ status: number; body?: string; headers?: Record<string, string> } | "hang">,
};
let server: Server;
let url = "";
before(async () => {
  signing = await import("../src/modules/webhooks/domain/signing.js");
  backoff = await import("../src/modules/webhooks/domain/backoff.js");
  outboxMod = await import("../src/modules/webhooks/domain/outbox.js");
  dispatcher = await import("../src/modules/webhooks/domain/dispatcher.js");
  lock = await import("../src/modules/webhooks/domain/worker-lock.js");
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      receiver.calls.push({ headers: req.headers, body });
      const a = receiver.answers.shift() ?? { status: 200, body: '{"received":true}' };
      if (a === "hang") return; // never answers
      res.writeHead(a.status, { "Content-Type": "application/json", ...(a.headers ?? {}) });
      res.end(a.body ?? "{}");
    });
  }).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hooks/gis`;
});
after(() => {
  server.closeAllConnections();
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

let n = 0;
const freshFile = () => path.join(dir, `outbox-${++n}`, "outbox.json");
const cfg = (over: Partial<import("../src/modules/webhooks/domain/dispatcher.js").DispatchConfig> = {}) => ({
  url,
  secrets: [SECRET],
  timeoutMs: 1500,
  maxAttempts: 4,
  backoff: { baseMs: 30_000, maxMs: 6 * 60 * 60_000, random: () => 1 },
  ...over,
});
const T0 = Date.parse("2026-11-27T08:00:00Z");
const newEvent = (o: InstanceType<Outbox["FileOutbox"]>, key = "LAIS-SUB-1", now = T0) =>
  o.createEvent({ id: signing.stableEventId("subdivision.completed", key), type: "subdivision.completed", key, payload: { event_id: signing.stableEventId("subdivision.completed", key), event_type: "subdivision.completed", event_version: "1.0", data: { Transaction_ID: key } }, now });

beforeEach(() => {
  receiver.calls = [];
  receiver.answers = [];
});

// ------------------------------------------------------------------ signing
describe("HMAC signing", () => {
  test("HMAC-SHA256 over `${timestamp}.${body}`, hex, as v1=…", () => {
    const body = '{"a":1}';
    const expected = createHmac("sha256", SECRET).update(`1764230400.${body}`).digest("hex");
    assert.equal(signing.signPayload(SECRET, 1764230400, body), expected);
    assert.equal(signing.signatureHeader([SECRET], 1764230400, body), `v1=${expected}`);
  });

  test("verification: right key and body pass; tampered body, wrong key, or a stale timestamp fail", () => {
    const body = '{"event":"x"}';
    const header = signing.signatureHeader([SECRET], 1000, body);
    assert.equal(signing.verifySignature(header, [SECRET], 1000, body, 1100), true);
    assert.equal(signing.verifySignature(header, [SECRET], 1000, body + " ", 1100), false);
    assert.equal(signing.verifySignature(header, ["x".repeat(40)], 1000, body, 1100), false);
    assert.equal(signing.verifySignature(header, [SECRET], 1000, body, 1000 + 301), false, "older than 5 minutes");
  });

  test("key change: one signature per key, so a receiver with either key verifies", () => {
    const header = signing.signatureHeader([SECRET, OLD_SECRET], 2000, "{}");
    assert.equal(header.split(",").length, 2);
    assert.equal(signing.verifySignature(header, [OLD_SECRET], 2000, "{}", 2000), true);
    assert.equal(signing.verifySignature(header, [SECRET], 2000, "{}", 2000), true);
  });

  test("stable event ids: same transaction → same id (any case); another → another; UUID-shaped", () => {
    const a = signing.stableEventId("subdivision.completed", "LAIS-SUB-1");
    assert.equal(a, signing.stableEventId("subdivision.completed", "lais-sub-1"));
    assert.notEqual(a, signing.stableEventId("subdivision.completed", "LAIS-SUB-2"));
    assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

// ------------------------------------------------------------------ backoff
describe("exponential backoff with jitter", () => {
  const opts = { baseMs: 30_000, maxMs: 6 * 60 * 60_000 };
  test("doubles per attempt up to the cap", () => {
    const top = (attempt: number) => backoff.backoffDelay(attempt, { ...opts, random: () => 1 });
    assert.deepEqual([1, 2, 3, 4, 5].map(top), [30_000, 60_000, 120_000, 240_000, 480_000]);
    assert.equal(top(20), opts.maxMs);
  });
  test("jitter keeps each delay between half and all of the step", () => {
    for (const attempt of [1, 3, 8]) {
      const ceiling = Math.min(opts.maxMs, opts.baseMs * 2 ** (attempt - 1));
      assert.equal(backoff.backoffDelay(attempt, { ...opts, random: () => 0 }), ceiling / 2);
      for (let i = 0; i < 50; i++) {
        const d = backoff.backoffDelay(attempt, opts);
        assert.ok(d >= ceiling / 2 && d <= ceiling, `${d} within [${ceiling / 2}, ${ceiling}]`);
      }
    }
  });
  test("Retry-After raises the delay (seconds or HTTP date), within the cap", () => {
    assert.equal(backoff.backoffDelay(1, { ...opts, random: () => 0 }, 120_000), 120_000);
    assert.equal(backoff.backoffDelay(1, { ...opts, random: () => 0 }, 10 * 24 * 3600_000), opts.maxMs);
    assert.equal(backoff.parseRetryAfter("90", T0), 90_000);
    assert.equal(backoff.parseRetryAfter(new Date(T0 + 60_000).toUTCString(), T0), 60_000);
    assert.equal(backoff.parseRetryAfter("soon", T0), null);
  });
});

// ------------------------------------------------------------------ outbox
describe("durable outbox", () => {
  test("an event survives a restart (new process = new instance reading the file)", async () => {
    const file = freshFile();
    const first = new outboxMod.FileOutbox(file);
    const { created, event } = await newEvent(first);
    assert.equal(created, true);
    const restarted = new outboxMod.FileOutbox(file);
    const events = await restarted.events();
    assert.deepEqual(events.map((e) => [e.id, e.status, e.key]), [[event.id, "pending", "LAIS-SUB-1"]]);
  });

  test("idempotent creation: the same event id twice, or five times at once, stores one event", async () => {
    const o = new outboxMod.FileOutbox(freshFile());
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => newEvent(o)));
    assert.equal(results.filter((r) => r.created).length, 1);
    assert.equal((await newEvent(o)).created, false);
    assert.equal((await o.events()).length, 1);
  });

  test("atomic writes leave no temporary files; a corrupt outbox is refused, never emptied", async () => {
    const file = freshFile();
    const o = new outboxMod.FileOutbox(file);
    await newEvent(o, "A");
    await newEvent(o, "B");
    assert.deepEqual(readdirSync(path.dirname(file)), ["outbox.json"]);
    writeFileSync(file, '{"version":1,"events":[{"id":', "utf8");
    await assert.rejects(() => new outboxMod.FileOutbox(file).events());
    assert.match(readFileSync(file, "utf8"), /^\{"version":1,"events":\[\{"id":$/, "the corrupt file is left for inspection");
  });

  test("tracking start is set once and kept across restarts", async () => {
    const file = freshFile();
    const first = await new outboxMod.FileOutbox(file).trackingSince(T0);
    const later = await new outboxMod.FileOutbox(file).trackingSince(T0 + 86_400_000);
    assert.equal(first, new Date(T0).toISOString());
    assert.equal(later, first);
  });
});

// ------------------------------------------------------------------ dispatcher
describe("dispatcher", () => {
  test("delivers with the agreed headers and a valid signature; 2xx marks it delivered", async () => {
    const o = new outboxMod.FileOutbox(freshFile());
    const { event } = await newEvent(o);
    const s = await dispatcher.dispatchDue(o, cfg(), T0);
    assert.deepEqual(s, { claimed: 1, delivered: 1, retrying: 0, dead: 0 });
    const call = receiver.calls[0]!;
    assert.equal(call.headers["content-type"], "application/json");
    assert.equal(call.headers["x-webhook-id"], event.id);
    assert.equal(call.headers["x-webhook-event"], "subdivision.completed");
    assert.equal(call.headers["x-webhook-version"], "1.0");
    assert.equal(call.headers["x-webhook-attempt"], "1");
    const ts = Number(call.headers["x-webhook-timestamp"]);
    assert.ok(signing.verifySignature(String(call.headers["x-webhook-signature"]), [SECRET], ts, call.body, Math.floor(Date.now() / 1000)), "App B can verify it");
    assert.deepEqual(JSON.parse(call.body), event.payload, "the stored payload is sent unchanged");
    const [saved] = await o.events();
    assert.equal(saved!.status, "delivered");
    assert.equal((await dispatcher.dispatchDue(o, cfg(), T0 + 3_600_000)).claimed, 0, "never sent again");
  });

  test("retryable failures (503, 429 with Retry-After, timeout) back off exponentially, then deliver", async () => {
    const o = new outboxMod.FileOutbox(freshFile());
    await newEvent(o);
    receiver.answers.push({ status: 503, body: '{"message":"maintenance"}' }, { status: 429, headers: { "Retry-After": "600" } }, "hang");
    let s = await dispatcher.dispatchDue(o, cfg(), T0);
    assert.equal(s.retrying, 1);
    let [e] = await o.events();
    assert.deepEqual([e!.status, e!.attempts, e!.lastResult, e!.lastError], ["pending", 1, "HTTP 503", "maintenance"]);
    assert.equal(Date.parse(e!.nextAttemptAt!), T0 + 30_000, "attempt 1 → 30 s");

    assert.equal((await dispatcher.dispatchDue(o, cfg(), T0 + 29_000)).claimed, 0, "not before its time");
    await dispatcher.dispatchDue(o, cfg(), T0 + 30_000);
    [e] = await o.events();
    assert.equal(Date.parse(e!.nextAttemptAt!), T0 + 30_000 + 600_000, "Retry-After 600 s beats the 60 s step");

    await dispatcher.dispatchDue(o, cfg(), T0 + 630_000);
    [e] = await o.events();
    assert.equal(e!.lastResult, "timeout");
    assert.equal(Date.parse(e!.nextAttemptAt!), T0 + 630_000 + 120_000, "attempt 3 → 120 s");

    s = await dispatcher.dispatchDue(o, cfg(), T0 + 750_000);
    [e] = await o.events();
    assert.deepEqual([s.delivered, e!.status, e!.attempts], [1, "delivered", 4]);
    assert.equal(new Set(receiver.calls.map((c) => c.headers["x-webhook-id"])).size, 1, "always the same event id");
    assert.deepEqual(receiver.calls.map((c) => c.headers["x-webhook-attempt"]), ["1", "2", "3", "4"]);
  });

  test("permanent failures (400, 401, 404, a redirect) dead-letter at once, with the reason", async () => {
    for (const answer of [{ status: 400, body: '{"message":"Unknown Transaction_ID"}' }, { status: 401 }, { status: 404 }, { status: 302, headers: { Location: "https://elsewhere.test/" } }]) {
      const o = new outboxMod.FileOutbox(freshFile());
      await newEvent(o);
      receiver.answers.push(answer);
      const s = await dispatcher.dispatchDue(o, cfg(), T0);
      const [e] = await o.events();
      assert.equal(s.dead, 1, `HTTP ${answer.status}`);
      assert.equal(e!.status, "dead");
      assert.match(e!.deadReason!, new RegExp(`Permanent failure: HTTP ${answer.status}`));
      assert.equal((await dispatcher.dispatchDue(o, cfg(), T0 + 86_400_000)).claimed, 0, "a dead letter is not retried");
    }
  });

  test("dead letter after the last allowed attempt; an administrator's replay sends it again", async () => {
    const o = new outboxMod.FileOutbox(freshFile());
    const { event } = await newEvent(o);
    receiver.answers.push({ status: 500 }, { status: 502 }, { status: 503 }, { status: 504 });
    let t = T0;
    for (let i = 0; i < 4; i++) {
      await dispatcher.dispatchDue(o, cfg(), t);
      t += 7 * 60 * 60_000;
    }
    let [e] = await o.events();
    assert.deepEqual([e!.status, e!.attempts], ["dead", 4]);
    assert.match(e!.deadReason!, /Gave up after 4 attempts \(last: HTTP 504\)/);
    assert.equal(e!.history.length, 4);

    assert.equal((await o.replay(event.id, t))?.status, "pending");
    await dispatcher.dispatchDue(o, cfg(), t);
    [e] = await o.events();
    assert.equal(e!.status, "delivered");
  });

  test("concurrent dispatch runs never send the same event twice", async () => {
    const o = new outboxMod.FileOutbox(freshFile());
    await newEvent(o, "A");
    await newEvent(o, "B");
    await newEvent(o, "C");
    const runs = await Promise.all([dispatcher.dispatchDue(o, cfg(), T0), dispatcher.dispatchDue(o, cfg(), T0), dispatcher.dispatchDue(o, cfg(), T0)]);
    assert.equal(runs.reduce((t, r) => t + r.delivered, 0), 3);
    assert.equal(receiver.calls.length, 3);
    assert.equal(new Set(receiver.calls.map((c) => c.headers["x-webhook-id"])).size, 3);
  });

  test("a worker that stops mid-delivery: the lease expires, the attempt counts, the event is sent again", async () => {
    const file = freshFile();
    const crashed = new outboxMod.FileOutbox(file);
    await newEvent(crashed);
    const leased = await crashed.claimDue(T0, { limit: 10, leaseMs: 40_000, maxAttempts: 4 });
    assert.equal(leased.length, 1); // ...and the process dies before completing

    const restarted = new outboxMod.FileOutbox(file);
    assert.equal((await dispatcher.dispatchDue(restarted, cfg(), T0 + 10_000)).claimed, 0, "lease still valid");
    const s = await dispatcher.dispatchDue(restarted, cfg(), T0 + 41_000);
    const [e] = await restarted.events();
    assert.equal(s.delivered, 1);
    assert.equal(e!.attempts, 2, "the interrupted attempt is counted");
    assert.equal(e!.history[0]!.result, "interrupted");
  });
});

// ------------------------------------------------------------------ configuration
describe("configuration validation", () => {
  const load = (env: Record<string, string>) =>
    spawnSync(process.execPath, ["--import", "@swc-node/register/esm-register", "-e", "await import('./src/config/env.ts'); console.log('loaded')"], {
      cwd: path.resolve(import.meta.dirname, ".."),
      env: { ...process.env, ...env },
      encoding: "utf8",
    });

  test("off by default: no URL or secret needed", () => {
    const r = load({ SUBDIVISION_WEBHOOK_ENABLED: "false", SUBDIVISION_WEBHOOK_URL: "", SUBDIVISION_WEBHOOK_SECRET: "" });
    assert.equal(r.status, 0, r.stderr);
  });

  test("enabled: refuses a missing/insecure URL or a short secret, naming the variables but never printing secrets", () => {
    const secretValue = "short-secret-value";
    let r = load({ SUBDIVISION_WEBHOOK_ENABLED: "true", SUBDIVISION_WEBHOOK_URL: "http://app-b.example/hook", SUBDIVISION_WEBHOOK_SECRET: secretValue });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /SUBDIVISION_WEBHOOK_URL must use https/);
    assert.match(r.stderr, /SUBDIVISION_WEBHOOK_SECRET must be at least 32 characters/);
    assert.ok(!r.stderr.includes(secretValue), "the secret value is not printed");
    r = load({ SUBDIVISION_WEBHOOK_ENABLED: "true", SUBDIVISION_WEBHOOK_URL: "", SUBDIVISION_WEBHOOK_SECRET: SECRET });
    assert.match(r.stderr, /SUBDIVISION_WEBHOOK_URL is required/);
    r = load({ SUBDIVISION_WEBHOOK_ENABLED: "true", SUBDIVISION_WEBHOOK_URL: "https://app-b.example/hook", SUBDIVISION_WEBHOOK_SECRET: SECRET });
    assert.equal(r.status, 0, r.stderr);
    r = load({ SUBDIVISION_WEBHOOK_ENABLED: "true", SUBDIVISION_WEBHOOK_URL: "http://127.0.0.1:9999/hook", SUBDIVISION_WEBHOOK_SECRET: SECRET });
    assert.equal(r.status, 0, "http is allowed for localhost testing");
  });
});

// ------------------------------------------------------------------ worker lock
describe("worker lock (one dispatcher per data directory)", () => {
  test("a second owner is refused while the first holds it; free again after release", async () => {
    const file = path.join(dir, "lock-1", "worker.lock");
    const a = await lock.acquireWorkerLock(file, { staleMs: 120_000 });
    assert.ok(a);
    assert.equal(await lock.acquireWorkerLock(file, { staleMs: 120_000 }), null);
    assert.equal(await a!.heartbeat(), true);
    await a!.release();
    const b = await lock.acquireWorkerLock(file, { staleMs: 120_000 });
    assert.ok(b);
    await b!.release();
  });

  test("a stale lock (no heartbeat, or its process is gone) is taken over; the old owner learns it lost it", async () => {
    const file = path.join(dir, "lock-2", "worker.lock");
    let clock = T0;
    const a = await lock.acquireWorkerLock(file, { staleMs: 120_000, now: () => clock });
    clock += 121_000;
    const b = await lock.acquireWorkerLock(file, { staleMs: 120_000, now: () => clock });
    assert.ok(b, "taken over after 2 minutes without a heartbeat");
    assert.equal(await a!.heartbeat(), false);
    await b!.release();

    writeFileSync(file, JSON.stringify({ owner: "x", pid: 999_999_999, host: (await import("node:os")).hostname(), startedAt: "", heartbeatAt: new Date().toISOString() }));
    const c = await lock.acquireWorkerLock(file, { staleMs: 120_000 });
    assert.ok(c, "its process no longer exists on this host");
    await c!.release();
  });
});
