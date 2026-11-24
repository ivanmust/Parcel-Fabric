import { executeForExtent } from "@arcgis/core/rest/query.js";
import type { QueryProperties } from "@arcgis/core/rest/support/Query.js";
import { layerRegistry } from "../layers/layerRegistry";
import { hasField, sessionQuery, sessionRows, sqlList, sqlString } from "../layers/query";

/**
 * Rwanda UPI (Unique Parcel Identifier) rules for the Plot layer's `name` field:
 * province/district/sector/cell/parcel number, e.g. 1/02/13/02/1001. Every current parcel in the
 * service followed this format when checked (2026-11-21), and the first four parts map to one cell.
 */
export const UPI_PATTERN = /^\d\/\d{2}\/\d{2}\/\d{2}\/\d+$/;
export const UPI_EXAMPLE = "1/02/13/02/1001";

/** Location fields filled from the surroundings when they are empty. */
export const LOCATION_FIELDS = ["province", "district", "sector", "cell", "village"] as const;
export type Location = Partial<Record<(typeof LOCATION_FIELDS)[number], string>>;

const NUMBER_FIELD = "parcel_number";
const PAGE = 2000;

const parcelLayer = () => layerRegistry.requireRole("parcel-polygon");
const has = (field: string) => hasField(parcelLayer().layer, field);
const locationFields = () => LOCATION_FIELDS.filter(has);

/** All parcels, current and historic, at the session moment: UPIs of retired parcels are not reused. */
const everyParcel = (props: QueryProperties) => sessionRows(parcelLayer(), props);

/** ` AND objectid NOT IN (…)`, or nothing. */
const excluding = (objectIds: number[]) => (objectIds.length ? ` AND ${parcelLayer().layer.objectIdField} NOT IN (${objectIds.join(",")})` : "");

/** Why a UPI is not acceptable as typed, or null. */
export function upiFormatProblem(upi: string): string | null {
  const v = upi.trim();
  if (!v) return "Enter a UPI.";
  if (!UPI_PATTERN.test(v)) return `Use the UPI format province/district/sector/cell/number, e.g. ${UPI_EXAMPLE}.`;
  return null;
}

/** The parcel number is the last part of the UPI. */
export const upiNumber = (upi: string) => Number(upi.trim().split("/").pop());

/** UPIs (from the given list) already used by any parcel other than `exceptObjectIds`. */
export async function upisInUse(upis: string[], exceptObjectIds: number[] = []): Promise<Set<string>> {
  const list = [...new Set(upis.map((u) => u.trim()).filter(Boolean))];
  if (!list.length) return new Set();
  const rows = await everyParcel({ where: `name IN (${sqlList(list)})${excluding(exceptObjectIds)}`, outFields: ["name"] });
  return new Set(rows.map((r) => String(r.name)));
}

/** The UPIs stored now (at the session moment) for the given parcels, current or historic. */
export async function storedUpis(objectIds: number[]): Promise<Map<number, string | null>> {
  if (!objectIds.length) return new Map();
  const oid = parcelLayer().layer.objectIdField;
  const rows = await everyParcel({ objectIds, outFields: [oid, "name"] });
  return new Map(rows.map((r) => [r[oid] as number, r.name == null ? null : String(r.name)]));
}

export interface UpiSuggestion {
  /** Province/district/sector/cell part, e.g. 1/02/13/02 */
  prefix: string;
  /** Suggested UPIs, one per requested parcel, in order. */
  upis: string[];
  location: Location;
  /** Where the cell came from, in words for the editor. */
  basis: string;
  /** Set when the cell has unusually high numbers that push the suggestion up. */
  warning: string | null;
}

export interface UpiRequest {
  /** How many UPIs. */
  count: number;
  /** The parcel(s) the new ones come from (split or merge): their cell is used. */
  from?: number[];
  /** Existing parcels that need UPIs (their own UPIs are ignored); used when there is no parent. */
  parcels?: number[];
  /** The cell to use, when the parents are in different cells and the editor chose one. */
  cell?: string;
}

const prefixOf = (upi: string) => upi.trim().split("/").slice(0, 4).join("/");

const mostCommon = (values: unknown[]) => {
  const counts = new Map<string, number>();
  for (const v of values) if (typeof v === "string" && v.trim()) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
};

/** The most common value of each location field among rows (empty when there are none). */
function commonLocation(rows: Record<string, unknown>[]): Location {
  const location: Location = {};
  for (const f of locationFields()) location[f] = mostCommon(rows.map((r) => r[f]));
  return location;
}

/**
 * Location fields of a cell's current parcels: those around the given parcels first (a cell has
 * several villages), else the whole cell.
 */
async function locationInCell(prefix: string, around: number[]): Promise<Location> {
  const info = parcelLayer();
  const inCell = `retiredbyrecord IS NULL AND name LIKE ${sqlString(`${prefix}/%`)}${excluding(around)}`;
  const { extent } = around.length ? await executeForExtent(info.url, sessionQuery(info, { objectIds: around })) : { extent: null };
  const near = extent ? await everyParcel({ where: inCell, geometry: extent.clone().expand(3), outFields: locationFields(), num: 200 }) : [];
  return commonLocation(near.length ? near : await everyParcel({ where: inCell, outFields: locationFields(), num: 500 }));
}

