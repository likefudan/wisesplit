import type { Currency } from "../shared/currencies";
import { isLang, type Lang, translate } from "../shared/i18n";
import { amountInput } from "../shared/money";
import type { Env } from "./env";
import type { GroupRow } from "./groups";

/**
 * A group's records as one CSV file (docs/pr-plan.md, PR 11): every expense that was not deleted
 * and every confirmed payment, oldest first, with one column per person for their share. A
 * payment reads like an expense the payer paid for the payee alone, so in both kinds of row what
 * someone paid less their column is what the row moved their balance by.
 */

interface ExpenseRow {
  id: string;
  description: string;
  amount: number;
  paid_by: string;
  date: string;
  created_at: string;
}

interface PaymentRow {
  id: string;
  from_user: string;
  to_user: string;
  amount: number;
  created_at: string;
}

interface PersonRow {
  id: string;
  name: string;
  joined_at: string | null;
}

/** Everyone in the group, and anyone who has left but is in an expense or payment that is exported. */
const PEOPLE_SQL = `SELECT u.id, u.name, m.joined_at FROM users u
  LEFT JOIN group_members m ON m.group_id = ? AND m.user_id = u.id
  WHERE u.id IN (
    SELECT user_id FROM group_members WHERE group_id = ?
    UNION SELECT paid_by FROM expenses WHERE group_id = ? AND deleted_at IS NULL
    UNION SELECT s.user_id FROM expense_shares s JOIN expenses e ON e.id = s.expense_id
      WHERE e.group_id = ? AND e.deleted_at IS NULL
    UNION SELECT from_user FROM settlements WHERE group_id = ? AND status = 'confirmed'
    UNION SELECT to_user FROM settlements WHERE group_id = ? AND status = 'confirmed')
  ORDER BY m.joined_at IS NULL, m.joined_at, u.name, u.id`;

/** The group's records, read together so the file is one moment's picture. */
async function load(env: Env, groupId: string) {
  const [expenses, shares, payments, people] = await env.DB.batch([
    env.DB.prepare(
      "SELECT id, description, amount, paid_by, date, created_at FROM expenses WHERE group_id = ? AND deleted_at IS NULL",
    ).bind(groupId),
    env.DB.prepare(
      `SELECT s.expense_id, s.user_id, s.amount FROM expense_shares s JOIN expenses e ON e.id = s.expense_id
       WHERE e.group_id = ? AND e.deleted_at IS NULL`,
    ).bind(groupId),
    env.DB.prepare(
      "SELECT id, from_user, to_user, amount, created_at FROM settlements WHERE group_id = ? AND status = 'confirmed'",
    ).bind(groupId),
    env.DB.prepare(PEOPLE_SQL).bind(groupId, groupId, groupId, groupId, groupId, groupId),
  ]);
  return {
    expenses: expenses!.results as unknown as ExpenseRow[],
    shares: shares!.results as unknown as { expense_id: string; user_id: string; amount: number }[],
    payments: payments!.results as unknown as PaymentRow[],
    people: people!.results as unknown as PersonRow[],
  };
}

/** A time zone the runtime knows (as a browser names it, "America/Los_Angeles"); else UTC. */
export function timeZoneOf(value: string | undefined): string {
  if (!value || value.length > 64) return "UTC";
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    return "UTC";
  }
}

/**
 * A function giving the calendar day (YYYY-MM-DD) a moment falls on in `timeZone`. Made once and
 * used for every row: building a formatter costs far more than using one.
 */
export function dayIn(timeZone: string): (moment: Date) => string {
  const format = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  return (moment) => {
    const parts = format.formatToParts(moment);
    const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
    return `${part("year")}-${part("month")}-${part("day")}`;
  };
}

/**
 * One CSV field. Quoted when it holds a comma, quote or line break. Text that a spreadsheet would
 * take for a formula (it starts with = + - @, also after spaces or in their full-width forms, or
 * with a tab or carriage return) gets a ' in front, so a description can't run anything when the
 * file is opened.
 */
