# Rwanda Parcel Fabric — Technical Assessment & Architecture

_Assessment date: 2026-11-19 · Author: development team_

## A. Existing project assessment

| Item | Finding |
|---|---|
| Repository | `Downloads/parcel` was **empty** (no git, no files). An earlier local prototype (PostGIS-backed "Parcel Studio") no longer exists here, so nothing was overwritten and the project starts clean. |
| Reusable code | None in this folder. Earlier design decisions kept: ArcGIS Maps SDK, ports 4001 (API) / 5174 (UI), satellite basemap default. |
| Supplied material | `Parcel Fabrics Service Access.txt` lists the 5 service URLs, the Portal URL and a **plaintext PostgreSQL login for `pf_owner`** (the data owner). |

## B. ArcGIS Enterprise compatibility

Verified live (public endpoints, no token):

| Component | Value |
|---|---|
| ArcGIS Server | **12.1.0** (`/server/rest/info`), token-based security, federated with Portal |
| Portal | 2026.1 / Enterprise 12.1.0 build 786, `access: private`, `supportsOAuth: true` |
| CORS | Server echoes `Access-Control-Allow-Origin` for `http://localhost:5174` (browser access works without a proxy) |
| Helper services | Print: `Utilities/PrintingTools/GPServer/Export Web Map Task`; Analysis: `System/SpatialAnalysisTools/GPServer`; Geometry: ArcGIS Online utility service (external) |
| JS SDK | `@arcgis/core` / `@arcgis/map-components` **5.1.27** (last patch of 5.1, released 2026-10-07), Calcite **5.1.2**. 5.2.x exists but had 6 patch releases in 2 weeks; we stay on the stable line and upgrade deliberately. SDK 5.x supports ArcGIS Enterprise 12.1. |

SDK facts that shape the design (checked in the installed type definitions):
- `versionManagement/VersionManagementService` exists (startReading/startEditing/stopEditing/reconcile/post/createVersion/getVersionInfos…), plus an `arcgis-version-management` component.
- **No Parcel Fabric API exists in the JS SDK** → Parcel Fabric operations must call the documented `ParcelFabricServer` REST operations through `esriRequest`.
- `IdentityManager` supports OAuth 2.0 (with a registered app ID) or a built-in sign-in dialog (generateToken over HTTPS).

## C. Service capabilities assessment

All five services return **`499 Token Required`** anonymously. An **authenticated inspection was run on 2026-11-19** using the test account (`npm --prefix server run inspect-services` → `docs/service-inspection.json`). Findings:

| Item | Live value |
|---|---|
| FeatureServer capabilities | `Query,Create,Update,Delete,Uploads,Editing,ChangeTracking`. `hasBranchVersionedData: true`, and every editable layer has `isDataBranchVersioned: true`. `maxRecordCount` 2000. applyEdits supports GlobalIDs, true curves and async; session-based add/update/delete is supported. |
| Spatial reference | Custom WKT `ITRF_2005`, Transverse Mercator, CM 30°E, k 0.9999, FE 500 000, FN 5 000 000 (no WKID). The service `fullExtent` is the whole SR domain; `initialExtent` and the data extents are valid. |
| Parcel Fabric controller | Layer **3 `KGL`** (Parcel Layer), topology layer **8 `KGL_Topology`** (`controllerDatasetLayers`). |
| Fabric layers | Records **2** (41 features) · parcel type **Plot**: polygons **17** (4,741) + lines **16** (41,647) · Points **9** (37,069) · Connection Lines **10** · adjustment points, lines and vectors **12/13/14** · topology errors: point **6**, line **4**, polygon **5**, Dirty Areas **7** (all currently 0). |
| Plot attributes | Fabric fields (`createdbyrecord`, `retiredbyrecord`, `statedarea`, `isseed`, `validationstatus`…) plus local fields: `province`, `district`, `sector`, `cell`, `village`, `parcel_number`, `size`, `area_in_wetland`. Records use the `RecordType` coded domain (Merge, Split, Subdivision, Boundary line adjustment…). |
| VersionManagementServer | Available. Default `sde.DEFAULT`; named versions `gisa@esri_rw.Editor`, `gisa@esri_rw.Viewer`. Async reconcile/post, partial post and lock infos are supported. |
| ValidationServer | Available. `supportsTopologyValidation`, `supportsTopologyErrorModification`, `supportsWriteErrors`, `supportsWriteErrorsWithSketchGeometries`. |
| **ParcelFabricServer** | **403 – "requires a user type extension license"** for the test account (org admin, *Creator* user type, no *Advanced Editing* extension). |

