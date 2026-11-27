# Rwanda Parcel Fabric

Web GIS editing application for the Kigali Parcel Fabric on ArcGIS Enterprise 12.1
(React 19 + TypeScript + Vite, ArcGIS Maps SDK for JavaScript 5.1, Calcite, Node/Express API).

See [docs/ASSESSMENT.md](docs/ASSESSMENT.md) for the technical assessment, architecture, roadmap and open requirements.

## Prerequisites (Windows)

- Node.js 22 or newer (tested with 24.20)
- Network access to `https://esrirw.rw` and `https://js.arcgis.com` (SDK and Calcite assets load from the CDN)
- A Portal for ArcGIS account on `https://esrirw.rw/portal`

## Install

```powershell
npm install
npm --prefix server install
Copy-Item server/.env.example server/.env   # then review the values
```

## Run in development

Use two terminals:

```powershell
npm --prefix server run dev     # API on http://localhost:4001
npm run dev                     # UI  on http://localhost:5174 (proxies /api to the API)
```

Open http://localhost:5174 and sign in with your Portal account.

## Configuration (`server/.env`)

| Variable | Purpose |
|---|---|
| `PORTAL_URL`, `ARCGIS_SERVER_URL`, `PARCEL_SERVICE_PATH` | ArcGIS Enterprise endpoints (public URLs). |
| `APP_ORIGINS` | Browser origins allowed to call the API. The first one is used as the referer when validating referer-bound tokens. |
| `ARCGIS_OAUTH_APP_ID` | Optional OAuth 2.0 app registered in Portal. Without it the SDK sign-in dialog is used. |
| `ROLE_GROUP_ADMIN` / `_EDITOR` / `_SURVEYOR` | Optional Portal group IDs that map users to application roles. |
| `AUDIT_DIR` / `BOOKMARKS_DIR` | Where the audit log and per-user bookmarks are stored (default `data/audit`, `data/bookmarks`). |
| `ARCGIS_USERNAME` / `ARCGIS_PASSWORD` | Used only by `inspect-services` and the end-to-end tests. Use a dedicated test account. Never commit them. |

No database credentials are used. All GIS access goes through ArcGIS Enterprise services under the signed-in user's identity.

## Checks

```powershell
npm run typecheck; npm --prefix server run typecheck
npm run test:unit              # Shapefile reader (no server needed)
npm run lint                   # ESLint for the web app, server and tests
```

Live end-to-end tests (they need both dev servers and work only in throw-away versions): see [tests/e2e/README.md](tests/e2e/README.md).

## API documentation

The backend API is described in [server/openapi.yaml](server/openapi.yaml) (OpenAPI 3.1). With the dev servers running, browse it in Swagger UI at http://localhost:5174/api/docs (or http://localhost:4001/api/docs). **Authorize** takes a Portal token to try the protected endpoints. The docs are on by default except in production; set `API_DOCS=true` or `false` in `server/.env` to override. Keep the file in step with `server/src/routes/` when routes change.

## Project layout

| Folder | Contents |
|---|---|
| `src/components/` | React UI: layout, toolbar, map, panels, dialogs |
| `src/gis/` | GIS logic without React: map controller, layers, editing, Parcel Fabric records, search, selection, version management |
| `src/services/` | API client, Portal sign-in, ArcGIS helpers, audit, error reporting |
| `src/stores/` | App state (Zustand) |
| `server/src/` | API: config, token validation, roles, audit log, bookmarks |
| `tests/e2e/` | Live end-to-end tests |

## Security model

- Every ArcGIS request uses the signed-in person's own Portal token, so ArcGIS enforces what they may view and edit. The app has no database access and no shared service account.
- The API validates tokens with Portal (cached by hash, rejections cached briefly), maps users to app roles, and keeps an audit log. Tokens are sent only in `Authorization` headers or POST bodies and are redacted from logs.
- App roles hide tools and are checked in the client services, but they run in the browser. Protect `sde.DEFAULT` in ArcGIS (set it to *protected*) so only the version administrator can post.

## Inspect the ArcGIS services

Run `npm --prefix server run inspect-services`, which writes `docs/service-inspection.json`.

## Production build

```powershell
npm run build                  # builds the SPA into dist/
npm --prefix server run build
$env:NODE_ENV="production"; npm --prefix server start   # serves the API and dist/ on PORT
```

