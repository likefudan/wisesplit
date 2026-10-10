import { useState } from "preact/hooks";
import { LANGS, type Lang } from "../../shared/i18n";
import { api } from "../api";
import { Avatar, ErrorMessage, Page, useErrorText } from "../components";
import { useI18n } from "../i18n";
import { RequireUser } from "../RequireUser";
import { chooseLang, type User, setUser } from "../session";
import { SignOutButton } from "./Home";

export function Profile() {
  return <RequireUser>{(user) => <ProfileForm user={user} />}</RequireUser>;
}

function ProfileForm({ user }: { user: User }) {
  const { lang, t } = useI18n();
  const errorText = useErrorText();
  const [name, setName] = useState(user.name);
  const [venmo, setVenmo] = useState(user.venmo ?? "");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: true } | { ok: false; error: unknown } | null>(null);

  async function save(e: Event) {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const saved = (await api<{ user: User }>("/api/me", { name, venmo })).user;
      setUser(saved);
      setName(saved.name);
      setVenmo(saved.venmo ?? "");
      setMessage({ ok: true });
    } catch (err) {
      setMessage({ ok: false, error: err });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Page title={t("profile.title")}>
      <div class="profile-head">
        <Avatar name={user.name} picture={user.picture} size={56} />
        <div>
          <div class="profile-name">{user.name}</div>
          <div class="muted">{user.email}</div>
        </div>
      </div>
      <form class="form" onSubmit={save}>
        <label class="field">
          <span>{t("profile.name")}</span>
          <input value={name} onInput={(e) => setName(e.currentTarget.value)} required />
        </label>
        <label class="field">
          <span>{t("profile.venmo")}</span>
          <input
            value={venmo}
            onInput={(e) => setVenmo(e.currentTarget.value)}
            maxLength={31}
            autoCapitalize="off"
            autoCorrect="off"
            spellcheck={false}
            placeholder="@username"
          />
          <small class="muted">{t("profile.venmoHint")}</small>
        </label>
        <label class="field">
          <span>{t("profile.lang")}</span>
          {/* Applies and saves at once, like the switch in the header. */}
          <select value={lang} onChange={(e) => chooseLang(e.currentTarget.value as Lang)}>
            {LANGS.map((l) => (
              <option key={l} value={l}>
                {t(`lang.${l}`)}
              </option>
            ))}
          </select>
        </label>
        {message &&
          (message.ok ? (
            <p class="success" role="status">
              {t("profile.saved")}
            </p>
          ) : (
            <ErrorMessage>{errorText(message.error)}</ErrorMessage>
          ))}
        <div class="actions">
          <button type="submit" class="button" disabled={busy}>
            {t("profile.save")}
          </button>
          <SignOutButton />
        </div>
      </form>
    </Page>
  );
}
