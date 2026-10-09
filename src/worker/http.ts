import type { ContentfulStatusCode } from "hono/utils/http-status";

/**
 * An error the API reports as `{ error: { code, message } }`. The page shows its own translation
 * of `code` (src/shared/i18n.ts); `message` is English, for logs and anyone calling the API directly.
 */
export class HttpError extends Error {
  constructor(
    public status: ContentfulStatusCode,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Reads a JSON object body; anything else (malformed, an array, empty) reads as `{}` so field checks report it. */
export async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const body = await req.json();
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** The current time as stored in the database (ISO 8601, UTC). */
export const now = () => new Date().toISOString();
