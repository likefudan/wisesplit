import type { Currency } from "../shared/currencies";
import { type Lang, translate } from "../shared/i18n";
import { formatAmount } from "../shared/money";
import { type AppNotification, notificationText } from "../shared/notifications";
import { type Env, isStaging } from "./env";

/** One email to one person. */
export interface Email {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/** Whether this site can send email: Resend's key and a sender address are both set. */
export const canEmail = (env: Env) => !!(env.RESEND_API_KEY && env.EMAIL_FROM);

// Addresses that can't receive mail (RFC 2606: the test logins use them); sending would only bounce.
const UNDELIVERABLE = /(^|\.)(example\.(com|net|org)|example|test|invalid|localhost)$/i;

/**
 * Sends `emails` through Resend, in one request: its free tier allows only a couple of requests a
 * second (and 100 emails a day). How many were accepted; a refusal is logged, never thrown, and so
 * is a network failure. Addresses that can't get mail are left out.
 */
export async function sendEmails(env: Env, emails: Email[]): Promise<number> {
  const deliverable = emails.filter((e) => !UNDELIVERABLE.test(e.to.split("@").pop() ?? ""));
  if (!canEmail(env) || !deliverable.length) return 0;
  try {
    const res = await fetch("https://api.resend.com/emails/batch", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(
        deliverable.map((e) => ({ from: env.EMAIL_FROM, to: [e.to], subject: e.subject, text: e.text, html: e.html })),
      ),
    });
    if (res.ok) return deliverable.length;
    console.error("emails not sent:", res.status, (await res.text()).slice(0, 500));
  } catch (err) {
    console.error("emails not sent:", err);
  }
  return 0;
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** A message with its {url} as a link, in HTML. */
const withLink = (lang: Lang, key: "email.footer" | "email.signupRejected", url: string) =>
  escapeHtml(translate(lang, key, { url: "\u0000" })).replace(
    "\u0000",
    `<a href="${escapeHtml(url)}">${escapeHtml(url)}</a>`,
  );

/**
 * The email telling one person about a notification, in their language: what the bell would say,
 * a link to where it happened, and how to turn these emails off. Null for a kind with no words.
 */
export function notificationEmail(
  env: Env,
  to: { id: string; email: string; lang: Lang },
  n: Pick<AppNotification, "kind" | "data" | "actorId">,
  group: { id: string; name: string; currency: Currency } | null,
  names: Record<string, string>,
): Email | null {
  const { lang } = to;
  const t = (key: Parameters<typeof translate>[1], params?: Record<string, string>) => translate(lang, key, params);
  const name = (id: string | null | undefined) =>
    id === to.id ? t("notifications.you") : (id && names[id]) || t("activity.someone");
  const money = (units: number | undefined) =>
    units === undefined ? "—" : group ? formatAmount(units, group.currency, lang) : String(units);
  const said = notificationText(n, lang, name, money);
  if (!said) return null;

  const origin = env.SITE_ORIGIN.replace(/\/$/, "");
  const rejected = n.kind === "signup.rejected";
  const link = group ? `${origin}/groups/${encodeURIComponent(group.id)}` : `${origin}/`;
  const settings = `${origin}/notifications/settings`;
  const subject = `${isStaging(env) ? `${t("email.staging")} ` : ""}${group ? `${group.name}: ` : ""}${said.text}`
    .replace(/\s+/g, " ")
    .slice(0, 200);

  const text = [
    group?.name,
    said.text,
    said.detail,
    "",
    rejected ? t("email.signupRejected", { url: link }) : `${t(group ? "email.openGroup" : "email.open")}: ${link}`,
    ...(rejected ? [] : ["", "—", t("email.footer", { url: settings })]),
  ]
    .filter((line) => line !== undefined && line !== null)
    .join("\n");

  const p = (style: string, html: string) => `<p style="margin:0 0 12px;${style}">${html}</p>`;
  const html = [
    `<!doctype html><html lang="${lang === "zh" ? "zh-CN" : "en"}"><head><meta charset="utf-8"></head>`,
    `<body style="margin:0;padding:24px;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;line-height:1.5;color:#1f2933">`,
    group ? p("color:#616e7c;font-size:14px", escapeHtml(group.name)) : "",
    p("font-size:16px", escapeHtml(said.text)),
    said.detail ? p("", escapeHtml(said.detail)) : "",
    rejected
      ? p("", withLink(lang, "email.signupRejected", link))
      : p(
          "",
          `<a href="${escapeHtml(link)}" style="display:inline-block;padding:8px 16px;border-radius:6px;background:#0f766e;color:#fff;text-decoration:none">${escapeHtml(t(group ? "email.openGroup" : "email.open"))}</a>`,
        ),
    rejected
      ? ""
      : `<hr style="border:none;border-top:1px solid #e4e7eb;margin:24px 0 12px">${p("color:#7b8794;font-size:12px", withLink(lang, "email.footer", settings))}`,
    "</body></html>",
  ].join("");

  return { to: to.email, subject, text, html };
}
