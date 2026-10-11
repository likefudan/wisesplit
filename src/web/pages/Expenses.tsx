import { useLocation, useRoute } from "preact-iso";
import { useEffect, useState } from "preact/hooks";
import type { Currency } from "../../shared/currencies";
import {
  type Balance,
  type Expense,
  type ExpenseEdit,
  type ExpensePage,
  FULL_PERCENT,
  MAX_SHARES,
  type NewExpense as NewExpenseFields,
  netOf,
  SPLIT_METHODS,
  SplitError,
  type SplitErrorCode,
  type SplitMethod,
  type SplitParams,
  splitShares,
} from "../../shared/expenses";
import type { GroupDetail } from "../../shared/groups";
import {
  amountInput,
  formatAmount,
  formatPercent,
  parseAdjustment,
  parseAmount,
  parseCount,
  parsePercent,
} from "../../shared/money";
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
      // An expense moved to an older day since the last page may come again: shown once, as it is now.
      const fresh = new Set(page.expenses.map((e) => e.id));
      setExpenses((list) =>
        before && list ? [...list.filter((x) => !fresh.has(x.id)), ...page.expenses] : page.expenses,
      );
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
              onUpdated={(latest) => {
                setExpenses((list) => (list ? list.map((x) => (x.id === e.id ? latest : x)) : list));
                onChange();
              }}
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

/** What someone's share came from, beside it in the expense: "25%", "2 shares", "+$5.00". */
function useShareDetail(currency: Currency) {
  const { lang, t } = useI18n();
  return (e: Expense, userId: string): string | null => {
    const v = e.splitParams?.[userId];
    if (v === undefined) return null;
    if (e.splitMethod === "percent") return formatPercent(v, lang);
    if (e.splitMethod === "shares") return v === 1 ? t("expense.oneShare") : t("expense.shareCount", { count: v });
    if (e.splitMethod === "adjust") return `${v > 0 ? "+" : "-"}${formatAmount(Math.abs(v), currency, lang)}`;
    return null;
  };
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
  const shareDetail = useShareDetail(group.currency);
  const share = e.shares.find((s) => s.userId === me.id);
  // Someone who has left owes or is owed something in it: deleting it would change that, which the
  // server turns down.
  const fixed = [...netOf({ ...e, shares: Object.fromEntries(e.shares.map((s) => [s.userId, s.amount])) })].some(
    ([id, net]) => net !== 0 && !group.members.some((m) => m.id === id),
  );
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
          .catch((err) => {
            if (err instanceof ApiError && err.code === "expense_not_found") onDeleted();
            else setError(err);
          });
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
          {t(`expense.split.${e.splitMethod}`)}
          <ul>
            {e.shares.map((s) => {
              const detail = shareDetail(e, s.userId);
              const amount = money(s.amount);
              return (
                <li key={s.userId}>
                  {detail
                    ? t("expense.shareDetail", { name: s.name, amount, detail })
                    : t("expense.share", { name: s.name, amount })}
                </li>
              );
            })}
          </ul>
        </div>
        {fixed ? (
          <p class="muted small">{t("expense.cannotDelete")}</p>
        ) : (
          error !== null && (
            <ErrorMessage>
              {error instanceof ApiError && error.code === "expense_changed"
                ? t("expense.changedBeforeDelete")
                : errorText(error)}
            </ErrorMessage>
          )
        )}
        <div class="actions expense-actions">
          <a
            class="button small secondary"
            href={`/groups/${encodeURIComponent(group.id)}/expenses/${encodeURIComponent(e.id)}/edit`}
          >
            {t("expense.edit")}
          </a>
          <button type="button" class="button small danger" disabled={busy || fixed} onClick={remove}>
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

  // Each load starts the form over, from what is there now.
  const [loads, setLoads] = useState(0);

  useEffect(() => {
    let alive = true;
    // The group first, so a failure to load the expense can still link back to it.
    api<{ group: GroupDetail }>(groupPath)
      .then(async (g) => {
        if (!alive) return;
        setGroup(g.group);
        if (expensePath) {
          const e = await api<{ expense: Expense }>(expensePath);
          if (alive) setExpense(e.expense);
        }
      })
      .catch((e) => alive && setError(e));
    return () => {
      alive = false;
    };
  }, [groupPath, expensePath]);

  // After someone else changed the expense or the group; failing, it leaves the form as it is.
  const reload = async () => {
    const [g, e] = await Promise.all([
      api<{ group: GroupDetail }>(groupPath),
      expensePath ? api<{ expense: Expense }>(expensePath) : null,
    ]);
    setGroup(g.group);
    if (e) setExpense(e.expense);
    setLoads((n) => n + 1);
  };

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
  return <ExpenseForm key={loads} group={group} me={me} expense={expense} reload={reload} />;
}

