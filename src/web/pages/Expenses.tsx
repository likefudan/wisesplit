import { useLocation, useRoute } from "preact-iso";
import { useEffect, useState } from "preact/hooks";
import { type Balance, type Expense, type ExpensePage, splitEqual } from "../../shared/expenses";
import type { GroupDetail } from "../../shared/groups";
import { amountInput, formatAmount, parseAmount } from "../../shared/money";
import { ApiError, api } from "../api";
import { ErrorMessage, Loading, Page, useErrorText } from "../components";
import { formatDay, today } from "../format";
import { useI18n } from "../i18n";
import { RequireUser } from "../RequireUser";
import type { User } from "../session";

/** Who owes and who is owed, on the group page. */
export function Balances({ group, me }: { group: GroupDetail; me: User }) {
  const { lang, t } = useI18n();
  const errorText = useErrorText();
  const [balances, setBalances] = useState<Balance[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let alive = true;
    setError(null);
    api<{ balances: Balance[] }>(`/api/groups/${encodeURIComponent(group.id)}/balances`)
      .then((r) => alive && setBalances(r.balances))
      .catch((e) => alive && setError(e));
    return () => {
      alive = false;
    };
  }, [group.id, reload]);

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
      ) : balances === null ? (
        <Loading />
      ) : (
        <ul class="balance-list">
          {balances.map((b) => {
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
      )}
    </section>
  );
}

