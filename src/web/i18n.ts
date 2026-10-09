import { useEffect, useState } from "preact/hooks";
import { detectLang, isLang, type Lang, type MessageKey, translate } from "../shared/i18n";

// The chosen language lives in this browser for now; once people sign in it moves to their profile.
const KEY = "lang";

function stored(): Lang | null {
  try {
    const v = localStorage.getItem(KEY);
    return isLang(v) ? v : null;
  } catch {
    return null;
  }
}

let current: Lang = stored() ?? detectLang(navigator.languages?.length ? navigator.languages : [navigator.language]);
const listeners = new Set<(lang: Lang) => void>();

function apply(lang: Lang) {
  document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
  document.title = translate(lang, "app.name");
}
apply(current);

export function setLang(lang: Lang) {
  current = lang;
  try {
    localStorage.setItem(KEY, lang);
  } catch {
    // Private mode or blocked storage: the choice still applies until the page is closed.
  }
  apply(lang);
  listeners.forEach((l) => l(lang));
}

/** The current language and a translator for it; the component re-renders when the language changes. */
export function useI18n() {
  const [lang, setState] = useState(current);
  useEffect(() => {
    listeners.add(setState);
    // The language may have changed between the first render and this effect.
    setState(current);
    return () => void listeners.delete(setState);
  }, []);
  const t = (key: MessageKey, params?: Record<string, string | number>) => translate(lang, key, params);
  return { lang, t };
}
