import { useLocation, useRoute } from "preact-iso";
import { useEffect, useState } from "preact/hooks";
import { CURRENCY_CODES, type Currency } from "../../shared/currencies";
import type { GroupDetail, GroupMember, GroupSummary } from "../../shared/groups";
import { api } from "../api";
import { Avatar, ErrorMessage, Loading, Page, useErrorText } from "../components";
import { currencyLabel, formatDate } from "../format";
import { useI18n } from "../i18n";
import { RequireUser } from "../RequireUser";
import type { User } from "../session";

/** The signed-in user's groups, on the front page. */
export function GroupList() {
  const { t } = useI18n();
  const errorText = useErrorText();
  const [groups, setGroups] = useState<GroupSummary[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let alive = true;
    setError(null);
    api<{ groups: GroupSummary[] }>("/api/groups")
      .then((r) => alive && setGroups(r.groups))
      .catch((e) => alive && setError(e));
    return () => {
      alive = false;
    };
  }, [reload]);

  return (
    <section>
      <div class="section-head">
        <h2>{t("groups.title")}</h2>
        <a class="button small" href="/groups/new">
          {t("groups.new")}
        </a>
      </div>
      {error !== null ? (
        <>
          <ErrorMessage>{errorText(error)}</ErrorMessage>
          <button type="button" class="button secondary" onClick={() => setReload((n) => n + 1)}>
            {t("common.retry")}
          </button>
        </>
      ) : groups === null ? (
        <Loading />
      ) : groups.length === 0 ? (
        <p class="muted">{t("groups.empty")}</p>
      ) : (
        <ul class="card-list">
          {groups.map((g) => (
            <li key={g.id}>
              <a class="card" href={`/groups/${encodeURIComponent(g.id)}`}>
                <span class="card-title">{g.name}</span>
                <span class="muted small">
                  {g.currency} ·{" "}
                  {g.memberCount === 1 ? t("groups.oneMember") : t("groups.members", { count: g.memberCount })}
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function NewGroup() {
  return <RequireUser>{() => <NewGroupForm />}</RequireUser>;
}

function NewGroupForm() {
  const { lang, t } = useI18n();
  const errorText = useErrorText();
  const { route } = useLocation();
  const [name, setName] = useState("");
  const [currency, setCurrency] = useState<Currency>("USD");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function submit(e: Event) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { group } = await api<{ group: GroupDetail }>("/api/groups", { name, currency });
      route(`/groups/${encodeURIComponent(group.id)}`, true);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <Page title={t("groupNew.title")}>
      <form class="form" onSubmit={submit}>
        <label class="field">
          <span>{t("groupNew.name")}</span>
          <input value={name} onInput={(e) => setName(e.currentTarget.value)} required />
        </label>
        <label class="field">
          <span>{t("groupNew.currency")}</span>
          <select value={currency} onChange={(e) => setCurrency(e.currentTarget.value as Currency)}>
            {CURRENCY_CODES.map((c) => (
              <option key={c} value={c}>
                {currencyLabel(c, lang)}
              </option>
            ))}
          </select>
          <small class="muted">{t("groupNew.currencyHint")}</small>
        </label>
        {error !== null && <ErrorMessage>{errorText(error)}</ErrorMessage>}
        <div class="actions">
          <button type="submit" class="button" disabled={busy}>
            {t("groupNew.submit")}
          </button>
        </div>
      </form>
    </Page>
  );
}

export function GroupPage() {
  const { params } = useRoute();
  return <RequireUser>{(me) => <GroupView key={params.id} id={params.id!} me={me} />}</RequireUser>;
}

function GroupView({ id, me }: { id: string; me: User }) {
  const { lang, t } = useI18n();
  const errorText = useErrorText();
  const { route } = useLocation();
  const [group, setGroup] = useState<GroupDetail | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  // Removing a member, leaving or deleting: what failed, shown next to the member list.
  const [actionError, setActionError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    api<{ group: GroupDetail }>(`/api/groups/${encodeURIComponent(id)}`)
      .then((r) => alive && setGroup(r.group))
      .catch((e) => alive && setLoadError(e));
    return () => {
      alive = false;
    };
  }, [id]);

  if (loadError !== null)
    return (
      <Page>
        <ErrorMessage>{errorText(loadError)}</ErrorMessage>
        <a href="/">{t("notFound.home")}</a>
      </Page>
    );
  if (!group)
    return (
      <Page>
        <Loading />
      </Page>
    );

  const isOwner = group.ownerId === me.id;
  const path = `/api/groups/${encodeURIComponent(group.id)}`;

  async function act(confirmText: string, run: () => Promise<void>) {
    if (!confirm(confirmText)) return;
    setBusy(true);
    setActionError(null);
    try {
      await run();
    } catch (err) {
      setActionError(err);
      // The list may be out of date (someone left meanwhile): show it as it is now.
      api<{ group: GroupDetail }>(path)
        .then((r) => setGroup(r.group))
        .catch(() => {});
    } finally {
      setBusy(false);
    }
  }

  const remove = (m: GroupMember) =>
    act(t("group.confirm.remove", { name: m.name }), async () => {
      const r = await api<{ group: GroupDetail }>(`${path}/members/${encodeURIComponent(m.id)}/remove`, {});
      setGroup(r.group);
    });
  const leave = () =>
    act(t("group.confirm.leave", { name: group.name }), async () => {
      await api(`${path}/leave`, {});
      route("/", true);
    });
  const del = () =>
    act(t("group.confirm.delete", { name: group.name }), async () => {
      await api(`${path}/delete`, {});
      route("/", true);
    });

  return (
    <Page title={group.name}>
      <p class="muted">{t("group.currency", { currency: currencyLabel(group.currency, lang) })}</p>

      <section>
        <h2>{t("group.expenses")}</h2>
        <p class="muted">{t("group.expensesSoon")}</p>
      </section>

      <section>
        <h2>
          {t("group.members")} ({group.members.length})
        </h2>
        {actionError !== null && <ErrorMessage>{errorText(actionError)}</ErrorMessage>}
        <ul class="user-list">
          {group.members.map((m) => (
            <li key={m.id} class="user-row">
              <Avatar name={m.name} picture={m.picture} size={40} />
              <div class="user-info">
                <div>
                  {m.name}{" "}
                  {[
                    m.id === group.ownerId && t("group.owner"),
                    m.id === me.id && t("group.you"),
                    m.deactivated && t("group.deactivated"),
                  ]
                    .filter(Boolean)
                    .map((label) => (
                      <span key={label as string} class="badge">
                        {label}
                      </span>
                    ))}
                </div>
              </div>
              {isOwner && m.id !== me.id && (
                <div class="user-actions">
                  <button type="button" class="button small secondary" disabled={busy} onClick={() => remove(m)}>
                    {t("group.remove")}
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      </section>

      <AddMember path={path} onAdded={setGroup} />
      <InviteLink path={path} />

      <section>
        {isOwner ? (
          <>
            <p class="muted small">{t("group.ownerStays")}</p>
            <button type="button" class="button danger" disabled={busy} onClick={del}>
              {t("group.delete")}
            </button>
          </>
        ) : (
          <button type="button" class="button secondary" disabled={busy} onClick={leave}>
            {t("group.leave")}
          </button>
        )}
      </section>
    </Page>
  );
}

function AddMember({ path, onAdded }: { path: string; onAdded: (group: GroupDetail) => void }) {
  const { t } = useI18n();
  const errorText = useErrorText();
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: true; name: string } | { ok: false; error: unknown } | null>(null);

  async function submit(e: Event) {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const { group, added } = await api<{ group: GroupDetail; added: string }>(`${path}/members`, { email });
      onAdded(group);
      setMessage({ ok: true, name: group.members.find((m) => m.id === added)?.name ?? email.trim() });
      setEmail("");
    } catch (err) {
      setMessage({ ok: false, error: err });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h2>{t("group.add.title")}</h2>
      <form class="form" onSubmit={submit}>
        <label class="field">
          <span>{t("group.add.email")}</span>
          <input
            type="email"
            value={email}
            onInput={(e) => setEmail(e.currentTarget.value)}
            required
            autoCapitalize="off"
            autoCorrect="off"
            spellcheck={false}
          />
          <small class="muted">{t("group.add.hint")}</small>
        </label>
        {message &&
          (message.ok ? (
            <p class="success" role="status">
              {t("group.add.done", { name: message.name })}
            </p>
          ) : (
            <ErrorMessage>{errorText(message.error)}</ErrorMessage>
          ))}
        <div class="actions">
          <button type="submit" class="button" disabled={busy}>
            {t("group.add.submit")}
          </button>
        </div>
      </form>
    </section>
  );
}

function InviteLink({ path }: { path: string }) {
  const { lang, t } = useI18n();
  const errorText = useErrorText();
  const [link, setLink] = useState<{ url: string; expiresAt: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function create() {
    setBusy(true);
    setError(null);
    setCopied(false);
    try {
      const r = await api<{ token: string; expiresAt: string }>(`${path}/invites`, {});
      setLink({ url: `${location.origin}/invite/${r.token}`, expiresAt: r.expiresAt });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link.url);
      setCopied(true);
    } catch {
      // No clipboard access: the link is selected in its box for copying by hand.
      (document.getElementById("invite-link") as HTMLInputElement | null)?.select();
    }
  }

  return (
    <section>
      <h2>{t("group.invite.title")}</h2>
      {link ? (
        <div class="form">
          <label class="field">
            <span>{t("group.invite.label")}</span>
            <input id="invite-link" readOnly value={link.url} onFocus={(e) => e.currentTarget.select()} />
            <small class="muted">{t("group.invite.hint", { date: formatDate(link.expiresAt, lang) })}</small>
          </label>
          <div class="actions">
            <button type="button" class="button" onClick={copy}>
              {t("group.invite.copy")}
            </button>
            <button type="button" class="button secondary" disabled={busy} onClick={create}>
              {t("group.invite.create")}
            </button>
          </div>
          {copied && (
            <p class="success" role="status">
              {t("group.invite.copied")}
            </p>
          )}
        </div>
      ) : (
        <>
          <p class="muted">{t("group.invite.about")}</p>
          <button type="button" class="button secondary" disabled={busy} onClick={create}>
            {t("group.invite.create")}
          </button>
        </>
      )}
      {error !== null && <ErrorMessage>{errorText(error)}</ErrorMessage>}
    </section>
  );
}
