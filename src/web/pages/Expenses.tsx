import { useLocation, useRoute } from "preact-iso";
import { useEffect, useState } from "preact/hooks";
import { type Balance, type Expense, type ExpensePage, splitEqual } from "../../shared/expenses";
import type { Transfer } from "../../shared/settlements";
import type { GroupDetail } from "../../shared/groups";
import { amountInput, formatAmount, parseAmount } from "../../shared/money";
import { api } from "../api";
import { ErrorMessage, Loading, Page, useErrorText } from "../components";
import { formatDay, today } from "../format";
import { useI18n } from "../i18n";
import { RequireUser } from "../RequireUser";
import type { User } from "../session";
import { Suggestions } from "./Payments";

/** Who owes and who is owed, on the group page, and the payments that would settle it. */
export function Balances({ group, me, version }: { group: GroupDetail; me: User; version: number }) {
  const { lang, t } = useI18n();
  const errorText = useErrorText();
  const [data, setData] = useState<{ balances: Balance[]; suggestions: Transfer[] } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let alive = true;
    setError(null);
    api<{ balances: Balance[]; suggestions: Transfer[] }>(`/api/groups/${encodeURIComponent(group.id)}/balances`)
      .then((r) => alive && setData(r))
      .catch((e) => alive && setError(e));
    return () => {
      alive = false;
    };
  }, [group.id, reload, version]);

  return (
    <section>
      <h2>{t("group.balances")}</h2>
      {error !== null ? (
        <>
          <ErrorMessage>{errorText(error)}</ErrorMessage>
          <button type="button" class="button secondary" onClick={() => setReload((n) => n + 1)}>
            {t("common.retry")}
          </button>
        </>
      ) : data === null ? (
        <Loading />
      ) : (
        <>
          <ul class="balance-list">
            {data.balances.map((b) => {
              const amount = formatAmount(Math.abs(b.net), group.currency, lang);
              return (
                <li key={b.userId} class="balance-row">
                  <span>
                    {b.name}
                    {b.userId === me.id && <span class="badge">{t("group.you")}</span>}
                  </span>
                  <span class={b.net > 0 ? "success" : b.net < 0 ? "error" : "muted"}>
                    {b.net > 0
                      ? t("group.balance.owed", { amount })
                      : b.net < 0
                        ? t("group.balance.owes", { amount })
                        : t("group.balance.settled")}
                  </span>
                </li>
              );
            })}
          </ul>
          <Suggestions group={group} me={me} suggestions={data.suggestions} />
        </>
      )}
    </section>
  );
}

