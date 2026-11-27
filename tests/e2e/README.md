# End-to-end tests (live ArcGIS Enterprise)

These scripts drive the real application in headless Chrome against the live services. They sign in with the account in `server/.env` (`ARCGIS_USERNAME` / `ARCGIS_PASSWORD`). That file is git-ignored.

**Data safety.** Every test that touches versions creates its own throw-away named version (`PS_E2E_<number>`), works only in it, and deletes it at the end. DEFAULT is never edited.

Before you run them:
- The API (`npm --prefix server run dev`) and the UI (`npm run dev`) must be running.
- Chrome must be installed. Set `CHROME_PATH` if it is not in the default location.

| Script | What it verifies |
|---|---|
| `npm run test:e2e:workspace` | Sign-in, Version Manager opening first, layer loading, identify, attribute table |
| `npm run test:e2e:search` | Map search: UPI (full, partial, typed with dashes) and Name (village, cell, sector, district, parcel record); zoom and properties; typing doesn't trigger shortcuts. Read-only. |
| `npm run test:e2e:phase2` | Licence detection, Version Manager create/switch/delete, role rules enforced by the version service, select by attributes, location and rectangle, selection panel, table sync |
| `npm run test:e2e:editing` | Full edit workflow: record creation and activation, Editor create, record stamping, modify (move) and undo, the undo guard, save, Parcel Fabric divide (3 parts), UPI suggestions and saving (parcel numbers, location fields), merge with a suggested UPI (a bad UPI is refused), lineage, retire, delete permanently, topology validation, discard. UPI rules on plain attribute edits (bad format and duplicates refused). Nothing is posted to DEFAULT. **Needs the ArcGIS Advanced Editing licence on the test account.** |
| `npm run test:e2e:tools` | The Editor tools, through the mouse and keyboard: snapping onto an existing parcel corner, a typed distance in the drawing tooltip (Tab), split and merge of a Plot line with the Editor (the non-parcel path), scale, rotate and reshape with the handles, an attribute change in the Editor form, and UPI refusal in the form and in the attribute table (a valid UPI typed in the table is saved). Nothing is saved or posted. **Needs the Advanced Editing licence.** |
| `npm run test:e2e:split` | Shapefile upload, Check errors and Validate (checked in the data), manual split with lineage, and active-record changes. Nothing is saved or posted. **Needs the Advanced Editing licence.** |
| `npm run test:e2e:topology` | Topology errors in DEFAULT: Check errors lists every stored error with the UPIs of its parcels and what is wrong, draws them all on the map, shows what the surveyor must check, and offers no fix or exception button. Read-only (no version, no edit session). |
| `npm run test:e2e:cleanup` | Removes leftover `PS_E2E_*` versions created by an interrupted run. It releases this account's own stale session locks first. |

Pass a folder as the first argument to keep screenshots, e.g. `node tests/e2e/phase2-ui.mjs C:\temp\shots`.

Shared setup is in `helpers.mjs`: test account, browser launch, sign-in, error capture, page helpers (clicks through shadow roots, waits, keys), and the version flow (create and switch through the Version Manager, create the active record, clean up). Run one suite at a time against the server: `test:e2e:cleanup` deletes every `PS_E2E_*` version, including one that another run is using.

Don't save files under `src/` while a suite runs: Vite reloads the page and the run fails half-way (run `test:e2e:cleanup` afterwards).

**Never post from a test**, not even an empty version. Where a test exercises the posting permission, it swaps the version service for an inert object first. Assert results in the data, not only that text appeared: the old Validate check passed for days while validation did nothing.
