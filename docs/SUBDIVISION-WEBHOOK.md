# Subdivision completion webhook (GIS → App B)

When a LAIS **Subdivision** transaction is posted in ArcGIS (its change reaches `sde.DEFAULT`), GIS sends an HTTPS POST to an external application ("App B") with the original `Transaction_ID`, the original parcel and every resulting parcel with all its attributes and its UPI.

- Scope: `Subdivision` only. Merge, CorrectBoundaries and CreatePlot never produce an event.
- Trigger: the GIS stage moving from `InReview` to `Posted`. Nothing is sent while a transaction is `InReview`, and nothing for `Closed` (version removed without posting).
- Delivery is **at least once**: App B must accept the same event more than once and process it once (deduplicate by `event_id`).
- Switched off by default (`SUBDIVISION_WEBHOOK_ENABLED=false`).

## Contract for App B (version 1.0)

**Request:** `POST <your URL>`, `Content-Type: application/json`, UTF-8.

| Header | Meaning |
| --- | --- |
| `X-Webhook-Id` | The event id (same as `event_id`). Stable: the same transaction always has the same id, and every retry carries it. |
| `X-Webhook-Event` | `subdivision.completed` |
| `X-Webhook-Version` | `1.0` (contract version; a breaking change gets a new major version) |
| `X-Webhook-Timestamp` | Unix time in seconds when this attempt was signed |
| `X-Webhook-Signature` | `v1=<hex>`; during a key change two values, comma-separated |
| `X-Webhook-Attempt` | 1 for the first attempt, then 2, 3… |
| `User-Agent` | `Rwanda-Parcel-Fabric-Webhook/1.0` |

**Verifying the signature (required):**
1. Read the **raw** request body (before JSON parsing).
2. Compute `HMAC-SHA256(secret, X-Webhook-Timestamp + "." + rawBody)` as lower-case hex.
3. Accept if it equals any `v1=` value in `X-Webhook-Signature` (constant-time comparison), and the timestamp is within 5 minutes of your clock. Otherwise answer `401`.

```js
// Node.js reference
const crypto = require("crypto");
function verify(rawBody, headers, secret) {
  const ts = Number(headers["x-webhook-timestamp"]);
  if (!Number.isInteger(ts) || Math.abs(Date.now() / 1000 - ts) > 300) return false;
  const expected = crypto.createHmac("sha256", secret).update(`${ts}.${rawBody}`).digest("hex");
  return String(headers["x-webhook-signature"]).split(",").some((p) => {
    const v = p.trim().replace(/^v1=/, "");
    return v.length === expected.length && crypto.timingSafeEqual(Buffer.from(v), Buffer.from(expected));
  });
}
```

**How to answer:**

| App B answers | GIS does |
| --- | --- |
| any `2xx` (also for an event you already processed) | delivered; never sent again |
| `408`, `425`, `429`, `5xx`, timeout (10 s), connection error | retries later with the same `event_id`: exponential backoff with jitter (about 30 s, 1, 2, 4… minutes, at most 6 hours apart), honouring `Retry-After`; up to 12 attempts (about a day), then dead-letter |
| `3xx`, any other `4xx` (e.g. 400, 401, 404, 409, 422) | permanent: dead-lettered at once, not retried. An administrator can replay it after the cause is fixed. Redirects are not followed. |

Answer quickly (store the event, answer `200`, process afterwards). A short JSON `{"message": "…"}` on errors is recorded for the GIS administrators.

**Body:**

```json
{
  "event_id": "1f0c2a8e-4b1d-5a3c-9e2f-7d6b5a4c3b2a",
  "event_type": "subdivision.completed",
  "event_version": "1.0",
  "created_at": "2026-11-27T09:20:04.512Z",
  "data": {
    "Transaction_ID": "LAIS-SUB-2026-00125",
    "Transaction_Type": "Subdivision",
    "Transaction_Date": "2026-11-24T08:30:00+02:00",
    "Transaction_Status": null,
    "version_name": "qt_testing.SUBV-LAIS-SUB-2026-00125-20261124",
    "completed_at": "2026-11-27T09:15:00.000Z",
    "detected_at": "2026-11-27T09:20:03.117Z",
    "detected_via": "record",
    "records": [
      { "global_id": "{7F242D4F-E063-4644-A898-D06B366D53B4}", "name": "SUBV-LAIS-SUB-2026-00125-20261124", "recorded_date": "2026-11-27T00:00:00.000Z" }
    ],
    "original_parcel": {
      "UPI": "1/02/13/02/1001",
      "object_id": 3289,
      "global_id": "{10A2731D-D912-42B9-9EA2-1BF02F5A912D}",
      "current": false,
      "area_sqm": 1570.96,
      "attributes": { "objectid": 3289, "name": "1/02/13/02/1001", "retiredbyrecord": "{7F242D4F-…}", "…": "every Plot field" }
    },
    "resulting_parcels": [
      {
        "UPI": "1/02/13/02/1101",
        "object_id": 8030,
        "global_id": "{B48C7050-494C-4538-B8E7-569376E8D956}",
        "current": true,
        "area_sqm": 785.48,
        "attributes": {
          "objectid": 8030, "name": "1/02/13/02/1101", "createdbyrecord": "{7F242D4F-…}", "retiredbyrecord": null,
          "province": "Kigali City", "district": "Gasabo", "sector": "Remera", "cell": "Nyarutarama", "village": "Kamahwa",
          "size": 785.48, "created_user": "editor", "created_date": "2026-11-27T09:10:36.000Z",
          "last_edited_date": "2026-11-27T09:15:00.000Z", "globalid": "{B48C7050-…}", "…": "every Plot field"
        },
        "geometry": { "type": "Polygon", "coordinates": [[[30.1000455, -1.9497315], ["…"], [30.1000455, -1.9497315]]] }
      },
      { "UPI": "1/02/13/02/1102", "…": "the second resulting parcel, same shape" }
    ]
  }
}
```

