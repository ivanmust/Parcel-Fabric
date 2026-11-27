import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/** HMAC-SHA256 of `${timestamp}.${body}`; X-Webhook-Signature carries `v1=<hex>` per active key. */
export const SIGNATURE_SCHEME = "v1";

export function signPayload(secret: string, timestamp: number, body: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`, "utf8").digest("hex");
}

export function signatureHeader(secrets: string[], timestamp: number, body: string): string {
  return secrets
    .filter((s) => s.length > 0)
    .map((s) => `${SIGNATURE_SCHEME}=${signPayload(s, timestamp, body)}`)
    .join(",");
}

/** Reference verification for receivers: any v1 signature matches a key and the timestamp is within the tolerance. */
export function verifySignature(header: string, secrets: string[], timestamp: number, body: string, nowSeconds: number, toleranceSeconds = 300): boolean {
  if (!Number.isInteger(timestamp) || Math.abs(nowSeconds - timestamp) > toleranceSeconds) return false;
  const given = header
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.startsWith(`${SIGNATURE_SCHEME}=`))
    .map((p) => p.slice(SIGNATURE_SCHEME.length + 1));
  const digest = (hex: string) => createHash("sha256").update(hex).digest();
  return secrets.some((secret) => {
    const expected = digest(signPayload(secret, timestamp, body));
    return given.some((g) => timingSafeEqual(digest(g), expected));
  });
}

/** The same event type and key always give the same UUID-shaped id, so an event can never be created twice. */
export function stableEventId(eventType: string, key: string): string {
  const h = createHash("sha256").update(`${eventType}\u0000${key.toLowerCase()}`).digest("hex");
  // Shape as a UUID (version nibble 5-style, RFC 4122 variant) for receivers that store ids as UUIDs.
  const variant = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
