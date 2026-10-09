import { useLocation } from "preact-iso";
import { useEffect, useState } from "preact/hooks";
import { api } from "../api";
import { Avatar, ErrorMessage, Loading, Page, useErrorText } from "../components";
import { useI18n } from "../i18n";
import { RequireUser } from "../RequireUser";
import type { User, UserStatus } from "../session";

const TABS: UserStatus[] = ["pending", "approved", "rejected", "deactivated"];
type Action = "approve" | "reject" | "deactivate" | "reactivate";
/** What the admin can do to a user in each state (the server allows the same, src/worker/routes/admin.ts). */
const ACTIONS: Record<UserStatus, Action[]> = {
  pending: ["approve", "reject"],
  approved: ["deactivate"],
  rejected: ["approve"],
  deactivated: ["reactivate"],
};

type Listed = User & { appliedAt: string; decidedAt: string | null };

export function Admin() {
  return <RequireUser admin>{(me) => <UserList me={me} />}</RequireUser>;
}

function UserList({ me }: { me: User }) {
  const { lang, t } = useI18n();
  const errorText = useErrorText();
  const { query, route } = useLocation();
  const tab = TABS.includes(query.status as UserStatus) ? (query.status as UserStatus) : "pending";
  const [users, setUsers] = useState<Listed[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let alive = true;
    setUsers(null);
    setError("");
    api<{ users: Listed[]; truncated: boolean }>(`/api/admin/users?status=${tab}`)
      .then((r) => {
        if (!alive) return;
        setUsers(r.users);
        setTruncated(r.truncated);
      })
      .catch((e) => alive && setError(errorText(e)));
    return () => {
      alive = false;
    };
  }, [tab, reload]);

  async function act(user: Listed, action: Action) {
    if (action === "deactivate" && !confirm(t("admin.confirm.deactivate", { name: user.name }))) return;
    setBusy(user.id);
    setError("");
    try {
      await api(`/api/admin/users/${encodeURIComponent(user.id)}/${action}`, {});
      setUsers((list) => list?.filter((u) => u.id !== user.id) ?? null);
    } catch (e) {
      setError(errorText(e));
      setReload((n) => n + 1);
    } finally {
      setBusy(null);
    }
  }

  const date = (iso: string) =>
    new Date(iso).toLocaleString(lang === "zh" ? "zh-CN" : "en-US", { dateStyle: "medium", timeStyle: "short" });

  return (
    <Page title={t("admin.title")}>
      <p>
        <a href="/admin/settings">{t("admin.settings")}</a>
      </p>
      <div class="tabs" role="tablist" aria-label={t("admin.users")}>
        {TABS.map((s) => (
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
      {error && <ErrorMessage>{error}</ErrorMessage>}
      {users === null ? (
        !error && <Loading />
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
                <div class="muted small">{t("admin.appliedAt", { date: date(u.appliedAt) })}</div>
              </div>
              {u.id !== me.id && (
                <div class="user-actions">
                  {ACTIONS[u.status].map((a) => (
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
