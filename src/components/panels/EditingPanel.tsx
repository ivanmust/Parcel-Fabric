import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import SnappingOptions from "@arcgis/core/views/interactive/snapping/SnappingOptions.js";
import { useMapView, useLayerRegistryVersion } from "../../hooks/useMapController";
import { useEditing, isDefaultVersion } from "../../stores/editingStore";
import { useApp } from "../../stores/appStore";
import { layerRegistry } from "../../gis/layers/layerRegistry";
import { versionSession } from "../../gis/version-management/versionSession";
import { recordService, recordsLayer, type RecordRow } from "../../gis/parcel-fabric/recordService";
import { registerEditor, isLayerEditable, type EditorElement } from "../../gis/editing/editorBridge";
import { runCommand } from "../../app/commands";
import { calciteInput } from "../../utils/calciteInput";
import { parcelFabricService } from "../../gis/parcel-fabric/parcelFabricService";
import { getMapController } from "../../gis/map/MapController";
import { useAsyncAction } from "../../hooks/useAsyncAction";
import { ErrorNotice } from "../common/ErrorNotice";

const SNAP_ROLES = new Set(["parcel-polygon", "parcel-line", "points", "connection-lines", "records"]);

export function EditingPanel() {
  useLayerRegistryVersion();
  const view = useMapView();
  const user = useApp((s) => s.user);
  const session = useEditing((s) => s.session);
  const current = useEditing((s) => s.current);
  const defaultVersion = useEditing((s) => s.defaultVersion);
  const pending = useEditing((s) => s.pendingEdits);
  const canUndo = useEditing((s) => s.canUndo);
  const canRedo = useEditing((s) => s.canRedo);
  const busy = useEditing((s) => s.busy);
  const advancedEditing = useEditing((s) => s.advancedEditing);
  const editing = session === "editing";
  const check = versionSession.canEditCurrentVersion();

  // Editor configuration from live layer metadata.
  const layerInfos = useMemo(
    () =>
      layerRegistry
        .all()
        .filter((i) => i.kind === "feature")
        // Parcels are retired or deleted through the Parcel Fabric (toolbar Delete), not by the Editor.
        .map((i) => ({ layer: i.layer, enabled: isLayerEditable(i), deleteEnabled: i.fabricRole !== "parcel-polygon" })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [layerRegistry.getVersion()],
  );
  const snappingOptions = useMemo(
    () =>
      new SnappingOptions({
        enabled: true,
        featureEnabled: true,
        selfEnabled: true,
        distance: 10,
        featureSources: layerRegistry
          .all()
          .filter((i) => i.kind === "feature" && i.fabricRole && SNAP_ROLES.has(i.fabricRole))
          .map((i) => ({ layer: i.layer, enabled: true })),
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [layerRegistry.getVersion()],
  );

  const editorRef = useCallback((el: EditorElement | null) => registerEditor(el), []);
  useEffect(() => () => registerEditor(null), []);

  const startEditing = () => runCommand("toggle-editing");

  return (
    <calcite-panel heading="Editing" description={current ? `Version ${current.name}` : "Version management unavailable"} loading={!!busy || undefined}>
      <calcite-action slot="header-actions-end" icon="code-branch" text="Version Manager" onClick={() => runCommand("versions")} />
      <div className="ps-panel-body">
        <section className="svc-card">
          <div className="ps-row space">
            <div style={{ minWidth: 0 }}>
              <div className="mono" style={{ fontWeight: 600, overflowWrap: "anywhere" }}>{current?.name ?? "—"}</div>
              <div className="muted" style={{ fontSize: 12 }}>
                {session === "editing"
                  ? `Editing · ${pending} unsaved edit(s)`
                  : session === "starting"
                    ? "Starting edit session…"
                    : session === "stopping"
                      ? "Stopping…"
                      : session === "reading"
                        ? "Read-only"
                        : "Versioning unavailable"}
              </div>
            </div>
            <calcite-chip scale="s" kind={editing ? "brand" : "neutral"} icon={editing ? "pencil" : "lock"} label="Session">
              {editing ? "Editing" : "Reading"}
            </calcite-chip>
          </div>
          {!editing ? (
            <>
              {isDefaultVersion({ current, defaultVersion }) && (
                <calcite-notice open kind="warning" scale="s" icon="information">
                  <div slot="message">
                    You are on the default version. Create or switch to a named version to edit safely, then reconcile & post.
                  </div>
                </calcite-notice>
              )}
              <div className="ps-row" style={{ gap: 6, flexWrap: "wrap" }}>
                <calcite-button scale="s" icon-start="pencil-mark" disabled={!check.ok || session !== "reading" || undefined} onClick={startEditing}>
                  Start editing
                </calcite-button>
                <calcite-button scale="s" appearance="outline" icon-start="code-branch" onClick={() => runCommand("versions")}>
                  Versions…
                </calcite-button>
              </div>
              {!check.ok &&
                (advancedEditing === "no" ? (
                  <calcite-notice open kind="warning" scale="s" icon="key">
                    <div slot="title">Advanced Editing licence required</div>
                    <div slot="message">{check.reason}</div>
                  </calcite-notice>
                ) : (
                  <div className="muted" style={{ fontSize: 12 }}>{check.reason}</div>
                ))}
            </>
          ) : (
            <div className="ps-row" style={{ gap: 4, flexWrap: "wrap" }}>
              <calcite-button scale="s" icon-start="save" disabled={!pending || !!busy || undefined} onClick={() => runCommand("save")}>
                Save
              </calcite-button>
              <calcite-button scale="s" appearance="outline" kind="danger" icon-start="reset" disabled={!pending || !!busy || undefined} onClick={() => runCommand("discard")}>
                Discard
              </calcite-button>
              <calcite-action icon="undo" text="Undo (Ctrl+Z)" scale="s" disabled={!canUndo || undefined} onClick={() => runCommand("undo")} />
              <calcite-action icon="redo" text="Redo (Ctrl+Y)" scale="s" disabled={!canRedo || undefined} onClick={() => runCommand("redo")} />
              <span className="ps-grow" />
              <calcite-button scale="s" appearance="transparent" icon-start="stop" onClick={() => runCommand("toggle-editing")}>
                Stop
              </calcite-button>
            </div>
          )}
        </section>

        {recordsLayer() && <ActiveRecordCard editing={editing} />}
        {editing && !!layerRegistry.byRole("parcel-polygon") && <ParcelFabricCard />}

        {editing && !user?.permissions.includes("features:edit") && (
          <calcite-notice open kind="warning" scale="s">
            <div slot="message">Your role does not include editing.</div>
          </calcite-notice>
        )}
      </div>

      {editing && view && (
        <arcgis-editor
          ref={editorRef as never}
          view={view}
          layerInfos={layerInfos as never}
          snappingOptions={snappingOptions}
          selectionManager={view.selectionManager}
          syncViewSelection
          tooltipOptions={{ enabled: true, inputEnabled: true } as never}
          labelOptions={{ enabled: true } as never}
          hideSplitButton
          hideMergeButton
        />
      )}
      {editing && (
        <div className="ps-panel-body" style={{ paddingTop: 0 }}>
          <calcite-notice open kind="brand" scale="s" icon="parcel-layer">
            <div slot="message">
              Standard edits to Parcel Fabric layers are stored in this version and stamped with the active record. Parcel Fabric operations
              (build, merge, divide) use the ParcelFabricServer and need the ArcGIS Advanced Editing licence.
            </div>
          </calcite-notice>
        </div>
      )}
    </calcite-panel>
  );
}

type ValidationStatus = Awaited<ReturnType<typeof parcelFabricService.validationStatus>>;

/** Parcel Fabric tools for the edit session: topology validation of the current map view. */
function ParcelFabricCard() {
  const fabricOps = useEditing((s) => s.fabricOpsInSession);
  const [status, setStatus] = useState<ValidationStatus | null>(null);
  const { busy, error, run } = useAsyncAction();

  const area = () => {
    const extent = getMapController().view?.extent;
    if (!extent) throw new Error("The map is not ready.");
    return extent.clone();
  };
  const check = () => run(async () => setStatus(await parcelFabricService.validationStatus(area())), "Checking");
  const validate = () =>
    run(async () => {
      const extent = area();
      await parcelFabricService.validate(extent);
      setStatus(await parcelFabricService.validationStatus(extent));
      useApp.getState().notify("success", "Topology validated", "The map view was validated in this version.");
    }, "Validating");
  /** Open "Assign UPIs" for current parcels in the map view that have no valid UPI. */
  const assignMissing = () =>
    run(async () => {
      const ids = await parcelFabricService.parcelsWithoutUpi(area());
      if (!ids.length) useApp.getState().notify("info", "Every parcel in this map view has a UPI");
      else useEditing.getState().patch({ assignUpiTargets: ids });
    }, "Finding parcels without UPI");
  const errorTotal = status ? status.errors.reduce((n, e) => n + e.count, 0) : 0;

  return (
    <section className="svc-card" id="parcel-fabric-card">
      <div className="ps-row space">
        <strong>Parcel Fabric</strong>
        {busy && <calcite-loader inline label={busy} scale="s" />}
      </div>
      <p className="muted" style={{ margin: 0, fontSize: 12 }}>
        Merge and Split on parcels use Parcel Fabric operations: the original parcels are retired by the active record and kept as history.
      </p>
      <div className="ps-row" style={{ gap: 6, flexWrap: "wrap" }}>
        <calcite-button scale="s" icon-start="check-shield" disabled={!!busy || undefined} onClick={() => void validate()}>
          Validate this map view
        </calcite-button>
        <calcite-button scale="s" appearance="outline" icon-start="refresh" disabled={!!busy || undefined} onClick={() => void check()}>
          Check errors
        </calcite-button>
        <calcite-button scale="s" appearance="outline" icon-start="tag" disabled={!!busy || undefined} onClick={() => void assignMissing()}>
          Assign UPIs
        </calcite-button>
      </div>
      {status && (
        <div className="kv" id="parcel-fabric-status">
          <div className="k">Dirty areas</div>
          <div>{status.dirtyAreas === 0 ? "None (validated)" : `${status.dirtyAreas} not yet validated`}</div>
          {status.errors.map((e) => (
            <Fragment key={e.layerKey}>
              <div className="k">{e.name}</div>
              <div>{e.count}</div>
            </Fragment>
          ))}
          <div className="k">Total errors</div>
          <div>{errorTotal === 0 ? "None" : errorTotal}</div>
        </div>
      )}
      {fabricOps > 0 && (
        <calcite-notice open kind="brand" scale="s" icon="information">
          <div slot="message">Undo isn't available after a Parcel Fabric operation. Use Discard to roll back everything since the last save.</div>
        </calcite-notice>
      )}
      <ErrorNotice message={error} />
    </section>
  );
}

function ActiveRecordCard({ editing }: { editing: boolean }) {
  const active = useEditing((s) => s.activeRecord);
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<RecordRow[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: "", recordType: "", date: new Date().toISOString().slice(0, 10) });
  const { isBusy, error, setError, run } = useAsyncAction();
  const layer = recordsLayer();
  const typeDomain = layer?.getFieldDomain("recordtype");

  useEffect(() => {
    let stale = false;
    const h = setTimeout(() => {
      recordService
        .search(query)
        .then((r) => !stale && setRows(r))
        .catch((e: Error) => !stale && setError(e.message));
    }, 300);
    return () => {
      stale = true;
      clearTimeout(h);
    };
  }, [query, active, setError]);

  const create = () =>
    run(async () => {
      const row = await recordService.create({
        name: form.name,
        recordType: form.recordType === "" ? null : Number(form.recordType),
        recordedDate: form.date ? new Date(form.date) : null,
      });
      recordService.setActive({ objectId: row.objectId, globalId: row.globalId, name: row.name });
      useApp.getState().notify("success", "Record created and activated", row.name);
      setCreating(false);
      setForm({ ...form, name: "" });
    });

  return (
    <section className="svc-card">
      <div className="ps-row space">
        <strong style={{ fontSize: 13 }}>Active parcel record</strong>
        {active && <calcite-action icon="x" text="Clear active record" scale="s" onClick={() => recordService.setActive(null)} />}
      </div>
      {active ? (
        <div>
          <div style={{ fontWeight: 600 }}>{active.name}</div>
          <div className="mono muted" style={{ fontSize: 11 }}>{active.globalId}</div>
        </div>
      ) : (
        <div className="muted" style={{ fontSize: 12 }}>None – new fabric features will have no CreatedByRecord.</div>
      )}
      <calcite-input-text
        scale="s"
        icon="search"
        clearable
        placeholder="Find a record by name"
        value={query}
        oncalciteInputTextInput={(e) => setQuery((e.target as HTMLElement & { value: string }).value)}
      />
      {rows && rows.length > 0 && (
        <calcite-list label="Records" scale="s" style={{ maxHeight: 180, overflow: "auto" }}>
          {rows.map((r) => (
            <calcite-list-item
              key={r.objectId}
              label={r.name}
              description={[r.recordType, r.recordedDate ? new Date(r.recordedDate).toLocaleDateString("en-GB") : null, r.parcelCount != null ? `${r.parcelCount} parcels` : null]
                .filter(Boolean)
                .join(" · ")}
              onClick={() => recordService.setActive({ objectId: r.objectId, globalId: r.globalId, name: r.name })}
            >
              {active?.globalId === r.globalId && <calcite-icon slot="content-end" icon="check" scale="s" />}
            </calcite-list-item>
          ))}
        </calcite-list>
      )}
      {rows && rows.length === 0 && <div className="muted" style={{ fontSize: 12 }}>No records match.</div>}
      {editing &&
        (creating ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <calcite-label scale="s" style={{ margin: 0 }}>
              Record name (legal document reference)
              <calcite-input-text scale="s" value={form.name} oncalciteInputTextInput={calciteInput((name) => setForm((f) => ({ ...f, name })))} />
            </calcite-label>
            {typeDomain?.type === "coded-value" && (
              <calcite-label scale="s" style={{ margin: 0 }}>
                Record type
                <calcite-select scale="s" label="Record type" oncalciteSelectChange={(e) => setForm({ ...form, recordType: (e.target as HTMLElement & { value: string }).value })}>
                  <calcite-option value="">—</calcite-option>
                  {typeDomain.codedValues.map((cv) => (
                    <calcite-option key={String(cv.code)} value={String(cv.code)} selected={String(cv.code) === form.recordType || undefined}>
                      {cv.name}
                    </calcite-option>
                  ))}
                </calcite-select>
              </calcite-label>
            )}
            <calcite-label scale="s" style={{ margin: 0 }}>
              Recorded date
              <calcite-input-date-picker scale="s" value={form.date} oncalciteInputDatePickerChange={(e) => setForm({ ...form, date: String((e.target as HTMLElement & { value: string }).value ?? "") })} />
            </calcite-label>
            <div className="ps-row" style={{ gap: 6 }}>
              <calcite-button scale="s" loading={isBusy || undefined} disabled={!form.name.trim() || undefined} onClick={() => void create()}>
                Create & activate
              </calcite-button>
              <calcite-button scale="s" appearance="transparent" onClick={() => setCreating(false)}>
                Cancel
              </calcite-button>
            </div>
          </div>
        ) : (
          <calcite-button scale="s" appearance="outline" icon-start="plus" onClick={() => setCreating(true)}>
            New record
          </calcite-button>
        ))}
      <ErrorNotice message={error} onClose={() => setError(null)} />
    </section>
  );
}
