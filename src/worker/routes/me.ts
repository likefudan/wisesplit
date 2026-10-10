import { Hono } from "hono";
import { type AppEnv, requireApproved, type UserRow } from "../auth";
import { HttpError, readJson } from "../http";
import { parseLang, parseName, parseVenmo, publicUser } from "../users";

/** The signed-in user's own profile: display name, Venmo username and the language of the pages. */
export const meRoutes = new Hono<AppEnv>();
meRoutes.use("*", requireApproved);

meRoutes.get("/", (c) => c.json({ user: publicUser(c.env, c.get("user")) }));

// Saves only the fields present in the body (so a language switch can't undo a profile save made
// at the same moment); each is checked before any is saved.
meRoutes.post("/", async (c) => {
  const user = c.get("user");
  const body = await readJson(c.req.raw);
  const fields: [string, string | null][] = [];
  if ("name" in body) fields.push(["name", parseName(body.name)]);
  if ("venmo" in body) fields.push(["venmo", parseVenmo(body.venmo)]);
  if ("lang" in body) fields.push(["lang", parseLang(body.lang)]);
  if (!fields.length) return c.json({ user: publicUser(c.env, user) });
  // Still approved: an admin may have deactivated the account since this request was checked.
  const saved = await c.env.DB.prepare(
    `UPDATE users SET ${fields.map(([col]) => `${col} = ?`).join(", ")} WHERE id = ? AND status = 'approved' RETURNING *`,
  )
    .bind(...fields.map(([, v]) => v), user.id)
    .first<UserRow>();
  if (!saved) throw new HttpError(403, "account_deactivated", "This account has been deactivated");
  return c.json({ user: publicUser(c.env, saved) });
});
