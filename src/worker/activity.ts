import type { ActivityEntry, ActivityPage, ExpenseSnapshot } from "../shared/activity";
import type { Env } from "./env";
import { HttpError } from "./http";

interface LogRow {
  id: string;
  actor_id: string;
  action: ActivityEntry["action"];
  subject_id: string | null;
  data: string | null;
  created_at: string;
}

/** Everyone an entry mentions, by user id: who did it, who it is about, and who is in the expense. */
function mentioned(entry: ActivityEntry): string[] {
  const ids = [entry.actorId];
  const fromExpense = (e: Partial<ExpenseSnapshot>) => {
    if (e.paidBy) ids.push(e.paidBy);
    if (e.shares) ids.push(...Object.keys(e.shares));
  };
  switch (entry.action) {
    case "expense.added":
    case "expense.deleted":
      fromExpense(entry.data);
      break;
    case "expense.edited":
      fromExpense(entry.data.before);
      fromExpense(entry.data.after);
      break;
    case "member.joined":
      ids.push(entry.data.invitedBy);
      if (entry.subjectId) ids.push(entry.subjectId);
      break;
    case "member.added":
    case "member.left":
    case "member.removed":
      if (entry.subjectId) ids.push(entry.subjectId);
      break;
  }
  return ids;
}

/**
 * One page of a group's activity log, newest first. `before` is the id of the last entry on the
 * previous page. Entries made in the same millisecond go by rowid, which follows the order they
 * were written in.
 */
export async function activityPage(
  env: Env,
  groupId: string,
  before: string | null,
  size: number,
): Promise<ActivityPage> {
  let statement: D1PreparedStatement;
  const columns = "SELECT id, actor_id, action, subject_id, data, created_at FROM activity_log";
  if (before) {
    const after = await env.DB.prepare(
      "SELECT created_at, rowid AS seq FROM activity_log WHERE group_id = ? AND id = ?",
    )
      .bind(groupId, before)
      .first<{ created_at: string; seq: number }>();
    if (!after) throw new HttpError(400, "invalid_cursor", "No such entry to list from");
    statement = env.DB.prepare(
      `${columns} WHERE group_id = ? AND (created_at, rowid) < (?, ?) ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    ).bind(groupId, after.created_at, after.seq, size + 1);
  } else {
    statement = env.DB.prepare(`${columns} WHERE group_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`).bind(
      groupId,
      size + 1,
    );
  }
  const { results } = await statement.all<LogRow>();
  const entries = results.slice(0, size).map(
    (r) =>
      ({
        id: r.id,
        actorId: r.actor_id,
        action: r.action,
        subjectId: r.subject_id,
        data: r.data === null ? null : JSON.parse(r.data),
        createdAt: r.created_at,
      }) as ActivityEntry,
  );
  const ids = [...new Set(entries.flatMap(mentioned))];
  const { results: users } = await env.DB.prepare(
    "SELECT id, name FROM users WHERE id IN (SELECT value FROM json_each(?))",
  )
    .bind(JSON.stringify(ids))
    .all<{ id: string; name: string }>();
  return {
    entries,
    names: Object.fromEntries(users.map((u) => [u.id, u.name])),
    next: results.length > size ? entries[entries.length - 1]!.id : null,
  };
}
