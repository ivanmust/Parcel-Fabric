# LAIS ↔ GIS transaction integration

## Design (implemented)

LAIS transactions are stored **on the existing Plot layer** (`ParcelFabric/FeatureServer/17`), not in a separate table, and **only inside a named branch version** — never in `sde.DEFAULT`.

```
LAIS ──POST /api/lais/transactions (X-API-Key)──► GIS Integration API
                                                   1. validate the request (UPI or UPIs; parcel count per type)
                                                   2. each UPI = exactly one CURRENT Plot in sde.DEFAULT
                                                      (retired UPI → UPI_EXPIRED + the current UPIs that replaced it)
                                                   2b. Merge: the parcels are neighbours, one connected group
                                                      (ArcGIS relation F***1****: boundaries share a line)
                                                   3. Transaction_ID not already recorded (DEFAULT or its version)
                                                   4. create PUBLIC version  {TYPE}-{CASE_NUMBER}-{DATE}
                                                      e.g. SUBV-CASE123-20261125
                                                   5. startReading → startEditing → applyEdits(gdbVersion, sessionID)
                                                      → stopEditing(saveEdits=true) → stopReading
GIS editors ── Version Manager ▸ LAIS transactions ── open version ▸ review ▸ reconcile/post
```

Code: [server/src/lais/laisService.ts](../server/src/lais/laisService.ts) (workflow), [server/src/lais/arcgisClient.ts](../server/src/lais/arcgisClient.ts) (token + Referer), [server/src/routes/lais.ts](../server/src/routes/lais.ts) (HTTP), tests in [server/test/lais.test.ts](../server/test/lais.test.ts) (`npm test` in `server/`, fake ArcGIS, no network).

## Parcels per transaction

`UPI` (one parcel) or `UPIs` (a list, max 20), not both.

| Type | Parcels | Extra check |
| --- | --- | --- |
| Subdivision | exactly 1 | — |
| Merge | 2 or more | neighbours: one connected group sharing boundary lines (corner contact doesn't count); same rule as the web editor's Merge |
| CorrectBoundaries | 1 or more | — |
| CreatePlot | 0 or more | — |

In `attributes` mode the transaction fields are written on every listed parcel. Resending the same parcels in a different order is the same transaction.

## API key change without downtime

Put the old key in `LAIS_API_KEY_PREVIOUS` and the new one in `LAIS_API_KEY`, restart; both work (the log warns while the old one is used). When LAIS has switched, empty `LAIS_API_KEY_PREVIOUS` and restart.

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
| `version_name` | fully qualified version name, e.g. `svc_lais.SUBV-LAIS-SUB-2026-00125-20261124` |

Version name = `{TYPE}-{CASE_NUMBER}-{DATE}`: TYPE `SUBV` Subdivision · `MERG` Merge · `CORB` CorrectBoundaries · `CRPL` CreatePlot; CASE_NUMBER = `Transaction_ID` (characters other than letters, digits, `-`, `_` become `-`); DATE = `yyyyMMdd` of `Transaction_Date` as sent; at most 62 characters. Two different Transaction_IDs that map to the same name are refused with 409 rather than sharing a version. Codes live in `TYPE_CODES` in `server/src/lais/laisService.ts` (the editor dialog's filter in `LaisTransactionsDialog.tsx` must match).

Field names are resolved case-insensitively from the live layer metadata; the API refuses to run (503) if the layer is not branch versioned, a field is missing, or the `case_`/`version_status` domains lack `Yes`/`VersionCreated`.

## Safety properties

- `applyEdits` is only ever sent with `gdbVersion` + `sessionID` of the transaction's own version, as an attribute-only **update** of the one matched Plot. No adds, deletes or geometry changes. Nothing reconciles or posts.
- **Idempotency key = `Transaction_ID`** (kept in the ledger, which also stores the version name). Identical retry → 200 `duplicate: true`; same ID, different payload → 409. A retry after a failure reuses the version created by the failed attempt.
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
