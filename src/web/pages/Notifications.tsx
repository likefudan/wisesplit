import { useEffect, useRef, useState } from "preact/hooks";
import {
  type AppNotification,
  type NotificationPage,
  type NotificationSettings,
  notificationText,
} from "../../shared/notifications";
import { api } from "../api";
import { ErrorMessage, Loading, Page, useErrorText } from "../components";
import { formatDate } from "../format";
import { useI18n } from "../i18n";
import { setUnread } from "../notifications";
import { checkPush, PushDenied, pushSupport, testPush, turnOffPush, turnOnPush } from "../push";
import { RequireUser } from "../RequireUser";
import type { User } from "../session";

export function Notifications() {
  return <RequireUser>{(me) => <NotificationList me={me} />}</RequireUser>;
}

/** The signed-in user's notifications, newest first, a page at a time. */
function NotificationList({ me }: { me: User }) {
  const { t } = useI18n();
  const errorText = useErrorText();
  const [list, setList] = useState<{ notifications: AppNotification[]; next: string | null } | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const [unread, setUnreadHere] = useState(0);
  const [busy, setBusy] = useState(false);
  // What failed: loading the first page (before null) or the one after `before`, or marking read.
  const [failed, setFailed] = useState<{ error: unknown; before?: string | null } | null>(null);
  // An older page asked for before "mark all as read" reloaded the list is dropped.
  const round = useRef(0);

  async function load(before: string | null) {
    const mine = before ? round.current : ++round.current;
    setBusy(true);
    setFailed(null);
    try {
      const page = await api<NotificationPage>(
        before ? `/api/notifications?before=${encodeURIComponent(before)}` : "/api/notifications",
      );
      if (mine !== round.current) return;
      setNames((known) => ({ ...known, ...page.names }));
      setList((shown) =>
        before
          ? { notifications: [...(shown?.notifications ?? []), ...page.notifications], next: page.next }
          : { notifications: page.notifications, next: page.next },
      );
      setUnreadHere(page.unread);
      setUnread(page.unread);
    } catch (error) {
      if (mine === round.current) setFailed({ error, before });
    } finally {
      if (mine === round.current) setBusy(false);
    }
  }

  useEffect(() => {
    load(null);
  }, []);

  function markShown(id: string | null) {
    setList(
      (shown) =>
        shown && {
          ...shown,
          notifications: shown.notifications.map((n) => (id === null || n.id === id ? { ...n, read: true } : n)),
        },
    );
  }

  // Opening one marks it read; the page it leads to opens at once, without waiting for that.
  function open(n: AppNotification) {
    if (n.read) return;
    markShown(n.id);
    const left = Math.max(0, unread - 1);
    setUnreadHere(left);
    setUnread(left);
    api(`/api/notifications/${encodeURIComponent(n.id)}/read`, {}).catch(() => {
      // It stays unread on the server and shows so next time.
    });
  }

  async function readAll() {
    setBusy(true);
    setFailed(null);
    try {
      await api("/api/notifications/read-all", {});
      markShown(null);
      setUnreadHere(0);
      setUnread(0);
    } catch (error) {
      setFailed({ error });
    } finally {
      setBusy(false);
    }
  }

  const notifications = list?.notifications ?? null;
  const next = list?.next ?? null;

  return (
    <Page title={t("notifications.title")}>
      <div class="actions notification-tools">
        {unread > 0 && (
          <button type="button" class="button secondary small" disabled={busy} onClick={readAll}>
            {t("notifications.readAll")}
          </button>
        )}
        <a href="/notifications/settings">{t("notifications.settings")}</a>
      </div>
      {notifications === null ? (
        failed === null && <Loading />
      ) : notifications.length === 0 ? (
        <p class="muted">{t("notifications.empty")}</p>
      ) : (
        <ul class="notification-list">
          {notifications.map((n) => (
            <li key={n.id}>
              <NotificationRow notification={n} names={names} me={me} onOpen={() => open(n)} />
            </li>
          ))}
        </ul>
      )}
      {failed !== null && (
        <>
          <ErrorMessage>{errorText(failed.error)}</ErrorMessage>
          {failed.before !== undefined && (
            <button type="button" class="button secondary" disabled={busy} onClick={() => load(failed.before!)}>
              {t("common.retry")}
            </button>
          )}
        </>
      )}
      {failed === null && next && (
        <div class="actions list-more">
          <button type="button" class="button secondary" disabled={busy} onClick={() => load(next)}>
            {t("notifications.more")}
          </button>
        </div>
      )}
    </Page>
  );
}

function NotificationRow({
  notification: n,
  names,
  me,
  onOpen,
}: {
  notification: AppNotification;
  names: Record<string, string>;
  me: User;
  onOpen: () => void;
}) {
  const { lang, t } = useI18n();
  const name = (id: string | null | undefined) =>
    id === me.id ? t("notifications.you") : (id && names[id]) || t("activity.someone");
  const said = notificationText(n, lang, name);
  // A rejection never shows here (only approved users see the bell), nor anything newer than this page.
  if (!said) return null;
  const { text, detail } = said;
  const href = n.group ? `/groups/${encodeURIComponent(n.group.id)}` : "/";
  return (
    <a class={n.read ? "notification" : "notification unread"} href={href} onClick={onOpen}>
      {n.group && <span class="muted small">{n.group.name}</span>}
      <span class="notification-text">
        {!n.read && <span class="visually-hidden">{t("notifications.unread")}: </span>}
        {text}
      </span>
      {detail && <span class="small">{detail}</span>}
      <span class="muted small">{formatDate(n.createdAt, lang)}</span>
    </a>
  );
}

