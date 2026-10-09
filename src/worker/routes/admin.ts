import { Hono } from "hono";
import { type AppEnv, requireAdmin, type UserRow, type UserStatus } from "../auth";
import { HttpError, now, readJson } from "../http";
import { getSettings, updateSettings } from "../settings";
import { publicUser } from "../users";

/** The admin console: applications, users, and site settings. */
export const adminRoutes = new Hono<AppEnv>();
adminRoutes.use("*", requireAdmin);

const STATUSES: readonly UserStatus[] = ["pending", "approved", "rejected", "deactivated"];
const LIST_LIMIT = 500;

// Users in one state; the pending list oldest application first (the order to work through it),
// the others newest first.
adminRoutes.get("/users", async (c) => {
  const status = c.req.query("status") as UserStatus;
  if (!STATUSES.includes(status))
    throw new HttpError(400, "invalid_input", `status must be one of ${STATUSES.join(", ")}`);
  const order = status === "pending" ? "applied_at ASC" : "applied_at DESC";
  const { results } = await c.env.DB.prepare(`SELECT * FROM users WHERE status = ? ORDER BY ${order} LIMIT ?`)
    .bind(status, LIST_LIMIT)
    .all<UserRow>();
  return c.json({
    users: results.map((u) => ({ ...publicUser(c.env, u), appliedAt: u.applied_at, decidedAt: u.decided_at })),
  });
});

/** Each admin action: the states it applies to and the state it leads to. */
const ACTIONS: Record<string, { from: UserStatus[]; to: UserStatus }> = {
  approve: { from: ["pending", "rejected"], to: "approved" },
  reject: { from: ["pending"], to: "rejected" },
  deactivate: { from: ["approved"], to: "deactivated" },
  reactivate: { from: ["deactivated"], to: "approved" },
};

adminRoutes.post("/users/:id/:action", async (c) => {
  const action = ACTIONS[c.req.param("action")];
  if (!action) throw new HttpError(404, "not_found", "Not found");
  const admin = c.get("user");
  const id = c.req.param("id");
  if (id === admin.id) throw new HttpError(400, "cannot_change_self", "Admins can't change their own account");
  const placeholders = action.from.map(() => "?").join(", ");
  // Checked and changed in one statement, so two admins clicking at once can't both act.
  const updated = await c.env.DB.prepare(
    `UPDATE users SET status = ?, decided_at = ?, decided_by = ? WHERE id = ? AND status IN (${placeholders}) RETURNING *`,
  )
    .bind(action.to, now(), admin.id, id, ...action.from)
    .first<UserRow>();
  if (!updated) {
    const exists = await c.env.DB.prepare("SELECT 1 FROM users WHERE id = ?").bind(id).first();
    if (!exists) throw new HttpError(404, "not_found", "No such user");
    throw new HttpError(409, "wrong_status", "The user's status has changed; reload the list");
  }
  return c.json({ user: publicUser(c.env, updated) });
});

adminRoutes.get("/settings", async (c) => c.json({ settings: await getSettings(c.env) }));

adminRoutes.post("/settings", async (c) =>
  c.json({ settings: await updateSettings(c.env, await readJson(c.req.raw)) }),
);
