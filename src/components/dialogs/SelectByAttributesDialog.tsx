import { useEffect, useMemo, useState } from "react";
import type Field from "@arcgis/core/layers/support/Field.js";
import { useEditing, type SelectionMode } from "../../stores/editingStore";
import { useApp } from "../../stores/appStore";
import { layerRegistry } from "../../gis/layers/layerRegistry";
import { selectionService } from "../../gis/selection/selectionService";
import { describeArcGISError } from "../../services/arcgis/serviceMetadata";
import { useLayerRegistryVersion } from "../../hooks/useMapController";
import { friendlyGeometryType } from "../../utils/format";
import { calciteInput } from "../../utils/calciteInput";
import { asShownOnMap, sqlString } from "../../gis/layers/query";

const OPERATORS = ["=", "<>", ">", ">=", "<", "<=", "LIKE", "IS NULL", "IS NOT NULL"] as const;
type Op = (typeof OPERATORS)[number];

const NUMERIC = new Set(["small-integer", "integer", "big-integer", "single", "double", "oid"]);

function literal(field: Field, op: Op, raw: string): string {
  if (op === "IS NULL" || op === "IS NOT NULL") return "";
  if (NUMERIC.has(field.type)) {
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new Error(`"${field.alias || field.name}" needs a number.`);
    return String(n);
  }
  if (field.type === "date") {
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) throw new Error("Enter a valid date (YYYY-MM-DD).");
    return `DATE '${d.toISOString().slice(0, 10)}'`;
  }
  return sqlString(op === "LIKE" ? `%${raw}%` : raw);
}

