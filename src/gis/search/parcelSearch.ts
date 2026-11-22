import SearchSource from "@arcgis/core/widgets/Search/SearchSource.js";
import Graphic from "@arcgis/core/Graphic.js";
import Polygon from "@arcgis/core/geometry/Polygon.js";
import type Extent from "@arcgis/core/geometry/Extent.js";
import type SpatialReference from "@arcgis/core/geometry/SpatialReference.js";
import type FeatureLayer from "@arcgis/core/layers/FeatureLayer.js";
import type { SearchResult, SuggestResult } from "@arcgis/core/widgets/Search/types.js";
import { layerRegistry } from "../layers/layerRegistry";
import { asShownOnMap, hasField, sqlString } from "../layers/query";
import { recordsLayer } from "../parcel-fabric/recordService";
import { useApp } from "../../stores/appStore";


const PLACE_FIELDS: { field: string; label: string }[] = [
  { field: "village", label: "village" },
  { field: "cell", label: "cell" },
  { field: "sector", label: "sector" },
  { field: "district", label: "district" },
];
const UPI_FIELD = "name";

const normalizeUpi = (s: string) =>
  s
    .trim()
    .replace(/[\\\-\s]+/g, "/")
    .replace(/\/{2,}/g, "/");

function plotLayer(): FeatureLayer | null {
  return layerRegistry.byRole("parcel-polygon")?.layer ?? null;
}
/** The Search component zooms to `target`: hand it the padded area while `feature` stays the real one. */
const zoomTarget = (extent: Extent) => new Graphic({ geometry: Polygon.fromExtent(extent) });

/** Show some surroundings: at least ~150 m across (map units are metres), and a margin around larger areas. */
const MIN_SPAN_M = 150;
function withinParcels(extent: Extent): Extent {
  const span = Math.max(extent.width, extent.height);
  const factor = span > 0 ? Math.max(1.6, MIN_SPAN_M / span) : 1;
  return extent.clone().expand(factor);
}

// ------------------------------------------------------------------------------------- UPI
async function upiSuggestions(term: string, max: number, signal?: AbortSignal): Promise<SuggestResult[]> {
  const layer = plotLayer();
  const upi = normalizeUpi(term);
  if (!layer || !upi) return [];
  const extra = PLACE_FIELDS.filter((p) => hasField(layer, p.field) && (p.field === "village" || p.field === "cell")).map((p) => p.field);
  const fs = await layer.queryFeatures(
    asShownOnMap(layer, {
      where: `${UPI_FIELD} LIKE ${sqlString(`%${upi}%`)}`,
      outFields: [layer.objectIdField, UPI_FIELD, ...extra],
      orderByFields: [UPI_FIELD],
      num: max,
      returnGeometry: false,
    }),
    { signal },
  );
  return fs.features.map((g) => {
    const a = g.attributes;
    const where = extra.map((f) => a[f]).filter(Boolean).join(", ");
    return { key: a[layer.objectIdField], text: where ? `${a[UPI_FIELD]} — ${where}` : String(a[UPI_FIELD]) };
  });
}

async function upiResults(suggest: SuggestResult, max: number, sr: SpatialReference | undefined, signal?: AbortSignal): Promise<SearchResult[]> {
  const layer = plotLayer();
  if (!layer) return [];
  let where: string;
  if (typeof suggest.key === "number") where = `${layer.objectIdField} = ${suggest.key}`;
  else {
    const upi = normalizeUpi(String(suggest.text ?? "").split(" — ")[0] ?? "");
    if (!upi) return [];
    // Enter on typed text: an exact UPI wins; otherwise the closest partial matches.
    const equals = `${UPI_FIELD} = ${sqlString(upi)}`;
    const exact = await layer.queryFeatureCount(asShownOnMap(layer, { where: equals }), { signal });
    where = exact ? equals : `${UPI_FIELD} LIKE ${sqlString(`%${upi}%`)}`;
  }
  const fs = await layer.queryFeatures(
    asShownOnMap(layer, { where, outFields: ["*"], orderByFields: [UPI_FIELD], num: max, returnGeometry: true, outSpatialReference: sr }),
    { signal },
  );
  return fs.features
    .filter((g) => g.geometry)
    .map((g) => {
      g.layer = layer;
      const extent = withinParcels(g.geometry!.extent!);
      return { feature: g, target: zoomTarget(extent), extent, name: String(g.attributes[UPI_FIELD]) };
    });
}

// ------------------------------------------------------------------------------------ Name
type NameKey = { kind: "place"; field: string; value: string } | { kind: "record"; objectId: number };
const encodeKey = (k: NameKey) => JSON.stringify(k);
const decodeKey = (s: unknown): NameKey | null => {
  try {
    return typeof s === "string" ? (JSON.parse(s) as NameKey) : null;
  } catch {
    return null;
  }
};

