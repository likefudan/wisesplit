import { useLocation, useRoute } from "preact-iso";
import { useEffect, useState } from "preact/hooks";
import type { InviteInfo } from "../../shared/groups";
import { ApiError, api } from "../api";
import { ErrorMessage, Loading, Page, useErrorText } from "../components";
import { useI18n } from "../i18n";
import { type Session, useSession } from "../session";
import { GoogleSignIn, SessionError, SignupForm } from "./Home";

/**
 * An invite link (/invite/<token>). Says which group it is for, then follows the visitor: signed
 * out (sign in with Google, coming back here), signed in but new (sign up through the link,
 * approved at once), or approved (join with one click).
 */
export function Invite() {
  const { params } = useRoute();
  const session = useSession();
  if (session.state === "loading")
    return (
      <Page>
        <Loading />
      </Page>
    );
  if (session.state === "error") return <SessionError error={session.error} />;
  return <InviteView key={params.token} token={params.token!} session={session.data} />;
}

function InviteView({ token, session }: { token: string; session: Session }) {
  const { t } = useI18n();
  const errorText = useErrorText();
  const { route } = useLocation();
  const [invite, setInvite] = useState<InviteInfo | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  // Loads the invite again, e.g. after it turned out to be used up meanwhile.
  const [reload, setReload] = useState(0);
  const path = `/api/invites/${encodeURIComponent(token)}`;
  const userId = session.user?.id;

  useEffect(() => {
    let alive = true;
    setLoadError(null);
    api<{ invite: InviteInfo }>(path)
      .then((r) => alive && setInvite(r.invite))
      .catch((e) => alive && setLoadError(e));
    return () => {
      alive = false;
    };
    // Again once signed up: they may turn out to be in the group already.
  }, [path, userId, reload]);

  const openGroup = (groupId: string) => route(`/groups/${encodeURIComponent(groupId)}`);

  async function join() {
    setBusy(true);
    setError(null);
    try {
      const { groupId } = await api<{ groupId: string }>(`${path}/accept`, {});
      openGroup(groupId);
    } catch (err) {
      setError(err);
      setBusy(false);
      // Used, withdrawn or gone meanwhile: the page says which.
      if (err instanceof ApiError && err.code.startsWith("invite_")) setReload((n) => n + 1);
    }
  }

  if (loadError !== null)
    return (
      <Page title={t("invite.title")}>
        <ErrorMessage>
          {loadError instanceof ApiError && loadError.code === "invite_not_found"
            ? t("invite.notFound")
            : errorText(loadError)}
        </ErrorMessage>
        <a href="/">{t("notFound.home")}</a>
      </Page>
    );
  if (!invite)
    return (
      <Page>
        <Loading />
      </Page>
    );

  const intro = <p class="lead">{t("invite.body", { inviter: invite.invitedBy, group: invite.groupName })}</p>;
  if (invite.memberOf)
    return (
      <Page title={t("invite.title")}>
        <p>{t("invite.joined", { group: invite.groupName })}</p>
        <button type="button" class="button" onClick={() => openGroup(invite.memberOf!)}>
          {t("invite.open")}
        </button>
      </Page>
    );
  if (invite.state !== "valid")
    return (
      <Page title={t("invite.title")}>
        {intro}
        <ErrorMessage>{t(`invite.${invite.state}`)}</ErrorMessage>
        <a href="/">{t("notFound.home")}</a>
      </Page>
    );

  const { identity, user } = session;
  return (
    <Page title={t("invite.title")}>
      {intro}
      {!identity ? (
        <>
          <p>{t("invite.signIn")}</p>
          <GoogleSignIn session={session} next={`/invite/${token}`} />
        </>
      ) : !user ? (
        <SignupForm
          session={session}
          inviteToken={token}
          onJoined={openGroup}
          onInviteGone={() => setReload((n) => n + 1)}
        />
      ) : user.status === "approved" ? (
        <>
          {error !== null && <ErrorMessage>{errorText(error)}</ErrorMessage>}
          <div class="actions">
            <button type="button" class="button" disabled={busy} onClick={join}>
              {t("invite.join")}
            </button>
          </div>
        </>
      ) : user.status === "pending" ? (
        <p>{t("invite.pending")}</p>
      ) : (
        <>
          <ErrorMessage>{t("invite.blocked")}</ErrorMessage>
          <a href="/">{t("notFound.home")}</a>
        </>
      )}
    </Page>
  );
}
