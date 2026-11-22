import { useEffect, useState } from "react";
import { useEditing } from "../../stores/editingStore";
import { useApp } from "../../stores/appStore";
import { layerRegistry } from "../../gis/layers/layerRegistry";
import { selectionService } from "../../gis/selection/selectionService";
import { parcelFabricService, type DivideOption, type ParcelRef } from "../../gis/parcel-fabric/parcelFabricService";
import { LOCATION_FIELDS, saveUpis, suggestUpisForParcels, upiAttributes, upiFormatProblem, upisInUse, UPI_EXAMPLE, type Location } from "../../gis/parcel-fabric/upi";
import { calciteInput } from "../../utils/calciteInput";
import { useAsyncAction } from "../../hooks/useAsyncAction";
import { ErrorNotice } from "../common/ErrorNotice";

/** Merge, Divide and Assign UPIs for Parcel Fabric parcels. */
export function ParcelFabricDialogs() {
  return (
    <>
      <MergeParcelsDialog />
      <DivideParcelDialog />
      <AssignUpiDialog />
    </>
  );
}

/** The selected current parcels (Plot layer), loaded when a dialog opens. */
function useSelectedParcels(open: boolean) {
  const [parcels, setParcels] = useState<ParcelRef[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    let stale = false;
    setParcels(null);
    setError(null);
    const info = layerRegistry.byRole("parcel-polygon");
    const ids = info ? selectionService.getIds(info) : [];
    parcelFabricService
      .readParcels(ids)
      .then((p) => !stale && setParcels(p))
      .catch((e: Error) => !stale && setError(e.message));
    return () => {
      stale = true;
    };
  }, [open]);
  return { parcels, error };
}

function Requirements() {
  const editing = useEditing((s) => s.session) === "editing";
  const record = useEditing((s) => s.activeRecord);
  if (!editing)
    return (
      <calcite-notice open kind="warning" scale="s">
        <div slot="message">Start editing in a named version first.</div>
      </calcite-notice>
    );
  return record ? (
    <div className="kv">
      <div className="k">Record</div>
      <div>{record.name}</div>
    </div>
  ) : (
    <calcite-notice open kind="warning" scale="s">
      <div slot="message">Choose the active parcel record first (Editing Tools → Active parcel record). It is the legal document for this change.</div>
    </calcite-notice>
  );
}

function LocationSummary({ location }: { location: Location }) {
  const entries = LOCATION_FIELDS.filter((f) => location[f]).map((f) => [f, location[f]!] as const);
  if (!entries.length) return null;
  return (
    <div className="kv">
      {entries.map(([k, v]) => (
        <div key={k} style={{ display: "contents" }}>
          <div className="k" style={{ textTransform: "capitalize" }}>{k}</div>
          <div>{v}</div>
        </div>
      ))}
    </div>
  );
}