/** SQL where-clause builder with domain-aware values, validated by the server. */
export function SelectByAttributesDialog() {
  useLayerRegistryVersion();
  const open = useEditing((s) => s.selectByAttributesOpen);
  const layers = layerRegistry.all().filter((i) => i.kind === "feature" || i.kind === "table");
  const [layerKey, setLayerKey] = useState<string>("");
  const info = layerRegistry.get(layerKey) ?? layers.find((l) => l.fabricRole === "parcel-polygon") ?? layers[0];
  const [fieldName, setFieldName] = useState("");
  const [op, setOp] = useState<Op>("=");
  const [value, setValue] = useState("");
  const [where, setWhere] = useState("");
  const [mode, setMode] = useState<SelectionMode>("new");
  const [msg, setMsg] = useState<{ kind: "info" | "danger" | "success"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const fields = useMemo(() => (info?.layer.fields ?? []).filter((f) => !["geometry", "blob", "raster", "xml"].includes(f.type)), [info]);
  const field = fields.find((f) => f.name === fieldName) ?? fields[0];
  const domain = field ? info?.layer.getFieldDomain(field.name) : null;

  useEffect(() => {
    setFieldName("");
    setWhere("");
    setMsg(null);
  }, [layerKey]);

  const close = () => useEditing.getState().patch({ selectByAttributesOpen: false });

  const addClause = () => {
    if (!field) return;
    try {
      const clause = `${field.name} ${op}${op.startsWith("IS") ? "" : ` ${literal(field, op, value)}`}`;
      setWhere((w) => (w.trim() ? `${w.trim()} AND ${clause}` : clause));
      setMsg(null);
    } catch (e) {
      setMsg({ kind: "danger", text: (e as Error).message });
    }
  };

  const verify = async () => {
    if (!info) return;
    setBusy(true);
    try {
      const n = await info.layer.queryFeatureCount(asShownOnMap(info.layer, { where: where.trim() || "1=1" }));
      setMsg({ kind: "info", text: `The expression is valid and matches ${n.toLocaleString("en-US")} feature(s).` });
    } catch (e) {
      setMsg({ kind: "danger", text: `Invalid expression: ${describeArcGISError(e)}` });
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    if (!info) return;
    setBusy(true);
    try {
      const n = await selectionService.selectByAttributes(info, where, mode);
      useApp.getState().notify("success", "Selection updated", `${n.toLocaleString("en-US")} feature(s) matched in ${info.name}`);
      close();
    } catch (e) {
      setMsg({ kind: "danger", text: describeArcGISError(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <calcite-dialog id="dlg-select-attributes" open={open || undefined} modal width="m" heading="Select by attributes" loading={busy || undefined} oncalciteDialogClose={close}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <calcite-label scale="s">
          Layer
          <calcite-select scale="s" label="Layer" oncalciteSelectChange={(e) => setLayerKey((e.target as HTMLElement & { value: string }).value)}>
            {layers.map((l) => (
              <calcite-option key={l.key} value={l.key} selected={l.key === info?.key || undefined}>
                {`${l.name} — ${friendlyGeometryType(l.geometryType)}`}
              </calcite-option>
            ))}
          </calcite-select>
        </calcite-label>
        <div style={{ display: "grid", gridTemplateColumns: "1.3fr 0.8fr 1.3fr auto", gap: 8, alignItems: "end" }}>
          <calcite-label scale="s" style={{ margin: 0 }}>
            Field
            <calcite-select scale="s" label="Field" oncalciteSelectChange={(e) => { setFieldName((e.target as HTMLElement & { value: string }).value); setValue(""); }}>
              {fields.map((f) => (
                <calcite-option key={f.name} value={f.name} selected={f.name === field?.name || undefined}>
                  {f.alias && f.alias !== f.name ? `${f.alias} (${f.name})` : f.name}
                </calcite-option>
              ))}
            </calcite-select>
          </calcite-label>
          <calcite-label scale="s" style={{ margin: 0 }}>
            Operator
            <calcite-select scale="s" label="Operator" oncalciteSelectChange={(e) => setOp((e.target as HTMLElement & { value: string }).value as Op)}>
              {OPERATORS.map((o) => (
                <calcite-option key={o} value={o} selected={o === op || undefined}>
                  {o}
                </calcite-option>
              ))}
            </calcite-select>
          </calcite-label>
          <calcite-label scale="s" style={{ margin: 0 }}>
            Value
            {domain?.type === "coded-value" ? (
              <calcite-select scale="s" label="Value" oncalciteSelectChange={(e) => setValue((e.target as HTMLElement & { value: string }).value)}>
                <calcite-option value="">—</calcite-option>
                {domain.codedValues.map((cv) => (
                  <calcite-option key={String(cv.code)} value={String(cv.code)} selected={String(cv.code) === value || undefined}>
                    {`${cv.name} (${cv.code})`}
                  </calcite-option>
                ))}
              </calcite-select>
            ) : (
              <calcite-input-text
                scale="s"
                value={value}
                disabled={op.startsWith("IS") || undefined}
                placeholder={field?.type === "date" ? "YYYY-MM-DD" : ""}
                oncalciteInputTextInput={calciteInput(setValue)}
              />
            )}
          </calcite-label>
          <calcite-button scale="s" appearance="outline" icon-start="plus" onClick={addClause}>
            Add
          </calcite-button>
        </div>
        <calcite-label scale="s">
          WHERE clause (SQL, evaluated by the server)
          <calcite-text-area
            scale="s"
            rows={3}
            value={where}
            placeholder="e.g. district = 'Gasabo' AND size > 500"
            oncalciteTextAreaInput={calciteInput(setWhere)}
          />
        </calcite-label>
        <calcite-label scale="s">
          Selection mode
          <calcite-segmented-control scale="s" width="full" oncalciteSegmentedControlChange={(e) => setMode((e.target as HTMLElement & { value: string }).value as SelectionMode)}>
            {(["new", "add", "remove", "intersect"] as const).map((m) => (
              <calcite-segmented-control-item key={m} value={m} checked={mode === m || undefined}>
                {m === "new" ? "New" : m === "add" ? "Add to" : m === "remove" ? "Remove from" : "Select within"}
              </calcite-segmented-control-item>
            ))}
          </calcite-segmented-control>
        </calcite-label>
        {msg && (
          <calcite-notice open kind={msg.kind === "danger" ? "danger" : msg.kind === "success" ? "success" : "brand"} scale="s">
            <div slot="message">{msg.text}</div>
          </calcite-notice>
        )}
      </div>
      <calcite-button slot="footer-start" appearance="transparent" icon-start="check-circle" onClick={() => void verify()}>
        Verify
      </calcite-button>
      <calcite-button slot="footer-end" appearance="outline" kind="neutral" onClick={close}>
        Cancel
      </calcite-button>
      <calcite-button slot="footer-end" icon-start="select" onClick={() => void apply()}>
        Apply
      </calcite-button>
    </calcite-dialog>
  );
}
