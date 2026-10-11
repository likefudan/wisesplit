/** Receipt photos: one per expense, a JPEG made small in the browser before it is sent. */

/** The longest side of a photo after the browser shrinks it, in pixels. */
export const RECEIPT_MAX_SIDE = 1600;

/** JPEG quality the browser saves it at (0 to 1). */
export const RECEIPT_QUALITY = 0.7;

/**
 * The most the server takes. A shrunk photo is usually 150 to 600 KB; this leaves room for a busy
 * one without letting anyone store big files.
 */
export const RECEIPT_MAX_BYTES = 2 * 1024 * 1024;

/** An expense's receipt photo in the API: POST a JPEG to add or replace it, POST …/delete to remove it. */
export const receiptBase = (groupId: string, expenseId: string) =>
  `/api/groups/${encodeURIComponent(groupId)}/expenses/${encodeURIComponent(expenseId)}/receipt`;

/** Where the photo is shown from (only to the group's members); `version` is `Expense.receipt`. */
export const receiptPath = (groupId: string, expenseId: string, version: string) =>
  `${receiptBase(groupId, expenseId)}?v=${encodeURIComponent(version)}`;
