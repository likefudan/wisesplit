import { useEffect, useState } from "preact/hooks";
import type { Settings } from "../../shared/settings";
import { api } from "../api";
import { ErrorMessage, Loading, Page, useErrorText } from "../components";
import { useI18n } from "../i18n";
import { RequireUser } from "../RequireUser";

export function AdminSettings() {
  return <RequireUser admin>{() => <SettingsForm />}</RequireUser>;
}

function SettingsForm() {
  const { t } = useI18n();
  const errorText = useErrorText();
  const [form, setForm] = useState<{ requireApproval: boolean; dailySignupCap: string; pendingCap: string } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: true } | { ok: false; error: unknown } | null>(null);

  const show = (s: Settings) =>
    setForm({
      requireApproval: s.requireApproval,
      dailySignupCap: String(s.dailySignupCap),
      pendingCap: String(s.pendingCap),
    });

  useEffect(() => {
    api<{ settings: Settings }>("/api/admin/settings")
      .then((r) => show(r.settings))
      .catch((e) => setMessage({ ok: false, error: e }));
  }, []);

  async function save(e: Event) {
    e.preventDefault();
    if (!form) return;
    setBusy(true);
    setMessage(null);
    try {
      const { settings } = await api<{ settings: Settings }>("/api/admin/settings", {
        requireApproval: form.requireApproval,
        // An empty or malformed box is sent as is, so the server's message explains it.
        dailySignupCap: form.dailySignupCap.trim() === "" ? null : Number(form.dailySignupCap),
        pendingCap: form.pendingCap.trim() === "" ? null : Number(form.pendingCap),
      });
      show(settings);
      setMessage({ ok: true });
    } catch (err) {
      setMessage({ ok: false, error: err });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Page title={t("admin.settings.title")}>
      <p>
        <a href="/admin">← {t("admin.users")}</a>
      </p>
      {!form ? (
        message && !message.ok ? (
          <ErrorMessage>{errorText(message.error)}</ErrorMessage>
        ) : (
          <Loading />
        )
      ) : (
        <form class="form" onSubmit={save}>
          <label class="field checkbox">
            <input
              type="checkbox"
              checked={form.requireApproval}
              onChange={(e) => setForm({ ...form, requireApproval: e.currentTarget.checked })}
            />
            <span>{t("admin.settings.requireApproval")}</span>
          </label>
          <small class="muted">{t("admin.settings.requireApprovalHint")}</small>
          <label class="field">
            <span>{t("admin.settings.dailyCap")}</span>
            <input
              type="number"
              inputMode="numeric"
              min={0}
              max={1000}
              value={form.dailySignupCap}
              onInput={(e) => setForm({ ...form, dailySignupCap: e.currentTarget.value })}
            />
            <small class="muted">{t("admin.settings.dailyCapHint")}</small>
          </label>
          <label class="field">
            <span>{t("admin.settings.pendingCap")}</span>
            <input
              type="number"
              inputMode="numeric"
              min={0}
              max={1000}
              value={form.pendingCap}
              onInput={(e) => setForm({ ...form, pendingCap: e.currentTarget.value })}
            />
            <small class="muted">{t("admin.settings.pendingCapHint")}</small>
          </label>
          {message &&
            (message.ok ? (
              <p class="success" role="status">
                {t("admin.settings.saved")}
              </p>
            ) : (
              <ErrorMessage>{errorText(message.error)}</ErrorMessage>
            ))}
          <div class="actions">
            <button type="submit" class="button" disabled={busy}>
              {t("admin.settings.save")}
            </button>
          </div>
        </form>
      )}
    </Page>
  );
}