/** The cells (UPI prefixes) of parcels, current or historic, from their valid UPIs. */
export async function cellsOf(objectIds: number[]): Promise<string[]> {
  if (!objectIds.length) return [];
  const rows = await everyParcel({ objectIds, outFields: ["name"] });
  return [...new Set(rows.map((r) => String(r.name ?? "")).filter((n) => UPI_PATTERN.test(n)).map(prefixOf))].sort();
}

/**
 * The numbers used in a cell (current and historic parcels), and whether a few unusually high ones
 * push the next number far beyond the cell's normal series. The suggestion still continues after
 * the highest number; the editor is told so the data owner can decide.
 */
async function numbersInCell(prefix: string): Promise<{ highest: number; warning: string | null }> {
  const inCell = `name LIKE ${sqlString(`${prefix}/%`)}`;
  let highest = 0;
  if (has(NUMBER_FIELD)) {
    const [stat] = await everyParcel({
      where: inCell,
      outStatistics: [{ statisticType: "max", onStatisticField: NUMBER_FIELD, outStatisticFieldName: "max_number" }] as never,
    });
    highest = Number(stat?.max_number ?? 0) || 0;
  }
  const used: { n: number; upi: string }[] = [];
  for (let start = 0; start < 50 * PAGE; start += PAGE) {
    const page = await everyParcel({ where: inCell, outFields: ["name"], start, num: PAGE });
    for (const r of page) {
      const upi = String(r.name);
      const n = upiNumber(upi);
      if (Number.isFinite(n)) used.push({ n, upi });
    }
    if (page.length < PAGE) break;
  }
  used.sort((a, b) => a.n - b.n);
  highest = Math.max(highest, used.at(-1)?.n ?? 0);

  // The normal series ends at the 99th percentile; numbers far above it are unusual.
  const typical = used.length ? used[Math.floor(0.99 * (used.length - 1))]!.n : 0;
  const unusual = used.filter((u) => u.n > typical * 1.5 && u.n - typical > 100);
  const warning = unusual.length
    ? `Most parcels in cell ${prefix} are numbered up to about ${typical.toLocaleString("en-US")}, but ${unusual.length} use much higher numbers (${unusual
        .slice(-5)
        .map((u) => u.upi)
        .join(", ")}${unusual.length > 5 ? ", …" : ""}). The suggestion continues after the highest, ${highest.toLocaleString("en-US")}. Check with the data owner before saving.`
    : null;
  return { highest, warning };
}

/** The cell of parcels from their own cell name: the UPI prefix most used by parcels with that cell name. */
async function cellFromCellName(objectIds: number[]): Promise<{ prefix: string; name: string; location: Location } | null> {
  if (!objectIds.length || !has("cell")) return null;
  const own = await everyParcel({ objectIds, outFields: ["cell", ...locationFields()] });
  const name = mostCommon(own.map((r) => (typeof r.cell === "string" ? r.cell.trim() : r.cell)));
  if (!name) return null;
  const sameName = (await everyParcel({ where: `UPPER(cell) = UPPER(${sqlString(name)})`, outFields: ["name", ...locationFields()], num: 1000 })).filter((r) =>
    UPI_PATTERN.test(String(r.name ?? "")),
  );
  const prefix = mostCommon(sameName.map((r) => prefixOf(String(r.name))));
  return prefix ? { prefix, name, location: commonLocation([...own, ...sameName.filter((r) => prefixOf(String(r.name)) === prefix)]) } : null;
}

/** The cell most used by current parcels around an area (the fallback when nothing else says). */
async function cellFromNeighbours(objectIds: number[]): Promise<{ prefix: string; location: Location } | null> {
  if (!objectIds.length) return null;
  const info = parcelLayer();
  const { extent } = await executeForExtent(info.url, sessionQuery(info, { objectIds }));
  if (!extent) return null;
  const neighbours = (
    await everyParcel({ where: `retiredbyrecord IS NULL${excluding(objectIds)}`, geometry: extent.clone().expand(3), outFields: ["name", ...locationFields()], num: 200 })
  ).filter((r) => UPI_PATTERN.test(String(r.name ?? "")));
  const prefix = mostCommon(neighbours.map((r) => prefixOf(String(r.name))));
  return prefix ? { prefix, location: commonLocation(neighbours.filter((r) => prefixOf(String(r.name)) === prefix)) } : null;
}

/**
 * Suggest UPIs by the application's rule (not an official NLA rule):
 *  - the cell: from the parcel(s) the new ones come from; if they are in several cells, the editor
 *    chooses (`cell`); without a parent, from the parcel's own cell name; only then from neighbours;
 *  - the number: the next free numbers after the highest used in that cell, current and historic
 *    parcels included, so a retired UPI is never reused;
 *  - location fields: from the parent(s), else from parcels of the same cell.
 * Returns null when no cell can be found.
 */