/** The group's expenses, newest first, a page at a time. */
export function ExpenseList({ group, me }: { group: GroupDetail; me: User }) {
  const { t } = useI18n();
  const errorText = useErrorText();
  const [expenses, setExpenses] = useState<Expense[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const path = `/api/groups/${encodeURIComponent(group.id)}/expenses`;

  async function load(before: string | null) {
    setBusy(true);
    setError(null);
    try {
      const page = await api<ExpensePage>(before ? `${path}?before=${encodeURIComponent(before)}` : path);
      setExpenses((list) => (before && list ? [...list, ...page.expenses] : page.expenses));
      setNext(page.next);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    load(null);
  }, [group.id]);

  return (
    <section>
      <div class="section-head">
        <h2>{t("group.expenses")}</h2>
        <a class="button small" href={`/groups/${encodeURIComponent(group.id)}/expenses/new`}>
          {t("group.addExpense")}
        </a>
      </div>
      {expenses === null ? (
        error === null && <Loading />
      ) : expenses.length === 0 ? (
        <p class="muted">{t("group.expensesEmpty")}</p>
      ) : (
        <ul class="card-list">
          {expenses.map((e) => (
            <ExpenseRow key={e.id} expense={e} group={group} me={me} />
          ))}
        </ul>
      )}
      {error !== null && (
        <>
          <ErrorMessage>{errorText(error)}</ErrorMessage>
          <button type="button" class="button secondary" disabled={busy} onClick={() => load(expenses ? next : null)}>
            {t("common.retry")}
          </button>
        </>
      )}
      {error === null && next && (
        <div class="actions list-more">
          <button type="button" class="button secondary" disabled={busy} onClick={() => load(next)}>
            {t("group.moreExpenses")}
          </button>
        </div>
      )}
    </section>
  );
}

function ExpenseRow({ expense: e, group, me }: { expense: Expense; group: GroupDetail; me: User }) {
  const { lang, t } = useI18n();
  const money = (units: number) => formatAmount(units, group.currency, lang);
  const share = e.shares.find((s) => s.userId === me.id);
  const lent = (e.paidBy === me.id ? e.amount : 0) - (share?.amount ?? 0);
  const [status, cls] =
    e.paidBy !== me.id && !share
      ? [t("expense.notInvolved"), "muted"]
      : lent === 0
        ? [t("expense.even"), "muted"]
        : lent > 0
          ? [t("expense.youLent", { amount: money(lent) }), "success"]
          : [t("expense.youBorrowed", { amount: money(-lent) }), "error"];
  return (
    <li>
      <details class="card expense">
        <summary class="expense-summary">
          <span class="expense-main">
            <span class="card-title">{e.description}</span>
            <span class="muted small">
              {formatDay(e.date, lang)} · {t("expense.paid", { name: e.paidByName, amount: money(e.amount) })}
            </span>
          </span>
          <span class={`expense-status small ${cls}`}>{status}</span>
        </summary>
        <div class="muted small expense-shares">
          {t("expense.splitEqual")}
          <ul>
            {e.shares.map((s) => (
              <li key={s.userId}>{t("expense.share", { name: s.name, amount: money(s.amount) })}</li>
            ))}
          </ul>
        </div>
      </details>
    </li>
  );
}

export function NewExpense() {
  const { params } = useRoute();
  return <RequireUser>{(me) => <NewExpenseLoader key={params.id} id={params.id!} me={me} />}</RequireUser>;
}

function NewExpenseLoader({ id, me }: { id: string; me: User }) {
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
  return <NewExpenseForm group={group} me={me} />;
}

function NewExpenseForm({ group, me }: { group: GroupDetail; me: User }) {
  const { lang, t } = useI18n();
  const errorText = useErrorText();
  const { route } = useLocation();
  const back = `/groups/${encodeURIComponent(group.id)}`;
  const [description, setDescription] = useState("");
  const [amountText, setAmountText] = useState("");
  const [paidBy, setPaidBy] = useState(me.id);
  const [date, setDate] = useState(today);
  // Everyone who can still use the site, to start with.
  const [participants, setParticipants] = useState(
    () => new Set(group.members.filter((m) => !m.deactivated).map((m) => m.id)),
  );
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const amount = parseAmount(amountText, group.currency);
  const chosen = group.members.filter((m) => participants.has(m.id)).map((m) => m.id);
  const shares = amount !== null && chosen.length > 0 ? splitEqual(amount, chosen) : null;
  const money = (units: number) => formatAmount(units, group.currency, lang);

  const toggle = (userId: string, on: boolean) =>
    setParticipants((set) => {
      const copy = new Set(set);
      if (on) copy.add(userId);
      else copy.delete(userId);
      return copy;
    });

  async function submit(e: Event) {
    e.preventDefault();
    setChecked(true);
    setError(null);
    if (amount === null || chosen.length === 0) return;
    setBusy(true);
    try {
      await api(`/api/groups/${encodeURIComponent(group.id)}/expenses`, {
        description,
        amount,
        paidBy,
        date,
        splitMethod: "equal",
        participants: chosen,
      });
      route(back, true);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <Page title={t("expenseNew.title")}>
      <p class="muted">{group.name}</p>
      <form class="form" onSubmit={submit} noValidate>
        <label class="field">
          <span>{t("expenseNew.description")}</span>
          <input value={description} onInput={(e) => setDescription(e.currentTarget.value)} maxLength={100} required />
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
        <label class="field">
          <span>{t("expenseNew.paidBy")}</span>
          <select value={paidBy} onChange={(e) => setPaidBy(e.currentTarget.value)}>
            {group.members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.id === me.id ? `${m.name} (${t("group.you")})` : m.name}
              </option>
            ))}
          </select>
        </label>
        <label class="field">
          <span>{t("expenseNew.date")}</span>
          <input type="date" value={date} onInput={(e) => setDate(e.currentTarget.value)} required />
        </label>
        <fieldset class="field participants">
          <legend>{t("expenseNew.split")}</legend>
          <label class="field checkbox">
            <input
              type="checkbox"
              checked={chosen.length === group.members.length}
              onChange={(e) =>
                setParticipants(e.currentTarget.checked ? new Set(group.members.map((m) => m.id)) : new Set())
              }
            />
            <span>{t("expenseNew.everyone")}</span>
          </label>
          {group.members.map((m) => (
            <label key={m.id} class="field checkbox">
              <input
                type="checkbox"
                checked={participants.has(m.id)}
                onChange={(e) => toggle(m.id, e.currentTarget.checked)}
              />
              <span class="participant-name">
                {m.name}
                {m.deactivated && <span class="badge">{t("group.deactivated")}</span>}
              </span>
              {shares?.has(m.id) && <span class="muted small">{money(shares.get(m.id)!)}</span>}
            </label>
          ))}
          {checked && chosen.length === 0 && <small class="error">{t("expenseNew.pickSomeone")}</small>}
        </fieldset>
        {error !== null && <ErrorMessage>{errorText(error)}</ErrorMessage>}
        <div class="actions">
          <button type="submit" class="button" disabled={busy}>
            {t("expenseNew.submit")}
          </button>
          <a class="button secondary" href={back}>
            {t("expenseNew.cancel")}
          </a>
        </div>
      </form>
    </Page>
  );
}
