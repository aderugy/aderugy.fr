/**
 * The step clock and the project stats of the research protocol (R22, metrics
 * #2, #13, #15). Pure: the data layer, the connector and the pages all derive
 * them from the same rows, and none of it is stored.
 */

import type { Item, Project, Step, StepStatus } from "./types";

/* --------------------------------------------------------------- minutes */

/** "40 min", "2h00", "-15 min", "-1h05". Same format as research_fmt_minutes (0030). */
export function fmtMinutes(minutes: number): string {
  const m = Math.round(minutes);
  const a = Math.abs(m);
  if (a < 60) return `${m} min`;
  return `${m < 0 ? "-" : ""}${Math.floor(a / 60)}h${String(a % 60).padStart(2, "0")}`;
}

/** Default cut line: 1.5 × budget, as the database fills it. */
export function defaultCut(budget: number): number {
  return Math.min(9000, Math.max(budget, Math.round(budget * 1.5)));
}

/** "40", "1h30", "1:30", "90m" → minutes; null when unreadable. */
export function parseMinutes(raw: string): number | null {
  const s = raw.trim().toLowerCase().replace(/\s+/g, "");
  if (!s) return null;
  const sign = s.startsWith("-") ? -1 : 1;
  const t = s.replace(/^[-+]/, "");
  let m: RegExpMatchArray | null;
  if ((m = t.match(/^(\d+)(?:min|m)?$/))) return sign * Number(m[1]);
  if ((m = t.match(/^(\d+)[h:](\d{0,2})(?:min|m)?$/))) return sign * (Number(m[1]) * 60 + Number(m[2] || 0));
  return null;
}

/* ----------------------------------------------------------------- clock */

/**
 * - ok: spent ≤ budget
 * - over: past the budget, within 20 %
 * - drift: more than 1.2 × the budget
 * - closing: at or past the cut line — closing actions only
 * The cut line can sit below 1.2 × budget; closing wins.
 */
export type ClockState = "ok" | "over" | "drift" | "closing";

export const DRIFT_FACTOR = 1.2;

export function clockState(spent: number, budget: number, cut: number): ClockState {
  if (spent >= cut) return "closing";
  if (spent > DRIFT_FACTOR * budget) return "drift";
  if (spent > budget) return "over";
  return "ok";
}

export type Clock = {
  spent: number;
  budget: number;
  cut: number;
  state: ClockState;
  /** Minutes before the budget; negative once past it. */
  leftBudget: number;
  /** Minutes before the cut line; negative once past it. */
  leftCut: number;
  /** Spent over budget, as a whole percentage (+21 means 21 % over). */
  overrunPct: number;
};

export function clockOf(spent: number, budget: number, cut: number): Clock {
  return {
    spent,
    budget,
    cut,
    state: clockState(spent, budget, cut),
    leftBudget: budget - spent,
    leftCut: cut - spent,
    overrunPct: Math.round(((spent - budget) / budget) * 100),
  };
}

export const CLOCK_LABELS: Record<ClockState, string> = {
  ok: "ok",
  over: "over",
  drift: "drift",
  closing: "closing",
};

/** Spent ÷ budget, two decimals. */
export function overrunRatio(spent: number, budget: number): number {
  return Math.round((spent / budget) * 100) / 100;
}

/* ------------------------------------------------------------ focus line */

export type FocusInput = {
  project: Pick<Project, "slug" | "status" | "next_action" | "next_action_minutes">;
  open: (Pick<Step, "code" | "title" | "budget_minutes" | "cut_minutes"> & { spent: number }) | null;
  /** Unread messages for whoever reads the line. */
  unread: number;
};

/**
 * One line, everywhere: write results of the connector, get_focus, the
 * project list and the Claude Code clock.
 *
 * MAD · 2.1 Ranger les données · ⏱ 3h10 / 2h00 (cut line 3h00) · closing · next: tables (≈ 40 min) · 2 messages
 */
