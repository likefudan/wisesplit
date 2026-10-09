import { Page } from "../components";
import { useI18n } from "../i18n";

export function Home() {
  const { t } = useI18n();
  return (
    <Page title={t("home.hello")}>
      <p class="lead">{t("app.tagline")}</p>
      <p>{t("home.comingSoon")}</p>
    </Page>
  );
}
