import type { Env } from "./env";
import { HttpError } from "./http";

/** Every receipt object's key starts with this, then the group id: see `receiptKey`. */
const PREFIX = "receipts/";

export const receiptKey = (groupId: string, expenseId: string, id: string) =>
  `${PREFIX}${groupId}/${expenseId}/${id}.jpg`;

const tooLarge = (max: number) =>
  new HttpError(413, "receipt_too_large", `A receipt photo may be at most ${max} bytes`);

/** The request body, refused with 413 as soon as it passes `max` bytes (whatever Content-Length says). */
export async function readBody(req: Request, max: number): Promise<Uint8Array> {
  if (Number(req.headers.get("Content-Length")) > max) throw tooLarge(max);
  const reader = req.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (reader) {
    let part: ReadableStreamReadResult<Uint8Array>;
    try {
      part = await reader.read();
    } catch {
      // The sender went away mid-upload: nobody is waiting for the answer.
      throw new HttpError(400, "invalid_receipt", "The upload was cut off");
    }
    const { done, value } = part;
    if (done) break;
    size += value.length;
    if (size > max) {
      await reader.cancel();
      throw tooLarge(max);
    }
    chunks.push(value);
  }
  return concat(chunks);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/**
 * A JPEG without the parts that can say where and when, and on what, a photo was taken: EXIF and
 * XMP (APP1, with the GPS position), IPTC (APP13), thumbnails, the other APPn blocks and comments,
 * wherever they are, and anything after the end of the image (a phone's second picture, a "motion
 * photo"). Keeps only the colour profile and Adobe's colour flag, which change how it looks
 * (`isMetadata`). EXIF's "which way up" goes too, so a photo must arrive upright: the
 * browser's shrunk copy is (and has none of these blocks anyway); this covers anyone calling the
 * API directly. Null when it isn't a whole JPEG: a frame header, a scan, and an end.
 */
export function stripJpegMetadata(data: Uint8Array): Uint8Array | null {
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) return null;
  const keep: Uint8Array[] = [data.subarray(0, 2)];
  let frame = false;
  let scan = false;
  let i = 2;
  while (i + 2 <= data.length) {
    if (data[i] !== 0xff) return null;
    const marker = data[i + 1]!;
    // Fill bytes before a marker.
    if (marker === 0xff) {
      i++;
      continue;
    }
    if (marker === 0xd9) {
      if (!frame || !scan) return null;
      keep.push(data.subarray(i, i + 2));
      return concat(keep);
    }
    // Other markers without a length (start of image, restarts) don't belong between segments.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8) || i + 4 > data.length) return null;
    const length = (data[i + 2]! << 8) | data[i + 3]!;
    let end = i + 2 + length;
    if (length < 2 || end > data.length) return null;
    // Frame headers (SOF0 to SOF15), except DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) frame = true;
    // Start of scan: the compressed data follows its header, up to the next marker that isn't a
    // restart (FF D0 to D7) or an escaped FF (FF 00).
    if (marker === 0xda) {
      if (!frame) return null;
      scan = true;
      while (end + 1 < data.length) {
        const next = data[end + 1]!;
        if (data[end] === 0xff && next !== 0 && !(next >= 0xd0 && next <= 0xd7)) break;
        end++;
      }
      if (end + 1 >= data.length) return null;
    }
    if (!isMetadata(marker, data.subarray(i + 4, end))) keep.push(data.subarray(i, end));
    i = end;
  }
  return null;
}

const ICC_PROFILE = new TextEncoder().encode("ICC_PROFILE\0");

/**
 * Whether a segment is one `stripJpegMetadata` drops: every APPn block and comment, except a
 * colour profile (APP2 "ICC_PROFILE") and Adobe's colour flag (APP14). That includes APP0, whose
 * JFIF header decoders do without and which can hold a thumbnail of the original.
 */
function isMetadata(marker: number, payload: Uint8Array): boolean {
  if (marker === 0xfe) return true;
  if (marker < 0xe0 || marker > 0xef || marker === 0xee) return false;
  return !(marker === 0xe2 && ICC_PROFILE.every((b, k) => payload[k] === b));
}

/** Deletes objects, ignoring failures: whatever is left behind goes in the next clean-up. Whether it worked. */
export async function deleteObjects(env: Env, keys: string[]): Promise<boolean> {
  if (!keys.length) return true;
  try {
    // At most 1000 at a time, which every caller keeps to (one page of a listing at most).
    await env.RECEIPTS.delete(keys);
    return true;
  } catch (err) {
    console.error("receipt delete failed:", err);
    return false;
  }
}

/** The receipt objects whose keys start with `prefix`, a page (up to 1000) at a time. */
async function* listPages(env: Env, prefix: string) {
  let cursor: string | undefined;
  do {
    const page = await env.RECEIPTS.list({ prefix, cursor });
    yield page.objects;
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

/** Deletes every receipt object of a group (once the group itself is gone). */
export async function deleteGroupReceipts(env: Env, groupId: string) {
  for await (const objects of listPages(env, `${PREFIX}${groupId}/`))
    await deleteObjects(
      env,
      objects.map((o) => o.key),
    );
}

/**
 * Objects only this old or older are cleaned up: an upload stores its object a moment before the
 * row that names it, and must not lose it in between.
 */
export const ORPHAN_AGE_MS = 3600_000;

/**
 * Removes receipt objects no expense names any more: left by an upload that failed after storing
 * its photo, a photo replaced or removed while deleting the old one failed, or a deleted group or
 * expense. Run daily (`scheduled` in index.ts). How many it removed.
 */
export async function cleanUpReceipts(env: Env, at = Date.now()): Promise<number> {
  let removed = 0;
  for await (const objects of listPages(env, PREFIX)) {
    const { results } = await env.DB.prepare(
      "SELECT object_key FROM receipts WHERE object_key IN (SELECT value FROM json_each(?))",
    )
      .bind(JSON.stringify(objects.map((o) => o.key)))
      .all<{ object_key: string }>();
    const used = new Set(results.map((r) => r.object_key));
    const orphans = objects
      .filter((o) => !used.has(o.key) && o.uploaded.getTime() <= at - ORPHAN_AGE_MS)
      .map((o) => o.key);
    if (await deleteObjects(env, orphans)) removed += orphans.length;
  }
  return removed;
}
