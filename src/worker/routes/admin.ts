import { Hono } from "hono";
import { ADMIN_ACTIONS, type AdminAction, USER_STATUSES, type UserStatus } from "../../shared/users";
import { type AppEnv, isAdminEmail, requireAdmin, type UserRow } from "../auth";
import { HttpError, now, readJson } from "../http";
import { getSettings, updateSettings } from "../settings";
import { publicUser } from "../users";

/** The admin console: applications, users, and site settings. */
export const adminRoutes = new Hono<AppEnv>();
adminRoutes.use("*", requireAdmin);

const LIST_LIMIT = 500;

// Users in one state; the pending list oldest application first (the order to work through it),
// the others newest first.
adminRoutes.get("/users", async (c) => {
  const status = c.req.query("status") as UserStatus;
  if (!USER_STATUSES.includes(status))
    throw new HttpError(400, "invalid_input", `status must be one of ${USER_STATUSES.join(", ")}`);
  const order = status === "pending" ? "applied_at ASC" : "applied_at DESC";
  const { results } = await c.env.DB.prepare(`SELECT * FROM users WHERE status = ? ORDER BY ${order} LIMIT ?`)
    .bind(status, LIST_LIMIT + 1)
    .all<UserRow>();
  return c.json({
    users: results.slice(0, LIST_LIMIT).map((u) => ({
      ...publicUser(c.env, u),
      appliedAt: u.applied_at,
      decidedAt: u.decided_at,
      // Named in ADMIN_EMAILS (approved or not yet): the console can't change them.
      adminEmail: isAdminEmail(c.env, u.email),
    })),
    // More than the page shows; plenty for a circle of friends, but say so rather than hide anyone.
    truncated: results.length > LIST_LIMIT,
  });
});

adminRoutes.post("/users/:id/:action", async (c) => {
  const name = c.req.param("action");
  if (!Object.hasOwn(ADMIN_ACTIONS, name)) throw new HttpError(404, "not_found", "Not found");
  const action = ADMIN_ACTIONS[name as AdminAction];
  const admin = c.get("user");
  const id = c.req.param("id");
  const target = await c.env.DB.prepare("SELECT email FROM users WHERE id = ?").bind(id).first<{ email: string }>();
  if (!target) throw new HttpError(404, "not_found", "No such user");
  // Admins (this one included) come and go only through ADMIN_EMAILS.
  if (isAdminEmail(c.env, target.email))
    throw new HttpError(400, "cannot_change_admin", "Admins are set by ADMIN_EMAILS, not here");
  const placeholders = action.from.map(() => "?").join(", ");
  // Checked and changed in one statement, so two admins clicking at once can't both act.
  const updated = await c.env.DB.prepare(
    `UPDATE users SET status = ?, decided_at = ?, decided_by = ? WHERE id = ? AND status IN (${placeholders}) RETURNING *`,
  )
    .bind(action.to, now(), admin.id, id, ...action.from)
    .first<UserRow>();
  if (!updated) throw new HttpError(409, "wrong_status", "The user's status has changed; reload the list");
  return c.json({ user: publicUser(c.env, updated) });
});

adminRoutes.get("/settings", async (c) => c.json({ settings: await getSettings(c.env) }));

adminRoutes.post("/settings", async (c) =>
  c.json({ settings: await updateSettings(c.env, await readJson(c.req.raw)) }),
);