function MergeParcelsDialog() {
  const open = useEditing((s) => s.mergeParcelsOpen);
  const editing = useEditing((s) => s.session) === "editing";
  const record = useEditing((s) => s.activeRecord);
  const { parcels, error: loadError } = useSelectedParcels(open);
  const [name, setName] = useState("");
  const [location, setLocation] = useState<Location>({});
  const { isBusy, error, setError, run } = useAsyncAction();
  const close = () => {
    useEditing.getState().patch({ mergeParcelsOpen: false });
    setError(null);
    setName("");
    setLocation({});
  };

  // Suggest the new UPI (next free number in the cell) and its location fields.
  useEffect(() => {
    if (!open || !parcels || parcels.length < 2) return;
    let stale = false;
    suggestUpisForParcels(
      parcels.map((p) => p.objectId),
      1,
    )
      .then((s) => {
        if (stale || !s) return;
        setLocation(s.location);
        setName((n) => n || s.upis[0]!);
      })
      .catch(() => undefined);
    return () => {
      stale = true;
    };
  }, [open, parcels]);

  const formatProblem = name ? upiFormatProblem(name) : null;
  const merge = () =>
    run(async () => {
      if (!parcels) return;
      const problem = upiFormatProblem(name);
      if (problem) throw new Error(problem);
      const ids = parcels.map((p) => p.objectId);
      if ((await upisInUse([name], ids)).size) throw new Error(`${name.trim()} is already used by another parcel.`);
      const { name: _n, ...extra } = upiAttributes(name, location);
      await parcelFabricService.merge(ids, name, extra);
      useApp.getState().notify("success", "Parcels merged", `${parcels.length} parcels → ${name.trim()}. The originals are kept as historic parcels.`);
      selectionService.clear();
      close();
    });

  const ready = editing && !!record && !!parcels && parcels.length >= 2 && name.trim().length > 0 && !formatProblem;
  return (
    <calcite-dialog id="dlg-merge-parcels" open={open || undefined} modal width="s" heading="Merge parcels" loading={isBusy || undefined} oncalciteDialogClose={close}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>
          Creates one new parcel from the selected parcels. The selected parcels are retired by the record and kept as historic parcels, so their history is preserved.
        </p>
        <Requirements />
        <div>
          <div className="ps-section-title">Parcels to merge</div>
          {loadError && <div className="muted">{loadError}</div>}
          {!parcels && !loadError && <calcite-loader inline label="Loading parcels" scale="s" />}
          {parcels && (
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {parcels.map((p) => (
                <li key={p.objectId} className="mono" style={{ fontSize: 13 }}>
                  {p.name ?? `OBJECTID ${p.objectId}`}
                </li>
              ))}
            </ul>
          )}
          {parcels && parcels.length < 2 && <div className="muted">Select at least two current parcels.</div>}
        </div>
        <calcite-label scale="s">
          UPI of the new parcel
          <calcite-input-text
            id="merge-new-upi"
            scale="s"
            value={name}
            placeholder={`e.g. ${UPI_EXAMPLE}`}
            status={formatProblem ? "invalid" : undefined}
            oncalciteInputTextInput={calciteInput(setName)}
          />
          <span className="muted" style={{ fontSize: 12 }}>{formatProblem ?? "Suggested: the next free number in this cell. Checked against all parcels, including historic ones."}</span>
        </calcite-label>
        <LocationSummary location={location} />
        <ErrorNotice message={error} />
      </div>
      <calcite-button slot="footer-end" appearance="outline" kind="neutral" onClick={close}>
        Cancel
      </calcite-button>
      <calcite-button slot="footer-end" icon-start="merge" disabled={!ready || isBusy || undefined} onClick={() => void merge()}>
        Merge parcels
      </calcite-button>
    </calcite-dialog>
  );
}

const DIVIDE_OPTIONS: { value: DivideOption; label: string; hint: string }[] = [
  { value: "ProportionalArea", label: "Proportional area", hint: "Splits the parcel into parts of equal share of its area." },
  { value: "EqualArea", label: "Equal area", hint: "Parts of the area you enter (m²); the remainder is kept or distributed." },
  { value: "EqualWidth", label: "Equal width", hint: "Parts of the width you enter (m), measured across the dividing direction." },
];

