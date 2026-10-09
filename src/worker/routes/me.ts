import { Hono } from "hono";
import { type AppEnv, requireApproved, type UserRow } from "../auth";
import { readJson } from "../http";
import { parseLang, parseName, parseVenmo, publicUser } from "../users";

/** The signed-in user's own profile: display name, Venmo username and the language of the pages. */
export const meRoutes = new Hono<AppEnv>();
meRoutes.use("*", requireApproved);

meRoutes.get("/", (c) => c.json({ user: publicUser(c.env, c.get("user")) }));

// Saves the fields present in the body; each is checked before any is saved.
meRoutes.post("/", async (c) => {
  const user = c.get("user");
  const body = await readJson(c.req.raw);
  const name = "name" in body ? parseName(body.name) : user.name;
  const venmo = "venmo" in body ? parseVenmo(body.venmo) : user.venmo;
  const lang = "lang" in body ? parseLang(body.lang) : user.lang;
  const saved = await c.env.DB.prepare("UPDATE users SET name = ?, venmo = ?, lang = ? WHERE id = ? RETURNING *")
    .bind(name, venmo, lang, user.id)
    .first<UserRow>();
  return c.json({ user: publicUser(c.env, saved!) });
});
