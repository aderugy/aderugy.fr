/**
 * A week of the planner as data, for the Claude connector: what is on the
 * grid, what the calendars committed, where the gaps are, and how the time
 * splits between categories. Pure functions; times are instants (ms) and
 * local dates ("YYYY-MM-DD") in the app's zone.
 */

import { addDaysISO, startOfLocalDay } from "./zoned";

export type Span = { start: number; end: number };

export type ViewTask = {
  task_id: string;
  category_id: string;
  description: string | null;
  minutes: number;
  ad_hoc: boolean;
};

export type ViewBlock = {
  id: string;
  starts_at: string;
  ends_at: string;
  description: string | null;
  status: "planned" | "done" | "skipped";
  created_by: "app" | "claude";
  template: string | null;
  tasks: ViewTask[];
  /** "Technical interview · Betclic", when the block holds one. */
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

/** What occupies time: blocks not skipped, and timed calendar events. */
export function busySpans(blocks: ViewBlock[], events: ViewEvent[], exceptBlockId?: string): (Span & { label: string })[] {
  const out: (Span & { label: string })[] = [];
  for (const b of blocks) {
    if (b.status === "skipped" || b.id === exceptBlockId) continue;
    out.push({ start: Date.parse(b.starts_at), end: Date.parse(b.ends_at), label: blockLabel(b, null) });
  }
  for (const e of events) {
    if (e.all_day) continue;
    out.push({ start: Date.parse(e.starts_at), end: Date.parse(e.ends_at), label: `${e.calendar}${e.title ? `: ${e.title}` : ""}` });
  }
  return out;
}

/** A block's name: its template, its description, or what is inside. */
export function blockLabel(b: ViewBlock, paths: Map<string, string> | null): string {
  if (b.interview) return b.interview;
  if (b.template) return b.template;
  if (b.description) return b.description;
  if (b.tasks.length && paths) {
    const t = b.tasks[0];
    const leaf = paths.get(t.category_id) ?? "?";
    return t.description ? `${leaf} — ${t.description}` : leaf;
  }
  return "block";
}

/**
 * Minutes per category over a week, before rolling up the tree: tasks inside
 * blocks that are not skipped (each for its own planned minutes) and the
 * calendars' timed events, clipped to the week. `done` counts blocks marked
 * done.
 */
export function minutesByCategory(
  blocks: ViewBlock[],
  events: ViewEvent[],
  week: Span,
): { planned: Map<string, number>; done: Map<string, number>; external: Map<string, number> } {
  const planned = new Map<string, number>();
  const done = new Map<string, number>();
  const external = new Map<string, number>();
  const add = (m: Map<string, number>, k: string, v: number) => m.set(k, (m.get(k) ?? 0) + v);
  for (const b of blocks) {
    if (b.status === "skipped") continue;
    for (const t of b.tasks) {
      if (t.minutes <= 0) continue;
      add(planned, t.category_id, t.minutes);
      if (b.status === "done") add(done, t.category_id, t.minutes);
    }
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
