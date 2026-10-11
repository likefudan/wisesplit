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
export function api<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** POSTs a file (its type as Content-Type), answered like `api`. */
export function apiUpload<T>(path: string, file: Blob): Promise<T> {
  return request<T>(path, { method: "POST", headers: { "Content-Type": file.type }, body: file });
}

async function request<T>(path: string, init: RequestInit): Promise<T> {
  let res: Response;
  let text: string;
  try {
    res = await fetch(path, init);
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
  if (!res.ok || error) throw failure(res.status, error);
  return data as T;
}

const failure = (status: number, error: { code?: string; message?: string } | undefined) =>
  new ApiError(error?.code ?? "http", status, error?.message ?? `HTTP ${status}`);

/**
 * GETs a file the server offers as a download, and saves it under the name it gives. An error
 * throws like `api`, instead of being saved as the file.
 */
export async function apiDownload(path: string): Promise<void> {
  let res: Response;
  let blob: Blob;
  try {
    res = await fetch(path);
    blob = await res.blob();
  } catch {
    throw new ApiError("network", 0, "network error");
  }
  if (!res.ok) {
    let error: { code?: string; message?: string } | undefined;
    try {
      error = (JSON.parse(await blob.text()) as { error?: typeof error } | null)?.error;
    } catch {
      // Not JSON: reported by status alone.
    }
    throw failure(res.status, error);
  }
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = fileName(res.headers.get("Content-Disposition") ?? "");
  document.body.append(link);
  link.click();
  link.remove();
  // Later, not now: some browsers start reading the file only after click() returns.
  setTimeout(() => URL.revokeObjectURL(link.href), 60_000);
}

/** The file name a Content-Disposition header gives in filename* (UTF-8), else "download". */
function fileName(disposition: string): string {
  const named = /filename\*=UTF-8''([^;]+)/.exec(disposition);
  try {
    return named ? decodeURIComponent(named[1]!) : "download";
  } catch {
    return "download";
  }
}