function DivideParcelDialog() {
  const open = useEditing((s) => s.divideParcelOpen);
  const editing = useEditing((s) => s.session) === "editing";
  const record = useEditing((s) => s.activeRecord);
  const { parcels, error: loadError } = useSelectedParcels(open);
  const [option, setOption] = useState<DivideOption>("ProportionalArea");
  const [parts, setParts] = useState("2");
  const [size, setSize] = useState("");
  const [bearing, setBearing] = useState("0");
  const [leftSide, setLeftSide] = useState(true);
  const [distribute, setDistribute] = useState(false);
  const { isBusy, error, setError, run } = useAsyncAction();
  const parcel = parcels?.length === 1 ? parcels[0]! : null;
  const close = () => {
    useEditing.getState().patch({ divideParcelOpen: false });
    setError(null);
  };

  const divide = () =>
    run(async () => {
      if (!parcel) return;
      const { created } = await parcelFabricService.divide(parcel.objectId, {
        option,
        parts: Number(parts),
        areaOrWidth: Number(size || 0),
        bearing: Number(bearing),
        leftSide,
        distributeRemainder: distribute,
      });
      useApp.getState().notify("success", "Parcel divided", `${parcel.name ?? parcel.objectId} → ${created.length || parts} parcels. Now give each one its UPI.`);
      selectionService.clear();
      close();
      // Straight on to the UPIs of the new parcels.
      if (created.length) useEditing.getState().patch({ assignUpiTargets: created });
    });

  const hint = DIVIDE_OPTIONS.find((o) => o.value === option)!.hint;
  return (
    <calcite-dialog id="dlg-divide-parcel" open={open || undefined} modal width="s" heading="Divide parcel" loading={isBusy || undefined} oncalciteDialogClose={close}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>
          Divides the selected parcel into new parcels. The original is retired by the record and kept as a historic parcel.
        </p>
        <Requirements />
        <div className="kv">
          <div className="k">Parcel</div>
          <div className="mono">{loadError ?? (parcels ? (parcel ? (parcel.name ?? `OBJECTID ${parcel.objectId}`) : "Select exactly one current parcel.") : "Loading…")}</div>
        </div>
        <calcite-label scale="s">
          Method
          <calcite-segmented-control scale="s" width="full" oncalciteSegmentedControlChange={(e) => setOption((e.target as HTMLElement & { value: string }).value as DivideOption)}>
            {DIVIDE_OPTIONS.map((o) => (
              <calcite-segmented-control-item key={o.value} value={o.value} checked={option === o.value || undefined}>
                {o.label}
              </calcite-segmented-control-item>
            ))}
          </calcite-segmented-control>
          <span className="muted" style={{ fontSize: 12 }}>{hint}</span>
        </calcite-label>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
          <calcite-label scale="s" style={{ margin: 0 }}>
            Parts
            <calcite-input-number id="divide-parts" scale="s" min={2} max={100} step={1} value={parts} oncalciteInputNumberInput={calciteInput(setParts)} />
          </calcite-label>
          <calcite-label scale="s" style={{ margin: 0 }}>
            {option === "EqualWidth" ? "Width (m)" : "Area (m²)"}
            <calcite-input-number scale="s" min={0} value={size} disabled={option === "ProportionalArea" || undefined} oncalciteInputNumberInput={calciteInput(setSize)} />
          </calcite-label>
          <calcite-label scale="s" style={{ margin: 0 }}>
            Bearing (°)
            <calcite-input-number id="divide-bearing" scale="s" min={0} max={359.9999} value={bearing} oncalciteInputNumberInput={calciteInput(setBearing)} />
          </calcite-label>
        </div>
        <span className="muted" style={{ fontSize: 12 }}>Bearing is the direction of the dividing lines, in degrees clockwise from north (0 = north–south lines).</span>
        <calcite-label scale="s" layout="inline">
          <calcite-checkbox checked={leftSide || undefined} oncalciteCheckboxChange={(e) => setLeftSide((e.target as HTMLElement & { checked: boolean }).checked)} />
          Start from the north / west side
        </calcite-label>
        {option !== "ProportionalArea" && (
          <calcite-label scale="s" layout="inline">
            <calcite-checkbox checked={distribute || undefined} oncalciteCheckboxChange={(e) => setDistribute((e.target as HTMLElement & { checked: boolean }).checked)} />
            Distribute the remainder over the parts
          </calcite-label>
        )}
        <calcite-notice open kind="brand" scale="s" icon="information">
          <div slot="message">After dividing, you'll be asked for the UPI of each new parcel (suggestions are filled in).</div>
        </calcite-notice>
        <ErrorNotice message={error} />
      </div>
      <calcite-button slot="footer-end" appearance="outline" kind="neutral" onClick={close}>
        Cancel
      </calcite-button>
      <calcite-button slot="footer-end" icon-start="split" disabled={!editing || !record || !parcel || isBusy || undefined} onClick={() => void divide()}>
        Divide parcel
      </calcite-button>
    </calcite-dialog>
  );
}

