import { executeQueryJSON } from "@arcgis/core/rest/query.js";
import Query, { type QueryProperties } from "@arcgis/core/rest/support/Query.js";
import type FeatureLayer from "@arcgis/core/layers/FeatureLayer.js";
import type { ServiceLayerInfo } from "./layerRegistry";

/**
 * Query parameters that read a layer exactly as the map shows it.
 *
 * - **Moment.** With branch versioning, edits in an open edit session are visible only to reads at
 *   the session's edit moment. The SDK keeps it in `layer.historicMoment` (forward after each edit,
 *   back on undo) and draws with it, but a plain `layer.queryFeatures(...)` ignores it, so it could
 *   not see unsaved edits (verified live: a record just added returned 0 rows, 1 at the moment).
 * - **Display filter.** The layer's `definitionExpression` (e.g. Parcel Fabric parcels hide historic
 *   features with `retiredbyrecord IS NULL`) applies to drawing only; queries built from a plain
 *   object ignore it. It is ANDed into `where` here.
 *
 * Every query the application runs against a map layer should go through this helper. Code that
 * must see hidden features (parcel lineage, UPI uniqueness) uses `sessionQuery` instead.
 */
export function asShownOnMap<T extends object>(
  layer: { historicMoment?: Date | null; definitionExpression?: string | null },
  params?: T,
): T & { historicMoment?: Date; where?: string } {
  const out = { ...(params ?? {}) } as T & { historicMoment?: Date; where?: string };
  const moment = layer.historicMoment ?? undefined;
  if (moment && !out.historicMoment) out.historicMoment = moment;
  const filter = layer.definitionExpression?.trim();
  if (filter) {
    const where = out.where?.trim();
    out.where = !where || where === "1=1" ? filter : `(${filter}) AND (${where})`;
  }
  return out;
}

/**
 * A REST query on the layer's service at the version and edit moment the map uses, but WITHOUT the
 * display filter: it also sees features the map hides (historic parcels). No geometry by default.
 */
export function sessionQuery(info: ServiceLayerInfo, props: QueryProperties = {}): Query {
  return new Query({
    where: "1=1",
    spatialRelationship: "intersects",
    returnGeometry: false,
    gdbVersion: info.layer.gdbVersion ?? undefined,
    historicMoment: info.layer.historicMoment ?? undefined,
    ...props,
  });
}

/** Attribute rows of a `sessionQuery`. */
export async function sessionRows(info: ServiceLayerInfo, props: QueryProperties = {}): Promise<Record<string, unknown>[]> {
  return (await executeQueryJSON(info.url, sessionQuery(info, props))).features.map((g) => g.attributes as Record<string, unknown>);
}

/** A SQL string literal: quoted, with embedded quotes doubled. Services use standardized queries. */
export const sqlString = (value: string) => `'${value.replace(/'/g, "''")}'`;

/** A comma-separated list of SQL string literals, for `IN (…)`. */
export const sqlList = (values: string[]) => values.map(sqlString).join(",");

/** Whether a layer has a field, by name, ignoring case. */
export const hasField = (layer: FeatureLayer, name: string) => layer.fields.some((f) => f.name.toLowerCase() === name.toLowerCase());
