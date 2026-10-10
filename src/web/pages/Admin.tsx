import { useLocation } from "preact-iso";
import { useEffect, useState } from "preact/hooks";
import { api } from "../api";
import { Avatar, ErrorMessage, Loading, Page, useErrorText } from "../components";
import { formatDate } from "../format";
import { useI18n } from "../i18n";
import { RequireUser } from "../RequireUser";
import { type AdminAction, actionsFor, USER_STATUSES, type UserStatus } from "../../shared/users";
import type { User } from "../session";

type Listed = User & { appliedAt: string; decidedAt: string | null; adminEmail: boolean };

export function Admin() {
  return <RequireUser admin>{(me) => <UserList me={me} />}</RequireUser>;
}

function UserList({ me }: { me: User }) {
  const { lang, t } = useI18n();
  const errorText = useErrorText();
  const { query, route } = useLocation();
  const tab = USER_STATUSES.includes(query.status as UserStatus) ? (query.status as UserStatus) : "pending";
  const [users, setUsers] = useState<Listed[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  // Loading the list and acting on a user fail separately, so a reload after a failed action
  // doesn't wipe the message saying why it failed.
  const [loadError, setLoadError] = useState<unknown>(null);
  const [actionError, setActionError] = useState<unknown>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let alive = true;
    setUsers(null);
    setLoadError(null);
    api<{ users: Listed[]; truncated: boolean }>(`/api/admin/users?status=${tab}`)
      .then((r) => {
        if (!alive) return;
        setUsers(r.users);
        setTruncated(r.truncated);
      })
      .catch((e) => alive && setLoadError(e));
    return () => {
      alive = false;
    };
  }, [tab, reload]);

  useEffect(() => setActionError(null), [tab]);

  async function act(user: Listed, action: AdminAction) {
    if (action === "deactivate" && !confirm(t("admin.confirm.deactivate", { name: user.name }))) return;
    setBusy(user.id);
    setActionError(null);
    try {
      await api(`/api/admin/users/${encodeURIComponent(user.id)}/${action}`, {});
      setUsers((list) => list?.filter((u) => u.id !== user.id) ?? null);
    } catch (e) {
      setActionError(e);
      // The list is likely out of date (another admin acted first): show it as it is now.
      setReload((n) => n + 1);
    } finally {
      setBusy(null);
    }
  }

  return (
    <Page title={t("admin.title")}>
      <p>
        <a href="/admin/settings">{t("admin.settings")}</a>
      </p>
      <div class="tabs" role="tablist" aria-label={t("admin.users")}>
        {USER_STATUSES.map((s) => (
          <button
            key={s}
            type="button"
            role="tab"
            aria-selected={s === tab}
            class={s === tab ? "tab active" : "tab"}
            onClick={() => route(s === "pending" ? "/admin" : `/admin?status=${s}`)}
          >
            {t(`admin.tab.${s}`)}
          </button>
        ))}
      </div>
      {actionError !== null && <ErrorMessage>{errorText(actionError)}</ErrorMessage>}
      {loadError !== null && <ErrorMessage>{errorText(loadError)}</ErrorMessage>}
      {users === null ? (
        loadError === null && <Loading />
      ) : users.length === 0 ? (
        <p class="muted">{t("admin.empty")}</p>
      ) : (
        <ul class="user-list">
          {users.map((u) => (
            <li key={u.id} class="user-row">
              <Avatar name={u.name} picture={u.picture} size={40} />
              <div class="user-info">
                <div>
                  {u.name} {u.id === me.id && <span class="muted">{t("admin.you")}</span>}
                </div>
                <div class="muted small">{u.email}</div>
                <div class="muted small">{t("admin.appliedAt", { date: formatDate(u.appliedAt, lang) })}</div>
              </div>
              {!u.adminEmail && (
                <div class="user-actions">
                  {actionsFor(u.status).map((a) => (
                    <button
                      key={a}
                      type="button"
                      class={a === "approve" || a === "reactivate" ? "button small" : "button small secondary"}
                      disabled={busy === u.id}
                      onClick={() => act(u, a)}
                    >
                      {t(`admin.action.${a}`)}
                    </button>
                  ))}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {users && truncated && <p class="muted small">{t("admin.truncated", { count: users.length })}</p>}
    </Page>
  );
}