export async function suggestUpis(request: UpiRequest): Promise<UpiSuggestion | null> {
  const from = request.from ?? [];
  const parcels = request.parcels ?? [];
  let found: { prefix: string; location: Location; basis: string } | null = null;

  if (from.length) {
    const cells = await cellsOf(from);
    if (request.cell) {
      if (!UPI_PATTERN.test(`${request.cell}/1`)) throw new Error(`${request.cell} is not a cell code like 1/02/13/02.`);
      found = { prefix: request.cell, location: {}, basis: `Cell ${request.cell}, chosen by you` };
    } else if (cells.length > 1) {
      throw new Error(`The parcels are in different cells (${cells.join(", ")}). Choose the cell of the new parcel.`);
    } else if (cells.length === 1) {
      found = { prefix: cells[0]!, location: {}, basis: `Cell ${cells[0]}, from ${from.length > 1 ? "the merged parcels" : "the parcel it comes from"}` };
    }
    if (found) {
      const parents = await everyParcel({ objectIds: from, outFields: ["name", ...locationFields()] });
      found.location = commonLocation(parents.filter((r) => prefixOf(String(r.name ?? "")) === found!.prefix));
    }
  }
  if (!found) {
    const byName = await cellFromCellName(parcels.length ? parcels : from);
    if (byName) found = { prefix: byName.prefix, location: byName.location, basis: `Cell ${byName.prefix}, from the cell name "${byName.name}"` };
  }
  if (!found) {
    const near = await cellFromNeighbours([...parcels, ...from]);
    if (near) found = { prefix: near.prefix, location: near.location, basis: `Cell ${near.prefix}, from neighbouring parcels: check it` };
  }
  if (!found) return null;
  // Fields the parent(s) leave empty are taken from the same cell's parcels around them.
  if (locationFields().some((f) => !found!.location[f])) {
    const cell = await locationInCell(found.prefix, [...parcels, ...from]);
    for (const f of locationFields()) found.location[f] ||= cell[f];
  }

  const { highest, warning } = await numbersInCell(found.prefix);
  const upis: string[] = [];
  let next = highest + 1;
  while (upis.length < request.count) {
    const batch = Array.from({ length: request.count - upis.length + 5 }, (_, i) => `${found!.prefix}/${next + i}`);
    const used = await upisInUse(batch);
    for (const u of batch) if (!used.has(u) && upis.length < request.count) upis.push(u);
    next += batch.length;
  }
  return { prefix: found.prefix, upis, location: found.location, basis: found.basis, warning };
}

/** Attributes to write with a UPI: the name, its parcel number, and location fields that are empty. */
export function upiAttributes(upi: string, location: Location, current: Record<string, unknown> = {}): Record<string, string | number> {
  const out: Record<string, string | number> = { name: upi.trim() };
  if (has(NUMBER_FIELD)) out[NUMBER_FIELD] = upiNumber(upi);
  for (const f of locationFields()) {
    const value = location[f];
    const existing = current[f];
    if (value && (existing === null || existing === undefined || existing === "")) out[f] = value;
  }
  return out;
}

/** Suggest UPIs for existing parcels that have none (their own UPIs are ignored). */
export const suggestUpisForParcels = (objectIds: number[], count = objectIds.length) => suggestUpis({ count, parcels: objectIds });

/**
 * Write UPIs (and parcel numbers, and empty location fields) to parcels in the open edit session.
 * Refuses badly formatted UPIs, repeats within the list, and UPIs used by any other parcel.
 */
export async function saveUpis(assignments: { objectId: number; upi: string }[], location: Location): Promise<number> {
  const info = parcelLayer();
  const problem = assignments.map((a) => upiFormatProblem(a.upi)).find(Boolean);
  if (problem) throw new Error(problem);
  const upis = assignments.map((a) => a.upi.trim());
  const repeated = upis.find((u, i) => upis.indexOf(u) !== i);
  if (repeated) throw new Error(`${repeated} is entered twice.`);
  const ids = assignments.map((a) => a.objectId);
  const used = await upisInUse(upis, ids);
  if (used.size) throw new Error(`Already used by another parcel: ${[...used].join(", ")}.`);
  const oid = info.layer.objectIdField;
  const current = new Map((await everyParcel({ objectIds: ids, outFields: [oid, ...locationFields()] })).map((r) => [r[oid] as number, r]));
  const res = await info.layer.applyEdits({
    updateFeatures: assignments.map((a) => ({ attributes: { [oid]: a.objectId, ...upiAttributes(a.upi, location, current.get(a.objectId)) } })) as never,
  });
  const failed = res.updateFeatureResults.filter((r) => r.error);
  if (failed.length) throw new Error(`${failed.length} parcel(s) not updated: ${failed[0]!.error!.message}`);
  return res.updateFeatureResults.length;
}
