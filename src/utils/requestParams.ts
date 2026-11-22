/** A service URL as a RegExp source: trailing slashes removed, special characters escaped. */
export const urlPattern = (url: string) => url.replace(/\/+$/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export type RequestParamsSource = { query?: unknown; body?: unknown } | undefined;

/** Read a request parameter from esriRequest options (query object, URLSearchParams, FormData or a form string). */
export function readRequestParam(options: RequestParamsSource, name: string): string | null {
  for (const source of [options?.query, options?.body]) {
    if (!source) continue;
    if (source instanceof URLSearchParams || source instanceof FormData) {
      const v = source.get(name);
      if (typeof v === "string" && v) return v;
    } else if (typeof source === "string") {
      const v = new URLSearchParams(source).get(name);
      if (v) return v;
    } else if (typeof source === "object") {
      const v = (source as Record<string, unknown>)[name];
      if (typeof v === "string" && v) return v;
    }
  }
  return null;
}
