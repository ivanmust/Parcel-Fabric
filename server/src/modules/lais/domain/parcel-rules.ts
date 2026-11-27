import { sql, sqlList } from "../../../common/utils/sql.js";
import { plotShapes, queryPlots, relatedPlots, type LayerSchema, type PlotFeature } from "../repositories/plot-layer.repository.js";
import type { FieldError } from "../models/transaction.model.js";

/** Groups of ids connected through the given links. */
function connectedGroups(ids: number[], links: Array<[number, number]>): number[][] {
  const parent = new Map(ids.map((id) => [id, id]));
  const root = (id: number): number => (parent.get(id) === id ? id : root(parent.get(id)!));
  for (const [a, b] of links) if (parent.has(a) && parent.has(b)) parent.set(root(a), root(b));
  const groups = new Map<number, number[]>();
  for (const id of ids) groups.set(root(id), [...(groups.get(root(id)) ?? []), id]);
  return [...groups.values()];
}

/** A Merge's parcels must be one connected group of neighbours sharing boundary lines (as in the web editor). Null when they are. */
export async function mergeNeighbourProblem(token: string, schema: LayerSchema, parcels: Array<{ objectId: number; upi: string }>): Promise<string | null> {
  const oid = schema.objectIdField;
  const ids = parcels.map((p) => p.objectId);
  const shapes = await plotShapes(token, `${oid} IN (${ids.join(",")})`, [oid]);
  const links: Array<[number, number]> = [];
  for (const f of shapes.features) {
    const self = Number(f.attributes[oid]);
    const others = ids.filter((id) => id !== self);
    const touching = await relatedPlots(token, schema, f.geometry, shapes.spatialReference, "F***1****", `${oid} IN (${others.join(",")})`);
    for (const t of touching) links.push([self, Number(t[oid])]);
  }
  const groups = connectedGroups(ids, links);
  if (groups.length === 1) return null;
  const upi = new Map(parcels.map((p) => [p.objectId, p.upi]));
  const named = groups.map((g) => `[${g.map((id) => upi.get(id)).join(", ")}]`);
  return parcels.length === 2
    ? `${parcels[0]!.upi} and ${parcels[1]!.upi} are not neighbours: they share no boundary. Only neighbouring parcels can be merged.`
    : `The parcels are not one connected group of neighbours: ${named.join(" and ")} share no boundary with each other.`;
}

/** The current UPIs of the parcels that replaced a historic one (created by the record that retired it, overlapping it). */
export async function successorUpis(token: string, schema: LayerSchema, historic: PlotFeature, spatialReference: object): Promise<string[]> {
  const f = schema.fields;
  const record = historic.attributes[f.retiredBy];
  if (typeof record !== "string" || !historic.geometry) return [];
  const rows = await relatedPlots(token, schema, historic.geometry, spatialReference, "T********", `${f.createdBy} = ${sql(record)} AND ${f.retiredBy} IS NULL`);
  return [...new Set(rows.map((r) => String(r[f.upi] ?? "")).filter(Boolean))].sort();
}

/**
 * Each UPI must name exactly one current parcel. A UPI found only on historic parcels has expired
 * (merged or subdivided): the error says which current parcels replaced it.
 */
export async function resolveParcels(token: string, schema: LayerSchema, upis: string[], fieldOf: (i: number) => string): Promise<{ errors: FieldError[]; objectIds: number[] }> {
  const f = schema.fields;
  const oid = schema.objectIdField;
  if (!upis.length) return { errors: [], objectIds: [] };
  const current = await queryPlots(token, schema, `${f.upi} IN (${sqlList(upis)}) AND ${f.retiredBy} IS NULL`, undefined, [oid, f.upi], 200);
  const byUpi = new Map<string, number[]>();
  for (const r of current) byUpi.set(String(r[f.upi]), [...(byUpi.get(String(r[f.upi])) ?? []), Number(r[oid])]);
  const missing = upis.filter((u) => !byUpi.has(u));
  const historic = missing.length ? await plotShapes(token, `${f.upi} IN (${sqlList(missing)}) AND ${f.retiredBy} IS NOT NULL`, [oid, f.upi, f.retiredBy]) : null;

  const errors: FieldError[] = [];
  for (const [i, upi] of upis.entries()) {
    const found = byUpi.get(upi) ?? [];
    if (found.length > 1) {
      errors.push({ field: fieldOf(i), code: "UPI_NOT_UNIQUE", message: `More than one current parcel has the UPI ${upi} in GIS. GIS must resolve the duplicate before this transaction can be accepted.` });
    } else if (!found.length) {
      const old = historic?.features.find((h) => h.attributes[f.upi] === upi);
      if (!old) {
        errors.push({ field: fieldOf(i), code: "PARCEL_NOT_FOUND", message: `No parcel with the UPI ${upi} exists in GIS.` });
      } else {
        const replacedBy = await successorUpis(token, schema, old, historic!.spatialReference);
        errors.push({
          field: fieldOf(i),
          code: "UPI_EXPIRED",
          message: `The UPI ${upi} has expired: GIS merged or subdivided that parcel.${replacedBy.length ? ` It is now ${replacedBy.join(", ")}.` : ""} Use the UPI of the current parcel.`,
          ...(replacedBy.length ? { replacedBy } : {}),
        });
      }
    }
  }
  return { errors, objectIds: errors.length ? [] : upis.map((u) => byUpi.get(u)![0]!) };
}
