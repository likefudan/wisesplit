/**
 * Security headers for every response. The Worker sets them on what it serves (the API);
 * src/web/public/_headers repeats them for the static pages Cloudflare serves directly, and a
 * test keeps the two the same.
 *
 * The content policy is report-only for now: violations are reported to /api/csp-report (and
 * show up in the Worker logs) but nothing is blocked. Switch the header name to
 * Content-Security-Policy once the logs stay quiet.
 */
export const CSP_HEADER = "Content-Security-Policy-Report-Only";

export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  // Inline style attributes.
  "style-src 'self' 'unsafe-inline'",
  // Google profile pictures come from googleusercontent.com.
  "img-src 'self' data: https://googleusercontent.com https://*.googleusercontent.com",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "report-uri /api/csp-report",
].join("; ");

/** One year of HTTPS-only; no includeSubDomains or preload, so nothing outside this site is bound. */
export const HSTS = "max-age=31536000";

/** Every security header, set by the Worker and repeated in _headers (the test checks each one). */
export const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  // Invite links will carry secret tokens in the path; keep them out of referrers.
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
  "Strict-Transport-Security": HSTS,
  [CSP_HEADER]: CSP,
};
