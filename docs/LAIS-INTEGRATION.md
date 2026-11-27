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

Code: [server/src/modules/lais/](../server/src/modules/lais/) (domain: submit, status, completion; repositories: Plot layer, versions, ledger), [arcgis-client.ts](../server/src/common/arcgis/arcgis-client.ts) (token + Referer), [lais-transactions.controller.ts](../server/src/modules/lais/controllers/lais-transactions.controller.ts) (HTTP), tests in [server/test/lais.test.ts](../server/test/lais.test.ts) (`npm test` in `server/`, fake ArcGIS, no network).

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

## How LAIS learns that GIS finished (both write modes)

LAIS asks; the API never calls LAIS. `GET /api/lais/transactions/{Transaction_ID}` for one transaction, or `GET /api/lais/transactions?updatedSince=…` for the dashboard (pass the previous response's `next_updated_since`; only transactions whose stage, result or warnings changed come back).

`stage`:
- `InReview`: the change is not in sde.DEFAULT yet.
- `Posted`: an editor did the work in the version and Reconcile & Post put it in sde.DEFAULT. `result` gives the resulting `parcels` (UPI, area, location, `current`), the `retired_parcels` (expired UPIs) and the Parcel Fabric `records`. The parcels are fixed when the API first sees the change. Their attributes are re-read on every call, so a UPI that GIS assigns later shows up and the `UPI_MISSING` warning goes.
- `Closed`: the version is gone and the change never reached sde.DEFAULT (cancelled). A resubmission does not recreate it.

How the API finds the change, reading sde.DEFAULT only, with no licence needed:
1. **The record named after the version.** Editors name the Parcel Fabric record like the version, e.g. record `SUBV-000008-20261120`; a record with the Transaction_ID in `transaction_id` also counts. A record reaches DEFAULT only when its version is posted. Its parcels are the ones it created; the ones it retired are history. This is the only signal for a CreatePlot without a parent.
2. **Lineage.** The transaction's parcels (ObjectIDs kept at submission) are retired in DEFAULT. The result is the current parcels that the retiring record created over them.
3. **CorrectBoundaries** edits parcels in place: its posted record, or in `attributes` mode its posted fields, means the corrected parcels are the result.

**Editors:** name the record after the version, and run **Assign UPIs** before posting. Otherwise LAIS sees `UPI_MISSING`. A CorrectBoundaries without a record named after the version, posted in `version-only` mode, is never detected as Posted.

`area_sqm` comes from `size`, or the shape area when `size` is empty. The location fields are empty on parcels the editor creates unless the editor fills them.

## "Editing done": GIS tells LAIS the work is ready for approval (built; switched off)

The approval flow agreed with LAIS on 2026-11-26:
1. LAIS submits the transaction; GIS creates its version (above).
2. The GIS editor does the work in the version, saves it, and presses **Editing done** (Version Manager ▸ LAIS transactions). GIS sends the proposed parcels to an endpoint LAIS hosts. **Built.**
3. The registrar decides in LAIS, which calls GIS (**built**, tested against the fake GIS; live posting needs the licence):
   - `POST /api/lais/transactions/{id}/approve` `{ "event_id", "approved_by", "cell"? }`: GIS gives each new parcel its UPI inside the version (the next numbers of the parents' cell after the highest taken: by any parcel, current or historic, in sde.DEFAULT now or in the version — a version sees DEFAULT only as of its last reconcile — or reserved by another approval that has not finished; every page of the cell is read and checked against its count; approvals in one cell run one at a time), fills empty location fields from the parents, then reconciles and posts the version (conflicts abort; nothing is posted).
   - `POST /api/lais/transactions/{id}/reject` `{ "event_id", "rejected_by", "reason" }`: recorded and shown to the editor, who revises the work in the same version and presses Editing done again (a new `event_id`). Nothing in GIS changes.
4. The approve response is the transaction (stage `Posted`, result parcels) plus `approval.upis`: the UPI of each new parcel by `parcel_ref`.

**Rules:** LAIS decides on one notification (`event_id`); an older one is `EVENT_MISMATCH`. If the editor changed the work after sending it, approve refuses (`CHANGED_SINCE_SUBMISSION`) and the editor sends the revision. A failed approval (`RECONCILE_CONFLICT`, `VERSION_IN_USE`, GIS down) can be repeated and reuses the same UPIs; a repeat after success is `409 ALREADY_APPROVED` with the UPIs in `data`. Parents in several cells (a Merge across cells) or a CreatePlot without parent and cell name: `CELL_REQUIRED`, approve again with `cell`. Audit: `lais.transaction.approve`, `lais.transaction.reject`, `lais.transaction.post`.

**Licence:** the LAIS ArcGIS account needs the **Advanced Editing** user type extension; without it approve answers `503 GIS_NOT_CONFIGURED` and nothing is posted. Checked 2026-11-26 (evening): `qt_testing` now has it (GIS Professional Advanced, Publisher role); an edit in a version and a reconcile without post were accepted live, and a dry run on PS-E2E-LAIS-ED-192733 matched the work sent and would assign 1/02/13/02/3875–3876. The first real post is a change to DEFAULT: do it with QT on an agreed parcel.

**Switch:** `LAIS_EDITING_DONE=false` by default. Keep it off until steps 2 and 3 both work end to end. With it on, Reconcile & post is not offered for LAIS versions (they are posted at approval), and the editors' Assign UPIs step moves to approval.

**Settings:** `LAIS_WEBHOOK_URL` (LAIS's endpoint, e.g. `http://192.168.160.188:8000/transaction/processed`), `LAIS_WEBHOOK_KEY` (the key LAIS issued to GIS, sent as `X-API-Key`), `LAIS_WEBHOOK_METHOD` (`PUT` as LAIS asked, default; or `POST`), `LAIS_WEBHOOK_TIMEOUT_MS` (default 10 s). For local testing, `npm run mock-lais` in `server/` starts a stand-in LAIS endpoint on port 4010 (`MOCK_LAIS_MODE=ok|fail-once|refuse|slow`); it writes what it receives to `server/data/mock-lais/received.jsonl`.

**What GIS sends** (`POST`, JSON, headers `X-API-Key`, `X-GIS-Event-Id`, `X-GIS-Event-Type: editing.completed`), exactly the sample sent to LAIS:
`event_id`, `event_type`, `sent_at`, `Transaction_ID`, `Transaction_Type`, `version_name`, `record_name`, `edited_by`, `parent_parcels[]` (`UPI`, `area_sqm`, `province` … `village`), `proposed_parcels[]` (`parcel_ref` = the Plot's global id, `UPI` null for new parcels, `area_sqm`, location, `geometry` as GeoJSON in EPSG:4326), `totals`.

**Where the data comes from:** the transaction's version, read with the LAIS service account (nothing is edited). The record is the one named after the version (or the editor's active record). Proposed parcels = created by the record and current; parents = retired by the record. For a CorrectBoundaries, the transaction's parcels in the version (proposed) and in DEFAULT (parents). Area = `size`, else the shape area. The editor gets clear refusals when the work does not match the transaction: no record, no parcels, a subdivision into fewer than 2 parcels, a merge into more than 1, or the wrong parcel replaced.

**Delivery:** any 2xx = delivered. 408, 429, 5xx, timeout or no connection = retried with the same `event_id` after about 1, 5 and 15 minutes, then hourly, for 24 hours (status `retrying`, then `failed`). Other 4xx = `refused`, with LAIS's message shown to the editor. Refused or failed notifications can be sent again (a new `event_id`); a delivered one is never resent. The state is kept in the ledger entry (`editingDone`), so retries survive a restart; it does not change the `updated_at` LAIS sees. Every attempt is in the audit log (`lais.editing-done`, `lais.editing-done.delivery`).

**Location on new parcels:** Divide and Merge do not copy province … village to the new parcels, and Assign UPIs (which used to fill them) moves to approval. The web app now copies the parents' location onto the new parcels right after a Divide or Merge, for each field on which all parents agree.

Code: [editing-done.ts](../server/src/modules/lais/domain/editing-done.ts), [lais-editing.controller.ts](../server/src/modules/lais/controllers/lais-editing.controller.ts) (`/api/lais-editing`, signed-in editors or the API key), [src/components/dialogs/EditingDoneDialog.tsx](../src/components/dialogs/EditingDoneDialog.tsx).

## Plot layer fields written (inside the version, `attributes` mode only)

| Field | Value |
| --- | --- |
| `transaction_id` | LAIS `Transaction_ID` (the API takes any length; this field holds 50, so attributes mode refuses longer IDs with `TOO_LONG_FOR_GIS`) |
| `transaction_type` | `Transaction_Type` — domain KGL_TransactionType |
| `transaction_status` | `Transaction_Status` **only if LAIS sends it** — domain KGL_TransactionStatus |
| `transaction_date` | `Transaction_Date` (stored as UTC) |
| `case_` | `Yes` (decided by the API; failed submissions write nothing) |
| `validation_message` | `Validated by the LAIS integration API` |
| `version_status` | `VersionCreated` |
| `version_name` | fully qualified version name, e.g. `svc_lais.SUBV-LAIS-SUB-2026-00125-20261124` |

Version name = `{TYPE}-{CASE_NUMBER}-{DATE}`: TYPE `SUBV` Subdivision · `MERG` Merge · `CORB` CorrectBoundaries · `CRPL` CreatePlot; CASE_NUMBER = `Transaction_ID` (characters other than letters, digits, `-`, `_` become `-`); DATE = `yyyyMMdd` of `Transaction_Date` as sent; at most 62 characters. Two different Transaction_IDs that map to the same name are refused with 409 rather than sharing a version. Codes live in `TYPE_CODES` in `server/src/modules/lais/domain/version-naming.ts` (the editor dialog's filter in `LaisTransactionsDialog.tsx` must match).

Field names are resolved case-insensitively from the live layer metadata; the API refuses to run (503) if the layer is not branch versioned, a field is missing, or the `case_`/`version_status` domains lack `Yes`/`VersionCreated`.

## Safety properties

- `applyEdits` is only ever sent with `gdbVersion` + `sessionID` of the transaction's own version, as an attribute-only **update** of the one matched Plot. No adds, deletes or geometry changes. Nothing reconciles or posts.
- **Only 201 means recorded.** Every other answer has `success: false`, `case: "No"`.
- **`Transaction_ID` is recorded once** (kept in the ledger, which also stores the version name). Sending it again → 409 `ALREADY_RECORDED`, nothing created, with the transaction as it stands in `data` (so a retry after a lost response still learns its version and stage). Same ID, different payload → 409 `DUPLICATE_TRANSACTION_ID`. A retry after a 5xx reuses the version created by the failed attempt and gets 201.
- **One open transaction per UPI.** A new Transaction_ID naming a parcel that another transaction holds → 409 `UPI_IN_TRANSACTION`, with `transactionId` naming the holder. A transaction holds its parcels while its version exists and its change is not in sde.DEFAULT; once GIS posts or removes the version, the parcel is free. The check and the recording happen one submission at a time, so two simultaneous transactions cannot both take a parcel.
- A failed edit stops the session with `saveEdits=false` and releases the read lock.
- Concurrent requests for the same `Transaction_ID` are serialised in-process.
- Every submission (accepted or rejected) is written to the audit log as `lais.transaction.submit`.

## Known limitations / decisions still open

- A UPI is free again once its transaction's version is posted or removed. One exception: a CorrectBoundaries posted in `version-only` mode without a record named after the version can't be seen as posted, so its UPI stays held until GIS deletes the version.
- Once a version is posted and a later transaction overwrites `transaction_id` on the same Plot, the earlier ID can no longer be found (it lives only in history/archive).
- The in-process lock assumes one API instance. Run a single instance, or add a shared lock, before scaling out.
- The service account owns the versions. To reconcile/post them, GIS editors need the Portal privilege to manage versions they don't own (version administrator), or an administrator does it.

## Deployment checklist

- Public HTTPS URL behind a reverse proxy; set `trust proxy` for that proxy so rate limits see the LAIS IP; allow-list LAIS's IPs at the firewall.
- `NODE_ENV=production` (also turns off `/api/docs` unless `API_DOCS=true`).
- `LAIS_API_KEY` ≥ 32 random characters, shared with LAIS out of band. `LAIS_ARCGIS_REFERER` = the API's public origin.
- Service account: can query Layer 17, create versions and edit in its own versions.
