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
