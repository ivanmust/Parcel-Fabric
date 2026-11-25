import type Polygon from "@arcgis/core/geometry/Polygon.js";
import type Polyline from "@arcgis/core/geometry/Polyline.js";
import * as boundaryOperator from "@arcgis/core/geometry/operators/boundaryOperator.js";
import * as bufferOperator from "@arcgis/core/geometry/operators/bufferOperator.js";
import * as distanceOperator from "@arcgis/core/geometry/operators/distanceOperator.js";
import * as intersectionOperator from "@arcgis/core/geometry/operators/intersectionOperator.js";
import * as lengthOperator from "@arcgis/core/geometry/operators/lengthOperator.js";

/**
 * Neighbour check for Merge, from the parcels' geometry (never from IDs or attributes).
 *
 * Two parcels are neighbours when their boundaries run together for at least MIN_SHARED_BOUNDARY_M.
 * Boundaries count as together within SNAP_TOLERANCE_M, so vertices stored a few millimetres apart
 * still match (the data's xy tolerance is 1 mm). Parcels that only touch at a corner share almost no
 * boundary (about 2 cm at this tolerance) and are not neighbours. A merge is allowed only when every
 * selected parcel is linked to all the others through such shared boundaries (one connected group).
 *
 * Geometries must be in a projected coordinate system in metres, like the Plot layer's own
 * (ITRF 2005 Transverse Mercator); lengths in degrees would be meaningless.
 */
export const SNAP_TOLERANCE_M = 0.01;
export const MIN_SHARED_BOUNDARY_M = 0.1;

export interface MergeCandidate {
  objectId: number;
  /** Shown in messages: the UPI, or "OBJECTID n" without one. */
  label: string;
  geometry: Polygon;
}

/** Length (m) of `a`'s boundary that runs along `b`'s boundary. */
export function sharedBoundaryLength(a: Polygon, b: Polygon): number {
  const edgeA = boundaryOperator.execute(a) as Polyline | null;
  const edgeB = boundaryOperator.execute(b) as Polyline | null;
  if (!edgeA || !edgeB) return 0;
  const nearB = bufferOperator.execute(edgeB, SNAP_TOLERANCE_M);
  if (!nearB) return 0;
  const common = intersectionOperator.execute(edgeA, nearB);
  return common ? lengthOperator.execute(common) : 0;
}

/** Groups of ids connected through the given links (each group sorted, groups by first id). */
export function connectedGroups(ids: number[], links: [number, number][]): number[][] {
  const parent = new Map(ids.map((id) => [id, id]));
  const root = (id: number): number => {
    let r = id;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(id, r);
    return r;
  };
  for (const [a, b] of links) if (parent.has(a) && parent.has(b)) parent.set(root(a), root(b));
  const groups = new Map<number, number[]>();
  for (const id of ids) groups.set(root(id), [...(groups.get(root(id)) ?? []), id]);
  return [...groups.values()].map((g) => g.sort((x, y) => x - y)).sort((x, y) => x[0]! - y[0]!);
}

const list = (labels: string[]) => (labels.length > 1 ? `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}` : (labels[0] ?? ""));

/** Why these parcels cannot be merged as neighbours, or null when they form one connected group. */
export function mergeAdjacencyProblem(parcels: MergeCandidate[]): string | null {
  if (parcels.length < 2) return null;
  if (parcels.some((p) => p.geometry.spatialReference?.isGeographic)) {
    throw new Error("The neighbour check needs parcel shapes in metres, not degrees.");
  }
  const links: [number, number][] = [];
  for (let i = 0; i < parcels.length; i++)
    for (let j = i + 1; j < parcels.length; j++)
      if (sharedBoundaryLength(parcels[i]!.geometry, parcels[j]!.geometry) >= MIN_SHARED_BOUNDARY_M) links.push([parcels[i]!.objectId, parcels[j]!.objectId]);

  const groups = connectedGroups(
    parcels.map((p) => p.objectId),
    links,
  );
  if (groups.length === 1) return null;

  const label = new Map(parcels.map((p) => [p.objectId, p.label]));
  if (parcels.length === 2) {
    const [a, b] = parcels as [MergeCandidate, MergeCandidate];
    const gap = distanceOperator.execute(a.geometry, b.geometry);
    return gap <= SNAP_TOLERANCE_M
      ? `${a.label} and ${b.label} only touch at a corner. Parcels must share a boundary to be merged.`
      : `${a.label} and ${b.label} are not neighbours: they are ${gap < 1 ? gap.toFixed(2) : gap.toFixed(1)} m apart. Only parcels that share a boundary can be merged.`;
  }
  const described = groups.map((g) => list(g.map((id) => label.get(id)!)));
  return `The selected parcels are not one connected group of neighbours: ${described.map((d) => `[${d}]`).join(" and ")} share no boundary with each other. Every parcel must be linked to the others through shared boundaries.`;
}
