import { useLocation, useRoute } from "preact-iso";
import { useEffect, useState } from "preact/hooks";
import type { GroupDetail } from "../../shared/groups";
import { amountInput, formatAmount, parseAmount } from "../../shared/money";
import {
  type Payment,
  type PaymentList,
  type PaymentMethod,
  type Transfer,
  venmoLink,
  venmoNote,
} from "../../shared/settlements";
import { api } from "../api";
import { ErrorMessage, Loading, Page, useErrorText } from "../components";
import { formatDate } from "../format";
import { useI18n } from "../i18n";
import { RequireUser } from "../RequireUser";
import type { User } from "../session";

function payPath(group: GroupDetail, query: Record<string, string>) {
  const search = new URLSearchParams(query).toString();
  return `/groups/${encodeURIComponent(group.id)}/pay${search ? `?${search}` : ""}`;
}

const isDeactivated = (group: GroupDetail, userId: string) =>
  group.members.some((m) => m.id === userId && m.deactivated);

/** The payments that would settle the group, under the balances; yours come with a button to pay. */
export function Suggestions({ group, me, suggestions }: { group: GroupDetail; me: User; suggestions: Transfer[] }) {
  const { lang, t } = useI18n();
  if (suggestions.length === 0) return null;
  return (
    <>
      <h3 class="subhead">{t("settle.suggested")}</h3>
      <ul class="balance-list">
        {suggestions.map((s) => {
          const amount = formatAmount(s.amount, group.currency, lang);
          // Paid by you; or by someone deactivated, who can't record it, to you.
          const link =
            s.fromId === me.id
              ? payPath(group, { to: s.toId, amount: String(s.amount) })
              : s.toId === me.id && isDeactivated(group, s.fromId)
                ? payPath(group, { from: s.fromId, amount: String(s.amount) })
                : null;
          return (
            <li key={`${s.fromId}-${s.toId}`} class="suggestion-row">
              <span>{t("settle.pays", { from: s.fromName, to: s.toName, amount })}</span>
              {link && (
                <a class="button small" href={link}>
                  {s.fromId === me.id ? t("settle.pay") : t("settle.recordReceived")}
                </a>
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}

/** Payments awaiting confirmation, with what you can do about them, then the latest finished ones. */
export function Payments({
  group,
  me,
  version,
  onChange,
}: {
  group: GroupDetail;
  me: User;
  /** Changes when the balances were reloaded for another reason, so this list follows. */
  version: number;
  /** A payment was confirmed, declined or withdrawn. */
  onChange: () => void;
}) {
  const { t } = useI18n();
  const errorText = useErrorText();
  const [list, setList] = useState<PaymentList | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  // Confirming, declining or withdrawing: what failed.
  const [actionError, setActionError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const path = `/api/groups/${encodeURIComponent(group.id)}/payments`;

  useEffect(() => {
    let alive = true;
    api<PaymentList>(path)
      .then((r) => {
        if (!alive) return;
        setList(r);
        setLoadError(null);
      })
      .catch((e) => alive && setLoadError(e));
    return () => {
      alive = false;
    };
  }, [path, version, reload]);

  async function decide(p: Payment, action: "confirm" | "decline" | "withdraw") {
    if (action === "decline" && !confirm(t("payment.confirm.decline", { name: p.fromName }))) return;
    if (action === "withdraw" && !confirm(t("payment.confirm.withdraw"))) return;
    setBusy(true);
    setActionError(null);
    try {
      await api(`${path}/${encodeURIComponent(p.id)}/${action}`, {});
    } catch (err) {
      setActionError(err);
    } finally {
      setBusy(false);
      // Whatever happened, show it and the balances as they now are: someone may have acted on it
      // meanwhile.
      onChange();
    }
  }

  return (
    <section>
      <div class="section-head">
        <h2>{t("group.payments")}</h2>
        <a class="button small secondary" href={payPath(group, {})}>
          {t("group.recordPayment")}
        </a>
      </div>
      {actionError !== null && <ErrorMessage>{errorText(actionError)}</ErrorMessage>}
      {loadError !== null && (
        <>
          <ErrorMessage>{errorText(loadError)}</ErrorMessage>
          <button type="button" class="button secondary" onClick={() => setReload((n) => n + 1)}>
            {t("common.retry")}
          </button>
        </>
      )}
      {list === null ? (
        loadError === null && <Loading />
      ) : list.pending.length === 0 && list.recent.length === 0 ? (
        <p class="muted">{t("group.paymentsEmpty")}</p>
      ) : (
        <>
          {list.pending.length > 0 && (
            <>
              <h3 class="subhead">{t("payment.pending")}</h3>
              <ul class="card-list">
                {list.pending.map((p) => (
                  <PendingPayment key={p.id} payment={p} group={group} me={me} busy={busy} decide={decide} />
                ))}
              </ul>
            </>
          )}
          {list.recent.length > 0 && (
            <>
              <h3 class="subhead">{t("payment.recent")}</h3>
              <ul class="card-list">
                {list.recent.map((p) => (
                  <PaymentRow key={p.id} payment={p} group={group} />
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </section>
  );
}

function PaymentLine({ payment: p, group }: { payment: Payment; group: GroupDetail }) {
  const { lang, t } = useI18n();
  return (
    <span class="expense-main">
      <span class="card-title">
        {t("payment.paid", { from: p.fromName, to: p.toName, amount: formatAmount(p.amount, group.currency, lang) })}
      </span>
      <span class="muted small">
        {formatDate(p.createdAt, lang)} · {p.method === "venmo" ? t("payment.method.venmo") : t("payment.method.other")}
      </span>
    </span>
  );
}

function PendingPayment({
  payment: p,
  group,
  me,
  busy,
  decide,
}: {
  payment: Payment;
  group: GroupDetail;
  me: User;
  busy: boolean;
  decide: (p: Payment, action: "confirm" | "decline" | "withdraw") => void;
}) {
  const { t } = useI18n();
  const payeeGone = isDeactivated(group, p.toId);
  return (
    <li class="card">
      <PaymentLine payment={p} group={group} />
      <span class="small warning">
        {p.toId === me.id
          ? t("payment.waitingForYou")
          : payeeGone
            ? t("payment.payeeDeactivated", { name: p.toName })
            : t("payment.waitingFor", { name: p.toName })}
      </span>
      {(p.toId === me.id || p.fromId === me.id) && (
        <div class="actions payment-actions">
          {(p.toId === me.id || payeeGone) && (
            <button type="button" class="button small" disabled={busy} onClick={() => decide(p, "confirm")}>
              {p.toId === me.id ? t("payment.received") : t("payment.confirmForThem")}
            </button>
          )}
          {p.toId === me.id && (
            <button type="button" class="button small secondary" disabled={busy} onClick={() => decide(p, "decline")}>
              {t("payment.decline")}
            </button>
          )}
          {p.fromId === me.id && (
            <button type="button" class="button small secondary" disabled={busy} onClick={() => decide(p, "withdraw")}>
              {t("payment.withdraw")}
            </button>
          )}
        </div>
      )}
    </li>
  );
}

function PaymentRow({ payment: p, group }: { payment: Payment; group: GroupDetail }) {
  const { t } = useI18n();
  const [label, cls] =
    p.status === "confirmed"
      ? [t("payment.status.confirmed"), "success"]
      : p.status === "declined"
        ? [t("payment.status.declined"), "error"]
        : [t("payment.status.withdrawn"), "muted"];
  return (
    <li class="card payment-row">
      <PaymentLine payment={p} group={group} />
      <span class={`expense-status small ${cls}`}>{label}</span>
    </li>
  );
}

export function NewPayment() {
  const { params } = useRoute();
  return <RequireUser>{(me) => <NewPaymentLoader key={params.id} id={params.id!} me={me} />}</RequireUser>;
}

function NewPaymentLoader({ id, me }: { id: string; me: User }) {
  const { t } = useI18n();
  const errorText = useErrorText();
  const [group, setGroup] = useState<GroupDetail | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let alive = true;
    api<{ group: GroupDetail }>(`/api/groups/${encodeURIComponent(id)}`)
      .then((r) => alive && setGroup(r.group))
      .catch((e) => alive && setError(e));
    return () => {
      alive = false;
    };
  }, [id]);

  if (error !== null)
    return (
      <Page>
        <ErrorMessage>{errorText(error)}</ErrorMessage>
        <a href="/">{t("notFound.home")}</a>
      </Page>
    );
  if (!group)
    return (
      <Page>
        <Loading />
      </Page>
    );
  return <NewPaymentForm group={group} me={me} />;
}

/**
 * Records a payment you made (or, from someone deactivated, one you received). Opened from a
 * suggestion with ?to= (or ?from=) and ?amount= filled in; everything can be changed.
 */
function NewPaymentForm({ group, me }: { group: GroupDetail; me: User }) {
  const { t } = useI18n();
  const errorText = useErrorText();
  const { query, route } = useLocation();
  const back = `/groups/${encodeURIComponent(group.id)}`;
  // Who may be the payer here: you, or a deactivated member paying you.
  const payers = group.members.filter((m) => m.id === me.id || m.deactivated);
  const [from, setFrom] = useState(() => (payers.some((m) => m.id === query.from) ? query.from! : me.id));
  const payees =
    from === me.id ? group.members.filter((m) => m.id !== me.id) : group.members.filter((m) => m.id === me.id);
  const [toChoice, setTo] = useState(() => query.to ?? "");
  const to = payees.some((m) => m.id === toChoice) ? toChoice : (payees[0]?.id ?? "");
  const payee = group.members.find((m) => m.id === to);
  const suggested = Number(query.amount);
  const [amountText, setAmountText] = useState(() =>
    Number.isSafeInteger(suggested) && suggested > 0 ? amountInput(suggested, group.currency) : "",
  );
  const amount = parseAmount(amountText, group.currency);
  // Venmo: US dollars only, paying someone with a Venmo username.
  const venmoOk = group.currency === "USD" && from === me.id && !!payee?.venmo;
  const [methodChoice, setMethod] = useState<PaymentMethod>("venmo");
  const method: PaymentMethod = venmoOk ? methodChoice : "other";
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function submit(e: Event) {
    e.preventDefault();
    setChecked(true);
    setError(null);
    if (amount === null || !to) return;
    setBusy(true);
    try {
      await api(`/api/groups/${encodeURIComponent(group.id)}/payments`, { from, to, amount, method });
      route(back, true);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  const nameOf = (m: { id: string; name: string }) => (m.id === me.id ? `${m.name} (${t("group.you")})` : m.name);

  if (group.members.length < 2)
    return (
      <Page title={t("paymentNew.title")}>
        <p class="muted">{t("paymentNew.alone")}</p>
        <a class="button secondary" href={back}>
          {t("expenseNew.cancel")}
        </a>
      </Page>
    );

  return (
    <Page title={t("paymentNew.title")}>
      <p class="muted">{group.name}</p>
      <form class="form" onSubmit={submit} noValidate>
        {payers.length > 1 && (
          <label class="field">
            <span>{t("paymentNew.from")}</span>
            <select value={from} onChange={(e) => setFrom(e.currentTarget.value)}>
              {payers.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.deactivated ? `${m.name} (${t("group.deactivated")})` : nameOf(m)}
                </option>
              ))}
            </select>
            {from !== me.id && <small class="muted">{t("paymentNew.fromDeactivated")}</small>}
          </label>
        )}
        <label class="field">
          <span>{t("paymentNew.to")}</span>
          <select value={to} onChange={(e) => setTo(e.currentTarget.value)} disabled={payees.length < 2}>
            {payees.map((m) => (
              <option key={m.id} value={m.id}>
                {m.deactivated ? `${m.name} (${t("group.deactivated")})` : nameOf(m)}
              </option>
            ))}
          </select>
        </label>
        <label class="field">
          <span>{t("expenseNew.amount", { currency: group.currency })}</span>
          <input
            value={amountText}
            onInput={(e) => setAmountText(e.currentTarget.value)}
            inputMode="decimal"
            autoComplete="off"
            required
          />
          {checked && amount === null && (
            <small class="error">{t("expenseNew.amountInvalid", { example: amountInput(1250, group.currency) })}</small>
          )}
        </label>
        {venmoOk && (
          <fieldset class="field participants">
            <legend>{t("paymentNew.method")}</legend>
            <label class="field checkbox">
              <input type="radio" name="method" checked={method === "venmo"} onChange={() => setMethod("venmo")} />
              <span>{t("payment.method.venmo")}</span>
            </label>
            <label class="field checkbox">
              <input type="radio" name="method" checked={method === "other"} onChange={() => setMethod("other")} />
              <span>{t("paymentNew.other")}</span>
            </label>
          </fieldset>
        )}
        {method === "venmo" && payee?.venmo ? (
          <div class="venmo-step">
            {amount === null ? (
              <span class="button secondary disabled" aria-disabled="true">
                {t("paymentNew.openVenmo")}
              </span>
            ) : (
              <a
                class="button secondary"
                href={venmoLink(payee.venmo, amount, venmoNote(group.name))}
                target="_blank"
                rel="noopener noreferrer"
              >
                {t("paymentNew.openVenmo")}
              </a>
            )}
            <small class="muted">{t("paymentNew.venmoHint", { name: payee.name, venmo: `@${payee.venmo}` })}</small>
          </div>
        ) : (
          <p class="muted small">{group.currency !== "USD" ? t("paymentNew.otherOnly") : t("paymentNew.otherHint")}</p>
        )}
        <p class="muted small">
          {from !== me.id || payee?.deactivated
            ? t("paymentNew.countsNow")
            : t("paymentNew.needsConfirm", { name: payee?.name ?? "" })}
        </p>
        {error !== null && <ErrorMessage>{errorText(error)}</ErrorMessage>}
        <div class="actions">
          <button type="submit" class="button" disabled={busy}>
            {method === "venmo" ? t("paymentNew.paid") : t("paymentNew.submit")}
          </button>
          <a class="button secondary" href={back}>
            {t("expenseNew.cancel")}
          </a>
        </div>
      </form>
    </Page>
  );
}
