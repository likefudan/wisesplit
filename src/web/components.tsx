import type { ComponentChildren } from "preact";
import { setLang, useI18n } from "./i18n";
import { useStaging } from "./site";

/** Every page's frame: the test-site banner, the header with the language switch, then the content. */
export function Page({ title, children }: { title?: string; children: ComponentChildren }) {
  const { lang, t } = useI18n();
  const staging = useStaging();
  return (
    <>
      {staging && (
        <div class="staging-banner" role="status">
          {t("staging.banner")}
        </div>
      )}
      <header class="header">
        <a class="brand" href="/">
          {t("app.name")}
        </a>
        <button
          type="button"
          class="lang-switch"
          aria-label={t("lang.switchLabel")}
          onClick={() => setLang(lang === "zh" ? "en" : "zh")}
        >
          {t("lang.switch")}
        </button>
      </header>
      <main class="page">
        {title && <h1>{title}</h1>}
        {children}
      </main>
    </>
  );
}
