import { Hono } from "hono";
import { RECEIPT_MAX_BYTES } from "../../shared/receipts";
import type { AppEnv } from "../auth";
import type { Env } from "../env";
import { groupForMember } from "../groups";
import { HttpError, now } from "../http";
import { randomId } from "../lib/crypto";
import { deleteObjects, readBody, receiptKey, stripJpegMetadata } from "../receipts";

/**
 * An expense's receipt photo, under /api/groups/:id (behind requireApproved there). Any member of
 * the group may see, add, replace or remove it, as with the expense itself.
 */
export const receiptRoutes = new Hono<AppEnv>();

const noSuchExpense = () => new HttpError(404, "expense_not_found", "No such expense in this group");

const expenseExists = async (env: Env, groupId: string, expenseId: string) =>
  !!(await env.DB.prepare("SELECT 1 FROM expenses WHERE id = ? AND group_id = ?").bind(expenseId, groupId).first());

/** SQL that is true while expense ? is in group ? and user ? is in that group. */
const MEMBER_EXPENSE_SQL = `EXISTS (SELECT 1 FROM expenses e JOIN group_members m ON m.group_id = e.group_id
  WHERE e.id = ? AND e.group_id = ? AND m.user_id = ?)`;

// The photo itself. Checked against the group on every view (`no-cache`): someone who has left
// can't load it again, however long their browser keeps it.
receiptRoutes.get("/expenses/:expenseId/receipt", async (c) => {
  const groupId = c.req.param("id")!;
  const me = c.get("user").id;
  // One query for the usual case; the group's own 404 when it finds nothing because of that.
  const row = await c.env.DB.prepare(
    `SELECT r.object_key FROM receipts r JOIN expenses e ON e.id = r.expense_id
       JOIN group_members m ON m.group_id = e.group_id AND m.user_id = ?
     WHERE e.group_id = ? AND e.id = ?`,
  )
    .bind(me, groupId, c.req.param("expenseId"))
    .first<{ object_key: string }>();
  if (!row) await groupForMember(c.env, groupId, me);
  // Only If-None-Match: a browser revalidating its copy. (Other conditions would need a 412.)
  const conditions = new Headers();
  const etag = c.req.header("If-None-Match");
  if (etag) conditions.set("If-None-Match", etag);
  const object = row && (await c.env.RECEIPTS.get(row.object_key, { onlyIf: conditions }));
  if (!object) throw new HttpError(404, "receipt_not_found", "This expense has no receipt photo");
  const headers = {
    "Content-Type": "image/jpeg",
    "Content-Disposition": 'inline; filename="receipt.jpg"',
    "Cache-Control": "private, no-cache",
    ETag: object.httpEtag,
  };
  // Unchanged since the browser's copy (If-None-Match): R2 leaves out the body.
  if (!("body" in object)) return c.body(null, 304, headers);
  return c.body(object.body, 200, { ...headers, "Content-Length": String(object.size) });
});

// Adds the photo, or replaces the one there. The body is the JPEG itself.
receiptRoutes.post("/expenses/:expenseId/receipt", async (c) => {
  const me = c.get("user");
  if (c.req.header("Content-Type")?.split(";")[0]?.trim().toLowerCase() !== "image/jpeg")
    throw new HttpError(415, "invalid_receipt", "Send the photo as image/jpeg");
  const group = await groupForMember(c.env, c.req.param("id")!, me.id);
  const expenseId = c.req.param("expenseId");
  if (!(await expenseExists(c.env, group.id, expenseId))) throw noSuchExpense();
  const jpeg = stripJpegMetadata(await readBody(c.req.raw, RECEIPT_MAX_BYTES));
  if (!jpeg) throw new HttpError(400, "invalid_receipt", "That is not a JPEG photo");

  const id = randomId();
  const key = receiptKey(group.id, expenseId, id);
  const at = now();
  await c.env.RECEIPTS.put(key, jpeg, { httpMetadata: { contentType: "image/jpeg" } });
  // One transaction: the old photo's key as it was just before, the log entry and the new row
  // (both only if the expense is still there and the uploader still in its group).
  const [old, , saved] = await c.env.DB.batch([
    c.env.DB.prepare("SELECT object_key FROM receipts WHERE expense_id = ?").bind(expenseId),
    c.env.DB.prepare(
      `INSERT INTO activity_log (id, group_id, actor_id, action, subject_id, data, created_at)
       SELECT ?, ?, ?,
         CASE WHEN EXISTS (SELECT 1 FROM receipts WHERE expense_id = ?) THEN 'receipt.replaced' ELSE 'receipt.added' END,
         ?, ?, ?
       WHERE ${MEMBER_EXPENSE_SQL}`,
    ).bind(
      randomId(),
      group.id,
      me.id,
      expenseId,
      expenseId,
      JSON.stringify({ size: jpeg.length }),
      at,
      expenseId,
      group.id,
      me.id,
    ),
    c.env.DB.prepare(
      `INSERT INTO receipts (expense_id, id, object_key, size, uploaded_by, uploaded_at)
       SELECT ?, ?, ?, ?, ?, ? WHERE ${MEMBER_EXPENSE_SQL}
       ON CONFLICT (expense_id) DO UPDATE SET id = excluded.id, object_key = excluded.object_key,
         size = excluded.size, uploaded_by = excluded.uploaded_by, uploaded_at = excluded.uploaded_at
       RETURNING id`,
    ).bind(expenseId, id, key, jpeg.length, me.id, at, expenseId, group.id, me.id),
  ]);
  if (!saved?.results.length) {
    await deleteObjects(c.env, [key]);
    await groupForMember(c.env, group.id, me.id); // the uploader has left: 404
    throw noSuchExpense(); // deleted meanwhile
  }
  const replaced = (old?.results[0] as { object_key: string } | undefined)?.object_key;
  if (replaced) await deleteObjects(c.env, [replaced]);
  return c.json({ receipt: id });
});

// Removes the photo. Removing one that isn't there is fine.
receiptRoutes.post("/expenses/:expenseId/receipt/delete", async (c) => {
  const me = c.get("user");
  const group = await groupForMember(c.env, c.req.param("id")!, me.id);
  const expenseId = c.req.param("expenseId");
  const member = [expenseId, group.id, me.id];
  const [, removed] = await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO activity_log (id, group_id, actor_id, action, subject_id, data, created_at)
       SELECT ?, ?, ?, 'receipt.removed', ?, NULL, ?
       WHERE EXISTS (SELECT 1 FROM receipts WHERE expense_id = ?) AND ${MEMBER_EXPENSE_SQL}`,
    ).bind(randomId(), group.id, me.id, expenseId, now(), expenseId, ...member),
    c.env.DB.prepare(`DELETE FROM receipts WHERE expense_id = ? AND ${MEMBER_EXPENSE_SQL} RETURNING object_key`).bind(
      expenseId,
      ...member,
    ),
  ]);
  const key = (removed?.results[0] as { object_key: string } | undefined)?.object_key;
  if (key) await deleteObjects(c.env, [key]);
  else {
    await groupForMember(c.env, group.id, me.id);
    if (!(await expenseExists(c.env, group.id, expenseId))) throw noSuchExpense();
  }
  return c.body(null, 204);
});
