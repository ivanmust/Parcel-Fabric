import * as projectOperator from "@arcgis/core/geometry/operators/projectOperator.js";
import Point from "@arcgis/core/geometry/Point.js";
import SpatialReference from "@arcgis/core/geometry/SpatialReference.js";
import type { GeometryUnion } from "@arcgis/core/unionTypes.js";

let loading: Promise<void> | null = null;

/** Load the client-side projection engine once (it is a WASM module). */
export function ensureProjection(): Promise<void> {
  if (projectOperator.isLoaded()) return Promise.resolve();
  loading ??= projectOperator.load();
  return loading;
}

export function project<T extends GeometryUnion>(geometry: T, to: SpatialReference): T | null {
  if (!projectOperator.isLoaded()) return null;
  if (geometry.spatialReference?.equals(to)) return geometry;
  try {
    return (projectOperator.execute(geometry, to) as T | null | undefined) ?? null;
  } catch {
    return null;
  }
}

export const WGS84 = SpatialReference.WGS84;

export function toWgs84(point: Point): Point | null {
  return project(point, WGS84);
}

export function formatDD(lon: number, lat: number, digits = 6): string {
  return `${lat.toFixed(digits)}°, ${lon.toFixed(digits)}°`;
}

function dms(value: number, pos: string, neg: string): string {
  const hemi = value >= 0 ? pos : neg;
  const abs = Math.abs(value);
  let d = Math.floor(abs);
  let m = Math.floor((abs - d) * 60);
  let s = (abs - d - m / 60) * 3600;
  if (s >= 59.995) {
    s = 0;
    m += 1;
  }
  if (m >= 60) {
    m = 0;
    d += 1;
  }
  return `${d}°${String(m).padStart(2, "0")}′${s.toFixed(2).padStart(5, "0")}″${hemi}`;
}

export function formatDMS(lon: number, lat: number): string {
  return `${dms(lat, "N", "S")} ${dms(lon, "E", "W")}`;
}

export function formatXY(x: number, y: number, digits = 3): string {
  return `${x.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })} E, ${y.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })} N`;
}

/**
 * Parse a coordinate string. Accepts decimal degrees ("-1.9536, 30.0606"),
 * DMS ("1°57'13\"S 30°03'38\"E") or projected "x y" pairs.
 */
export function parseCoordinatePair(text: string): { a: number; b: number } | null {
  const t = text.trim();
  if (!t) return null;
  const dmsRe = /(\d+(?:\.\d+)?)\s*[°d]\s*(\d+(?:\.\d+)?)?\s*['′m]?\s*(\d+(?:\.\d+)?)?\s*["″s]?\s*([NSEW])/gi;
  const parts = [...t.matchAll(dmsRe)];
  if (parts.length === 2) {
    const vals = parts.map((p) => {
      const v = Number(p[1]) + Number(p[2] ?? 0) / 60 + Number(p[3] ?? 0) / 3600;
      const h = p[4]!.toUpperCase();
      return { v: h === "S" || h === "W" ? -v : v, isLat: h === "N" || h === "S" };
    });
    const lat = vals.find((v) => v.isLat)?.v;
    const lon = vals.find((v) => !v.isLat)?.v;
    if (lat === undefined || lon === undefined) return null;
    return { a: lat, b: lon };
  }
  const nums = t.split(/[\s,;]+/).filter(Boolean).map(Number);
  if (nums.length !== 2 || nums.some((n) => !Number.isFinite(n))) return null;
  return { a: nums[0]!, b: nums[1]! };
}