export function NotificationSettingsPage() {
  return <RequireUser>{() => <SettingsForm />}</RequireUser>;
}

/** How to hear about things: on the site, and by push in this browser. */
function SettingsForm() {
  const { t } = useI18n();
  const errorText = useErrorText();
  const [settings, setSettings] = useState<NotificationSettings | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: true } | { ok: false; error: unknown } | null>(null);

  useEffect(() => {
    let alive = true;
    setMessage(null);
    api<{ settings: NotificationSettings }>("/api/notifications/settings")
      .then((r) => alive && setSettings(r.settings))
      .catch((e) => alive && setMessage({ ok: false, error: e }));
    return () => {
      alive = false;
    };
  }, [attempt]);

  // Each switch saves as soon as it is flipped.
  async function save(change: Partial<NotificationSettings>) {
    setBusy(true);
    setMessage(null);
    try {
      setSettings((await api<{ settings: NotificationSettings }>("/api/notifications/settings", change)).settings);
      setMessage({ ok: true });
    } catch (err) {
      setMessage({ ok: false, error: err });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Page title={t("notifySettings.title")}>
      <p>
        <a href="/notifications">← {t("notifications.title")}</a>
      </p>
      {!settings ? (
        message && !message.ok ? (
          <>
            <ErrorMessage>{errorText(message.error)}</ErrorMessage>
            <button type="button" class="button" onClick={() => setAttempt((n) => n + 1)}>
              {t("common.retry")}
            </button>
          </>
        ) : (
          <Loading />
        )
      ) : (
        <div class="form">
          <label class="field checkbox">
            <input
              type="checkbox"
              checked={settings.inApp}
              disabled={busy}
              onChange={(e) => save({ inApp: e.currentTarget.checked })}
            />
            <span>{t("notifySettings.inApp")}</span>
          </label>
          <small class="muted">{t("notifySettings.inAppHint")}</small>
          <PushSetting />
          {message &&
            (message.ok ? (
              <p class="success" role="status">
                {t("notifySettings.saved")}
              </p>
            ) : (
              <ErrorMessage>{errorText(message.error)}</ErrorMessage>
            ))}
        </div>
      )}
    </Page>
  );
}

/**
 * Push in this browser: a switch, or why there is none (not set up, not supported, or on an
 * iPhone outside the Home Screen). On and off are per browser, so this reads the browser itself.
 */
function PushSetting() {
  const { t } = useI18n();
  const errorText = useErrorText();
  const support = pushSupport();
  // undefined while loading; null when the site has no key (push not set up).
  const [publicKey, setPublicKey] = useState<string | null | undefined>(undefined);
  const [on, setOn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<
    { kind: "denied" | "testSent" | "testFailed" } | { kind: "error"; error: unknown } | null
  >(null);

  useEffect(() => {
    if (support !== "ok") return;
    let alive = true;
    api<{ publicKey: string | null }>("/api/push")
      .then(async ({ publicKey }) => {
        const enabled = publicKey ? await checkPush(publicKey) : false;
        if (!alive) return;
        setPublicKey(publicKey);
        setOn(enabled);
      })
      .catch((error) => {
        if (!alive) return;
        setPublicKey(null);
        setMessage({ kind: "error", error });
      });
    return () => {
      alive = false;
    };
  }, []);

  async function flip(next: boolean) {
    if (!publicKey) return;
    setBusy(true);
    setMessage(null);
    try {
      if (next) await turnOnPush(publicKey);
      else await turnOffPush();
      setOn(next);
    } catch (error) {
      setMessage(error instanceof PushDenied ? { kind: "denied" } : { kind: "error", error });
      // Off in the browser after a failed "off" (it unsubscribes first), and after a failed "on".
      setOn(false);
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    setBusy(true);
    setMessage(null);
    try {
      const result = await testPush();
      if (result === "gone") setOn(false);
      setMessage({ kind: result === "sent" ? "testSent" : "testFailed" });
    } catch (error) {
      setMessage({ kind: "error", error });
    } finally {
      setBusy(false);
    }
  }

  if (support !== "ok")
    return (
      <p class="muted">{t(support === "ios-install" ? "notifySettings.pushIos" : "notifySettings.pushUnsupported")}</p>
    );
  if (publicKey === undefined) return <Loading />;
  if (publicKey === null && message === null) return <p class="muted">{t("notifySettings.pushNotConfigured")}</p>;
  return (
    <>
      {publicKey && (
        <>
          <label class="field checkbox">
            <input type="checkbox" checked={on} disabled={busy} onChange={(e) => flip(e.currentTarget.checked)} />
            <span>{t("notifySettings.push")}</span>
          </label>
          <small class="muted">{t("notifySettings.pushHint")}</small>
          {on && (
            <div class="actions">
              <button type="button" class="button secondary small" disabled={busy} onClick={test}>
                {t("notifySettings.pushTest")}
              </button>
            </div>
          )}
        </>
      )}
      {message?.kind === "denied" && <ErrorMessage>{t("notifySettings.pushDenied")}</ErrorMessage>}
      {message?.kind === "testSent" && (
        <p class="success" role="status">
          {t("notifySettings.pushTestSent")}
        </p>
      )}
      {message?.kind === "testFailed" && <ErrorMessage>{t("notifySettings.pushTestFailed")}</ErrorMessage>}
      {message?.kind === "error" && <ErrorMessage>{errorText(message.error)}</ErrorMessage>}
    </>
  );
}