export function csvField(value: string): string {
  const safe = /^(\s*[=+\-@＝＋－＠]|[\t\r])/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** Rows of fields as CSV text: CRLF line ends, and a byte order mark so Excel reads it as UTF-8. */
export const toCsv = (rows: string[][]) => `\uFEFF${rows.map((r) => r.map(csvField).join(",")).join("\r\n")}\r\n`;

/**
 * What to call each person, in their column's heading and in every row: their name, marked for
 * those who have left, and with a number after it when someone earlier already goes by it, so no
 * two people are called the same.
 */
function labelsOf(people: PersonRow[], lang: Lang): string[] {
  const taken = new Set<string>();
  return people.map((p) => {
    const base = p.joined_at === null ? translate(lang, "export.formerMember", { name: p.name }) : p.name;
    let label = base;
    for (let n = 2; taken.has(label); n++) label = `${base} (${n})`;
    taken.add(label);
    return label;
  });
}

/**
 * The group's CSV file, in `lang`. `day` dates a payment by when it was recorded, the day the
 * money changed hands (it may be confirmed later).
 */
export async function groupCsv(env: Env, group: GroupRow, lang: Lang, day: (moment: Date) => string): Promise<string> {
  const { expenses, shares, payments, people } = await load(env, group.id);
  const currency: Currency = group.currency;
  const money = (units: number) => amountInput(units, currency);
  const labels = labelsOf(people, lang);
  const labelOf = new Map(people.map((p, i) => [p.id, labels[i]!]));
  const name = (id: string) => labelOf.get(id) ?? "";

  const sharesOf = new Map<string, Map<string, number>>();
  for (const s of shares) {
    const of = sharesOf.get(s.expense_id) ?? new Map<string, number>();
    of.set(s.user_id, s.amount);
    sharesOf.set(s.expense_id, of);
  }

  /** A row with a cell per person: the amount for those in `parts`, blank for everyone else. */
  const perPerson = (parts: Map<string, number>) => people.map((p) => (parts.has(p.id) ? money(parts.get(p.id)!) : ""));

  const records = [
    ...expenses.map((e) => ({
      key: `${e.date}|${e.created_at}|${e.id}`,
      fields: [
        e.date,
        e.description,
        translate(lang, "export.type.expense"),
        name(e.paid_by),
        money(e.amount),
        currency,
        ...perPerson(sharesOf.get(e.id) ?? new Map()),
      ],
    })),
    ...payments.map((p) => {
      const date = day(new Date(p.created_at));
      return {
        key: `${date}|${p.created_at}|${p.id}`,
        fields: [
          date,
          translate(lang, "export.payment", { from: name(p.from_user), to: name(p.to_user) }),
          translate(lang, "export.type.payment"),
          name(p.from_user),
          money(p.amount),
          currency,
          ...perPerson(new Map([[p.to_user, p.amount]])),
        ],
      };
    }),
  ];
  // Oldest day first; within a day, in the order they were recorded.
  records.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  const heading = (["date", "description", "type", "paidBy", "total", "currency"] as const).map((k) =>
    translate(lang, `export.column.${k}`),
  );
  return toCsv([[...heading, ...labels], ...records.map((r) => r.fields)]);
}

/**
 * The Content-Disposition for the file "<group name>-<day>.csv": the name as written in
 * filename*, and with only its plain ASCII letters in filename, for browsers that know no better.
 */
export function attachment(groupName: string, day: string): string {
  // Characters that file systems refuse, and control characters, become "_".
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it removes
  const name = `${groupName.replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, "_").trim() || "group"}-${day}.csv`;
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/[%;\\"]/g, "_");
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/** The language asked for, else the user's own. */
export const exportLang = (asked: string | undefined, own: Lang): Lang => (isLang(asked) ? asked : own);