- `original_parcel`: the parcel LAIS sent; after the subdivision it is historic (`current: false`) and keeps its UPI.
- `resulting_parcels`: every parcel the subdivision produced (2 or more), sorted by UPI. `current` is false only if one was itself retired before GIS noticed (e.g. subdivided again).
- `attributes`: every field of the GIS Plot layer, exactly as stored in `sde.DEFAULT`; `null` when GIS has no value. Dates are ISO 8601 UTC. Field names are GIS's own (e.g. `name` holds the UPI). New fields added to the GIS layer appear without a version change; removing or renaming fields is a breaking change announced in advance.
- `area_sqm`: the area of the parcel's boundary (GIS shape area, `Shape__Area`), in m², 2 decimals, so it always matches `geometry` and the resulting parcels add up to the original. The stored `size` attribute is sent unchanged in `attributes` but can be out of date (seen live: an original with `size` 6136.92 whose boundary is 3141.93 m²); `area_sqm` falls back to `size` only when GIS has no shape area.
- `geometry`: GeoJSON (RFC 7946), WGS 84 longitude/latitude, outer rings counter-clockwise.
- `completed_at`: the latest edit time of the resulting parcels (null without editor tracking). `detected_at`: when GIS noticed the posted change.

**What App B must configure:** an HTTPS endpoint; the shared secret (at least 32 random characters, exchanged out of band); signature and timestamp checks; deduplication by `event_id`; a `2xx` answer for events it has already processed. If App B restricts callers by IP, allow the GIS API server's outgoing address.

## How it works in GIS

```
LAIS transaction (ledger) ──► reconciler (every 5 min) ──► durable outbox ──► dispatcher (every 15 s) ──► App B
                               uses transactionStatus /        file, atomic,      HMAC, timeout, backoff,
                               detectCompletion (DEFAULT)      stable ids         dead-letter, audit
```

1. **Reconciler** ([subdivision-completion.ts](../server/src/modules/webhooks/domain/subdivision-completion.ts)): for each Subdivision in the LAIS ledger with a version, accepted since tracking began, and without an event, it runs the existing status logic (`transactionStatus`, which detects completion in `sde.DEFAULT` by the record named after the version or by parcel lineage). It runs on its own schedule, so it does not depend on LAIS polling, and its first run after a restart picks up everything posted while the server was down. `Closed` transactions are not checked again.
2. **Event build**: reads the original and resulting parcels from `sde.DEFAULT` (`outFields=*`, geometry in EPSG:4326). It refuses to send an incomplete result: fewer than 2 resulting parcels, a resulting parcel without UPI or boundary, or an original parcel that the posted change did not retire. Such a transaction **waits** (listed under `/api/webhooks/subdivision/waiting`) and is checked again on every run until the data is complete.
3. **Outbox** ([outbox.ts](../server/src/modules/webhooks/domain/outbox.ts)): `data/lais/webhooks/subdivision-outbox.json`. The event id is derived from the Transaction_ID, so it is created once even if two runs or two restarts race. Every change is written to a temp file, fsynced, then renamed over the old file (a crash leaves the old or the new file, never a torn one); a corrupt file stops the worker instead of being replaced.
4. **Dispatcher** ([dispatcher.ts](../server/src/modules/webhooks/domain/dispatcher.ts)): leases due events (lease persisted before sending), signs, posts with a timeout, records the outcome. A lease that expires because the process died counts as an attempt and the event is sent again.
5. **Worker** ([worker.ts](../server/src/modules/webhooks/domain/worker.ts)): background timers in the API process; nothing in editing, posting or the LAIS API waits for it. Only the process holding `data/lais/webhooks/worker.lock` runs (exclusive file creation plus heartbeat; a stale lock is taken over).