/** Someone in the form: a member, or someone already in the expense who has since left. */
interface Person {
  id: string;
  name: string;
  deactivated: boolean;
  left: boolean;
}

/** The methods that take a value per person, and what the form keeps typed for each, by user id. */
type Entered = Record<Exclude<SplitMethod, "equal">, Record<string, string>>;

/**
 * What the form's split comes to: who takes part, the split's parameters, which typed values
 * don't read, and each person's share (or why there is none yet).
 */
function readSplit(
  method: SplitMethod,
  amount: number | null,
  members: readonly { id: string }[],
  ticked: ReadonlySet<string>,
  entered: Entered,
  currency: Currency,
) {
  const bad = new Set<string>();
  let participants: string[];
  let params: SplitParams | null = null;
  if (method === "equal" || method === "adjust") {
    participants = members.filter((m) => ticked.has(m.id)).map((m) => m.id);
    if (method === "adjust") {
      params = {};
      for (const id of participants) {
        const text = entered.adjust[id]?.trim() ?? "";
        if (!text) continue;
        const v = parseAdjustment(text, currency);
        if (v === null) bad.add(id);
        else if (v !== 0) params[id] = v;
      }
    }
  } else {
    // Exact, percent, shares: whoever has something typed takes part.
    participants = [];
    params = {};
    for (const m of members) {
      const text = entered[method][m.id]?.trim() ?? "";
      if (!text) continue;
      participants.push(m.id);
      const v =
        method === "exact"
          ? parseAmount(text, currency)
          : method === "percent"
            ? parsePercent(text)
            : parseCount(text, MAX_SHARES);
      if (v === null) bad.add(m.id);
      else params[m.id] = v;
    }
  }
  let shares: Map<string, number> | null = null;
  let error: SplitErrorCode | null = null;
  if (amount !== null && participants.length > 0 && bad.size === 0) {
    try {
      shares = splitShares(method, amount, participants, params);
    } catch (err) {
      if (!(err instanceof SplitError)) throw err;
      error = err.code;
    }
  }
  return { participants, params, bad, shares, error };
}

/** A percentage in hundredths for a form field: 3333 → "33.33", 2500 → "25". */
const percentInput = (hundredths: number) =>
  `${Math.floor(hundredths / 100)}${hundredths % 100 ? `.${String(hundredths % 100).padStart(2, "0")}` : ""}`;