export function focusLine({ project, open, unread }: FocusInput): string {
  const parts = [project.slug];
  if (project.status === "draft") parts.push("draft — contract not validated");
  else if (project.status !== "active") parts.push(project.status);

  if (open) {
    const c = clockOf(open.spent, open.budget_minutes, open.cut_minutes);
    parts.push(`${open.code} ${open.title}`);
    parts.push(`⏱ ${fmtMinutes(c.spent)} / ${fmtMinutes(c.budget)} (cut line ${fmtMinutes(c.cut)})`);
    parts.push(c.state === "over" || c.state === "drift" ? `${c.state} +${c.overrunPct} %` : c.state);
  } else if (project.status === "active") {
    parts.push("no open step");
  }

  if (project.next_action) {
    const d = project.next_action_minutes ? ` (≈ ${fmtMinutes(project.next_action_minutes)})` : "";
    parts.push(`next: ${project.next_action}${d}`);
  }
  if (unread > 0) parts.push(`${unread} message${unread > 1 ? "s" : ""}`);
  return parts.join(" · ");
}

/* ----------------------------------------------------------------- stats */

const CLOSED: StepStatus[] = ["done", "cut"];

export function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** `yyyy-mm-dd` of the Monday of the Paris week holding this instant. */
export function parisWeekStart(at: Date | string, timeZone = "Europe/Paris"): string {
  const d = typeof at === "string" ? new Date(at) : at;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const dow = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(get("weekday"));
  // Calendar arithmetic on the Paris date, in UTC so no offset can shift it.
  const day = new Date(Date.UTC(Number(get("year")), Number(get("month")) - 1, Number(get("day"))));
  day.setUTCDate(day.getUTCDate() - dow);
  return day.toISOString().slice(0, 10);
}

function addWeeks(isoMonday: string, n: number): string {
  const d = new Date(`${isoMonday}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 7 * n);
  return d.toISOString().slice(0, 10);
}

export type ProjectStats = {
  /** Median spent ÷ budget over closed steps (done or cut). */
  medianRatio: number | null;
  closedSteps: number;
  /** Share of closed steps that ended at their cut line. */
  shareCut: number | null;
  /** Steps closed per Paris week, oldest first: the current week and the 3 before. */
  stepsPerWeek: { week: string; count: number }[];
  /** Items raised as parked over the last 14 days, per day. */
  parkedPerDay: number;
  /** Share of those Claude raised. */
  parkedByClaude: number | null;
};

export const PARKED_WINDOW_DAYS = 14;

export function projectStats(
  steps: (Pick<Step, "status" | "budget_minutes" | "closed_at"> & { spent: number })[],
  items: Pick<Item, "created_as" | "origin" | "created_at">[],
  now: Date = new Date(),
): ProjectStats {
  const closed = steps.filter((s) => CLOSED.includes(s.status));
  const ratios = closed.map((s) => s.spent / s.budget_minutes);
  const m = median(ratios);

  const thisWeek = parisWeekStart(now);
  const weeks = [-3, -2, -1, 0].map((n) => addWeeks(thisWeek, n));
  const perWeek = new Map(weeks.map((w) => [w, 0]));
  for (const s of closed) {
    if (!s.closed_at) continue;
    const w = parisWeekStart(s.closed_at);
    if (perWeek.has(w)) perWeek.set(w, perWeek.get(w)! + 1);
  }

  const since = now.getTime() - PARKED_WINDOW_DAYS * 86_400_000;
  const parked = items.filter((i) => i.created_as === "park" && Date.parse(i.created_at) >= since);

  return {
    medianRatio: m === null ? null : Math.round(m * 100) / 100,
    closedSteps: closed.length,
    shareCut: closed.length ? closed.filter((s) => s.status === "cut").length / closed.length : null,
    stepsPerWeek: weeks.map((week) => ({ week, count: perWeek.get(week)! })),
    parkedPerDay: Math.round((parked.length / PARKED_WINDOW_DAYS) * 10) / 10,
    parkedByClaude: parked.length ? parked.filter((i) => i.origin === "claude").length / parked.length : null,
  };
}

export function pct(x: number | null): string {
  return x === null ? "—" : `${Math.round(x * 100)} %`;
}
