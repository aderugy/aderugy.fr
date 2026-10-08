/**
 * How the backlog page orders, labels and filters tasks. Pure: the page and
 * its tests share it, and "today" is always passed in (a local calendar date,
 * "YYYY-MM-DD") so server and client render the same thing.
 */

import { addDaysISO, mondayOf } from "./zoned";

export type RankableTask = {
  priority: number;
  /** Stored as midnight UTC; only the date part means anything. */
  deadline: string | null;
  created_at: string;
};

/** Whole days from `today` to the deadline: 0 today, 1 tomorrow, -2 two days late. */
export function daysUntil(deadline: string, today: string): number {
  const d = Date.parse(`${deadline.slice(0, 10)}T00:00:00Z`);
  const t = Date.parse(`${today}T00:00:00Z`);
  return Math.round((d - t) / 86_400_000);
}

/**
 * How many priority levels a deadline is worth. A close deadline lifts a task
 * past others of a higher priority with no deadline: something Normal due
 * tomorrow comes before something High that can wait, but not before Urgent.
 */
export function deadlineBoost(days: number | null): number {
  if (days === null) return 0;
  if (days <= 0) return 2;
  if (days <= 2) return 1.5;
  if (days <= 7) return 1;
  if (days <= 14) return 0.5;
  return 0;
}

/** Lower is more urgent. Priority 1..4, minus the deadline's boost. */
export function urgency(task: RankableTask, today: string): number {
  const days = task.deadline ? daysUntil(task.deadline, today) : null;
  return task.priority - deadlineBoost(days);
}

export type SortKey = "smart" | "deadline" | "priority" | "recent";

export const SORT_LABELS: Record<SortKey, string> = {
  smart: "Smart",
  deadline: "Deadline",
  priority: "Priority",
  recent: "Newest",
};

const deadlineTime = (t: RankableTask) =>
  t.deadline ? Date.parse(t.deadline) : Number.POSITIVE_INFINITY;
const createdTime = (t: RankableTask) => Date.parse(t.created_at);

function byDeadline(a: RankableTask, b: RankableTask) {
  const da = deadlineTime(a);
  const db = deadlineTime(b);
  return da === db ? 0 : da < db ? -1 : 1;
}

export function comparator(key: SortKey, today: string) {
  return (a: RankableTask, b: RankableTask): number => {
    switch (key) {
      case "smart":
        return (
          urgency(a, today) - urgency(b, today) ||
          byDeadline(a, b) ||
          a.priority - b.priority ||
          createdTime(a) - createdTime(b)
        );
      case "deadline":
        return byDeadline(a, b) || a.priority - b.priority || createdTime(a) - createdTime(b);
      case "priority":
        return a.priority - b.priority || byDeadline(a, b) || createdTime(a) - createdTime(b);
      case "recent":
        return createdTime(b) - createdTime(a);
    }
  };
}

/* ------------------------------------------------------------ deadlines */

export type DeadlineTone = "overdue" | "soon" | "week" | "later";

const DAY_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Today", "Tomorrow", "2d late", "Fri", "Fri 23 Oct" — and how loud to show it. */
export function deadlineLabel(
  deadline: string,
  today: string,
): { text: string; tone: DeadlineTone } {
  const days = daysUntil(deadline, today);
  const date = deadline.slice(0, 10);
  const [y, m, d] = date.split("-").map(Number);
  const dow = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;

  if (days < -1) return { text: `${-days}d late`, tone: "overdue" };
  if (days === -1) return { text: "Yesterday", tone: "overdue" };
  if (days === 0) return { text: "Today", tone: "soon" };
  if (days === 1) return { text: "Tomorrow", tone: "soon" };
  if (days < 7) return { text: DAY_SHORT[dow], tone: days <= 2 ? "soon" : "week" };
  return {
    text: `${DAY_SHORT[dow]} ${d} ${MONTH_SHORT[m - 1]}`,
    tone: days <= 14 ? "week" : "later",
  };
}

export type DeadlineFilter = "all" | "overdue" | "week" | "dated" | "none";

export const DEADLINE_FILTER_LABELS: Record<DeadlineFilter, string> = {
  all: "Any",
  overdue: "Overdue",
  week: "Next 7 days",
  dated: "Has a deadline",
  none: "No deadline",
};

export function matchesDeadline(
  deadline: string | null,
  filter: DeadlineFilter,
  today: string,
): boolean {
  if (filter === "all") return true;
  if (filter === "none") return deadline === null;
  if (deadline === null) return false;
  if (filter === "dated") return true;
  const days = daysUntil(deadline, today);
  if (filter === "overdue") return days < 0;
  return days <= 7; // "week" keeps what is late as well: it is due before then too.
}

/** Shortcut dates for the editor's deadline field. */
export function deadlineShortcuts(today: string): { label: string; date: string }[] {
  const nextMonday = addDaysISO(mondayOf(today), 7);
  const friday = addDaysISO(mondayOf(today), 4);
  const out = [
    { label: "Today", date: today },
    { label: "Tomorrow", date: addDaysISO(today, 1) },
  ];
  if (friday > addDaysISO(today, 1)) out.push({ label: "Friday", date: friday });
  out.push({ label: "Next week", date: nextMonday });
  return out;
}

/* ------------------------------------------------------------ quick add */

export type QuickAddParse = {
  description: string;
  minutes: number | null;
  priority: number | null;
};

/**
 * Pulls inline shortcuts out of a quick-add line: a duration ("45m", "1h",
 * "1h30", "2h15m") and a priority ("!1".."!4"). Only whole words count, so
 * "h2o" or "x!2" stay in the description. The last one of each wins.
 */
export function parseQuickAdd(text: string): QuickAddParse {
  let minutes: number | null = null;
  let priority: number | null = null;
  const kept: string[] = [];

  for (const word of text.split(/\s+/).filter(Boolean)) {
    const p = /^!([1-4])$/.exec(word);
    if (p) {
      priority = Number(p[1]);
      continue;
    }
    const hm = /^(\d{1,2})h(?:(\d{1,2})m?)?$/i.exec(word);
    if (hm) {
      const total = Number(hm[1]) * 60 + Number(hm[2] ?? 0);
      if (total >= 5 && total <= 1440) {
        minutes = total;
        continue;
      }
    }
    const m = /^(\d{1,4})(?:m|min)$/i.exec(word);
    if (m) {
      const total = Number(m[1]);
      if (total >= 5 && total <= 1440) {
        minutes = total;
        continue;
      }
    }
    kept.push(word);
  }

  return { description: kept.join(" "), minutes, priority };
}
