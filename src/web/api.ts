/** A failed API call. `code` is the server's error code, or "network" / "http" when it sent none. */
export class ApiError extends Error {
  constructor(
    public code: string,
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Calls the Worker's API. A 204 resolves to undefined; anything else but a 2xx JSON answer throws an ApiError. */
export async function api<T>(path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError("network", 0, "network error");
  }
  if (res.status === 204) return undefined as T;
  const data = (await res.json().catch(() => null)) as { error?: { code: string; message: string } } | null;
  if (!res.ok || !data || data.error) {
    throw new ApiError(data?.error?.code ?? "http", res.status, data?.error?.message ?? `HTTP ${res.status}`);
  }
  return data as T;
}
