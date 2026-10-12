import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import { isMessageKey } from "../shared/i18n";
import { UNREAD_MAX } from "../shared/notifications";
import { ApiError } from "./api";
import { useI18n } from "./i18n";
import { useUnread } from "./notifications";
import { chooseLang, useSession } from "./session";
import { isStaging } from "./site";

/**
 * Every page's frame: the test-site banner, the header with the account and language switch, the
 * content, then the footer with the privacy policy and terms.
 */
export function Page({ title, children }: { title?: string; children: ComponentChildren }) {
  const { lang, t } = useI18n();
  const session = useSession();
  const user = session.state === "ok" && session.data.user?.status === "approved" ? session.data.user : null;
  const unread = useUnread(!!user);
  return (
    <>
      {isStaging && (
        <div class="staging-banner" role="status">
          {t("staging.banner")}
        </div>
      )}
      <header class="header">
        <a class="brand" href="/">
          {t("app.name")}
        </a>
        <nav class="header-actions">
          {user?.isAdmin && (
            <a class="header-link" href="/admin">
              {t("account.admin")}
            </a>
          )}
          {/* Named in the language it switches to, so either reader can find it. */}
          <button
            type="button"
            class="lang-switch"
            lang={lang === "zh" ? "en" : "zh-CN"}
            onClick={() => chooseLang(lang === "zh" ? "en" : "zh")}
          >
            {t("lang.switch")}
          </button>
          {user && <Bell unread={unread} />}
          {user && (
            <a class="avatar-link" href="/profile" aria-label={t("account.profile")} title={user.email}>
              <Avatar name={user.name} picture={user.picture} />
            </a>
          )}
        </nav>
      </header>
      <main class="page">
        {title && <h1>{title}</h1>}
        {children}
      </main>
      <footer class="footer">
        <a href="/privacy">{t("legal.privacy")}</a>
        <a href="/terms">{t("legal.terms")}</a>
      </footer>
    </>
  );
}

/** The bell in the header, with the number of unread notifications on it. */
function Bell({ unread }: { unread: number | null }) {
  const { t } = useI18n();
  const count = unread && unread > UNREAD_MAX ? `${UNREAD_MAX}+` : String(unread ?? 0);
  return (
    <a
      class="bell-link"
      href="/notifications"
      aria-label={unread ? t("notifications.bellUnread", { count }) : t("notifications.bell")}
      title={t("notifications.title")}
    >
      <svg
        width="22"
        height="22"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        aria-hidden="true"
      >
        <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" stroke-linecap="round" stroke-linejoin="round" />
        <path d="M13.73 21a2 2 0 0 1-3.46 0" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
      {!!unread && (
        <span class="bell-count" aria-hidden="true">
          {count}
        </span>
      )}
    </a>
  );
}

/** The Google profile picture, or the first letter of the name when there is none (or it fails to load). */
export function Avatar({ name, picture, size = 32 }: { name: string; picture: string | null; size?: number }) {
  const [failed, setFailed] = useState<string | null>(null);
  const style = { width: `${size}px`, height: `${size}px` };
  if (picture && picture !== failed)
    return <img class="avatar" src={picture} alt="" style={style} onError={() => setFailed(picture)} />;
  return (
    <span class="avatar avatar-initial" style={style} aria-hidden="true">
      {[...name][0]?.toUpperCase() ?? "?"}
    </span>
  );
}

/** The message to show for a failed API call, in the page's language. */
export function useErrorText() {
  const { t } = useI18n();
  return (err: unknown) => {
    if (err instanceof ApiError) {
      const key = `error.${err.code}`;
      if (isMessageKey(key)) return t(key);
      return t("error.unknown", { status: err.status });
    }
    return t("error.unknown", { status: 0 });
  };
}

export function ErrorMessage({ children }: { children: ComponentChildren }) {
  return (
    <p class="error" role="alert">
      {children}
    </p>
  );
}

export function Loading() {
  const { t } = useI18n();
  return <p class="muted">{t("common.loading")}</p>;
}