/** Give parcels their UPIs (and parcel numbers and empty location fields), with suggestions and checks. */
function AssignUpiDialog() {
  const targets = useEditing((s) => s.assignUpiTargets);
  const editing = useEditing((s) => s.session) === "editing";
  const open = targets.length > 0;
  const [rows, setRows] = useState<{ objectId: number; current: string | null; upi: string }[] | null>(null);
  const [location, setLocation] = useState<Location>({});
  const { isBusy, error, setError, run } = useAsyncAction();
  const close = () => {
    useEditing.getState().patch({ assignUpiTargets: [] });
    setRows(null);
    setError(null);
    setLocation({});
  };

  useEffect(() => {
    if (!open) return;
    let stale = false;
    setRows(null);
    (async () => {
      const parcels = await parcelFabricService.readParcels(targets);
      const missing = parcels.filter((p) => !p.name || upiFormatProblem(p.name));
      const suggestion = await suggestUpisForParcels(
        parcels.map((p) => p.objectId),
        missing.length,
      ).catch(() => null);
      if (stale) return;
      let k = 0;
      setLocation(suggestion?.location ?? {});
      setRows(
        parcels.map((p) => ({
          objectId: p.objectId,
          current: p.name,
          upi: p.name && !upiFormatProblem(p.name) ? p.name : (suggestion?.upis[k++] ?? ""),
        })),
      );
    })().catch((e: Error) => !stale && setError(e.message));
    return () => {
      stale = true;
    };
  }, [open, targets, setError]);

  const setUpi = (objectId: number) => (value: string) => setRows((rs) => rs?.map((r) => (r.objectId === objectId ? { ...r, upi: value } : r)) ?? null);
  const upis = rows?.map((r) => r.upi.trim()) ?? [];
  const problemOf = (upi: string, i: number) => upiFormatProblem(upi) ?? (upis.indexOf(upi.trim()) !== i ? "Entered twice." : null);
  const allValid = !!rows && rows.every((r, i) => !problemOf(r.upi, i));

  const save = () =>
    run(async () => {
      if (!rows) return;
      const n = await saveUpis(
        rows.map((r) => ({ objectId: r.objectId, upi: r.upi })),
        location,
      );
      useApp.getState().notify("success", "UPIs saved", `${n} parcel(s) updated (unsaved in the version until you save).`);
      close();
    });

  return (
    <calcite-dialog id="dlg-assign-upi" open={open || undefined} modal width="s" heading="Assign UPIs" loading={isBusy || undefined} oncalciteDialogClose={close}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>
          Suggestions use the next free numbers in this cell. Each UPI is checked against all parcels, including historic ones. The parcel number and any empty location fields are filled in too.
        </p>
        {!editing && (
          <calcite-notice open kind="warning" scale="s">
            <div slot="message">Start editing first.</div>
          </calcite-notice>
        )}
        {!rows && !error && <calcite-loader inline label="Preparing suggestions" scale="s" />}
        {rows?.map((r, i) => {
          const problem = problemOf(r.upi, i);
          return (
            <calcite-label key={r.objectId} scale="s" style={{ margin: 0 }}>
              {r.current ? `Parcel ${r.current}` : `New parcel (OBJECTID ${r.objectId})`}
              <calcite-input-text id={`upi-${r.objectId}`} scale="s" value={r.upi} status={problem ? "invalid" : undefined} oncalciteInputTextInput={calciteInput(setUpi(r.objectId))} />
              {problem && <span style={{ fontSize: 12, color: "var(--calcite-color-status-danger)" }}>{problem}</span>}
            </calcite-label>
          );
        })}
        <LocationSummary location={location} />
        <ErrorNotice message={error} />
      </div>
      <calcite-button slot="footer-end" appearance="outline" kind="neutral" onClick={close}>
        Later
      </calcite-button>
      <calcite-button slot="footer-end" icon-start="save" disabled={!editing || !allValid || isBusy || undefined} onClick={() => void save()}>
        Save UPIs
      </calcite-button>
    </calcite-dialog>
  );
}
