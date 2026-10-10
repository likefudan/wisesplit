import type { Lang } from "../shared/i18n";

const locale = (lang: Lang) => (lang === "zh" ? "zh-CN" : "en-US");

/** A currency as people know it: "USD · US Dollar", or just the code if the browser has no name for it. */
export function currencyLabel(code: string, lang: Lang): string {
  try {
    const name = new Intl.DisplayNames([locale(lang)], { type: "currency" }).of(code);
    return name && name !== code ? `${code} · ${name}` : code;
  } catch {
    return code;
  }
}

export const formatDate = (iso: string, lang: Lang) =>
  new Date(iso).toLocaleString(locale(lang), { dateStyle: "medium", timeStyle: "short" });

/** A calendar day (YYYY-MM-DD) as people write it: "Oct 1, 2026", "2026年10月1日". */
export const formatDay = (day: string, lang: Lang) =>
  new Date(`${day}T00:00:00Z`).toLocaleDateString(locale(lang), { dateStyle: "medium", timeZone: "UTC" });

/** Today where the browser is, YYYY-MM-DD. */
export function today(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
