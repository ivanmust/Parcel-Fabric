/**
 * Stand-in for App B's subdivision webhook receiver, for testing until App B provides theirs. It does
 * what docs/SUBDIVISION-WEBHOOK.md asks of App B: verify the signature, ignore an event_id it already
 * processed, and answer 2xx quickly.
 *
 *   npm run mock-app-b
 *   then in server/.env:  SUBDIVISION_WEBHOOK_ENABLED=true
 *                         SUBDIVISION_WEBHOOK_URL=http://127.0.0.1:4011/subdivision
 *                         SUBDIVISION_WEBHOOK_SECRET=<same as MOCK_APP_B_SECRET below>
 *
 * Settings (environment):
 *   MOCK_APP_B_PORT    default 4011
 *   MOCK_APP_B_SECRET  the shared secret it verifies with (default: a 40-character test value; also
 *                      accepts MOCK_APP_B_SECRET_PREVIOUS during a key change)
 *   MOCK_APP_B_MODE    ok (200, default) | fail-first:N (503 for the first N deliveries of each event, then 200)
 *                      | busy (429 with Retry-After: 120) | refuse (400) | slow (answers after 15 s)
 * Every delivery received is printed and appended to data/mock-app-b/received.jsonl.
 */
import { createServer, type ServerResponse } from "node:http";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { verifySignature } from "../modules/webhooks/domain/signing.js";

const port = Number(process.env.MOCK_APP_B_PORT ?? 4011);
const secrets = [process.env.MOCK_APP_B_SECRET ?? "mock-app-b-shared-secret-0123456789abcdef", process.env.MOCK_APP_B_SECRET_PREVIOUS ?? ""].filter(Boolean);
const mode = process.env.MOCK_APP_B_MODE ?? "ok";
const failFirst = /^fail-first:(\d+)$/.exec(mode);
const out = path.resolve("data/mock-app-b/received.jsonl");
const deliveries = new Map<string, number>();
const processed = new Set<string>();

const send = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
};
const header = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value) ?? "";

createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", async () => {
    if (req.method !== "POST") return send(res, 405, { message: "Use POST." });
    const eventId = header(req.headers["x-webhook-id"]);
    const attempt = header(req.headers["x-webhook-attempt"]);
    const timestamp = Number(header(req.headers["x-webhook-timestamp"]));
    const signatureOk = verifySignature(header(req.headers["x-webhook-signature"]), secrets, timestamp, raw, Math.floor(Date.now() / 1000));
    const count = (deliveries.get(eventId) ?? 0) + 1;
    deliveries.set(eventId, count);

    type Parcel = { UPI?: string | null };
    type Body = { data?: { Transaction_ID?: string; original_parcel?: Parcel; resulting_parcels?: Parcel[] } };
    let body: Body | null;
    try {
      body = JSON.parse(raw) as Body;
    } catch {
      body = null;
    }
    const d = body?.data ?? {};
    const resulting = Array.isArray(d.resulting_parcels) ? d.resulting_parcels.map((p) => p.UPI).join(", ") : "";
    const duplicate = processed.has(eventId);
    console.log(
      `[mock App B] ${new Date().toISOString()} ${header(req.headers["x-webhook-event"])} v${header(req.headers["x-webhook-version"])} event ${eventId} attempt ${attempt}: ` +
        `signature ${signatureOk ? "VALID" : "INVALID"}; ${d.Transaction_ID ?? "?"}: ${d.original_parcel?.UPI ?? "?"} → ${resulting}${duplicate ? " (already processed: ignored)" : ""}`,
    );
    await mkdir(path.dirname(out), { recursive: true });
    await appendFile(out, `${JSON.stringify({ received_at: new Date().toISOString(), signature_valid: signatureOk, headers: Object.fromEntries(Object.entries(req.headers).filter(([k]) => k.startsWith("x-webhook-") || k === "user-agent")), body })}\n`);

    if (!signatureOk) return send(res, 401, { message: "Invalid or expired signature." });
    if (!body) return send(res, 400, { message: "The body is not JSON." });
    if (duplicate) return send(res, 200, { received: true, duplicate: true });
    if (mode === "refuse") return send(res, 400, { message: "Mock App B refuses this event (MOCK_APP_B_MODE=refuse)." });
    if (mode === "busy") return send(res, 429, { message: "Mock App B is busy." }, { "Retry-After": "120" });
    if (failFirst && count <= Number(failFirst[1])) return send(res, 503, { message: "Mock App B is temporarily unavailable." });
    if (mode === "slow") await new Promise((r) => setTimeout(r, 15_000));
    processed.add(eventId);
    send(res, 200, { received: true });
  });
}).listen(port, "127.0.0.1", () => console.log(`[mock App B] listening on http://127.0.0.1:${port}/subdivision (mode ${mode}); writing ${out}`));
