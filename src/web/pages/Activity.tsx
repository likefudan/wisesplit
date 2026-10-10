import { useEffect, useState } from "preact/hooks";
import type { ActivityEntry, ActivityPage, ExpenseSnapshot } from "../../shared/activity";
import type { GroupDetail } from "../../shared/groups";
import { isMessageKey } from "../../shared/i18n";
import { formatAmount } from "../../shared/money";
import { api } from "../api";
import { ErrorMessage, Loading, useErrorText } from "../components";
import { formatDate, formatDay } from "../format";
import { useI18n } from "../i18n";

/** What happened in the group, newest first, a page at a time. */
export function ActivityList({ group }: { group: GroupDetail }) {
  const { t } = useI18n();
  const errorText = useErrorText();
  const [entries, setEntries] = useState<ActivityEntry[] | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const [next, setNext] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const path = `/api/groups/${encodeURIComponent(group.id)}/activity`;

  async function load(before: string | null) {
    setBusy(true);
    setError(null);
    try {
      const page = await api<ActivityPage>(before ? `${path}?before=${encodeURIComponent(before)}` : path);
      setEntries((list) => (before && list ? [...list, ...page.entries] : page.entries));
      setNames((known) => ({ ...known, ...page.names }));
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
      <h2>{t("activity.title")}</h2>
      {entries === null ? (
        error === null && <Loading />
      ) : entries.length === 0 ? (
        <p class="muted">{t("activity.empty")}</p>
      ) : (
        <ul class="activity-list">
          {entries.map((e) => (
            <ActivityRow key={e.id} entry={e} names={names} group={group} />
          ))}
        </ul>
      )}
      {error !== null && (
        <>
          <ErrorMessage>{errorText(error)}</ErrorMessage>
          <button type="button" class="button secondary" disabled={busy} onClick={() => load(entries ? next : null)}>
            {t("common.retry")}
          </button>
        </>
      )}
      {error === null && next && (
        <div class="actions list-more">
          <button type="button" class="button secondary" disabled={busy} onClick={() => load(next)}>
            {t("activity.more")}
          </button>
        </div>
      )}
    </section>
  );
}

function ActivityRow({
  entry: e,
  names,
  group,
}: {
  entry: ActivityEntry;
  names: Record<string, string>;
  group: GroupDetail;
}) {
  const { lang, t } = useI18n();
  const name = (id: string | null | undefined) => (id && names[id]) || t("activity.someone");
  const money = (units: number) => formatAmount(units, group.currency, lang);
  const actor = name(e.actorId);
  let text: string;
  let changes: string[] = [];
  switch (e.action) {
    case "group.created":
      text = t("activity.group.created", { actor });
      break;
    case "expense.added":
      text = t("activity.expense.added", { actor, description: e.data.description, amount: money(e.data.amount) });
      break;
    case "expense.deleted":
      text = t("activity.expense.deleted", { actor, description: e.data.description, amount: money(e.data.amount) });
      break;
    case "expense.edited":
      text = t("activity.expense.edited", { actor, description: e.data.description });
      changes = changeLines(e.data.before, e.data.after);
      break;
    case "member.added":
      text = t("activity.member.added", { actor, name: name(e.subjectId) });
      break;
    case "member.joined":
      text = t("activity.member.joined", { actor, name: name(e.data.invitedBy) });
      break;
    case "member.left":
      text = t("activity.member.left", { actor });
      break;
    case "member.removed":
      text = t("activity.member.removed", { actor, name: name(e.subjectId) });
      break;
    default:
      // Something a newer version of the site logs: this page has no words for it.
      return null;
  }

  function changeLines(before: Partial<ExpenseSnapshot>, after: Partial<ExpenseSnapshot>): string[] {
    const lines: string[] = [];
    const method = (m: string) => {
      const key = `splitMethod.${m}`;
      return isMessageKey(key) ? t(key) : m;
    };
    if (before.description !== undefined && after.description !== undefined)
      lines.push(
        t("activity.change.description", { before: `“${before.description}”`, after: `“${after.description}”` }),
      );
    if (before.amount !== undefined && after.amount !== undefined)
      lines.push(t("activity.change.amount", { before: money(before.amount), after: money(after.amount) }));
    if (before.paidBy !== undefined && after.paidBy !== undefined)
      lines.push(t("activity.change.paidBy", { before: name(before.paidBy), after: name(after.paidBy) }));
    if (before.date !== undefined && after.date !== undefined)
      lines.push(
        t("activity.change.date", { before: formatDay(before.date, lang), after: formatDay(after.date, lang) }),
      );
    if (before.splitMethod !== undefined && after.splitMethod !== undefined)
      lines.push(
        t("activity.change.splitMethod", { before: method(before.splitMethod), after: method(after.splitMethod) }),
      );
    if (before.shares && after.shares) {
      const was = before.shares;
      const will = after.shares;
      const ids = [...new Set([...Object.keys(was), ...Object.keys(will)])]
        .filter((id) => was[id] !== will[id])
        .sort((a, b) => name(a).localeCompare(name(b), lang));
      for (const id of ids)
        lines.push(
          t("activity.change.share", {
            name: name(id),
            before: id in was ? money(was[id]!) : "—",
            after: id in will ? money(will[id]!) : "—",
          }),
        );
    }
    return lines;
  }

  return (
    <li class="activity-row">
      <span>{text}</span>
      {changes.length > 0 && (
        <ul class="muted small activity-changes">
          {changes.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
      )}
      <span class="muted small">{formatDate(e.createdAt, lang)}</span>
    </li>
  );
}
