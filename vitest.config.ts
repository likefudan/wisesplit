import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations("./migrations"),
          // As in production, whatever a developer's .dev.vars says; tests that need otherwise pass their own.
          ENVIRONMENT: "production",
          GOOGLE_CLIENT_ID: "",
          GOOGLE_CLIENT_SECRET: "",
          TURNSTILE_SITE_KEY: "",
          TURNSTILE_SECRET_KEY: "",
          ADMIN_EMAILS: "",
          TEST_LOGIN_SECRET: "",
        },
      },
    })),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["./test/setup.ts"],
  },
});
