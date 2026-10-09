import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import { isMessageKey, type Lang } from "../shared/i18n";
import { ApiError, api } from "./api";
import { setLang, useI18n } from "./i18n";
import { type User, setUser, useSession } from "./session";
import { isStaging } from "./site";

/** Every page's frame: the test-site banner, the header with the account and language switch, then the content. */
export function Page({ title, children }: { title?: string; children: ComponentChildren }) {
  const { lang, t } = useI18n();
  const session = useSession();
  const user = session.state === "ok" && session.data.user?.status === "approved" ? session.data.user : null;
  async function switchLang(next: Lang) {
    setLang(next);
    // Signed-in users keep the choice in their profile, so it follows them to other devices.
    if (user) {
      try {
        setUser((await api<{ user: User }>("/api/me", { lang: next })).user);
      } catch {
        // The page has switched anyway; the profile keeps the old one until the next change.
      }
    }
  }
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
            onClick={() => switchLang(lang === "zh" ? "en" : "zh")}
          >
            {t("lang.switch")}
          </button>
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
    </>
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