/**
 * The form to add an expense, or with `expense`, to edit one. `reload` loads the group and the
 * expense as they are now, after someone else changed them.
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
  reload: () => Promise<void>;
}) {
  const { lang, t } = useI18n();
  const errorText = useErrorText();
  const { route } = useLocation();
  const back = `/groups/${encodeURIComponent(group.id)}`;
  // The members, then anyone in the expense who has left the group since: they stay in it as they are.
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
  // What someone who has left owes or is owed in it can't change (the server turns that down), so
  // with them in it only the description and date can.
  const fixedFor = people.filter((p) => p.left);
  const locked = fixedFor.length > 0;
  const [description, setDescription] = useState(expense?.description ?? "");
  const [amountText, setAmountText] = useState(expense ? amountInput(expense.amount, group.currency) : "");
  const [paidBy, setPaidBy] = useState(expense?.paidBy ?? me.id);
  const [date, setDate] = useState(expense?.date ?? today);
  const [method, setMethod] = useState<SplitMethod>(expense?.splitMethod ?? "equal");
  // Adding: everyone who can still use the site, to start with: ticked for an equal split (with or
  // without adjustments), one share each by shares. Editing: the split as it was entered.
  const active = group.members.filter((m) => !m.deactivated).map((m) => m.id);
  const [ticked, setTicked] = useState(
    () =>
      new Set(
        expense && (expense.splitMethod === "equal" || expense.splitMethod === "adjust")
          ? expense.shares.map((s) => s.userId)
          : active,
      ),
  );
  const [entered, setEntered] = useState<Entered>(() => {
    const all: Entered = {
      exact: {},
      percent: {},
      shares: Object.fromEntries(active.map((id) => [id, "1"])),
      adjust: {},
    };
    const params = expense?.splitParams;
    if (expense && params && expense.splitMethod !== "equal") {
      const text = (v: number) =>
        expense.splitMethod === "percent"
          ? percentInput(v)
          : expense.splitMethod === "shares"
            ? String(v)
            : `${expense.splitMethod === "adjust" && v > 0 ? "+" : ""}${amountInput(v, group.currency)}`;
      all[expense.splitMethod] = Object.fromEntries(Object.entries(params).map(([id, v]) => [id, text(v)]));
    }
    return all;
  });
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const amount = parseAmount(amountText, group.currency);
  const split = readSplit(method, amount, people, ticked, entered, group.currency);
  const money = (units: number) => formatAmount(units, group.currency, lang);
  const byTicking = method === "equal" || method === "adjust";
  const members = group.members.map((m) => m.id);

  const tick = (userIds: string[], on: boolean) =>
    setTicked((set) => {
      const copy = new Set(set);
      for (const id of userIds) {
        if (on) copy.add(id);
        else copy.delete(id);
      }
      return copy;
    });
  const enter = (kind: keyof Entered, userId: string, text: string) =>
    setEntered((all) => ({ ...all, [kind]: { ...all[kind], [userId]: text } }));

  async function submit(e: Event) {
    e.preventDefault();
    setChecked(true);
    setError(null);
    if (amount === null || !split.shares) return;
    setBusy(true);
    const fields: NewExpenseFields = {
      description,
      amount,
      paidBy,
      date,
      splitMethod: method,
      participants: split.participants,
      splitParams: split.params,
    };
    const path = `/api/groups/${encodeURIComponent(group.id)}/expenses`;
    try {
      if (expense)
        await api(`${path}/${encodeURIComponent(expense.id)}`, {
          ...fields,
          version: expense.version,
        } satisfies ExpenseEdit);
      else await api(path, fields);
      route(back, true);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  // How far the exact amounts or percentages are from adding up, as they are typed.
  let tally: { text: string; done: boolean } | null = null;
  if (split.bad.size === 0 && (method === "exact" || method === "percent") && split.params) {
    const sum = Object.values(split.params).reduce((a, b) => a + b, 0);
    const show = (v: number) => (method === "exact" ? money(v) : formatPercent(v, lang));
    const target = method === "exact" ? amount : FULL_PERCENT;
    if (target !== null)
      tally =
        sum === target
          ? { text: t(method === "exact" ? "expenseNew.addsUp" : "expenseNew.addsUpPercent"), done: true }
          : sum < target
            ? { text: t("expenseNew.left", { amount: show(target - sum) }), done: false }
            : { text: t("expenseNew.over", { amount: show(sum - target) }), done: false };
  }
  // What's wrong with the split, once it's worth saying: typos at once, the rest on saving, except
  // adjustments that can't work, shown as they are typed (exact amounts and percentages have their tally).
  let splitProblem: string | null = null;
  if (split.bad.size > 0) splitProblem = t("expenseNew.badInput");
  else if (checked && split.participants.length === 0) splitProblem = t("expenseNew.pickSomeone");
  else if (split.error && !tally && (checked || method === "adjust")) splitProblem = t(`error.${split.error}`);

  // Someone else changed the expense, or someone in it has left the group meanwhile.
  const stale =
    expense !== null &&
    error instanceof ApiError &&
    ["expense_changed", "former_member_involved", "not_in_group"].includes(error.code);
  // Deleted by someone else meanwhile: nothing left to save.
  const gone = error instanceof ApiError && error.code === "expense_not_found";

  async function loadAgain() {
    setBusy(true);
    try {
      await reload();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  const label = (p: Person) =>
    p.left ? `${p.name} (${t("expenseNew.leftGroup")})` : p.id === me.id ? `${p.name} (${t("group.you")})` : p.name;

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
                  {label(p)}
                </option>
              ))}
          </select>
        </label>
        <label class="field">
          <span>{t("expenseNew.date")}</span>
          <input type="date" value={date} onInput={(e) => setDate(e.currentTarget.value)} required />
        </label>
        <label class="field">
          <span>{t("expenseNew.method")}</span>
          <select value={method} onChange={(e) => setMethod(e.currentTarget.value as SplitMethod)} disabled={locked}>
            {SPLIT_METHODS.map((m) => (
              <option key={m} value={m}>
                {t(`expenseNew.method.${m}`)}
              </option>
            ))}
          </select>
        </label>
        <fieldset class="field participants" disabled={locked}>
          <legend>{t(method === "equal" ? "expenseNew.split" : `expenseNew.split.${method}`)}</legend>
          {method === "adjust" ? (
            <small class="muted">{t("expenseNew.adjustHint")}</small>
          ) : (
            !byTicking && <small class="muted">{t("expenseNew.blankHint")}</small>
          )}
          {byTicking && (
            <label class="field checkbox">
              <input
                type="checkbox"
                checked={members.every((id) => ticked.has(id))}
                onChange={(e) => tick(members, e.currentTarget.checked)}
              />
              <span>{t("expenseNew.everyone")}</span>
            </label>
          )}
          {people.map((m) => {
            const name = (
              <span class="participant-name">
                {m.name}
                {m.deactivated && <span class="badge">{t("group.deactivated")}</span>}
                {m.left && <span class="badge">{t("expenseNew.leftGroup")}</span>}
              </span>
            );
            const share = split.shares?.has(m.id) && <span class="muted small">{money(split.shares.get(m.id)!)}</span>;
            const kind = method === "equal" ? null : method;
            const input = kind && (!byTicking || ticked.has(m.id)) && (
              <input
                class={`split-input split-${kind}`}
                value={entered[kind][m.id] ?? ""}
                onInput={(e) => enter(kind, m.id, e.currentTarget.value)}
                inputMode={kind === "shares" ? "numeric" : "decimal"}
                autoComplete="off"
                placeholder={kind === "adjust" ? "+0" : undefined}
                aria-label={t(`expenseNew.input.${kind}`, { name: m.name })}
                aria-invalid={split.bad.has(m.id) || undefined}
              />
            );
            return (
              <div key={m.id} class="field checkbox">
                {byTicking ? (
                  <label class="field checkbox participant-pick">
                    <input
                      type="checkbox"
                      checked={ticked.has(m.id)}
                      onChange={(e) => tick([m.id], e.currentTarget.checked)}
                    />
                    {name}
                  </label>
                ) : (
                  name
                )}
                {input}
                {method !== "exact" && share}
              </div>
            );
          })}
          {tally && <small class={tally.done ? "success" : checked ? "error" : "muted"}>{tally.text}</small>}
          {splitProblem && <small class="error">{splitProblem}</small>}
        </fieldset>
        {error !== null && <ErrorMessage>{errorText(error)}</ErrorMessage>}
        <div class="actions">
          {gone ? null : stale ? (
            <button type="button" class="button" disabled={busy} onClick={loadAgain}>
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