**Audit log:** `webhook.event.created`, `webhook.delivery` (success, or attempt with the retry time), `webhook.dead-letter`, `webhook.replay`. Logs carry event id, transaction, attempt, HTTP status and duration; never the secret or the signature.

**Administration** (Administrator role): `GET /api/webhooks/subdivision/events?status=dead`, `GET /api/webhooks/subdivision/waiting`, `POST /api/webhooks/subdivision/events/{eventId}/replay` (dead-lettered events only).

## Configuration (`server/.env`)

| Variable | Default | |
| --- | --- | --- |
| `SUBDIVISION_WEBHOOK_ENABLED` | `false` | `true` starts the worker |
| `SUBDIVISION_WEBHOOK_URL` | | App B's endpoint; `https://` required (`http://` only for localhost) |
| `SUBDIVISION_WEBHOOK_SECRET` | | shared HMAC key, at least 32 characters |
| `SUBDIVISION_WEBHOOK_SECRET_PREVIOUS` | | only during a key change: requests carry a signature for both keys |
| `SUBDIVISION_WEBHOOK_TIMEOUT_MS` | `10000` | per attempt |
| `SUBDIVISION_WEBHOOK_MAX_ATTEMPTS` | `12` | then dead-letter |
| `SUBDIVISION_WEBHOOK_BACKOFF_BASE_MS` / `_MAX_MS` | `30000` / `21600000` | backoff start and cap |
| `SUBDIVISION_WEBHOOK_RECONCILE_INTERVAL_MS` | `300000` | GIS check every 5 minutes |
| `SUBDIVISION_WEBHOOK_DISPATCH_INTERVAL_MS` | `15000` | delivery check every 15 seconds |
| `SUBDIVISION_WEBHOOK_SINCE` | empty | ISO date: only transactions accepted since then. Empty: since the webhook was first enabled (switching it on does not replay past subdivisions) |

The server refuses to start with the webhook enabled but no URL, a non-HTTPS URL, or a short secret (only variable names are printed, never values).

**Key change without downtime:** put the old key in `SUBDIVISION_WEBHOOK_SECRET_PREVIOUS` and the new one in `SUBDIVISION_WEBHOOK_SECRET`, restart; App B switches to the new key; empty `_PREVIOUS` and restart.

## Testing without App B

`npm --prefix server run mock-app-b` starts a stand-in receiver on `http://127.0.0.1:4011/subdivision` that does what App B must do: verifies the signature (401 if wrong), ignores an `event_id` it already processed, and answers 200. It prints one line per delivery (`signature VALID/INVALID`, transaction, original → resulting UPIs) and appends each one to `server/data/mock-app-b/received.jsonl`.

| `MOCK_APP_B_MODE` | Behaviour | Expected in GIS |
| --- | --- | --- |
| `ok` (default) | 200 | `webhook.delivery` success |
| `fail-first:N` | 503 for the first N deliveries of each event, then 200 | retries with growing delay, then delivered |
| `busy` | 429 with `Retry-After: 120` | next attempt no earlier than 2 minutes |
| `refuse` | 400 | dead-lettered at once; replay after fixing |
| `slow` | answers after 15 s | timeout, retried |

`MOCK_APP_B_SECRET` must equal `SUBDIVISION_WEBHOOK_SECRET`; a different value simulates an App B with the wrong key (401 → dead letter). To test on a running server without touching real data, point `LAIS_DATA_DIR` and `AUDIT_DIR` at a copy: enabling the webhook records when tracking began in the outbox.

## Deployment

- One API instance (as for the LAIS ledger). Back up `server/data/lais/` (ledger and outbox) with the server.
- The API needs outbound HTTPS to App B.
- Enable only after App B's endpoint verifies signatures and deduplicates by `event_id`.

## Known limitations

- **Single instance.** The outbox and the LAIS ledger are files written by one process. The worker lock stops a second process on the same machine from sending, but two API instances behind a load balancer are not supported. Running several instances needs shared transactional storage: the smallest step is one PostgreSQL table for the outbox (and one for the ledger), with `INSERT … ON CONFLICT (event_id) DO NOTHING` for creation and `SELECT … FOR UPDATE SKIP LOCKED` for leasing. Redis or Kafka are not needed at this volume.
- **At least once.** A crash between App B's `2xx` and GIS recording it sends the event again.
- **Whole-file writes.** Every outbox change rewrites the file; fine for thousands of events, not for millions. Delivered events are kept (no automatic pruning yet).
- **Lineage detection.** A subdivision whose record is not named after its version is found by parcel lineage. If an unrelated later edit retires the transaction's parcel before the subdivision is posted, GIS could attribute that edit to the transaction; the event is then refused only if the result does not look like a subdivision of that parcel.
- **Attributes are sent as stored.** If GIS has no location, area or UPI on a parcel, App B receives `null` (the event waits only for a missing UPI or boundary).
