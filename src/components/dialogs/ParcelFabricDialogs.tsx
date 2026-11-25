import { Fragment, useEffect, useState } from "react";
import { useEditing } from "../../stores/editingStore";
import { useApp } from "../../stores/appStore";
import { layerRegistry } from "../../gis/layers/layerRegistry";
import { selectionService } from "../../gis/selection/selectionService";
import { parcelFabricService, type DivideOption, type ParcelRef } from "../../gis/parcel-fabric/parcelFabricService";
import { cellsOf, LOCATION_FIELDS, saveUpis, storedUpis, suggestUpis, upiAttributes, upiFormatProblem, upisInUse, UPI_EXAMPLE, type Location, type UpiSuggestion } from "../../gis/parcel-fabric/upi";
import { calciteInput } from "../../utils/calciteInput";
import { useAsyncAction } from "../../hooks/useAsyncAction";
import { ErrorNotice } from "../common/ErrorNotice";
import { manualSplit } from "../../gis/parcel-fabric/manualSplit";
import { formatArea } from "../../utils/format";

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

/** Where the suggested cell came from, and a warning about unusual numbers in it. */
function SuggestionNote({ suggestion }: { suggestion: UpiSuggestion | null }) {
  if (!suggestion) return null;
  return (
    <>
      <div id="upi-basis" className="muted" style={{ fontSize: 12 }}>
        {suggestion.basis}. Next free number after the highest used in this cell (historic parcels included).
      </div>
      {suggestion.warning && (
        <calcite-notice id="upi-warning" open kind="warning" scale="s" icon="exclamation-mark-triangle">
          <div slot="message">{suggestion.warning}</div>
        </calcite-notice>
      )}
    </>
  );
}

