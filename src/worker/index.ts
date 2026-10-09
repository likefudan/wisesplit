import { Hono } from "hono";
import { SECURITY_HEADERS } from "../shared/security";
import { type Env, isStaging } from "./env";
import { HttpError } from "./http";

const app = new Hono<{ Bindings: Env }>();

app.use("*", async (c, next) => {
  await next();
  // API answers are per user; keep them out of caches.
  c.header("Cache-Control", "no-store");
  // Same as public/_headers, which covers the static pages.
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) c.header(name, value);
  if (isStaging(c.env)) c.header("X-Robots-Tag", "noindex, nofollow");
});

// Proves the Worker is up and can reach its database.
app.get("/api/health", async (c) => {
  await c.env.DB.prepare("SELECT 1").first();
  return c.json({ ok: true });
});

// What every page needs before anything else: whether this is the test site.
app.get("/api/site", (c) => c.json({ staging: isStaging(c.env) }));

// Browsers report what the content policy would have blocked; read them in the Worker logs.
app.post("/api/csp-report", async (c) => {
  // Anyone can post here, so only the start of a report is read and logged.
  const reader = c.req.raw.body?.getReader();
  const bytes = new Uint8Array(2000);
  let n = 0;
  try {
    while (reader && n < bytes.length) {
      const { done, value } = await reader.read();
      if (done) break;
      const part = value.subarray(0, bytes.length - n);
      bytes.set(part, n);
      n += part.length;
    }
    await reader?.cancel();
  } catch {
    // The sender went away mid-report: log what arrived.
  }
  console.warn("csp report:", new TextDecoder().decode(bytes.subarray(0, n)));
  return c.body(null, 204);
});

// Search engines may index the real site, never the test site.
app.get("/robots.txt", (c) =>
  c.text(isStaging(c.env) ? "User-agent: *\nDisallow: /\n" : "User-agent: *\nDisallow: /api/\n"),
);

app.notFound((c) => c.json({ error: { code: "not_found", message: "Not found" } }, 404));

app.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: { code: err.code, message: err.message } }, err.status);
  console.error(err);
  return c.json({ error: { code: "internal", message: "Something went wrong on the server" } }, 500);
});

export default {
  fetch: app.fetch,
} satisfies ExportedHandler<Env>;
