import { useLocation } from "preact-iso";
import { useState } from "preact/hooks";
import { isMessageKey } from "../../shared/i18n";
import { ApiError, api } from "../api";
import { ErrorMessage, Loading, Page, useErrorText } from "../components";
import { useI18n } from "../i18n";
import { refreshSession, type Session, type User, setUser, signOut, useSession } from "../session";
import { Turnstile } from "../turnstile";
import { GroupList } from "./Groups";

/**
 * The front page, which follows where the visitor is: signed out, signed in with Google but not
 * signed up, waiting for approval, rejected, deactivated, or a member. /login is the same page,
 * showing why a Google sign-in did not work.
 */
export function Home() {
  const { t } = useI18n();
  const session = useSession();
  if (session.state === "loading")
    return (
      <Page>
        <Loading />
      </Page>
    );
  if (session.state === "error") return <SessionError error={session.error} />;
  const { identity, user } = session.data;
  if (!identity) return <SignedOut session={session.data} />;
  if (!user)
    return (
      <Page title={t("signup.title")}>
        <LoginErrorNote />
        <SignupForm session={session.data} />
      </Page>
    );
  switch (user.status) {
    case "pending":
      return (
        <Page title={t("status.pending.title")}>
          <LoginErrorNote />
          <p>{t("status.pending.body", { name: user.name })}</p>
          <SignOutButton />
        </Page>
      );
    case "rejected":
      return (
        <Page title={t("status.rejected.title")}>
          <LoginErrorNote />
          <p>{t("status.rejected.body")}</p>
          <SignupForm session={session.data} again />
        </Page>
      );
    case "deactivated":
      return (
        <Page title={t("status.deactivated.title")}>
          <LoginErrorNote />
          <p>{t("status.deactivated.body")}</p>
          <SignOutButton />
        </Page>
      );
    case "approved":
      return (
        <Page title={t("home.welcome", { name: user.name })}>
          <LoginErrorNote />
          <GroupList />
        </Page>
      );
  }
}

/** The welcome page with the Google button; `next` is where to come back to after signing in. */
export function SignedOut({ session, next }: { session: Session; next?: string }) {
  const { t } = useI18n();
  const { query } = useLocation();
  // Back from a failed Google sign-in: try again towards the page it started from.
  next ??= query.next;
  return (
    <Page title={t("home.hello")}>
      <p class="lead">{t("app.tagline")}</p>
      <p>{t("home.signedOut")}</p>
      <LoginErrorNote />
      <GoogleSignIn session={session} next={next} />
    </Page>
  );
}

/** The Google sign-in button; `next` is where to come back to afterwards. */
export function GoogleSignIn({ session, next }: { session: Session; next?: string }) {
  const { t } = useI18n();
  const href = `/api/auth/google${next ? `?next=${encodeURIComponent(next)}` : ""}`;
  return session.googleEnabled ? (
    // target="_top": a real page load to the Worker, not a route inside this app.
    <a class="button" href={href} target="_top">
      {t("login.google")}
    </a>
  ) : (
    <p class="muted">{t("login.error.not_configured")}</p>
  );
}

/**
 * Why a Google sign-in did not work (/login?error=…). Shown on every version of the page: a
 * browser still signed in to another account sees it too, and stays signed in to that one.
 */
function LoginErrorNote() {
  const { t } = useI18n();
  const { query } = useLocation();
  if (!query.error) return null;
  const key = `login.error.${query.error}`;
  return <ErrorMessage>{isMessageKey(key) ? t(key) : t("login.error.failed")}</ErrorMessage>;
}

/**
 * Signing up, or applying again after a rejection. With `inviteToken` the sign-up goes through
 * that invite link, and `onJoined` gets the group the new user is now in.
 */
export function SignupForm({
  session,
  again,
  inviteToken,
  onJoined,
}: {
  session: Session;
  again?: boolean;
  inviteToken?: string;
  onJoined?: (groupId: string) => void;
}) {
  const { lang, t } = useI18n();
  const errorText = useErrorText();
  const [name, setName] = useState(session.user?.name ?? session.identity?.name ?? "");
  const [token, setToken] = useState("");
  const [resetKey, setResetKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const needsTurnstile = !!session.turnstileSiteKey;

  async function submit(e: Event) {
    e.preventDefault();
    if (needsTurnstile && !token) {
      setError(t("signup.turnstileNeeded"));
      return;
    }
    setBusy(true);
    setError("");
    try {
      const { user, groupId } = await api<{ user: User; groupId?: string }>("/api/auth/register", {
        name,
        lang,
        turnstileToken: token,
        ...(inviteToken === undefined ? {} : { inviteToken }),
      });
      setUser(user);
      if (groupId) onJoined?.(groupId);
    } catch (err) {
      setError(errorText(err));
      // A Turnstile answer works only once.
      setResetKey((k) => k + 1);
      // Signed up meanwhile (another tab, or the admin approved a rejected applicant): show where it stands.
      if (err instanceof ApiError && err.code === "already_registered") refreshSession();
    } finally {
      setBusy(false);
    }
  }

  return (
    <form class="form" onSubmit={submit}>
      {!again && <p>{t("signup.intro", { email: session.identity?.email ?? "" })}</p>}
      <label class="field">
        <span>{t("signup.name")}</span>
        <input value={name} onInput={(e) => setName(e.currentTarget.value)} required autoComplete="name" />
      </label>
      {needsTurnstile && <Turnstile siteKey={session.turnstileSiteKey!} onToken={setToken} resetKey={resetKey} />}
      {error && <ErrorMessage>{error}</ErrorMessage>}
      <div class="actions">
        <button type="submit" class="button" disabled={busy}>
          {again ? t("status.rejected.again") : t("signup.submit")}
        </button>
        <button type="button" class="button secondary" onClick={() => signOut()}>
          {t("signup.otherAccount")}
        </button>
      </div>
    </form>
  );
}

/** The session could not be loaded (offline, server error): say so, with a way to try again. */
export function SessionError({ error }: { error: unknown }) {
  const { t } = useI18n();
  const errorText = useErrorText();
  return (
    <Page>
      <ErrorMessage>{errorText(error)}</ErrorMessage>
      <button type="button" class="button" onClick={() => refreshSession()}>
        {t("common.retry")}
      </button>
    </Page>
  );
}

export function SignOutButton() {
  const { t } = useI18n();
  return (
    <button type="button" class="button secondary" onClick={() => signOut()}>
      {t("account.signOut")}
    </button>
  );
}
