import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

/**
 * Durable webhook outbox in one JSON file (temp file + fsync + rename, so never torn). One worker owns it
 * (worker-lock.ts). Lifecycle: pending → delivering → delivered | pending (retry) | dead; at-least-once.
 */

export type EventStatus = "pending" | "delivering" | "delivered" | "dead";

export interface DeliveryAttempt {
  at: string;
  /** "HTTP 200", "HTTP 503", "timeout", "network error", "interrupted" */
  result: string;
  outcome: "delivered" | "retry" | "dead";
  durationMs: number | null;
}

export interface OutboxEvent {
  /** Stable: derived from the event type and the business key (see stableEventId). */
  id: string;
  type: string;
  /** Business key, e.g. the Transaction_ID. */
  key: string;
  createdAt: string;
  payload: Record<string, unknown>;
  status: EventStatus;
  attempts: number;
  nextAttemptAt: string | null;
  leaseUntil: string | null;
  lastAttemptAt: string | null;
  lastResult: string | null;
  /** Receiver's explanation or the network error, trimmed; never secrets. */
  lastError: string | null;
  deliveredAt: string | null;
  deadAt: string | null;
  deadReason: string | null;
  /** The most recent attempts (bounded). */
  history: DeliveryAttempt[];
}

/** A completed transaction whose event cannot be built yet (e.g. a UPI is still missing). */
export interface EnrichmentWait {
  key: string;
  since: string;
  lastCheckedAt: string;
  checks: number;
  reason: string;
}

interface OutboxState {
  version: 1;
  /** First time the webhook ran; transactions accepted before it are not eligible (unless configured). */
  trackingSince: string | null;
  events: OutboxEvent[];
  waiting: Record<string, EnrichmentWait>;
}

const HISTORY_LIMIT = 20;
const empty = (): OutboxState => ({ version: 1, trackingSince: null, events: [], waiting: {} });
const clone = <T>(v: T): T => structuredClone(v);

export interface CompleteInput {
  at: number;
  result: string;
  outcome: "delivered" | "retry" | "dead";
  durationMs: number | null;
  error?: string | null;
  nextAttemptAt?: number;
  deadReason?: string;
}

export class FileOutbox {
  private state: OutboxState | null = null;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(readonly file: string) {}

