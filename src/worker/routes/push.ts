import { Hono } from "hono";
import { type AppEnv, requireApproved, sessionHash } from "../auth";
import { readJson, str } from "../http";
import { parseSubscription, pushTest, subscribe, unsubscribe, vapidKey } from "../push";

/** Push notifications for the signed-in user's browsers (the notification settings page). */
export const pushRoutes = new Hono<AppEnv>();
pushRoutes.use("*", requireApproved);

// The key browsers subscribe with; null while push isn't set up on this site.
pushRoutes.get("/", (c) => c.json({ publicKey: vapidKey(c.env)?.publicKey ?? null }));

pushRoutes.post("/subscribe", async (c) => {
  const sub = await parseSubscription(await readJson(c.req.raw));
  await subscribe(c.env, c.get("user").id, await sessionHash(c), sub);
  return c.body(null, 204);
});

// Someone else's browser, or one push is already off in: nothing to do.
pushRoutes.post("/unsubscribe", async (c) => {
  await unsubscribe(c.env, c.get("user").id, str((await readJson(c.req.raw)).endpoint));
  return c.body(null, 204);
});

pushRoutes.post("/test", async (c) =>
  c.json({ result: await pushTest(c.env, c.get("user").id, str((await readJson(c.req.raw)).endpoint)) }),
);
