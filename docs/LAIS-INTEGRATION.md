# LAIS ↔ GIS transaction integration

## Design (implemented)

LAIS transactions are stored **on the existing Plot layer** (`ParcelFabric/FeatureServer/17`), not in a separate table, and **only inside a named branch version** — never in `sde.DEFAULT`.

```
LAIS ──POST /api/lais/transactions (X-API-Key)──► GIS Integration API
                                                   1. validate the request
                                                   2. exactly one Plot with name = UPI in sde.DEFAULT
                                                   3. Transaction_ID not already recorded (DEFAULT or its version)
                                                   4. create PUBLIC version  LAIS_<Transaction_ID>_<hash>
                                                   5. startReading → startEditing → applyEdits(gdbVersion, sessionID)
                                                      → stopEditing(saveEdits=true) → stopReading
GIS editors ── Version Manager ▸ LAIS transactions ── open version ▸ review ▸ reconcile/post
```

Code: [server/src/lais/laisService.ts](../server/src/lais/laisService.ts) (workflow), [server/src/lais/arcgisClient.ts](../server/src/lais/arcgisClient.ts) (token + Referer), [server/src/routes/lais.ts](../server/src/routes/lais.ts) (HTTP), tests in [server/test/lais.test.ts](../server/test/lais.test.ts) (`npm test` in `server/`, fake ArcGIS, no network).

## Write modes (`LAIS_WRITE_MODE`)

- **`version-only` (current default):** the LAIS ArcGIS account only **reads** GIS and **creates** the public version (steps 1–4). It makes no edit calls, so it needs no editing licence. The accepted transaction is kept in the server ledger `server/data/lais/transactions.json` (idempotency, duplicate detection, status). The version description says `LAIS <type> UPI <upi> <Transaction_ID>`; the fields below are left for GIS editors.
- **`attributes`:** additionally performs step 5 and writes the fields below on the Plot inside the version. Requires the Portal **Advanced Editing** user type extension on the LAIS account (without it ArcGIS refuses `startEditing`; the API then answers 503).

Status `stage`: `InReview` (version exists), `Posted` (fields found in sde.DEFAULT), `Closed` (version no longer exists — reconciled/posted or deleted by GIS; a resubmission does not recreate it).

## Plot layer fields written (inside the version, `attributes` mode only)

| Field | Value |
| --- | --- |
| `transaction_id` | LAIS `Transaction_ID` (≤ 50) |
| `transaction_type` | `Transaction_Type` — domain KGL_TransactionType |
| `transaction_status` | `Transaction_Status` **only if LAIS sends it** — domain KGL_TransactionStatus |
| `transaction_date` | `Transaction_Date` (stored as UTC) |
| `case_` | `Yes` (decided by the API; failed submissions write nothing) |
| `validation_message` | `Validated by the LAIS integration API` |
| `version_status` | `VersionCreated` |
| `version_name` | fully qualified version name, e.g. `svc_lais.LAIS_LAIS_SUB_2026_00125_1A2B3C4D` |

Field names are resolved case-insensitively from the live layer metadata; the API refuses to run (503) if the layer is not branch versioned, a field is missing, or the `case_`/`version_status` domains lack `Yes`/`VersionCreated`.

## Safety properties

- `applyEdits` is only ever sent with `gdbVersion` + `sessionID` of the transaction's own version, as an attribute-only **update** of the one matched Plot. No adds, deletes or geometry changes. Nothing reconciles or posts.
- **Idempotency key = version name** (derived from `Transaction_ID`). Identical retry → 200 `duplicate: true`; same ID, different payload → 409. A retry after a failure reuses the version created by the failed attempt.
- A failed edit stops the session with `saveEdits=false` and releases the read lock.
- Concurrent requests for the same `Transaction_ID` are serialised in-process.
- Every submission (accepted or rejected) is written to the audit log as `lais.transaction.submit`.

## Known limitations / decisions still open

- Two *different* Transaction_IDs for the same UPI get two versions; they will conflict at reconcile. Decide whether LAIS should be blocked from submitting a second transaction while one is in review.
- Once a version is posted and a later transaction overwrites `transaction_id` on the same Plot, the earlier ID can no longer be found (it lives only in history/archive).
- The in-process lock assumes one API instance. Run a single instance, or add a shared lock, before scaling out.
- The service account owns the versions. To reconcile/post them, GIS editors need the Portal privilege to manage versions they don't own (version administrator), or an administrator does it.

## Deployment checklist

- Public HTTPS URL behind a reverse proxy; set `trust proxy` for that proxy so rate limits see the LAIS IP; allow-list LAIS's IPs at the firewall.
- `NODE_ENV=production` (also turns off `/api/docs` unless `API_DOCS=true`).
- `LAIS_API_KEY` ≥ 32 random characters, shared with LAIS out of band. `LAIS_ARCGIS_REFERER` = the API's public origin.
- Service account: can query Layer 17, create versions and edit in its own versions.