The application reads all of this at runtime from service metadata; nothing is hard-coded. The layer tree mirrors the MapServer table of contents. Two ways to re-run the inspection:

1. (The in-app GIS Services panel was removed on 2026-11-20 at the user's request; use the CLI below.)
2. CLI: put a named Portal account in `server/.env` (`ARCGIS_USERNAME` / `ARCGIS_PASSWORD`) and run `npm --prefix server run inspect-services` → writes `docs/service-inspection.json` and a summary.

Documented REST operations (Esri REST reference, Enterprise "latest"), to be confirmed against the live metadata:

- **ParcelFabricServer** (POST, require *ArcGIS Advanced Editing* user-type extension; take `gdbVersion`, `sessionId`, optional `async`): `build`, `merge`, `divide`, `duplicateParcels`, `assignFeaturesToRecord`, `reassignFeaturesToRecord`, `createSeeds`, `changeParcelType`, `copyLinesToParcelType`, `deleteParcels`, `updateParcelHistory`, `reconstructFromSeeds`, `clip`, `transferParcel`, `analyzeByLeastSquaresAdjustment`, `applyLeastSquaresAdjustment`, `mergeParcelPoints` (12.0), `setParcelLineLabelPosition`, `shrinkToSeed` (12.0). Most require a `record` (parcel record GUID).
- **VersionManagementServer**: create / delete / versionInfos / lockInfos / purgeLock; per version: alter, conflicts, inspectConflicts, differences, reconcile, post, partialPost, restoreRows, deleteForwardEdits, startReading, startEditing, stopEditing, stopReading.
- **ValidationServer**: `evaluate` (`evaluationType`: validationRules / calculationRules / topologyRules), `updateErrors`, `writeErrors` (11.3+). Errors persist in the `GDB_Validation*Errors` tables.
- Named-version edit flow: `startReading` → `startEditing` → operations with the **same `sessionId`** → `stopEditing(saveEdits)` → `stopReading`.

## D. Recommended architecture

```
Browser (React 19 + TS + Vite)                     Node/Express API (TS)              ArcGIS Enterprise 12.1
┌───────────────────────────────┐                  ┌──────────────────────┐          ┌──────────────────────────┐
│ UI shell (Calcite)            │  /api (Bearer)   │ config / health      │  HTTPS   │ Portal (OAuth / tokens)  │
│ MapController (one MapView)   ├─────────────────►│ token → session/role ├─────────►│ community/self           │
│ services/* (esriRequest)      │                  │ audit log (JSONL)    │          │                          │
│ IdentityManager (user token)  ├──────────────────┼──────────────────────┼─────────►│ Map/Feature/ParcelFabric/│
└───────────────────────────────┘   direct, user   │ bookmarks            │          │ VersionMgmt/Validation   │
                                    token, CORS    └──────────────────────┘          └──────────────────────────┘
```

Key decisions:
- **The user's own Portal identity is used for every ArcGIS call.** ArcGIS enforces layer/edit permissions; the app never uses a shared service account or the database login.
- **The backend never proxies edits.** It validates tokens (`/sharing/rest/community/self`), maps Portal role, privileges and groups to an application role, writes the audit trail, and stores per-user data. Tokens are sent only in POST bodies or `Authorization` headers and are redacted from all logs.
- **No direct database access.** The `pf_owner` credentials are not used anywhere. Parcel Fabric integrity rules (records, lineage, topology) are enforced only through the services.
- **Map isolated from React.** `MapController` owns the `MapView`; React components push commands to it and read throttled status from a Zustand store.
- **Parcel Fabric workflows go in their own module** (`gis/parcel-fabric`), separate from standard feature editing, and always run inside a version session.

Application roles: ADMINISTRATOR (Portal `org_admin` or a configured group), GIS_EDITOR (`features:user:edit` or a group), SURVEYOR (configured group), VIEWER. These roles gate the UI, the backend routes and the client services (for example, only `versions:post` may reconcile & post). ArcGIS still enforces its own permissions on every request.

## E. Folder structure

```
parcel/
  src/                      React frontend
    app/                    App bootstrap, theme, commands, shortcuts
    components/             React UI only: layout/ toolbar/ map/ panels/ dialogs/ common/
    gis/                    GIS logic, no React: map/ (MapController) layers/ geometry/ editing/
                            parcel-fabric/ search/ selection/ version-management/
    services/               api/ authentication/ arcgis/ audit/ logging/
    hooks/ stores/ types/ utils/ styles/
  server/src/               Express backend
    config/ middleware/ routes/ authentication/ authorization/ audit/ logging/ utils/ scripts/
  tests/e2e/                live end-to-end tests (shared setup in helpers.mjs)
  docs/                     this assessment, service inspection output
  eslint.config.js          one lint config for the web app, server and tests
```

## F. UI/UX design

Calcite design tokens drive both light and dark themes. Layout: header (brand, project, map, version chip, notifications, help, settings, theme, user) → grouped toolbar → icon action bar + resizable left panel → map → resizable properties panel → collapsible bottom workspace → status bar (state, tool, scale, WGS 84 and data-CRS pointer coordinates). Every tool has a tooltip and a keyboard shortcut. Destructive actions ask for confirmation. Loading uses skeletons and progress bars. Toolbar groups and panels appear only when they work; the app has no placeholder buttons.

## G. Implementation roadmap

| Phase | Scope | Status |
|---|---|---|
| 1 | Shell, auth, map, layer management, navigation, measure, identify, properties, read-only attribute table, bookmarks, audit and logging | **Implemented** (see §I) |
| 2 | Version Manager, edit sessions in named versions, Editor-based editing (create, modify, split, merge, delete), snapping, precision input, selection tools, attribute editing, active parcel record, editing history, undo/redo/save/discard, reconcile and post | **Implemented** (see §J); data edits are blocked server-side until the licence is assigned |
| 3 | Advanced geometry (split/merge/reshape/COGO-style construction), undo/redo, editing history, form configuration, import/export | |
| 4 | Parcel Fabric: records (create, search, assign), parcel identification and lineage, `build`, `createSeeds` | |
| 5 | `merge`, `divide`, `clip`, `duplicateParcels`; Version Manager (create/switch/reconcile/conflicts/post); ValidationServer dashboard | |
| 6 | Analysis toolbox (client geometry operators in workers, SpatialAnalysisTools GP), reports, printing via the on-premises print service | |
| 7 | Admin and audit UI, performance (code splitting; the main bundle is currently 3.5 MB), deployment (IIS/Windows service), test suites | |

## H. Risks, dependencies and missing requirements

1. **ArcGIS Advanced Editing licence: required for ALL editing on this service.** (Resolved for testing on 2026-11-19: `gisa@esri_rw` has the GIS Professional Advanced user type, which includes it, and all editing was verified with that account. Every other editor still needs it.) Verified live on 2026-11-19: `FeatureServer/2/applyEdits` returns *"You cannot edit as you have not been assigned required user type extensions: [Advanced Editing]."* The FeatureServer contains a Parcel Fabric and topology, so the server requires the extension for every edit, not only for ParcelFabricServer operations. A Portal administrator must assign *ArcGIS Advanced Editing* (Organization → Licenses → User type extensions) to every editor. Until then the app disables editing with this explanation. Viewing, selection, version management and reconcile work without it.
2. **OAuth app registration (recommended).** Register an Application item in Portal with redirect URIs `http://localhost:5174` (and the production URL), then set `ARCGIS_OAUTH_APP_ID`. Until then the SDK sign-in dialog (generateToken) is used.
3. **Branch versioning — confirmed.** All editable layers report `isDataBranchVersioned: true`, so Phase 2 editing will run in named versions with `startReading`/`startEditing` sessions. Edits to `sde.DEFAULT` should be limited to administrators.
4. **Licensing.** Parcel Fabric and validation operations require the *ArcGIS Advanced Editing* user-type extension.
5. **Credential hygiene.** The access file holds the `pf_owner` password in plain text. Rotate it, stop circulating it, and keep owner credentials out of application configuration. This application does not use them.
6. **Geometry service.** The portal's geometry helper is ArcGIS Online (external). Client-side geometry operators cover most needs; server-side work should use the on-premises SpatialAnalysisTools.
7. **View coordinate system.** Basemaps use Web Mercator, so features are reprojected for display. Construction and measurements must use the data CRS, which is shown in the status bar and the properties panel. A data-CRS view (without Esri basemaps) can be added if surveyors need it.

## I. First milestone (Phase 1) — delivered

- **Backend:** zod-validated config, pino structured logging with token redaction, Helmet CSP, rate limiting, `/api/health` (live ArcGIS reachability), `/api/config`, `/api/auth/session` (Portal token validation, role and permission mapping, 5-minute cache by token hash), audit log (`POST/GET /api/audit`, monthly JSONL files), per-user bookmarks, client error intake, and the `inspect-services` CLI.
- **Frontend:**
  - Portal sign-in (OAuth or IdentityManager) and the session/profile dialog.
  - MapView built from FeatureServer `/layers` metadata, with geometry-ordered groups, tables registered, and the MapServer added hidden.
  - Layer list: drag reorder, visibility, transparency, legend, zoom, properties, remove (with confirmation).
  - Add data by URL or Portal item, and a Portal catalog search.
  - Basemap gallery, map search (later replaced by UPI and Name search, see §K), and extent history (previous/next).
  - Full extent, locate, go-to (WGS 84 DD/DMS, data CRS, Web Mercator), and geodesic distance/area/perimeter measurement.
  - Coordinate tool, identify returning the full re-queried record (domains and subtypes decoded, geodetic and planar geometry facts), layer schema viewer, and the read-only FeatureTable (server paging, extent filter, zoom to selection).
  - Messages and Logs tabs with export, a context menu, keyboard shortcuts, resizable panels, and light/dark/system themes.
- **Verified:** both projects typecheck in strict mode; the production build succeeds; npm audit is clean; the API endpoints were exercised; and the sign-in screen was tested headlessly against the live Portal (reachability shown, IdentityManager dialog targets `https://esrirw.rw/portal`, no console errors).
- **Verified end-to-end with the live services (2026-11-19, headless Chrome):**
  - The IdentityManager sign-in posts to `generateToken`; the backend session resolves the test account as ADMINISTRATOR; the header shows `sde.DEFAULT`.
  - 12 FeatureServer layers load in the published layer tree, and "full extent" comes from the parcel data.
  - Identify returns Plot `1/02/08/01/1769` with decoded GUIDs, domains and dates.
  - The attribute table pages Plot (4,741 records).
  - The ParcelFabricServer licence error is reported in the Editing panel and logs (the GIS Services panel was later removed).
  - No application console errors remain. (The service's invalid label placement and desktop-only label font have been normalised in the browser since 2026-11-20, see §K.)
- **Display default:** fabric Points and Connection Lines draw only at 1:5,000 and larger when the service defines no scale range (37k points at overview scale). Only the client display changes; the service is unchanged.

## J. Phase 2 — delivered

**Version management** (`gis/version-management/versionSession.ts`, Version Manager dialog):
- List versions. For each, show owner, access, created, modified and reconcile dates, and live edit, lock and conflict status.
- Create a version (private, protected or public), switch, and delete with confirmation.
- Start editing, save (and continue), discard (server rollback, with confirmation), and stop (prompts to save or discard).
- Server-side undo/redo inside the session.
- Reconcile, and reconcile & post with abort-on-conflict (by object or by attribute). Posting needs the `versions:post` permission.
- An unsaved-edits guard on unload, and release of server locks on sign-out and page close.
- Editing DEFAULT is limited to administrators and requires an explicit confirmation.

**Editing** (Editor component + `gis/editing/*`):
- Create from service templates. Modify (move, rotate, scale, vertices, attributes), split, merge, and delete selected (confirmation dialog, chunked, counts confirmed by the server).
- Batch attribute editing, with forms that respect domains, subtypes, nullability and read-only fields.
- Feature, self and grid snapping using the fabric layers as snap sources.
- Tooltips with direction and distance input for precise construction.
- Attribute table editable only during a session, for permitted roles, on updatable layers.
- **Active parcel record**: search, or create (name, `RecordType` domain, recorded date). New fabric features are stamped in `createdbyrecord`. A server-side check after each add catches anything that slipped through.
- Editing History tab (server-confirmed results only, CSV export), plus an audit event per edit and per session or version operation.

**Selection** (`gis/selection/selectionService.ts`, Selection panel):
- Click (`Shift` adds, `Ctrl` removes), rectangle, polygon, lasso, by attributes, by location, and clear.
- Modes: new, add, remove, select within.
- Every selection runs server-side (`queryObjectIds`) on the view's `SelectionManager`, which is shared with the Editor and the attribute table.
- The by-attributes builder uses coded domains and can verify a clause on the server before applying it.
- By location supports seven relations and an optional buffer distance.

**Fixes found by live testing:**
- The SelectionManager does not include layers nested in group layers. Its sources are now synced explicitly.
- `changeVersion` refuses to leave a version this client still holds a read lock on, and the edit session leaves one behind. The read lock is now released before switching, on sign-out and on page close.
- Reconcile works without the Advanced Editing licence (verified). Reconcile and post therefore check only the version-management permission.
- Error messages now include the server's own explanation, not just the generic "Unable to complete operation".
- Version switches wait for the map to go idle, which avoids cancelled-tile console errors.

**Verified live (2026-11-19, throw-away versions, all deleted afterwards; DEFAULT unchanged at 4,741 Plots):**

| Check | Result |
|---|---|
| Licence probe, Start editing disabled with reason, licence notice in the Editing panel | Pass |
| Create, switch and delete a version through the UI, with read locks released | Pass |
| Server session start/stop; edit rejected by the server with a clear licence message | Pass |
| Reconcile through the app (no conflicts, nothing posted) | Pass |
| Select by attributes (server-verified clause → 57 Plots) | Pass |
| Select by location (813 Points within the selected Plots) | Pass |
| Rectangle selection (4 Plots, 106 lines, 102 points); clear selection | Pass |
| Selection panel counts; attribute table synced ("Plot (Total: 4,741, Selection: 57)") | Pass |
| Browser console errors during the run | None |

**Editing verified later** with the licensed account (see §K and §L): create, modify, split, merge, delete, record stamping, undo and discard all pass against the live server.

## K. Changes after Phase 2 (2026-11-20 to 2026-11-21)

- **Editing works end to end** with a licensed account. Three defects were found live and fixed:
  - The Editor could get an all-disabled layer list when the Editing panel was built before the layers finished loading (*"Creating features is unsupported or disabled"*). Layers now notify the registry again once loaded.
  - In a branch-version edit session, unsaved edits are visible only to reads at `layer.historicMoment`. All app queries now go through `atLayerMoment()` (`gis/layers/layerMoment.ts`; today `asShownOnMap` in `gis/layers/query.ts`, see §Q). This fixed reading back a newly created parcel record.
  - Vite invalidated its pre-bundled ArcGIS dependencies mid-session ("504 Outdated Optimize Dep"), which broke snapping. `@arcgis/core`, `@arcgis/map-components` and `@esri/calcite-components` are now served unbundled, which also stopped Calcite and Lit from loading twice.
- **Search** now has two sources (`gis/search/parcelSearch.ts`):
  - **UPI:** the Plot `name` field, full or partial. Dashes, backslashes and spaces count as `/`.
  - **Name:** village, cell, sector, district, or parcel record.
  - Results zoom to show the surroundings and include parcels not yet saved in an edit session.
- **Version first:** the Version Manager opens after sign-in.
- **Clear selection** also closes an open Modify, Split or Merge step; a Create in progress is kept.
- **UI:** the sign-in page was redesigned and renamed *Rwanda Parcel Fabric*. The GIS Services panel was removed at the user's request; use `npm --prefix server run inspect-services` instead.
- **Console clean-up:** two label settings in the published service are corrected in the browser (`gis/layers/serviceMetadataFixes.ts`): the Records layer's invalid label placement, and the Plot labels' desktop-only font (Tahoma). The proper fix is to correct both label classes in ArcGIS Pro and republish.

## L. Code quality and security review (2026-11-21)

**How the audit was done:**
- Read the server and all client code that changes data.
- Scanned for unused exports, unreachable files, HTML injection, `eval` and token handling.
- Checked that every dependency is used, and ran `npm audit`.
- Added ESLint: the code had lint-suppression comments but no linter installed.

**Security fixes:**
- *Authorization in the client services:*
  - `reconcile({ withPost: true })` did not check `versions:post`, so a GIS Editor could post to DEFAULT through it.
  - Creating and deleting versions did not check `versions:manage`; only the buttons were hidden.
  - Both are now enforced in `versionSession`, and a live test covers them.
- *Abuse resistance in the API:*
  - Tokens that Portal rejects are cached for 60 s, so junk tokens no longer each trigger a Portal call.
  - The public `/health` check is cached for 15 s and no longer returns raw error text.
  - A client-supplied `X-Request-Id` is accepted only if it is short and plain, which prevents header and log injection.
- *Sign-in robustness:* if the Portal address hasn't loaded yet, sign-in now refuses with a clear message instead of opening a credential prompt for the web server.
- *Dependencies:* 0 known vulnerabilities in both packages. The lint tooling is pinned to patched releases.

**Data-integrity fix:** when a delete partly fails, only the features the server actually deleted are deselected. Failed ones stay selected so they can be retried.

**Bugs fixed:**
- The Catalog search and the record search could show stale results when replies arrived out of order.
- Clicking quickly could leave two features highlighted.
- Re-thrown errors now keep their original cause.

**Clean-up:**
- Removed dead code: the unused `versionSession.post()` and its dialog option, and the unused `ArcGISRestError` type.
- Removed leftover files: a probe script, a 1.7 MB failure screenshot in `docs/`, and an empty build-cache file (now git-ignored).
- Moved the three React components out of `gis/map/` into `components/map/`.
- The duplicated setup in the test scripts now lives in `tests/e2e/helpers.mjs`. This also fixes a sign-in click that could be lost.
- The bookmarks folder is configurable (`BOOKMARKS_DIR`), the server build now flags unused code, and the package names match the app.

**Verified (2026-11-21):**

| Check | Result |
|---|---|
| Typecheck (web, server) | Pass |
| ESLint | 0 problems |
| Production builds (web, server) | Pass; test handle absent from the bundle |
| Production server start | Serves the app with its CSP; deep links fall back to the app; unknown API routes return 404; ArcGIS reachable |
| API security checks (curl) | Health cached; hostile request ID replaced; bad token cached (0.25 s, then 3 ms); CORS allowlist; security headers present; protected routes return 401 |
| `test:e2e:workspace` | Pass, no browser errors |
| `test:e2e:phase2` (versions, selection, role enforcement) | 18 / 18 |
| `test:e2e:search` | 13 / 13 |
| `test:e2e:editing` (create, modify, split, merge, delete, undo, discard) | 29 / 29; DEFAULT unchanged (4,746 Plots) |

**Remaining risks and technical debt:**
1. **App roles are not a security boundary.** They run in the browser. Real protection comes from ArcGIS: set `sde.DEFAULT` to **protected** so only the version administrator can post, and give editors only the privileges they need.
2. **Test credentials on disk.** `server/.env` holds an org-admin password in plain text. It is git-ignored, but a dedicated least-privilege test account would be safer. Rotate the passwords that were shared in chat.
3. **Token storage.** The SDK's credential is copied to `sessionStorage` (one browser tab only), where any successful XSS attack could read it. No XSS was found, and the CSP limits scripts to `'self'`. Registering an OAuth app (`ARCGIS_OAUTH_APP_ID`) is still recommended.
4. **Audit events reported by the browser:** the server attributes them to the signed-in user, but their content comes from the browser.
5. **SDK display warning:** "Unable to get instance" from the map's WebGL renderer after Discard or Undo. It is display-only.
6. **No unit tests.** Verification relies on the live end-to-end suites, which need the dev servers and the live service. The main bundle is about 3.7 MB; splitting it would speed up the first load.
7. **Internal keys** still use the old `parcel-studio.*` prefix in localStorage and sessionStorage. Renaming them would sign every user out and reset their saved layout, so they were left as they are.

## M. Parcel Fabric operations (2026-11-21)

Split and merge on parcels were plain polygon edits, which lose the fabric's history. They now use the server's Parcel Fabric operations. All of it was developed and verified in throw-away versions; nothing was posted to DEFAULT.

**What was added (`gis/parcel-fabric/parcelFabricService.ts`):**
- **Merge** (`ParcelFabricServer/merge`) and **Divide** (`ParcelFabricServer/divide`; proportional area, equal area or equal width, with a bearing).
  - The originals are retired by the active record (RetiredByRecord) and kept as historic parcels.
  - New parcels are created by the record.
  - The dialogs open from the toolbar's Merge and Split when parcels are selected.
  - The Editor's own split and merge buttons are hidden, so parcels can't be split or merged without lineage.
- **Validate** (`ValidationServer/evaluate`, `topologyRules`) for the current map view, plus a count of dirty areas and point, line and polygon errors.
- **Parcel lineage** in the properties panel: current or historic status, the creating and retiring records, and the overlapping parcels before and after. Historic parcels are outlined on the map on request.
- **Historic parcels hidden on the map:** current parcels and lines only (`retiredbyrecord IS NULL`).
  - The filter is applied to drawing and to every app query (`asShownOnMap`); lineage queries the service directly.
  - DEFAULT already held 3 historic Plots and 18 historic lines that used to draw on top of current parcels.

**How it is safe:**
- **Exact contract:** parameter names come from this server's REST Services Directory, and formats from the Esri REST reference.
- **Edit session only:** operations run only in an edit session of a named version, with the session's id. The SDK sends that id on startEditing but doesn't expose it, so it is read from that request through a public request hook.
- **Undo:** server operations are not on the SDK's undo stack, so undo is disabled after one; Discard rolls the session back.
- **Undone edits:** operations are refused while undone edits exist. Otherwise the server would build on undone state, and the SDK's "delete forward edits" on save could remove the operation's results.

**Verified live (`test:e2e:editing`, 38 / 38):**
- the guard after undo;
- divide (2 current parcels; the original historic, retired by the record);
- merge (one parcel with the entered UPI; parents kept as history);
- lineage in the UI;
- validation;
- discard (rolled back exactly the fabric operations).

The versions/selection (18/18), search (13/13) and workspace suites also pass.

**Still open:**
- **Delete:** deleting a parcel deletes it rather than retiring it. `deleteParcels` exists on the server but is not used yet.
- **COGO and build:** COGO line entry and `build` are not done yet.
- **UPIs after divide:** divided parcels have no UPI until the editor enters one.
- **Lineage through records:** lineage is derived through records, as in the fabric model. When one record is used for several operations in the same area, "came from" lists every parcel that record retired there.

## N. Retire, delete and UPI rules (2026-11-22)

**Retire and delete parcels.** Delete on parcels now offers two Parcel Fabric operations:
- **Retire (keep history):** `updateParcelHistory` with `setAsHistoric=true` and the active record. The parcels stay as history.
- **Delete permanently:** `deleteParcels`, for mistakes. It keeps no history, and it removes the parcels' lines and points that no other parcel uses, which the old plain delete left orphaned.

The Editor's own Delete is switched off for the parcel layer (`deleteEnabled: false`), so it can't bypass either option. Contracts come from the server's REST Services Directory and the Esri REST reference.

**UPI rules** (`gis/parcel-fabric/upi.ts`). Checked against DEFAULT on 2026-11-21: all 4,743 current UPIs use `d/dd/dd/dd/n`, and the first four parts identify one cell.
- *Format:* new UPIs must use that format.
- *Uniqueness:* a UPI is refused if any other parcel uses it, current or historic, or if it is entered twice in the same dialog.
- *Suggestions:* the most common cell prefix among the surrounding parcels, then the next free numbers. The highest number comes from both `parcel_number` and the UPI text, because some parcels have an empty or different `parcel_number`.
- *Attributes:* saving a UPI also writes `parcel_number`, and fills `province`, `district`, `sector`, `cell` and `village` from the neighbours, only where those fields are empty.
- *Where it applies:* "Assign UPIs" opens after a divide; Merge suggests and checks the new UPI; Editing Tools → Parcel Fabric → **Assign UPIs** finds parcels in the map view without a valid UPI.

**Data-quality findings in DEFAULT (reported, not changed):**
- 8 duplicate UPIs among current parcels (e.g. `1/02/13/02/186`);
- 3 parcels without location fields;
- 4 parcels whose `parcel_number` doesn't match their UPI (e.g. `1/02/08/01/18370` with 1837).

**Verified live (`test:e2e:editing`, 41 / 41; other suites 18/18, 13/13, workspace pass):**
- undo of a move, the undo guard, save;
- divide into 3, then UPI suggestions `…/18374–18376` saved with parcel numbers and location fields;
- merge with the suggested `…/18377`, with a bad UPI refused;
- lineage;
- retire (historic, retired by the record);
- delete permanently (the parcel is gone, with no history);
- validation;
- discard (the original parcel is current again).

DEFAULT was unchanged.

**Still open:**
- ~~**Manual edits:** a UPI typed directly into the attribute form or table isn't checked yet.~~ Done, see §O.
- **Survey work:** COGO line entry and `build` are not done.

## O. UPI rules for typed attribute edits (2026-11-22)

A UPI typed in the Editor's attribute form, in the attribute table, or written by any other app code now follows the same rules as the dialogs. `gis/parcel-fabric/upiGuard.ts` checks every outgoing `applyEdits` request for the parcel layer (layer-level `…/FeatureServer/17/applyEdits` and service-level `…/FeatureServer/applyEdits`) before it is sent, using an `esriConfig.request.interceptors` `before` hook that the SDK awaits.

- A new or changed UPI that is badly formatted, has leading or trailing spaces, is given to two parcels in one request, or is used by any other parcel (current or historic) is refused. The editor sees "UPI not saved" with the reason, and nothing is sent to the server.
- The request is never modified: it is sent as is or refused.
- Only UPIs that change are checked (compared with the stored value at the session moment), so the 8 pre-existing duplicates in DEFAULT do not block other edits to those parcels.
- An empty UPI is allowed; Editing Tools → Parcel Fabric → **Assign UPIs** lists those parcels.
- Merge sets its UPI through the ParcelFabricServer, so it is not covered by the guard; the Merge dialog checks it itself.

The shared request-parameter reader moved to `utils/requestParams.ts`.

**Verified live (`test:e2e:editing`, 44 / 44, in a throw-away version):**
- `ABC` refused (format);
- an existing UPI refused (already used);
- a valid free UPI saved;
- the dialogs' UPI suggestions skip it afterwards;
- typecheck, lint and build pass;
- DEFAULT unchanged (4,743 Plots).

## P. Automated tests for the Editor tools (2026-11-22)

New live suite `npm run test:e2e:tools` (`tests/e2e/editing-tools-test.mjs`). It drives the Editor with the mouse and keyboard in a throw-away version and never saves or posts. It covers the items the manual checklist marked "test by hand" (13.2, 13.4, 13.5, 13.6):

| Item | What the test does | Result |
|---|---|---|
| Snapping | Starts a parcel ~5 px (3.4 m) from an existing corner | The new corner is exactly on it (0.000 m) |
| Typed distance | Tab in the drawing tooltip, types 80, then clicks the direction | Line is 80 ft = 24.38 m long (see units below) |
| Split / merge, non-parcel layer | Shift+S / Shift+G on a Plot line: Editor split (polyline splitter), then merge | 2 lines, then 1 line of the original length |
| Scale / rotate / reshape | Drags the box corner, the rotate handle, then one vertex of a diamond parcel | Area ×1.83; same area, new orientation; exactly one corner moved |
| Attribute form | Types a village, then `ABC` as a UPI | Village saved; UPI refused, with the reason in the app and in the Editor panel |
| Attribute table | Types `ABC`, then a free UPI, in the Name cell | Refused, then saved |

Results: two full passes (24/24 and 25/25), and `test:e2e:editing` 44/44 after the shared helpers moved to `tests/e2e/helpers.mjs`. DEFAULT unchanged (4,743 parcels, 41,636 lines). No test versions left (listed read-only afterwards).

**Found while testing:**
- **Drawing units are feet.** The Editor's tooltip shows and reads distances in feet (`Distance ft`, `Z ft`), because the Portal organisation or user default units are "english". The rest of the app (scale bar, Measure, geometry facts) is set to metric explicitly. The `arcgis-editor` component has no units option. Fix: set Portal default units to metric (Organization → Settings → General, and the user profile). Data is not affected; typed distances are read in feet until then.
- **Test cleanup could report a false success** when the page had reloaded mid-run (the version list was empty). `cleanupTestVersion` now fails unless the list includes DEFAULT. One version left this way (`PS_E2E_11221217`, nothing saved) was deleted with `test:e2e:cleanup`.
- Saving files under `src/` during a run reloads the page through Vite and breaks the run. This happened twice today, from edits made outside this session.

## Q. Refactor: duplication removed, behaviour unchanged (2026-11-22)

The goal was a cleaner codebase with every feature, workflow and screen unchanged. No dead code was found (every export is used), so the work removed duplication:

- **One query module:** `gis/layers/query.ts` replaces `layerMoment.ts`. It holds `asShownOnMap` (unchanged), `sessionQuery` / `sessionRows` (version- and moment-aware reads that also see historic parcels), `sqlString` / `sqlList` (one SQL quoting rule), and `hasField`. These replace `queryAll` (parcelFabricService), `queryEveryParcel` (upi), three inline `Query` copies, five quote-escape copies and three `hasField` copies.
- **Registry helpers:** `layerRegistry.byRole`, `requireRole`, `allByRole` and `fabricLayers` replace about 25 hand-written filters.
- **Errors:** `arcgisError(e)` (`services/arcgis/serviceMetadata.ts`) replaces the repeated describe-and-rethrow; `urlPattern` (`utils/requestParams.ts`) is shared by the three request interceptors.
- **UI:** `hooks/useAsyncAction.ts` and `components/common/ErrorNotice.tsx` replace nine copies of the busy/error/try-catch block and the error notice (Parcel Fabric dialogs, Editing panel cards, Select by location, Layers panel). Element IDs, labels and behaviour are unchanged.
- **Smaller tidy-ups:** `upi.ts` rewritten around the helpers, with object-ID filters through `objectIds` instead of hand-built `IN (…)`; `versionSession.watchLayerEdits` computes results once and drops an unused handle list.
- **Logging:** a request refused on purpose by the UPI guard (`request:interceptor`) is no longer logged twice as a runtime error; the user still sees the message in the app and in the Editor.

Verified: typecheck, lint and build pass; live suites workspace pass, versions and selection 18/18, search 13/13, editing 44/44, Editor tools 25/25. No test versions left; DEFAULT unchanged (4,743 parcels, 41,636 lines). A snapshot of the code before the refactor is kept outside the project for rollback.
