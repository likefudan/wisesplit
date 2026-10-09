import type { D1Migration } from "cloudflare:test";

declare global {
  namespace Cloudflare {
    interface GlobalProps {
      mainModule: typeof import("../src/worker/index");
    }
    interface Env {
      DB: D1Database;
      ASSETS: Fetcher;
      TEST_MIGRATIONS: D1Migration[];
      SITE_ORIGIN: string;
      ENVIRONMENT?: string;
    }
  }
}
