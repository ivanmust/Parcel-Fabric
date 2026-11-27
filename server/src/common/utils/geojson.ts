export type GeoJsonPolygon = { type: "Polygon"; coordinates: number[][][] } | { type: "MultiPolygon"; coordinates: number[][][][] };

const round7 = (n: number) => Math.round(n * 1e7) / 1e7;

/** Shoelace formula: positive = counter-clockwise. */
function signedArea(ring: number[][]): number {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i++) sum += ring[i]![0]! * ring[i + 1]![1]! - ring[i + 1]![0]! * ring[i]![1]!;
  return sum / 2;
}

/**
 * ArcGIS rings (outer clockwise, holes counter-clockwise) → RFC 7946 GeoJSON (the reverse). A hole
 * belongs to the outer ring before it, as ArcGIS orders them.
 */
export function toGeoJson(geometry: { rings?: number[][][] } | undefined): GeoJsonPolygon | null {
  const rings = (geometry?.rings ?? []).filter((r) => r.length >= 4);
  if (!rings.length) return null;
  const polygons: number[][][][] = [];
  for (const ring of rings) {
    const isOuter = signedArea(ring) < 0;
    const coordinates = [...ring].reverse().map(([x, y]) => [round7(x!), round7(y!)]);
    if (isOuter || !polygons.length) polygons.push([coordinates]);
    else polygons[polygons.length - 1]!.push(coordinates);
  }
  return polygons.length === 1 ? { type: "Polygon", coordinates: polygons[0]! } : { type: "MultiPolygon", coordinates: polygons };
}
