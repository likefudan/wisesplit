import { Hono } from "hono";
import type { AppEnv } from "../auth";
import { attachment, dayIn, exportLang, groupCsv, timeZoneOf } from "../export";
import { groupForMember } from "../groups";

/**
 * The group's records as a CSV file, for any member, under /api/groups/:id (behind requireApproved
 * there): GET /export.csv?lang=zh&tz=America/Los_Angeles. `lang` is the language of the headings
 * (default: the user's own); `tz` the time zone that decides which day a payment was made, and the
 * day in the file's name (default: UTC).
 */
export const exportRoutes = new Hono<AppEnv>();

exportRoutes.get("/export.csv", async (c) => {
  const me = c.get("user");
  const group = await groupForMember(c.env, c.req.param("id")!, me.id);
  const day = dayIn(timeZoneOf(c.req.query("tz")));
  const csv = await groupCsv(c.env, group, exportLang(c.req.query("lang"), me.lang), day);
  return c.body(csv, 200, {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": attachment(group.name, day(new Date())),
  });
});
