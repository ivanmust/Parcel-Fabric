/**
 * Retry delay after a failed attempt: exponential (base × 2^(attempt−1)), capped, with "equal jitter"
 * (a random value between half and all of it) so many failed events do not retry in lockstep.
 * A Retry-After from the receiver raises the delay, still within the cap.
 */
export interface BackoffOptions {
  baseMs: number;
  maxMs: number;
  /** Injectable for tests; returns a number in [0, 1). */
  random?: () => number;
}

export function backoffDelay(attempt: number, opts: BackoffOptions, retryAfterMs?: number | null): number {
  const exponent = Math.min(Math.max(attempt - 1, 0), 30);
  const ceiling = Math.min(opts.maxMs, opts.baseMs * 2 ** exponent);
  const r = (opts.random ?? Math.random)();
  const jittered = Math.round(ceiling / 2 + (ceiling / 2) * r);
  return Math.min(opts.maxMs, Math.max(jittered, retryAfterMs ?? 0));
}

/** Retry-After as seconds or an HTTP date; null when absent or unreadable. */
export function parseRetryAfter(value: string | null, now: number): number | null {
  if (!value) return null;
  const v = value.trim();
  if (/^\d+$/.test(v)) return Number(v) * 1000;
  const at = Date.parse(v);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}
