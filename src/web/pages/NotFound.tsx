import { Page } from "../components";
import { useI18n } from "../i18n";

export function NotFound() {
  const { t } = useI18n();
  return (
    <Page title={t("notFound.title")}>
      <p>{t("notFound.body")}</p>
      <a class="button" href="/">
        {t("notFound.home")}
      </a>
    </Page>
  );
}