function MergeParcelsDialog() {
  const open = useEditing((s) => s.mergeParcelsOpen);
  const editing = useEditing((s) => s.session) === "editing";
  const record = useEditing((s) => s.activeRecord);
  const { parcels, error: loadError } = useSelectedParcels(open);
  const [name, setName] = useState("");
  const [location, setLocation] = useState<Location>({});
  const [suggestion, setSuggestion] = useState<UpiSuggestion | null>(null);
  /** The parents' cells; the editor chooses one when there are several. */
  const [cells, setCells] = useState<string[]>([]);
  const [cell, setCell] = useState<string | null>(null);
  /** Neighbour check: undefined while checking, null when they form one connected group, else why not. */
  const [notNeighbours, setNotNeighbours] = useState<string | null | undefined>(undefined);
  const { isBusy, error, setError, run } = useAsyncAction();
  const close = () => {
    useEditing.getState().patch({ mergeParcelsOpen: false });
    setError(null);
    setName("");
    setLocation({});
    setSuggestion(null);
    setCells([]);
    setCell(null);
    setNotNeighbours(undefined);
  };

  // Only neighbouring parcels can be merged: check the shapes as soon as the parcels are known.
  useEffect(() => {
    if (!open || !parcels || parcels.length < 2) return;
    let stale = false;
    setNotNeighbours(undefined);
    parcelFabricService
      .checkMergeNeighbours(parcels.map((p) => p.objectId))
      .then((problem) => !stale && setNotNeighbours(problem))
      .catch((e: Error) => !stale && setNotNeighbours(`The neighbour check could not run: ${e.message}`));
    return () => {
      stale = true;
    };
  }, [open, parcels]);

  // The new parcel's cell is the parents' cell; across cells the editor chooses it. Then suggest the UPI.
  useEffect(() => {
    if (!open || !parcels || parcels.length < 2) return;
    let stale = false;
    const ids = parcels.map((p) => p.objectId);
    (async () => {
      const found = await cellsOf(ids);
      if (stale) return;
      setCells(found);
      if (found.length > 1 && !cell) return setSuggestion(null);
      const s = await suggestUpis({ count: 1, from: ids, cell: found.length > 1 ? (cell ?? undefined) : undefined });
      if (stale || !s) return;
      setSuggestion(s);
      setLocation(s.location);
      setName(s.upis[0]!);
    })().catch((e: Error) => !stale && setError(e.message));
    return () => {
      stale = true;
    };
  }, [open, parcels, cell, setError]);
  const mustChooseCell = cells.length > 1 && !cell;

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

  const ready = editing && !!record && !!parcels && parcels.length >= 2 && notNeighbours === null && name.trim().length > 0 && !formatProblem && !mustChooseCell;
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
          {parcels && parcels.length >= 2 && notNeighbours === undefined && <div className="muted" style={{ fontSize: 12 }}>Checking that the parcels are neighbours…</div>}
          {notNeighbours && (
            <calcite-notice id="merge-not-neighbours" open kind="danger" scale="s" icon="exclamation-mark-triangle" style={{ marginTop: 8 }}>
              <div slot="message">{notNeighbours}</div>
            </calcite-notice>
          )}
        </div>
        {cells.length > 1 && (
          <calcite-label scale="s">
            These parcels are in different cells. Which cell is the new parcel in?
            <calcite-segmented-control id="merge-cell" scale="s" width="full" oncalciteSegmentedControlChange={(e) => setCell((e.target as HTMLElement & { value: string }).value)}>
              {cells.map((c) => (
                <calcite-segmented-control-item key={c} value={c} checked={cell === c || undefined}>
                  {c}
                </calcite-segmented-control-item>
              ))}
            </calcite-segmented-control>
          </calcite-label>
        )}
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
          {formatProblem && <span className="muted" style={{ fontSize: 12 }}>{formatProblem}</span>}
        </calcite-label>
        {mustChooseCell ? <div className="muted" style={{ fontSize: 12 }}>Choose the cell to get a suggested UPI.</div> : <SuggestionNote suggestion={suggestion} />}
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

type SplitMethod = DivideOption | "Manual";

const DIVIDE_OPTIONS: { value: SplitMethod; label: string; hint: string }[] = [
  { value: "Manual", label: "Draw the line manually", hint: "You draw the boundary between the new parcels, straight or with bends. It snaps to parcels and uploaded data. For more parts, split a new part again." },
  { value: "ProportionalArea", label: "Proportional area", hint: "Splits the parcel into parts of equal share of its area." },
  { value: "EqualArea", label: "Equal area", hint: "Parts of the area you enter (m²); the remainder is kept or distributed." },
  { value: "EqualWidth", label: "Equal width", hint: "Parts of the width you enter (m), measured across the dividing direction." },
];

function DivideParcelDialog() {
  const open = useEditing((s) => s.divideParcelOpen);
  const editing = useEditing((s) => s.session) === "editing";
  const record = useEditing((s) => s.activeRecord);
  const { parcels, error: loadError } = useSelectedParcels(open);
  const [option, setOption] = useState<SplitMethod>("ProportionalArea");
  const [parts, setParts] = useState("2");
  const [size, setSize] = useState("");
  const [bearing, setBearing] = useState("0");
  const [leftSide, setLeftSide] = useState(true);
  const [distribute, setDistribute] = useState(false);
  const { isBusy, error, setError, run } = useAsyncAction();
  const parcel = parcels?.length === 1 ? parcels[0]! : null;
  const split = useEditing((s) => s.manualSplit);
  const manual = option === "Manual";
  const drawing = split?.phase === "drawing";
  const onDialogClose = () => {
    // The dialog steps aside while the line is drawn; that is not a cancel.
    if (useEditing.getState().manualSplit?.phase !== "drawing") close();
  };
  const close = () => {
    manualSplit.cancel();
    useEditing.getState().patch({ divideParcelOpen: false });
    setError(null);
  };

  const divide = () =>
    run(async () => {
      if (!parcel || option === "Manual") return;
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
      if (created.length) useEditing.getState().patch({ assignUpiTargets: created, assignUpiFrom: [parcel.objectId] });
    });

  const draw = () =>
    run(async () => {
      if (parcel) await manualSplit.draw(parcel.objectId);
    });
  const splitManually = () =>
    run(async () => {
      if (!parcel) return;
      const created = await manualSplit.commit();
      useApp.getState().notify("success", "Parcel split", `${parcel.name ?? parcel.objectId} → 2 parcels. Now give each one its UPI.`);
      selectionService.clear();
      close();
      useEditing.getState().patch({ assignUpiTargets: created, assignUpiFrom: [parcel.objectId] });
    });

  const hint = DIVIDE_OPTIONS.find((o) => o.value === option)!.hint;
  return (
    <calcite-dialog id="dlg-divide-parcel" open={(open && !drawing) || undefined} modal width="s" heading="Divide parcel" loading={(isBusy && !drawing) || undefined} oncalciteDialogClose={onDialogClose}>
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
          <calcite-segmented-control
            id="divide-method"
            scale="s"
            width="full"
            layout="vertical"
            oncalciteSegmentedControlChange={(e) => {
              manualSplit.cancel();
              setError(null);
              setOption((e.target as HTMLElement & { value: string }).value as SplitMethod);
            }}
          >
            {DIVIDE_OPTIONS.map((o) => (
              <calcite-segmented-control-item key={o.value} value={o.value} checked={option === o.value || undefined}>
                {o.label}
              </calcite-segmented-control-item>
            ))}
          </calcite-segmented-control>
          <span className="muted" style={{ fontSize: 12 }}>{hint}</span>
        </calcite-label>
        <div style={{ display: manual ? "none" : "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
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
        <span className="muted" style={{ fontSize: 12, display: manual ? "none" : undefined }}>Bearing is the direction of the dividing lines, in degrees clockwise from north (0 = north–south lines).</span>
        <calcite-label scale="s" layout="inline" style={{ display: manual ? "none" : undefined }}>
          <calcite-checkbox checked={leftSide || undefined} oncalciteCheckboxChange={(e) => setLeftSide((e.target as HTMLElement & { checked: boolean }).checked)} />
          Start from the north / west side
        </calcite-label>
        {!manual && option !== "ProportionalArea" && (
          <calcite-label scale="s" layout="inline">
            <calcite-checkbox checked={distribute || undefined} oncalciteCheckboxChange={(e) => setDistribute((e.target as HTMLElement & { checked: boolean }).checked)} />
            Distribute the remainder over the parts
          </calcite-label>
        )}
        <calcite-notice open kind="brand" scale="s" icon="information">
          <div slot="message">After dividing, you'll be asked for the UPI of each new parcel (suggestions are filled in).</div>
        </calcite-notice>
        {manual && split?.phase === "ready" && (
          <div className="kv" id="manual-split-preview">
            {split.areas.map((m2, i) => (
              <Fragment key={i}>
                <div className="k">Part {"AB"[i]}</div>
                <div>{formatArea(m2)}</div>
              </Fragment>
            ))}
          </div>
        )}
        <ErrorNotice message={error ?? (manual && split?.phase === "invalid" ? split.message : null)} />
      </div>
      <calcite-button slot="footer-end" appearance="outline" kind="neutral" onClick={close}>
        Cancel
      </calcite-button>
      {manual && (
        <calcite-button
          slot="footer-end"
          id="manual-split-draw"
          icon-start="line"
          appearance={split?.phase === "ready" ? "outline" : "solid"}
          disabled={!editing || !record || !parcel || isBusy || undefined}
          onClick={() => void draw()}
        >
          {split ? "Redraw line" : "Draw split line"}
        </calcite-button>
      )}
      {manual && split?.phase === "ready" && (
        <calcite-button slot="footer-end" id="manual-split-commit" icon-start="split" disabled={!editing || !record || isBusy || undefined} onClick={() => void splitManually()}>
          Split parcel
        </calcite-button>
      )}
      {!manual && (
        <calcite-button slot="footer-end" icon-start="split" disabled={!editing || !record || !parcel || isBusy || undefined} onClick={() => void divide()}>
          Divide parcel
        </calcite-button>
      )}
    </calcite-dialog>
  );
}

/** Give parcels their UPIs (and parcel numbers and empty location fields), with suggestions and checks. */
function AssignUpiDialog() {
  const targets = useEditing((s) => s.assignUpiTargets);
  const from = useEditing((s) => s.assignUpiFrom);
  const [suggestion, setSuggestion] = useState<UpiSuggestion | null>(null);
  const editing = useEditing((s) => s.session) === "editing";
  const open = targets.length > 0;
  const [rows, setRows] = useState<{ objectId: number; current: string | null; upi: string }[] | null>(null);
  const [location, setLocation] = useState<Location>({});
  const { isBusy, error, setError, run } = useAsyncAction();
  const close = () => {
    useEditing.getState().patch({ assignUpiTargets: [], assignUpiFrom: [] });
    setRows(null);
    setSuggestion(null);
    setError(null);
    setLocation({});
  };

  useEffect(() => {
    if (!open) return;
    let stale = false;
    setRows(null);
    (async () => {
      const parcels = await parcelFabricService.readParcels(targets);
      // A UPI of the parcel(s) these come from has expired with them: never offer it again.
      const expired = new Set([...(await storedUpis(from)).values()].filter((u): u is string => !!u));
      const usable = (name: string | null): name is string => !!name && !upiFormatProblem(name) && !expired.has(name);
      const missing = parcels.filter((p) => !usable(p.name));
      const suggestion = missing.length ? await suggestUpis({ count: missing.length, parcels: missing.map((p) => p.objectId), from }) : null;
      if (stale) return;
      let k = 0;
      setSuggestion(suggestion);
      setLocation(suggestion?.location ?? {});
      setRows(
        parcels.map((p) => ({
          objectId: p.objectId,
          current: p.name,
          upi: usable(p.name) ? p.name : (suggestion?.upis[k++] ?? ""),
        })),
      );
    })().catch((e: Error) => !stale && setError(e.message));
    return () => {
      stale = true;
    };
  }, [open, targets, from, setError]);

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
        <SuggestionNote suggestion={suggestion} />
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
