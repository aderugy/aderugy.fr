/**
 * Wall-clock time in a named zone, for code that runs on a server in UTC (the
 * Claude connector) but talks in Arthur's local time. The planner's own
 * helpers in lib/time.ts work in the *runtime's* zone, which is right in the
 * browser and wrong on Vercel.
 *
 * Pure functions on Intl; nothing here reads the runtime's zone.
 */

const PARTS_CACHE = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = PARTS_CACHE.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
    });
    PARTS_CACHE.set(timeZone, f);
  }
  return f;
}

export type WallTime = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0 = Monday … 6 = Sunday */
  weekday: number;
};

const WEEKDAYS: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };

/** What a clock in `timeZone` reads at `instant`. */
export function wallTime(instant: Date | number, timeZone: string): WallTime {
  const parts = formatter(timeZone).formatToParts(new Date(instant));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "0";
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")),
    minute: Number(get("minute")),
    second: Number(get("second")),
    weekday: WEEKDAYS[get("weekday")] ?? 0,
  };
}

/** The zone's offset from UTC at `instant`, in milliseconds (+2h in Paris in summer). */
export function offsetMs(instant: Date | number, timeZone: string): number {
  const t = new Date(instant).getTime();
  const w = wallTime(t, timeZone);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return asUtc - Math.floor(t / 1000) * 1000;
}

/**
 * The instant at which a clock in `timeZone` reads this wall time. In the
 * hour skipped when clocks go forward, the time is read with the offset from
 * before the change (02:30 → 03:30); in the hour that repeats when they go
 * back, the first of the two is taken.
 */
export function fromWallTime(
  w: { year: number; month: number; day: number; hour?: number; minute?: number },
  timeZone: string,
): Date {
  const hour = w.hour ?? 0;
  const minute = w.minute ?? 0;
  const guess = Date.UTC(w.year, w.month - 1, w.day, hour, minute);
  // Offsets well before and well after: any change of the day lies between.
  const before = guess - offsetMs(guess - 14 * 3_600_000, timeZone);
  const after = guess - offsetMs(guess + 14 * 3_600_000, timeZone);
  const reads = (t: number) => {
    const back = wallTime(t, timeZone);
    return back.hour === hour && back.minute === minute;
  };
  const valid = [before, after].filter(reads);
  // Repeated hour: both read right, the earlier wins. Skipped hour: neither
  // does, and the offset from before the change moves it forward.
  return new Date(valid.length ? Math.min(...valid) : before);
}

const LOCAL = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?)?$/;
const WITH_ZONE = /(Z|[+-]\d{2}:?\d{2})$/i;

/**
 * Read a time the way Claude writes one: "2026-10-09T18:00" is local time in
 * `timeZone`; a trailing Z or offset is taken as given; a bare date is
 * midnight. Null for anything else.
 */
export function parseLocal(raw: string, timeZone: string): Date | null {
  const s = raw.trim();
  if (WITH_ZONE.test(s)) {
    const t = Date.parse(s);
    return Number.isFinite(t) ? new Date(t) : null;
  }
  const m = LOCAL.exec(s);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m;
  const w = { year: +y, month: +mo, day: +d, hour: h ? +h : 0, minute: mi ? +mi : 0 };
  if (w.month < 1 || w.month > 12 || w.day < 1 || w.day > 31 || w.hour > 23 || w.minute > 59) return null;
  const out = fromWallTime(w, timeZone);
  // 2026-02-31 rolls over in Date.UTC: refuse it rather than move the day.
  const back = wallTime(out, timeZone);
  if (back.day !== w.day || back.month !== w.month) return null;
  return out;
}

/** "2026-10-09" — the local calendar day of an instant. */
export function localDate(instant: Date | number, timeZone: string): string {
  const w = wallTime(instant, timeZone);
  return `${w.year}-${String(w.month).padStart(2, "0")}-${String(w.day).padStart(2, "0")}`;
}

/** Add days to a "YYYY-MM-DD" date, as calendar arithmetic. */
export function addDaysISO(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}

/** Monday of the week containing this local date, "YYYY-MM-DD". */
export function mondayOf(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const dow = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
  return addDaysISO(date, -dow);
}

/** Local midnight of a "YYYY-MM-DD" date, as an instant. */
export function startOfLocalDay(date: string, timeZone: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  return fromWallTime({ year: y, month: m, day: d }, timeZone);
}

/** "18:05" */
export function fmtClock(instant: Date | string, timeZone: string): string {
  const w = wallTime(new Date(instant), timeZone);
  return `${String(w.hour).padStart(2, "0")}:${String(w.minute).padStart(2, "0")}`;
}

const DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Thursday 9 Oct" */
export function fmtDayHeading(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const dow = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
  return `${DAY_NAMES[dow]} ${d} ${MONTHS[m - 1]}`;
}

/** "Thu 9 Oct 18:00" */
export function fmtWhen(instant: Date | string, timeZone: string): string {
  const date = localDate(new Date(instant), timeZone);
  return `${fmtDayHeading(date).replace(/^(\w{3})\w*/, "$1")} ${fmtClock(instant, timeZone)}`;
}

/** 90 → "1h30", 45 → "45 min", 120 → "2h" */
export function fmtMinutes(minutes: number): string {
  const m = Math.round(minutes);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h}h${String(r).padStart(2, "0")}` : `${h}h`;
}

/** Minutes past local midnight for an instant, on its local day. */
export function minutesIntoDay(instant: Date | string, timeZone: string): number {
  const w = wallTime(new Date(instant), timeZone);
  return w.hour * 60 + w.minute;
}
