import { CURRENCY_CODES, type Currency, isCurrency } from "../shared/currencies";
import { GROUP_NAME_MAX, type GroupDetail, type GroupSummary } from "../shared/groups";
import type { Env } from "./env";
import { HttpError } from "./http";
import { tidyName } from "./users";

export interface GroupRow {
  id: string;
  name: string;
  currency: Currency;
  owner_id: string;
  created_at: string;
}

/** A group name: tidied like a display name, then 1 to 60 characters. */
export function parseGroupName(value: unknown): string {
  const name = tidyName(value);
  if (!name || [...name].length > GROUP_NAME_MAX)
    throw new HttpError(400, "invalid_group_name", `Group name must be 1 to ${GROUP_NAME_MAX} characters`);
  return name;
}

export function parseCurrency(value: unknown): Currency {
  if (!isCurrency(value))
    throw new HttpError(400, "invalid_currency", `Currency must be one of ${CURRENCY_CODES.join(", ")}`);
  return value;
}

export const noSuchGroup = () => new HttpError(404, "group_not_found", "No such group, or you are not in it");

/**
 * The group, if `userId` is one of its members. Anyone else gets the same 404 as for a group that
 * doesn't exist, so group ids reveal nothing.
 */
export async function groupForMember(env: Env, groupId: string, userId: string): Promise<GroupRow> {
  const group = await env.DB.prepare(
    "SELECT g.* FROM groups g JOIN group_members m ON m.group_id = g.id WHERE g.id = ? AND m.user_id = ?",
  )
    .bind(groupId, userId)
    .first<GroupRow>();
  if (!group) throw noSuchGroup();
  return group;
}

export const isMember = async (env: Env, groupId: string, userId: string) =>
  !!(await env.DB.prepare("SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?")
    .bind(groupId, userId)
    .first());

/**
 * SQL that is true while group ? is not settled up: someone's balance in it is not 0 (deleted
 * expenses count for nothing). Binds the group id twice. (PR 7 adds: or a payment in it awaits
 * confirmation.)
 */
export const UNSETTLED_SQL = `EXISTS (SELECT 1 FROM (
    SELECT paid_by AS user_id, amount AS net FROM expenses WHERE group_id = ? AND deleted_at IS NULL
    UNION ALL
    SELECT s.user_id, -s.amount FROM expense_shares s JOIN expenses e ON e.id = s.expense_id
      WHERE e.group_id = ? AND e.deleted_at IS NULL
  ) GROUP BY user_id HAVING SUM(net) != 0)`;
export const unsettledArgs = (groupId: string) => [groupId, groupId];

/**
 * SQL that is true while user ? may not leave group ? (or be removed from it). The rule
 * (docs/mvp-scope.md §2): someone with any expense involving them, paid by them or shared by
 * them, may go only once the whole group is settled; someone with none (or only deleted ones) may
 * go any time. Written
 * as SQL so the check and the removal are one statement, and an expense added at the same moment
 * can't slip in between.
 */
export const MAY_NOT_LEAVE_SQL = `((EXISTS (SELECT 1 FROM expenses WHERE group_id = ? AND paid_by = ? AND deleted_at IS NULL)
    OR EXISTS (SELECT 1 FROM expense_shares s JOIN expenses e ON e.id = s.expense_id
      WHERE e.group_id = ? AND s.user_id = ? AND e.deleted_at IS NULL))
  AND ${UNSETTLED_SQL})`;
export const mayNotLeaveArgs = (groupId: string, userId: string) => [
  groupId,
  userId,
  groupId,
  userId,
  ...unsettledArgs(groupId),
];

/** The groups `userId` is in, newest first. */
export async function groupsOf(env: Env, userId: string): Promise<GroupSummary[]> {
  const { results } = await env.DB.prepare(
    `SELECT g.*, (SELECT COUNT(*) FROM group_members c WHERE c.group_id = g.id) AS member_count
     FROM groups g JOIN group_members m ON m.group_id = g.id
     WHERE m.user_id = ? ORDER BY g.created_at DESC, g.id`,
  )
    .bind(userId)
    .all<GroupRow & { member_count: number }>();
  return results.map((g) => summary(g, g.member_count));
}

/**
 * The group with its members, oldest first. Members' emails stay private: someone who joined
 * through a forwarded link may not know the others.
 */
export async function groupDetail(env: Env, group: GroupRow): Promise<GroupDetail> {
  const { results } = await env.DB.prepare(
    `SELECT u.id, u.name, u.picture, u.status, m.joined_at
     FROM group_members m JOIN users u ON u.id = m.user_id
     WHERE m.group_id = ? ORDER BY m.joined_at, u.id`,
  )
    .bind(group.id)
    .all<{ id: string; name: string; picture: string | null; status: string; joined_at: string }>();
  return {
    ...summary(group, results.length),
    createdAt: group.created_at,
    members: results.map((u) => ({
      id: u.id,
      name: u.name,
      picture: u.picture,
      deactivated: u.status === "deactivated",
      joinedAt: u.joined_at,
    })),
  };
}

const summary = (g: GroupRow, memberCount: number): GroupSummary => ({
  id: g.id,
  name: g.name,
  currency: g.currency,
  ownerId: g.owner_id,
  memberCount,
});
