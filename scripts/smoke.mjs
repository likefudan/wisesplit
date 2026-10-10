// CI helper: after a deploy, check the live site from the outside. Read-only; changes nothing.
// Retries for a minute while the new version reaches every Cloudflare location.
const site = process.env.SITE_ORIGIN ?? "https://wisesplit.llmat.dev";
const staging = new URL(site).hostname.startsWith("staging.");

const checks = [
  [
    "home page",
    "/",
    (r, body) => r.status === 200 && body.includes('<div id="app">') && r.headers.get("x-frame-options") === "DENY",
  ],
  ["health", "/api/health", (r, body) => r.status === 200 && JSON.parse(body).ok === true],
  [
    "robots.txt",
    "/robots.txt",
    (r, body) => r.status === 200 && body.includes(staging ? "Disallow: /\n" : "Disallow: /api/"),
  ],
  ["unknown API path", "/api/not-a-real-path", (r) => r.status === 404],
  ["sign-in status", "/api/auth/session", (r, body) => r.status === 200 && "googleEnabled" in JSON.parse(body)],
  // The live site must never have the browser tests' test login.
  ...(staging
    ? []
    : [
        [
          "no test login",
          "/api/test/login",
          (r) => r.status === 404,
          { method: "POST", headers: { Origin: site, "Content-Type": "application/json" }, body: "{}" },
        ],
      ]),
];

let failed = 0;
for (const [name, path, ok, init] of checks) {
  let passed = false;
  let detail = "";
  for (let attempt = 0; attempt < 6 && !passed; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 10_000));
    try {
      const res = await fetch(site + path, init);
      const body = await res.text();
      passed = ok(res, body);
      detail = `HTTP ${res.status}`;
    } catch (err) {
      detail = err.message;
    }
  }
  console.log(`${passed ? "✓" : "✗"} ${name} (${detail})`);
  if (!passed) failed++;
}
if (failed) {
  console.error(`${failed} smoke check(s) failed against ${site}`);
  process.exit(1);
}
