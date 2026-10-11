import { Hono } from "hono";
import { NOTIFICATIONS_PAGE } from "../../shared/notifications";
import { type AppEnv, requireApproved } from "../auth";
import { readJson } from "../http";
import {
  getNotificationSettings,
  markRead,
  notificationPage,
  unreadCount,
  updateNotificationSettings,
} from "../notifications";

/** The signed-in user's notifications (the bell in the header) and how they want to get them. */
export const notificationRoutes = new Hono<AppEnv>();
notificationRoutes.use("*", requireApproved);

notificationRoutes.get("/", async (c) =>
  c.json(await notificationPage(c.env, c.get("user").id, c.req.query("before") || null, NOTIFICATIONS_PAGE)),
);

// For the bell, which asks every so often.
notificationRoutes.get("/unread", async (c) => c.json({ unread: await unreadCount(c.env, c.get("user").id) }));

notificationRoutes.post("/read-all", async (c) => {
  await markRead(c.env, c.get("user").id, null);
  return c.body(null, 204);
});

notificationRoutes.get("/settings", async (c) =>
  c.json({ settings: await getNotificationSettings(c.env, c.get("user").id) }),
);

notificationRoutes.post("/settings", async (c) =>
  c.json({ settings: await updateNotificationSettings(c.env, c.get("user").id, await readJson(c.req.raw)) }),
);

// Someone else's, or no such notification: nothing to do, the same as one already read.
notificationRoutes.post("/:id/read", async (c) => {
  await markRead(c.env, c.get("user").id, c.req.param("id"));
  return c.body(null, 204);
});
