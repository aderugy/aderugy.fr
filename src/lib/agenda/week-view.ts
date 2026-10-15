/**
 * A week of the planner as data, for the Claude connector: what is on the
 * grid, what the calendars committed, where the gaps are, and how the time
 * splits between categories. Pure functions; times are instants (ms) and
 * local dates ("YYYY-MM-DD") in the app's zone.
 */

import { addDaysISO, startOfLocalDay } from "./zoned";

export type Span = { start: number; end: number };

/** A session as the connector reads it: the slot and what its task says. */
export type ViewSession = {
  id: string;
  task_id: string;
  starts_at: string;
  ends_at: string;
  status: "planned" | "done" | "skipped";
  created_by: "app" | "claude";
  category_id: string;
  description: string | null;
  /** The task's own status (done, dropped…), which may differ from the slot's. */
  task_status: string;
  /** "Technical interview · Betclic", when the session holds one. */
  interview: string | null;
};

export type ViewEvent = {
  calendar: string;
  category_id: string | null;
  title: string | null;
  starts_at: string;
  ends_at: string;
  all_day: boolean;
  archived: boolean;
};

/** Merge spans that overlap or touch. Sorted by start. */
export function mergeSpans(spans: Span[]): Span[] {
  const sorted = spans.filter((s) => s.end > s.start).sort((a, b) => a.start - b.start);
  const out: Span[] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s.start <= last.end) last.end = Math.max(last.end, s.end);
    else out.push({ ...s });
  }
  return out;
}

/** The parts of `window` no busy span covers, at least `minMinutes` long. */
export function gaps(window: Span, busy: Span[], minMinutes: number): Span[] {
  const out: Span[] = [];
  let cursor = window.start;
  for (const b of mergeSpans(busy)) {
    if (b.end <= window.start || b.start >= window.end) continue;
    if (b.start > cursor) out.push({ start: cursor, end: Math.min(b.start, window.end) });
    cursor = Math.max(cursor, b.end);
    if (cursor >= window.end) break;
  }
  if (cursor < window.end) out.push({ start: cursor, end: window.end });
  return out.filter((g) => g.end - g.start >= minMinutes * 60_000);
}

/** What overlaps a span, among labelled spans. */
export function overlapping<T extends Span>(span: Span, others: T[]): T[] {
  return others.filter((o) => o.start < span.end && o.end > span.start);
}

/** What occupies time: sessions not skipped, and timed calendar events. */
export function busySpans(sessions: ViewSession[], events: ViewEvent[], exceptSessionId?: string): (Span & { label: string })[] {
  const out: (Span & { label: string })[] = [];
  for (const s of sessions) {
    if (s.status === "skipped" || s.id === exceptSessionId) continue;
    out.push({ start: Date.parse(s.starts_at), end: Date.parse(s.ends_at), label: sessionLabel(s, null) });
  }
  for (const e of events) {
    if (e.all_day) continue;
    out.push({ start: Date.parse(e.starts_at), end: Date.parse(e.ends_at), label: `${e.calendar}${e.title ? `: ${e.title}` : ""}` });
  }
  return out;
}

/** A session's name: its interview, or its task's category and description. */
export function sessionLabel(s: ViewSession, paths: Map<string, string> | null): string {
  if (s.interview) return s.interview;
  const leaf = paths?.get(s.category_id) ?? null;
  if (leaf && s.description) return `${leaf} — ${s.description}`;
  return leaf ?? s.description ?? "task";
}

/**
 * Minutes per category over a week, before rolling up the tree: sessions that
 * are not skipped (each for its own length, against its task's category) and
 * the calendars' timed events, clipped to the week. `done` counts sessions
 * marked done.
 */
export function minutesByCategory(
  sessions: ViewSession[],
  events: ViewEvent[],
  week: Span,
): { planned: Map<string, number>; done: Map<string, number>; external: Map<string, number> } {
  const planned = new Map<string, number>();
  const done = new Map<string, number>();
  const external = new Map<string, number>();
  const add = (m: Map<string, number>, k: string, v: number) => m.set(k, (m.get(k) ?? 0) + v);
  for (const s of sessions) {
    if (s.status === "skipped") continue;
    const minutes = Math.round((Date.parse(s.ends_at) - Date.parse(s.starts_at)) / 60_000);
    if (minutes <= 0) continue;
    add(planned, s.category_id, minutes);
    if (s.status === "done") add(done, s.category_id, minutes);
  }
  for (const e of events) {
    if (e.all_day || !e.category_id) continue;
    const s = Math.max(Date.parse(e.starts_at), week.start);
    const en = Math.min(Date.parse(e.ends_at), week.end);
    if (en > s) add(external, e.category_id, Math.round((en - s) / 60_000));
  }
  return { planned, done, external };
}

/** The seven local dates of the week starting on `monday`. */
export function weekDates(monday: string): string[] {
  return Array.from({ length: 7 }, (_, i) => addDaysISO(monday, i));
}

/** The week as an instant span: Monday 00:00 to the next Monday 00:00, local. */
export function weekSpan(monday: string, timeZone: string): Span {
  return {
    start: startOfLocalDay(monday, timeZone).getTime(),
    end: startOfLocalDay(addDaysISO(monday, 7), timeZone).getTime(),
  };
}

/**
 * The local dates an all-day event covers. All-day boundaries are stored at
 * UTC midnight, so the date parts are read in UTC; the end is exclusive.
 */
export function allDayDates(e: Pick<ViewEvent, "starts_at" | "ends_at">): string[] {
  const out: string[] = [];
  let d = e.starts_at.slice(0, 10);
  const end = e.ends_at.slice(0, 10);
  for (let i = 0; i < 60 && d < end; i++) {
    out.push(d);
    d = addDaysISO(d, 1);
  }
  return out.length ? out : [e.starts_at.slice(0, 10)];
}