  /** Run `fn` with exclusive access to the state; persist when it says so. Errors leave the file unchanged. */
  private exclusive<T>(fn: (s: OutboxState) => { value: T; changed: boolean } | Promise<{ value: T; changed: boolean }>): Promise<T> {
    const run = this.chain.then(async () => {
      const current = await this.load();
      const working = clone(current);
      const { value, changed } = await fn(working);
      if (changed) {
        await this.write(working);
        this.state = working;
      }
      return clone(value);
    });
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async load(): Promise<OutboxState> {
    if (this.state) return this.state;
    let raw: string;
    try {
      raw = await readFile(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.state = empty();
      return this.state;
    }
    const parsed = JSON.parse(raw) as OutboxState; // a corrupt outbox throws: never replaced with an empty one
    if (parsed.version !== 1 || !Array.isArray(parsed.events)) throw new Error(`Unrecognised webhook outbox format in ${this.file}`);
    this.state = { ...empty(), ...parsed, waiting: parsed.waiting ?? {} };
    return this.state;
  }

  private async write(state: OutboxState): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
    const handle = await open(tmp, "w");
    try {
      await handle.writeFile(JSON.stringify(state, null, 1), "utf8");
      await handle.sync(); // on disk before it replaces the old file
    } finally {
      await handle.close();
    }
    try {
      await rename(tmp, this.file);
    } catch (error) {
      await rm(tmp, { force: true });
      throw error;
    }
  }

  /** The moment tracking began; set (and persisted) on first call. */
  trackingSince(now: number): Promise<string> {
    return this.exclusive((s) => {
      if (s.trackingSince) return { value: s.trackingSince, changed: false };
      s.trackingSince = new Date(now).toISOString();
      return { value: s.trackingSince, changed: true };
    });
  }

  /** Create the event unless one with this id exists (idempotent). Clears the key's enrichment wait. */
  createEvent(input: { id: string; type: string; key: string; payload: Record<string, unknown>; now: number }): Promise<{ created: boolean; event: OutboxEvent }> {
    return this.exclusive<{ created: boolean; event: OutboxEvent }>((s) => {
      const existing = s.events.find((e) => e.id === input.id);
      if (existing) return { value: { created: false, event: existing }, changed: false };
      const at = new Date(input.now).toISOString();
      const event: OutboxEvent = {
        id: input.id,
        type: input.type,
        key: input.key,
        createdAt: at,
        payload: input.payload,
        status: "pending",
        attempts: 0,
        nextAttemptAt: at,
        leaseUntil: null,
        lastAttemptAt: null,
        lastResult: null,
        lastError: null,
        deliveredAt: null,
        deadAt: null,
        deadReason: null,
        history: [],
      };
      s.events.push(event);
      delete s.waiting[input.key.toLowerCase()];
      return { value: { created: true, event }, changed: true };
    });
  }

  /** Lease the due events (an expired lease counts as an interrupted attempt). The lease is saved before sending. */
  claimDue(now: number, opts: { limit: number; leaseMs: number; maxAttempts: number }): Promise<OutboxEvent[]> {
    return this.exclusive((s) => {
      const at = new Date(now).toISOString();
      let changed = false;
      for (const e of s.events) {
        if (e.status === "delivering" && e.leaseUntil && Date.parse(e.leaseUntil) <= now) {
          e.attempts += 1;
          e.lastResult = "interrupted";
          e.lastError = "The delivery did not finish (the worker stopped); sending again.";
          const interrupted: DeliveryAttempt = { at, result: "interrupted", outcome: e.attempts >= opts.maxAttempts ? "dead" : "retry", durationMs: null };
          e.history = [...e.history, interrupted].slice(-HISTORY_LIMIT);
          e.leaseUntil = null;
          if (e.attempts >= opts.maxAttempts) Object.assign(e, { status: "dead", deadAt: at, deadReason: `Gave up after ${e.attempts} attempts`, nextAttemptAt: null });
          else Object.assign(e, { status: "pending", nextAttemptAt: at });
          changed = true;
        }
      }
      const due = s.events
        .filter((e) => e.status === "pending" && e.nextAttemptAt && Date.parse(e.nextAttemptAt) <= now)
        .sort((a, b) => Date.parse(a.nextAttemptAt!) - Date.parse(b.nextAttemptAt!))
        .slice(0, opts.limit);
      for (const e of due) {
        e.status = "delivering";
        e.leaseUntil = new Date(now + opts.leaseMs).toISOString();
        changed = true;
      }
      return { value: due, changed };
    });
  }

  /** Record the outcome of an attempt on a leased event. Ignored if the event is no longer leased. */
  complete(id: string, r: CompleteInput): Promise<OutboxEvent | null> {
    return this.exclusive((s) => {
      const e = s.events.find((x) => x.id === id);
      if (!e || e.status !== "delivering") return { value: null, changed: false };
      const at = new Date(r.at).toISOString();
      e.attempts += 1;
      e.lastAttemptAt = at;
      e.lastResult = r.result;
      e.lastError = r.error ?? null;
      e.leaseUntil = null;
      e.history = [...e.history, { at, result: r.result, outcome: r.outcome, durationMs: r.durationMs }].slice(-HISTORY_LIMIT);
      if (r.outcome === "delivered") Object.assign(e, { status: "delivered", deliveredAt: at, nextAttemptAt: null });
      else if (r.outcome === "dead") Object.assign(e, { status: "dead", deadAt: at, deadReason: r.deadReason ?? r.result, nextAttemptAt: null });
      else Object.assign(e, { status: "pending", nextAttemptAt: new Date(r.nextAttemptAt ?? r.at).toISOString() });
      return { value: e, changed: true };
    });
  }

  /** Put a dead-lettered event back in the queue (an administrator fixed the cause). */
  replay(id: string, now: number): Promise<OutboxEvent | null> {
    return this.exclusive((s) => {
      const e = s.events.find((x) => x.id === id);
      if (!e || e.status !== "dead") return { value: null, changed: false };
      Object.assign(e, { status: "pending", attempts: 0, nextAttemptAt: new Date(now).toISOString(), deadAt: null, deadReason: null, leaseUntil: null });
      return { value: e, changed: true };
    });
  }

  hasEvent(id: string): Promise<boolean> {
    return this.exclusive((s) => ({ value: s.events.some((e) => e.id === id), changed: false }));
  }

  events(filter: { status?: EventStatus } = {}): Promise<OutboxEvent[]> {
    return this.exclusive((s) => ({ value: s.events.filter((e) => !filter.status || e.status === filter.status), changed: false }));
  }

  /** Record that a key's event is waiting for complete data (one entry per key, updated each check). */
  markWaiting(key: string, reason: string, now: number): Promise<EnrichmentWait> {
    return this.exclusive((s) => {
      const k = key.toLowerCase();
      const at = new Date(now).toISOString();
      const previous = s.waiting[k];
      s.waiting[k] = { key, since: previous?.since ?? at, lastCheckedAt: at, checks: (previous?.checks ?? 0) + 1, reason };
      return { value: s.waiting[k]!, changed: true };
    });
  }

  waiting(): Promise<EnrichmentWait[]> {
    return this.exclusive((s) => ({ value: Object.values(s.waiting), changed: false }));
  }

  /** Test hook: forget the in-memory copy, as a restarted process would. */
  forgetCache(): void {
    this.state = null;
  }
}
