type TokenProvider = () => string | undefined;

let tokenProvider: TokenProvider = () => undefined;

export function setApiTokenProvider(fn: TokenProvider): void {
  tokenProvider = fn;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code: string,
    public readonly requestId?: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export async function apiFetch<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const headers = new Headers(init.headers);
  const token = tokenProvider();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  headers.set("X-Client-Origin", window.location.origin);
  let body = init.body;
  if (init.json !== undefined) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(init.json);
  }

  let res: Response;
  try {
    res = await fetch(`/api${path}`, { ...init, headers, body });
  } catch {
    throw new ApiError(0, "The Parcel Fabric server is unreachable. Check that the API is running.", "network_error");
  }
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = (data as { error?: { message?: string; code?: string; requestId?: string; details?: unknown } }).error;
    throw new ApiError(res.status, e?.message ?? `Request failed (${res.status})`, e?.code ?? "http_error", e?.requestId, e?.details);
  }
  return data as T;
}
