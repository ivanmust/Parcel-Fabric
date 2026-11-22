import esriConfig from "@arcgis/core/config.js";
import { layerRegistry } from "../layers/layerRegistry";
import { readRequestParam, urlPattern, type RequestParamsSource } from "../../utils/requestParams";
import { useApp } from "../../stores/appStore";
import { storedUpis, upiFormatProblem, upisInUse } from "./upi";

/**
 * Applies the UPI rules to every attribute edit of the parcel layer, whichever way it is made:
 * the Editor's attribute form, the attribute table, or app code. It checks the outgoing
 * applyEdits request and refuses it before it is sent when a new or changed UPI is badly formatted,
 * entered twice, or already used by another parcel (current or historic).
 *
 * Only UPIs that change are checked, so parcels whose existing UPI breaks the rules (for example
 * the duplicates already in DEFAULT) can still be edited otherwise. An empty UPI is allowed: such
 * parcels are listed by "Assign UPIs". Nothing is changed in the request; it is sent as is or refused.
 */
interface FeatureJson {
  attributes?: Record<string, unknown>;
}
interface LayerEditsJson {
  id?: number;
  adds?: FeatureJson[];
  updates?: FeatureJson[];
}

const parseJson = <T,>(text: string | null): T | null => {
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
};

/** Value of an attribute by field name, ignoring case (the service decides the case). */
const attribute = (attrs: Record<string, unknown> | undefined, field: string) => {
  if (!attrs) return { present: false, value: undefined as unknown };
  const key = Object.keys(attrs).find((k) => k.toLowerCase() === field.toLowerCase());
  return key === undefined ? { present: false, value: undefined as unknown } : { present: true, value: attrs[key] };
};

/** Why the UPI changes in these parcel edits are not acceptable, or null. */
export async function upiEditProblem(adds: FeatureJson[], updates: FeatureJson[], objectIdField: string): Promise<string | null> {
  const added = adds.map((f) => attribute(f.attributes, "name")).filter((a) => a.present && a.value != null && String(a.value) !== "");
  const updated = updates
    .map((f) => ({ oid: Number(attribute(f.attributes, objectIdField).value), name: attribute(f.attributes, "name") }))
    .filter((u) => Number.isInteger(u.oid) && u.name.present);
  if (!added.length && !updated.length) return null;

  const stored = await storedUpis(updated.map((u) => u.oid));
  const changed = updated.filter((u) => {
    const value = u.name.value == null ? "" : String(u.name.value);
    return value !== "" && value !== (stored.get(u.oid) ?? "");
  });
  const candidates = [...added.map((a) => ({ oid: null as number | null, upi: String(a.value) })), ...changed.map((u) => ({ oid: u.oid, upi: String(u.name.value) }))];
  if (!candidates.length) return null;

  for (const c of candidates) {
    if (c.upi !== c.upi.trim()) return `Remove the spaces before or after the UPI "${c.upi}".`;
    const problem = upiFormatProblem(c.upi);
    if (problem) return `"${c.upi}" is not a valid UPI. ${problem}`;
  }
  const upis = candidates.map((c) => c.upi);
  const repeated = upis.find((u, i) => upis.indexOf(u) !== i);
  if (repeated) return `${repeated} is given to more than one parcel.`;
  const used = await upisInUse(upis, candidates.flatMap((c) => (c.oid === null ? [] : [c.oid])));
  if (used.size) return `UPI already used by another parcel: ${[...used].join(", ")}. Each parcel needs its own UPI.`;
  return null;
}

let installed = false;

/** Install once, for the Parcel Fabric FeatureServer URL (…/FeatureServer). */
export function installUpiGuard(featureServerUrl: string) {
  if (installed) return;
  installed = true;
  const root = urlPattern(featureServerUrl);
  esriConfig.request.interceptors?.push({
    // layer-level (…/FeatureServer/17/applyEdits) and service-level (…/FeatureServer/applyEdits) edits
    urls: new RegExp(`^${root}(?:/(\\d+))?/applyEdits/?$`, "i"),
    before: async (params) => {
      const info = layerRegistry.byRole("parcel-polygon");
      if (!info || info.serviceLayerId == null) return;
      const options = params.requestOptions as RequestParamsSource;
      const layerId = new RegExp(`^${root}(?:/(\\d+))?/applyEdits`, "i").exec(params.url)?.[1];
      let edits: LayerEditsJson | undefined;
      if (layerId !== undefined) {
        if (Number(layerId) !== info.serviceLayerId) return;
        edits = { adds: parseJson<FeatureJson[]>(readRequestParam(options, "adds")) ?? [], updates: parseJson<FeatureJson[]>(readRequestParam(options, "updates")) ?? [] };
      } else {
        edits = parseJson<LayerEditsJson[]>(readRequestParam(options, "edits"))?.find((e) => e.id === info.serviceLayerId);
      }
      if (!edits) return;
      const problem = await upiEditProblem(edits.adds ?? [], edits.updates ?? [], info.layer.objectIdField);
      if (!problem) return;
      useApp.getState().notify("danger", "UPI not saved", `${problem} Nothing was sent to the server.`);
      return new Error(problem);
    },
  });
}
