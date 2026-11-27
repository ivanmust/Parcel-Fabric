import { createHash, timingSafeEqual } from "node:crypto";
import { config } from "../../config/env.js";

export const API_KEY_HEADER = "x-api-key";
const MIN_KEY_LENGTH = 32;

/** Constant-time comparison; hashing first keeps the lengths from leaking. */
export function sameSecret(received: string | undefined, expected: string): boolean {
  if (!received) return false;
  const a = createHash("sha256").update(received).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

export type ApiKeyMatch = "current" | "previous" | null;

/**
 * Which configured key the request carries. The key does not expire; LAIS_API_KEY_PREVIOUS keeps an old
 * key working during a key change. Keys under 32 characters never match.
 */
export function matchApiKey(received: string | undefined): ApiKeyMatch {
  if (config.LAIS_API_KEY.length < MIN_KEY_LENGTH) return null;
  const keys = [config.LAIS_API_KEY, config.LAIS_API_KEY_PREVIOUS].filter((k) => k.length >= MIN_KEY_LENGTH);
  // Compare with every key so the timing doesn't reveal which one matched.
  const matches = keys.map((key) => sameSecret(received, key));
  if (matches[0]) return "current";
  return matches.some(Boolean) ? "previous" : null;
}
