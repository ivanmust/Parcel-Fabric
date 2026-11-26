/**
 * Stand-in for the LAIS "editing done" endpoint, for local testing until LAIS provides theirs.
 *
 *   npm run mock-lais
 *   then in server/.env:  LAIS_EDITING_DONE=true
 *                         LAIS_WEBHOOK_URL=http://127.0.0.1:4010/editing-done
 *                         LAIS_WEBHOOK_KEY=<same as MOCK_LAIS_KEY below>
 *
 * Settings (environment):
 *   MOCK_LAIS_PORT  default 4010
 *   MOCK_LAIS_KEY   the X-API-Key it accepts (default "mock-lais-key")
 *   MOCK_LAIS_MODE  ok (200, default) | fail-once (503 on the first attempt of each event, then 200)
 *                   | refuse (400 with a message) | slow (answers after 15 s, longer than GIS waits)
 * Every notification received is printed and appended to data/mock-lais/received.jsonl.
 */
import { createServer } from "node:http";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

const port = Number(process.env.MOCK_LAIS_PORT ?? 4010);
const key = process.env.MOCK_LAIS_KEY ?? "mock-lais-key";
const mode = process.env.MOCK_LAIS_MODE ?? "ok";
const out = path.resolve("data/mock-lais/received.jsonl");
const seen = new Map<string, number>();

const send = (res: import("node:http").ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", async () => {
    if (req.method !== "POST") return send(res, 405, { message: "Use POST." });
    if (req.headers["x-api-key"] !== key) return send(res, 401, { message: "Wrong or missing X-API-Key." });
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(raw);
    } catch {
      return send(res, 400, { message: "The body is not JSON." });
    }
    const eventId = String(body.event_id ?? "");
    const count = (seen.get(eventId) ?? 0) + 1;
    seen.set(eventId, count);
    const parcels = Array.isArray(body.proposed_parcels) ? body.proposed_parcels.length : 0;
    console.log(`[mock LAIS] ${new Date().toISOString()} ${body.event_type} ${body.Transaction_ID} event ${eventId} (delivery ${count}): ${parcels} proposed parcel(s), record ${body.record_name}`);
    await mkdir(path.dirname(out), { recursive: true });
    await appendFile(out, `${JSON.stringify({ received_at: new Date().toISOString(), headers: { "x-gis-event-id": req.headers["x-gis-event-id"], "x-gis-event-type": req.headers["x-gis-event-type"] }, body })}\n`);

    if (mode === "refuse") return send(res, 400, { message: "Mock LAIS refuses this notification (MOCK_LAIS_MODE=refuse)." });
    if (mode === "fail-once" && count === 1) return send(res, 503, { message: "Mock LAIS is temporarily unavailable." });
    if (mode === "slow") await new Promise((r) => setTimeout(r, 15_000));
    send(res, 200, { received: true, duplicate: count > 1 });
  });
}).listen(port, "127.0.0.1", () => console.log(`[mock LAIS] listening on http://127.0.0.1:${port}/editing-done (mode ${mode}); writing ${out}`));
