/**
 * Money and time of a live session, from its events. Pure functions.
 *
 * Time played is the sitting minus the breaks; a session still running
 * counts up to `now`. The result is only known once the session ends with a
 * cash-out.
 */

import type { LiveSession, SessionEvent } from "./types";

export type Break = { start: string; end: string | null };

export type SessionSummary = {
  invested: number;
  buyIns: number;
  rebuys: number;
  breaks: Break[];
  /** Set while on a break. */
  onBreakSince: string | null;
  breakMs: number;
  playedMs: number;
  /** cash-out − invested; null while the session runs. */
  net: number | null;
  /** Per hour played; null while running or under a minute played. */
  hourly: number | null;
  bbPerHour: number | null;
};

const r2 = (x: number) => Math.round(x * 100) / 100;

export function sortSessionEvents(events: SessionEvent[]): SessionEvent[] {
  return [...events].sort((a, b) => a.at.localeCompare(b.at));
}

export function breaksOf(events: SessionEvent[]): Break[] {
  const out: Break[] = [];
  for (const e of sortSessionEvents(events)) {
    const open = out.length && out[out.length - 1].end === null ? out[out.length - 1] : null;
    if (e.kind === "break_start" && !open) out.push({ start: e.at, end: null });
    if (e.kind === "break_end" && open) open.end = e.at;
  }
  return out;
}

export function summarize(
  session: Pick<LiveSession, "started_at" | "ended_at" | "cash_out" | "big_blind">,
  events: SessionEvent[],
  now: number = Date.now(),
): SessionSummary {
  let invested = 0;
  let buyIns = 0;
  let rebuys = 0;
  for (const e of events) {
    if (e.kind === "buy_in" || e.kind === "rebuy") invested += Number(e.amount ?? 0);
    if (e.kind === "buy_in") buyIns++;
    if (e.kind === "rebuy") rebuys++;
  }
  const end = session.ended_at ? Date.parse(session.ended_at) : now;
  const start = Date.parse(session.started_at);
  const breaks = breaksOf(events);
  let breakMs = 0;
  for (const b of breaks) {
    const s = Math.max(Date.parse(b.start), start);
    const e = Math.min(b.end ? Date.parse(b.end) : end, end);
    breakMs += Math.max(0, e - s);
  }
  const open = breaks.length && breaks[breaks.length - 1].end === null ? breaks[breaks.length - 1] : null;
  const playedMs = Math.max(0, end - start - breakMs);
  const net = session.ended_at && session.cash_out !== null ? r2(Number(session.cash_out) - invested) : null;
  const hours = playedMs / 3_600_000;
  const hourly = net !== null && playedMs >= 60_000 ? r2(net / hours) : null;
  const bb = Number(session.big_blind);
  return {
    invested: r2(invested),
    buyIns,
    rebuys,
    breaks,
    onBreakSince: !session.ended_at && open ? open.start : null,
    breakMs,
    playedMs,
    net,
    hourly,
    bbPerHour: hourly !== null && bb > 0 ? r2(hourly / bb) : null,
  };
}

export type Totals = { sessions: number; net: number; playedMs: number; hourly: number | null };

/** Over finished sessions only: a running one has no result yet. */
export function totals(summaries: SessionSummary[]): Totals {
  const done = summaries.filter((s) => s.net !== null);
  const net = r2(done.reduce((t, s) => t + s.net!, 0));
  const playedMs = done.reduce((t, s) => t + s.playedMs, 0);
  return { sessions: done.length, net, playedMs, hourly: playedMs >= 60_000 ? r2(net / (playedMs / 3_600_000)) : null };
}

/** 7_500_000 → "2h05", 300_000 → "5 min" */
export function fmtDuration(ms: number): string {
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return `${h}h${String(min % 60).padStart(2, "0")}`;
}