async function nameSuggestions(term: string, max: number, signal?: AbortSignal): Promise<SuggestResult[]> {
  const t = term.trim();
  if (!t) return [];
  const like = `LIKE UPPER(${sqlString(`%${t}%`)})`;
  const out: SuggestResult[] = [];
  const plots = plotLayer();
  if (plots) {
    const places = await Promise.all(
      PLACE_FIELDS.filter((p) => hasField(plots, p.field)).map(async (p) => {
        const fs = await plots.queryFeatures(
          asShownOnMap(plots, { where: `UPPER(${p.field}) ${like}`, outFields: [p.field], returnDistinctValues: true, orderByFields: [p.field], num: max, returnGeometry: false }),
          { signal },
        );
        // The data has some names in two spellings (e.g. "KIMIHURURA" / "Kimihurura"): list each name once.
        const seen = new Set<string>();
        return fs.features
          .map((g) => String(g.attributes[p.field] ?? "").trim())
          .filter((v) => v && !seen.has(v.toUpperCase()) && seen.add(v.toUpperCase()))
          .map((v) => ({ key: encodeKey({ kind: "place", field: p.field, value: v }), text: `${v} — ${p.label}` }));
      }),
    );
    out.push(...places.flat());
  }
  const records = recordsLayer();
  if (records) {
    const nameField = records.displayField || "name";
    const fs = await records.queryFeatures(
      asShownOnMap(records, { where: `UPPER(${nameField}) ${like}`, outFields: [records.objectIdField, nameField], orderByFields: [nameField], num: max, returnGeometry: false }),
      { signal },
    );
    out.push(...fs.features.map((g) => ({ key: encodeKey({ kind: "record", objectId: g.attributes[records.objectIdField] }), text: `${g.attributes[nameField]} — parcel record` })));
  }
  return out.slice(0, max);
}

async function nameResults(suggest: SuggestResult, sr: SpatialReference | undefined, signal?: AbortSignal): Promise<SearchResult[]> {
  let key = decodeKey(suggest.key);
  if (!key) {
    // Enter on typed text: use the best suggestion.
    const [first] = await nameSuggestions(String(suggest.text ?? ""), 1, signal);
    key = decodeKey(first?.key);
    if (!key) return [];
  }
  if (key.kind === "place") {
    const plots = plotLayer();
    if (!plots) return [];
    const where = `UPPER(${key.field}) = UPPER(${sqlString(key.value)})`;
    const { extent, count } = await plots.queryExtent(asShownOnMap(plots, { where, outSpatialReference: sr }), { signal });
    if (!extent || !count) return [];
    const label = PLACE_FIELDS.find((p) => p.field === key.field)?.label ?? key.field;
    const name = `${key.value} (${label}) — ${count.toLocaleString("en-US")} parcel(s)`;
    useApp.getState().notify("info", key.value, `${label[0]!.toUpperCase()}${label.slice(1)} · ${count.toLocaleString("en-US")} parcel(s)`);
    const g = new Graphic({ geometry: Polygon.fromExtent(extent), attributes: { name } });
    const padded = extent.clone().expand(1.1);
    return [{ feature: g, target: zoomTarget(padded), extent: padded, name }];
  }
  const records = recordsLayer();
  if (!records) return [];
  const fs = await records.queryFeatures(
    asShownOnMap(records, { objectIds: [key.objectId], outFields: ["*"], returnGeometry: true, outSpatialReference: sr }),
    { signal },
  );
  const rec = fs.features[0];
  if (!rec) return [];
  rec.layer = records;
  const name = String(rec.attributes[records.displayField || "name"] ?? `Record ${key.objectId}`);
  // A record means the parcels it created: zoom to those (the record's own shape can be a tiny
  // placeholder). Fall back to the record's shape when it has no parcels yet.
  let extent: Extent | null = null;
  const plots = plotLayer();
  const guid = rec.attributes[records.globalIdField || "globalid"];
  if (plots && guid && hasField(plots, "createdbyrecord")) {
    const r = await plots.queryExtent(asShownOnMap(plots, { where: `createdbyrecord = '${guid}'`, outSpatialReference: sr }), { signal });
    if (r.extent && r.count) {
      extent = r.extent;
      useApp.getState().notify("info", name, `Parcel record · ${r.count.toLocaleString("en-US")} parcel(s)`);
    }
  }
  extent ??= rec.geometry?.extent ?? null;
  if (!extent) {
    useApp.getState().notify("warning", name, "This record has no parcels on the map yet.");
    return [];
  }
  const padded = withinParcels(extent);
  return [{ feature: rec, target: zoomTarget(padded), extent: padded, name }];
}

// ---------------------------------------------------------------------------------- sources
/** The Search component sends a chosen suggestion back to its source by `sourceIndex`. */
const withSource = (list: SuggestResult[], sourceIndex: number | null | undefined) => list.map((r) => ({ ...r, sourceIndex: sourceIndex ?? null }));

/** The two search sources: "UPI" (default) and "Name". */
export function createParcelSearchSources(): SearchSource[] {
  const upi = new SearchSource({
    placeholder: "Search by UPI, e.g. 1/02/13/02/1001",
    maxSuggestions: 8,
    maxResults: 6,
    minSuggestCharacters: 1,
    resultGraphicEnabled: false, // the app highlights the parcel itself
    getSuggestions: (p, o) => upiSuggestions(p.suggestTerm, p.maxSuggestions ?? 8, o?.signal ?? undefined).then((r) => withSource(r, p.sourceIndex), () => []),
    getResults: (p, o) => upiResults(p.suggestResult, p.maxResults ?? 6, p.view?.spatialReference, o?.signal ?? undefined),
  });
  (upi as unknown as { name: string }).name = "UPI";
  const name = new SearchSource({
    placeholder: "Village, cell, sector, district or record name",
    maxSuggestions: 10,
    maxResults: 1,
    minSuggestCharacters: 2,
    resultGraphicEnabled: false,
    getSuggestions: (p, o) => nameSuggestions(p.suggestTerm, p.maxSuggestions ?? 10, o?.signal ?? undefined).then((r) => withSource(r, p.sourceIndex), () => []),
    getResults: (p, o) => nameResults(p.suggestResult, p.view?.spatialReference, o?.signal ?? undefined),
  });
  (name as unknown as { name: string }).name = "Name";
  return [upi, name];
}
