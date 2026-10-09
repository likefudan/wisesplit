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

/**
 * Calls the Worker's API: GET without a body, POST with one. Resolves to the parsed JSON (undefined
 * for an empty answer); a non-2xx status, an `{ error }` answer or a body that is not JSON throws.
 */
export async function api<T>(path: string, body?: unknown): Promise<T> {
  let res: Response;
  let text: string;
  try {
    res = await fetch(path, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    text = await res.text();
  } catch {
    throw new ApiError("network", 0, "network error");
  }
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    throw new ApiError("http", res.status, `HTTP ${res.status}: not JSON`);
  }
  const error = (data as { error?: { code?: string; message?: string } } | null)?.error;
  if (!res.ok || error) {
    throw new ApiError(error?.code ?? "http", res.status, error?.message ?? `HTTP ${res.status}`);
  }
  return data as T;
}
