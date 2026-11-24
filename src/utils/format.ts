export function formatScale(scale: number): string {
  if (!scale) return "—";
  return `1:${Math.round(scale).toLocaleString("en-US")}`;
}

export function formatNumber(n: number, digits = 2): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}

export function formatArea(m2: number): string {
  if (!Number.isFinite(m2)) return "—";
  if (m2 >= 1_000_000) return `${formatNumber(m2 / 1_000_000, 3)} km²`;
  if (m2 >= 10_000) return `${formatNumber(m2 / 10_000, 4)} ha (${formatNumber(m2, 0)} m²)`;
  return `${formatNumber(m2, 2)} m²`;
}

export function formatLength(m: number): string {
  if (!Number.isFinite(m)) return "—";
  return m >= 1000 ? `${formatNumber(m / 1000, 3)} km` : `${formatNumber(m, 2)} m`;
}

export function formatTime(d: Date): string {
  return d.toLocaleTimeString("en-GB", { hour12: false });
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function friendlyGeometryType(t: string | null | undefined): string {
  switch (t) {
    case "esriGeometryPolygon":
    case "polygon":
      return "Polygon";
    case "esriGeometryPolyline":
    case "polyline":
      return "Polyline";
    case "esriGeometryPoint":
    case "point":
      return "Point";
    case "esriGeometryMultipoint":
    case "multipoint":
      return "Multipoint";
    default:
      return t ? String(t) : "Table";
  }
}
