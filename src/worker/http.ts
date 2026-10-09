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
