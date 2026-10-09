import { exports } from "cloudflare:workers";

export const ORIGIN = "https://wisesplit.test";

/** A request to the Worker as the browser would send it. */
export const call = (path: string, init?: RequestInit) => exports.default.fetch(`${ORIGIN}${path}`, init);
