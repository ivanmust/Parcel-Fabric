import { executeForExtent } from "@arcgis/core/rest/query.js";
import type Extent from "@arcgis/core/geometry/Extent.js";
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
}

const mostCommon = (values: unknown[]) => {
  const counts = new Map<string, number>();
  for (const v of values) if (typeof v === "string" && v.trim()) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
};

/**
 * Highest parcel number used in a cell, from `parcel_number` and from the UPI text itself (some
 * parcels have an empty or different parcel_number). Current and historic parcels both count.
 */
async function highestNumberInCell(prefix: string): Promise<number> {
  const inCell = `name LIKE ${sqlString(`${prefix}/%`)}`;
  let max = 0;
  if (has(NUMBER_FIELD)) {
    const [stat] = await everyParcel({
      where: inCell,
      outStatistics: [{ statisticType: "max", onStatisticField: NUMBER_FIELD, outStatisticFieldName: "max_number" }] as never,
    });
    max = Number(stat?.max_number ?? 0) || 0;
  }
  for (let start = 0; start < 50 * PAGE; start += PAGE) {
    const page = await everyParcel({ where: inCell, outFields: ["name"], start, num: PAGE });
    for (const r of page) {
      const n = upiNumber(String(r.name));
      if (Number.isFinite(n) && n > max) max = n;
    }
    if (page.length < PAGE) break;
  }
  return max;
}

/**
 * Suggest UPIs for `count` parcels in an area: the most common UPI prefix of the parcels around it,
 * then the next free parcel numbers in that cell (checked against current and historic parcels).
 * Location fields come from the neighbours with that prefix. Returns null if nothing is nearby.
 */
export async function suggestUpis(area: Extent, count: number, exceptObjectIds: number[] = []): Promise<UpiSuggestion | null> {
  const neighbours = (
    await everyParcel({ where: `retiredbyrecord IS NULL${excluding(exceptObjectIds)}`, geometry: area.clone().expand(3), outFields: ["name", ...locationFields()], num: 200 })
  ).filter((r) => UPI_PATTERN.test(String(r.name ?? "")));
  if (!neighbours.length) return null;
  const prefix = mostCommon(neighbours.map((r) => String(r.name).split("/").slice(0, 4).join("/")))!;
  const sameCell = neighbours.filter((r) => String(r.name).startsWith(`${prefix}/`));
  const location: Location = {};
  for (const f of locationFields()) location[f] = mostCommon(sameCell.map((r) => r[f]));

  const upis: string[] = [];
  let next = (await highestNumberInCell(prefix)) + 1;
  while (upis.length < count) {
    const batch = Array.from({ length: count - upis.length + 5 }, (_, i) => `${prefix}/${next + i}`);
    const used = await upisInUse(batch);
    for (const u of batch) if (!used.has(u) && upis.length < count) upis.push(u);
    next += batch.length;
  }
  return { prefix, upis, location };
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

/** Suggest UPIs for existing parcels from the area they cover (their own UPIs are ignored). */
export async function suggestUpisForParcels(objectIds: number[], count = objectIds.length): Promise<UpiSuggestion | null> {
  const info = parcelLayer();
  const { extent } = await executeForExtent(info.url, sessionQuery(info, { objectIds }));
  return extent ? suggestUpis(extent, count, objectIds) : null;
}

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
