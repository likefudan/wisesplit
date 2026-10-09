/**
 * Every string the pages show, in English and Chinese. English is the source: its keys are the
 * list of messages, and the Chinese table must have exactly the same keys (the type checks that a
 * key is not missing, test/i18n.test.ts that the placeholders match).
 *
 * Placeholders are written {name} and filled in by `translate`.
 */
export const LANGS = ["en", "zh"] as const;
export type Lang = (typeof LANGS)[number];

const en = {
  "app.name": "wisesplit",
  "app.tagline": "Split expenses with friends. No ads, no limits.",
  "home.hello": "Hello!",
  "home.comingSoon": "wisesplit is being built. Groups, expenses and settling up are on the way.",
  "lang.switch": "中文",
  "staging.banner": "Test site: data here is not real and may be wiped.",
  "notFound.title": "Page not found",
  "notFound.body": "The link may be wrong or out of date.",
  "notFound.home": "Back to the home page",
  "error.network": "Could not reach the server. Check your connection and try again.",
  "error.not_found": "Not found.",
  "error.internal": "Something went wrong on the server. Please try again later.",
  "error.unknown": "Request failed ({status}).",
} as const;

export type MessageKey = keyof typeof en;

const zh: Record<MessageKey, string> = {
  "app.name": "wisesplit",
  "app.tagline": "和朋友一起记账分账，没有广告，没有限制。",
  "home.hello": "你好！",
  "home.comingSoon": "wisesplit 正在建设中，群组、记账和结算功能马上就来。",
  "lang.switch": "English",
  "staging.banner": "测试网站：这里的数据不是真的，随时可能清空。",
  "notFound.title": "页面不存在",
  "notFound.body": "链接可能有误或已失效。",
  "notFound.home": "回到首页",
  "error.network": "连不上服务器，请检查网络后重试。",
  "error.not_found": "找不到这个地址。",
  "error.internal": "服务器出错了，请稍后再试。",
  "error.unknown": "请求失败（{status}）。",
};

export const MESSAGES: Record<Lang, Record<MessageKey, string>> = { en, zh };

export const isLang = (v: unknown): v is Lang => typeof v === "string" && (LANGS as readonly string[]).includes(v);

/** The language for a browser that has not picked one: Chinese if it prefers any Chinese, else English. */
export function detectLang(preferred: readonly string[]): Lang {
  for (const tag of preferred) {
    const base = tag.toLowerCase().split("-")[0];
    if (base === "zh") return "zh";
    if (base === "en") return "en";
  }
  return "en";
}

/** The message in `lang` with each {name} replaced by `params[name]`; unknown placeholders stay as written. */
export function translate(lang: Lang, key: MessageKey, params?: Record<string, string | number>): string {
  const text = MESSAGES[lang][key];
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name: string) =>
    Object.hasOwn(params, name) ? String(params[name]) : whole,
  );
}