## Keyboard shortcuts

Press `?` in the app for the full list.

| Area | Keys |
|---|---|
| Navigation | `E` explore, `H` pan, `+`/`-` zoom, `Alt+←/→` previous/next extent, `F` full extent, `G` go to coordinates |
| Selection | `S` click (`Shift` adds, `Ctrl` removes), `R` rectangle, `P` polygon, `L` lasso, `Shift+A` by attributes, `Shift+L` by location, `Shift+C` clear |
| Editing | `Shift+E` start/stop editing, `N` create, `M` modify, `Shift+S` split, `Shift+G` merge, `Delete` delete selected, `Ctrl+Z`/`Ctrl+Y` undo/redo, `Ctrl+S` save |
| Measure | `D` distance, `Shift+D` area & perimeter, `I` coordinate info |
| Workspace | `Alt+1/2/3` toggle panels, `Esc` cancel tool or workflow |

## Editing workflow (branch versioning)

1. The **Version Manager** opens after sign-in (or click the version chip in the header). Create or switch to a named version.
2. **Start editing** (`Shift+E`). This starts a server edit session on that version.
3. In **Editing Tools**, pick or create the **active parcel record**. New fabric features get it in `createdbyrecord`.
4. Edit:
   - create from templates with the Editor;
   - modify, move, rotate, scale and reshape vertices;
   - **parcels:** Split (`Shift+S`) opens **Divide** (by area or width, or **Draw the line manually**: draw across the parcel, preview both areas, then split) and Merge (`Shift+G`) opens **Merge**. These are Parcel Fabric operations: the original parcels are retired by the active record and kept as history (see *Parcel lineage* in the properties panel). Other layers use the Editor's split and merge;
   - **Delete** on parcels offers **Retire (keep history)**, the normal case, which sets them historic with the active record, or **Delete permanently**, for mistakes, which also removes their unused lines and points;
   - **UPIs:** after a split, **Assign UPIs** opens with suggestions. The cell comes from the parcel that was split (a merge across cells asks which cell; a parcel with no parent uses its cell name; neighbours only as a last resort, and the dialog says which). The number is the next free one after the highest used in that cell, historic parcels included. A warning shows when a few unusually high numbers push it up. This is the application's own rule, not an official NLA rule. It also fills the parcel number and any empty location fields. Merge suggests the new UPI the same way. **Assign UPIs** in Editing Tools → Parcel Fabric finds parcels in the map view without a valid UPI. A UPI typed in the attribute form or table follows the same rules: a new or changed UPI that is badly formatted or already used by another parcel is refused before anything is sent (an empty UPI is allowed; existing UPIs that are not changed are not checked);
   - **Validate this map view** (Editing Tools → Parcel Fabric, while editing a named version) checks the topology rules. **Check errors** works without editing. Both list errors by rule with the UPIs of the parcels at each and what is wrong, and draw them all on the map in red; click one to zoom to it and see what the surveyor must check. The app only shows errors and never fixes them: correcting the parcels is the surveyor's responsibility. Errors that are correct as they are (e.g. a gap along the outer edge of the data) are marked as exceptions by a GIS administrator in ArcGIS Pro;
   - **Upload Shapefile** (left bar) shows a .zip or .shp/.dbf/.prj on the map for reference and snapping. It stays in the browser and is never written to ArcGIS;
   - edit attributes, including batch edits, in the form or the attribute table.

   Snapping and direction/distance input are available while drawing.
5. Review **Editing History**, then **Save** or **Discard**. Undo/redo work within the session until a Parcel Fabric operation runs. After that, use Discard to roll back. Parcel Fabric operations are refused while undone edits exist; Save or Discard first.

The map shows **current** parcels and lines only. Historic (retired) ones stay in the data and are reached through parcel lineage.
6. Use **Reconcile** or **Reconcile & post** in the Version Manager to publish to the default version. Posting needs the Administrator role.

Search (top right of the map) finds parcels by **UPI** (full or partial, e.g. `1/02/13/02/1001`) or by **Name** (village, cell, sector, district or parcel record).

> ArcGIS Enterprise requires the **ArcGIS Advanced Editing** user type extension for *any* edit to a feature service that contains a Parcel Fabric. The app checks this when it starts. Without the extension it disables editing and explains why. Version management, reconcile, selection and viewing still work.
