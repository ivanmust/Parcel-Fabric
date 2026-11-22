import esriRequest from "@arcgis/core/request.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
export type ServiceJson = Record<string, any>;

/** Turn SDK/REST errors into a short, user-facing explanation. */
export function describeArcGISError(err: unknown): string {
  const e = err as { name?: string; message?: string; details?: { httpStatus?: number; messageCode?: string; messages?: string[]; raw?: any } };
  const status = e?.details?.httpStatus ?? e?.details?.raw?.error?.code;
  // The server's own explanation is usually in error.details ("Error: You cannot edit as …").
  const serverDetails: string[] = [...(e?.details?.messages ?? []), ...(e?.details?.raw?.error?.details ?? [])]
    .filter((d): d is string => typeof d === "string" && d.trim().length > 0)
    .map((d) => d.replace(/^Error:\s*/, ""));
  if (serverDetails.length) {
    const base = e?.message && !/unable to complete operation/i.test(e.message) ? `${e.message}: ` : "";
    return `${base}${[...new Set(serverDetails)].join(" ")}`;
  }
  if (e?.name === "AbortError") return "Request was cancelled.";
  if (status === 498) return "Your ArcGIS token has expired. Sign in again.";
  if (status === 499) return "This service requires sign-in (token required).";
  if (status === 403) return "You do not have permission to access this resource.";
  if (status === 404) return "The service or resource was not found.";
  if (e?.message?.includes("Failed to fetch") || e?.name === "request:server")
    return e?.message || "The ArcGIS server could not be reached.";
  return e?.message || "Unknown ArcGIS error";
}

/** An Error with the user-facing explanation of an SDK/REST error; the original is kept as `cause`. */
export const arcgisError = (err: unknown) => new Error(describeArcGISError(err), { cause: err });

/**
 * GET `<url>?f=json` through esriRequest so the IdentityManager attaches the
 * user's token automatically. REST-level errors (HTTP 200 + {error}) are
 * surfaced as exceptions by esriRequest.
 */
export async function fetchServiceJson(url: string, options: { signal?: AbortSignal; query?: Record<string, string> } = {}) {
  const res = await esriRequest(url, {
    query: { f: "json", ...options.query },
    responseType: "json",
    signal: options.signal,
  });
  return res.data as ServiceJson;
}

/** Find the human name for a spatial reference JSON object. */
export function describeSpatialReference(sr: ServiceJson | undefined): string {
  if (!sr) return "Unknown";
  const wkid = sr.latestWkid ?? sr.wkid;
  if (wkid === 4326) return "WGS 84 (EPSG:4326)";
  if (wkid === 3857 || wkid === 102100) return "WGS 84 / Web Mercator (EPSG:3857)";
  if (wkid) return `EPSG:${wkid}`;
  if (typeof sr.wkt !== "string") return "Custom (WKT)";
  const wkt: string = sr.wkt;
  const name = /^PROJCS\["([^"]+)"/.exec(wkt)?.[1] ?? /^GEOGCS\["([^"]+)"/.exec(wkt)?.[1] ?? "Custom";
  const projection = /PROJECTION\["([^"]+)"/.exec(wkt)?.[1];
  const cm = /PARAMETER\["Central_Meridian",(-?[\d.]+)\]/.exec(wkt)?.[1];
  if (projection === "Transverse_Mercator" && cm) return `${name} · TM ${Number(cm)}°E`;
  return projection ? `${name} · ${projection.replace(/_/g, " ")}` : name;
}