/** The group's expenses, newest first, a page at a time. `onChange` runs after one is deleted. */
export function ExpenseList({ group, me, onChange }: { group: GroupDetail; me: User; onChange: () => void }) {
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
            <ExpenseRow
              key={e.id}
              expense={e}
              group={group}
              me={me}
              onDeleted={() => {
                setExpenses((list) => (list ? list.filter((x) => x.id !== e.id) : list));
                onChange();
              }}
              onUpdated={(latest) =>
                setExpenses((list) => (list ? list.map((x) => (x.id === e.id ? latest : x)) : list))
              }
            />
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

function ExpenseRow({
  expense: e,
  group,
  me,
  onDeleted,
  onUpdated,
}: {
  expense: Expense;
  group: GroupDetail;
  me: User;
  onDeleted: () => void;
  onUpdated: (latest: Expense) => void;
}) {
  const { lang, t } = useI18n();
  const errorText = useErrorText();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
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

  async function remove() {
    if (!confirm(t("expense.confirmDelete", { description: e.description }))) return;
    setBusy(true);
    setError(null);
    const path = `/api/groups/${encodeURIComponent(group.id)}/expenses/${encodeURIComponent(e.id)}`;
    try {
      await api(`${path}/delete`, { version: e.version });
      onDeleted();
    } catch (err) {
      setBusy(false);
      const code = err instanceof ApiError ? err.code : null;
      // Already deleted by someone else: it goes from the list all the same.
      if (code === "expense_not_found") return onDeleted();
      setError(err);
      // Changed by someone else since the list was loaded: show it as it is now, to delete again
      // if that's still what they want.
      if (code === "expense_changed")
        api<{ expense: Expense }>(path)
          .then((r) => onUpdated(r.expense))
          .catch(() => {});
    }
  }

  return (
    <li>
      <details class="card expense">
        <summary class="expense-summary">
          <span class="expense-main">
            <span class="card-title">{e.description}</span>
            <span class="muted small">
              {formatDay(e.date, lang)} · {t("expense.paid", { name: e.paidByName, amount: money(e.amount) })}
              {e.updatedAt && ` · ${t("expense.edited")}`}
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
        {error !== null && (
          <ErrorMessage>
            {error instanceof ApiError && error.code === "expense_changed"
              ? t("expense.changedBeforeDelete")
              : errorText(error)}
          </ErrorMessage>
        )}
        <div class="actions expense-actions">
          <a
            class="button small secondary"
            href={`/groups/${encodeURIComponent(group.id)}/expenses/${encodeURIComponent(e.id)}/edit`}
          >
            {t("expense.edit")}
          </a>
          <button type="button" class="button small danger" disabled={busy} onClick={remove}>
            {t("expense.delete")}
          </button>
        </div>
      </details>
    </li>
  );
}

export function NewExpense() {
  const { params } = useRoute();
  return (
    <RequireUser>{(me) => <ExpenseLoader key={params.id} id={params.id!} expenseId={null} me={me} />}</RequireUser>
  );
}

export function EditExpense() {
  const { params } = useRoute();
  return (
    <RequireUser>
      {(me) => (
        <ExpenseLoader key={`${params.id}/${params.expenseId}`} id={params.id!} expenseId={params.expenseId!} me={me} />
      )}
    </RequireUser>
  );
}

/** Loads the group (and, to edit one, the expense) for the form. */
function ExpenseLoader({ id, expenseId, me }: { id: string; expenseId: string | null; me: User }) {
  const { t } = useI18n();
  const errorText = useErrorText();
  const [group, setGroup] = useState<GroupDetail | null>(null);
  const [expense, setExpense] = useState<Expense | null>(null);
  const [error, setError] = useState<unknown>(null);
  const groupPath = `/api/groups/${encodeURIComponent(id)}`;
  const expensePath = expenseId && `${groupPath}/expenses/${encodeURIComponent(expenseId)}`;

  useEffect(() => {
    let alive = true;
    Promise.all([api<{ group: GroupDetail }>(groupPath), expensePath ? api<{ expense: Expense }>(expensePath) : null])
      .then(([g, e]) => {
        if (!alive) return;
        setGroup(g.group);
        setExpense(e ? e.expense : null);
      })
      .catch((e) => alive && setError(e));
    return () => {
      alive = false;
    };
  }, [groupPath, expensePath]);

  // Someone else saved first: their version replaces the form (and what was typed in it).
  const reload = expensePath
    ? () =>
        api<{ expense: Expense }>(expensePath)
          .then((r) => setExpense(r.expense))
          .catch(setError)
    : undefined;

  if (error !== null)
    return (
      <Page>
        <ErrorMessage>{errorText(error)}</ErrorMessage>
        <a href={group ? `/groups/${encodeURIComponent(group.id)}` : "/"}>{group ? group.name : t("notFound.home")}</a>
      </Page>
    );
  if (!group || (expenseId && !expense))
    return (
      <Page>
        <Loading />
      </Page>
    );
  return (
    <ExpenseForm
      key={expense && `${expense.id}@${expense.version}`}
      group={group}
      me={me}
      expense={expense}
      reload={reload}
    />
  );
}

/** Someone in the form: a member, or someone already in the expense who has since left. */
interface Person {
  id: string;
  name: string;
  deactivated: boolean;
  left: boolean;
}

/**
 * The form to add an expense, or with `expense`, to edit one. `reload` loads the expense as it is
 * now, after someone else saved it first.
 */
function ExpenseForm({
  group,
  me,
  expense,
  reload,
}: {
  group: GroupDetail;
  me: User;
  expense: Expense | null;
  reload?: () => void;
}) {
  const { lang, t } = useI18n();
  const errorText = useErrorText();
  const { route } = useLocation();
  const back = `/groups/${encodeURIComponent(group.id)}`;
  // The members, then anyone in the expense who has left the group since: they stay in it unless
  // taken out (which the server allows only if it changes nothing they owe).
  const people: Person[] = group.members.map((m) => ({
    id: m.id,
    name: m.name,
    deactivated: m.deactivated,
    left: false,
  }));
  if (expense)
    for (const p of [{ userId: expense.paidBy, name: expense.paidByName }, ...expense.shares])
      if (!people.some((q) => q.id === p.userId))
        people.push({ id: p.userId, name: p.name, deactivated: false, left: true });
  // Someone who has left and owes or is owed something in it: that can't change (the server turns
  // it down), so only the description and date can.
  const net = (id: string) =>
    expense
      ? (expense.paidBy === id ? expense.amount : 0) - (expense.shares.find((s) => s.userId === id)?.amount ?? 0)
      : 0;
  const fixedFor = people.filter((p) => p.left && net(p.id) !== 0);
  const locked = fixedFor.length > 0;
  const [description, setDescription] = useState(expense?.description ?? "");
  const [amountText, setAmountText] = useState(expense ? amountInput(expense.amount, group.currency) : "");
  const [paidBy, setPaidBy] = useState(expense?.paidBy ?? me.id);
  const [date, setDate] = useState(expense?.date ?? today);
  // Adding: everyone who can still use the site, to start with.
  const [participants, setParticipants] = useState(
    () =>
      new Set(
        expense ? expense.shares.map((s) => s.userId) : group.members.filter((m) => !m.deactivated).map((m) => m.id),
      ),
  );
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const amount = parseAmount(amountText, group.currency);
  const chosen = people.filter((p) => participants.has(p.id)).map((p) => p.id);
  const shares = amount !== null && chosen.length > 0 ? splitEqual(amount, chosen) : null;
  const money = (units: number) => formatAmount(units, group.currency, lang);
  const everyone = group.members.every((m) => participants.has(m.id));

  const toggle = (userIds: string[], on: boolean) =>
    setParticipants((set) => {
      const copy = new Set(set);
      for (const id of userIds) {
        if (on) copy.add(id);
        else copy.delete(id);
      }
      return copy;
    });

  async function submit(e: Event) {
    e.preventDefault();
    setChecked(true);
    setError(null);
    if (amount === null || chosen.length === 0) return;
    setBusy(true);
    const fields = { description, amount, paidBy, date, splitMethod: "equal", participants: chosen };
    const path = `/api/groups/${encodeURIComponent(group.id)}/expenses`;
    try {
      if (expense) await api(`${path}/${encodeURIComponent(expense.id)}`, { ...fields, version: expense.version });
      else await api(path, fields);
      route(back, true);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  const label = (p: Person) => (p.id === me.id ? `${p.name} (${t("group.you")})` : p.name);
  const changed = error instanceof ApiError && error.code === "expense_changed";

  return (
    <Page title={t(expense ? "expenseEdit.title" : "expenseNew.title")}>
      <p class="muted">{group.name}</p>
      {locked && (
        <p class="muted small">{t("expenseEdit.locked", { names: fixedFor.map((p) => p.name).join(", ") })}</p>
      )}
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
            disabled={locked}
            required
          />
          {checked && amount === null && (
            <small class="error">{t("expenseNew.amountInvalid", { example: amountInput(1250, group.currency) })}</small>
          )}
        </label>
        <label class="field">
          <span>{t("expenseNew.paidBy")}</span>
          <select value={paidBy} onChange={(e) => setPaidBy(e.currentTarget.value)} disabled={locked}>
            {people
              .filter((p) => !p.left || p.id === expense?.paidBy)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.left ? `${p.name} (${t("expenseNew.left")})` : label(p)}
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
              checked={everyone}
              disabled={locked}
              onChange={(e) =>
                toggle(
                  group.members.map((m) => m.id),
                  e.currentTarget.checked,
                )
              }
            />
            <span>{t("expenseNew.everyone")}</span>
          </label>
          {people.map((p) => (
            <label key={p.id} class="field checkbox">
              <input
                type="checkbox"
                checked={participants.has(p.id)}
                disabled={locked}
                onChange={(e) => toggle([p.id], e.currentTarget.checked)}
              />
              <span class="participant-name">
                {p.name}
                {p.deactivated && <span class="badge">{t("group.deactivated")}</span>}
                {p.left && <span class="badge">{t("expenseNew.left")}</span>}
              </span>
              {shares?.has(p.id) && <span class="muted small">{money(shares.get(p.id)!)}</span>}
            </label>
          ))}
          {checked && chosen.length === 0 && <small class="error">{t("expenseNew.pickSomeone")}</small>}
        </fieldset>
        {error !== null && <ErrorMessage>{errorText(error)}</ErrorMessage>}
        <div class="actions">
          {changed && reload ? (
            <button type="button" class="button" onClick={reload}>
              {t("expenseEdit.reload")}
            </button>
          ) : (
            <button type="submit" class="button" disabled={busy}>
              {t("expenseNew.submit")}
            </button>
          )}
          <a class="button secondary" href={back}>
            {t("expenseNew.cancel")}
          </a>
        </div>
      </form>
    </Page>
  );
}
