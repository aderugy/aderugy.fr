/**
 * Grid geometry and date helpers.
 *
 * Everything here works in the *runtime's local timezone*. Timestamps are stored
 * in Postgres as `timestamptz` (so absolute instants are unambiguous) and are
 * rendered back in local time. This is correct as long as planning and viewing
 * happen in the same zone, which is the case for a single-user planner.
 */

export const SLOT_MIN = 15;
export const DAY_START_MIN = 6 * 60; // 06:00
export const DAY_END_MIN = 23 * 60; // 23:00
export const SLOTS_PER_DAY = (DAY_END_MIN - DAY_START_MIN) / SLOT_MIN;
export const PX_PER_SLOT = 14; // 56px per hour
export const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n));
}

/** Monday 00:00 local time of the week containing `d`. */
export function startOfWeek(d: Date): Date {
  const out = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dow = (out.getDay() + 6) % 7; // 0 = Monday
  out.setDate(out.getDate() - dow);
  return out;
}

export function addDays(d: Date, n: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + n);
  return out;
}

/** `yyyy-mm-dd` built from *local* parts (never use toISOString here). */
export function toISODate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function fromISODate(s: string): Date {
  const [y, m, day] = s.split("-").map(Number);
  return new Date(y, m - 1, day);
}

/** Absolute Date for a slot on the grid. */
export function dateAt(weekStart: Date, dayIndex: number, minutes: number): Date {
  const d = addDays(weekStart, dayIndex);
  d.setHours(0, minutes, 0, 0);
  return d;
}

export function minutesOfDay(d: Date): number {
  return d.getHours() * 60 + d.getMinutes();
}

/** 0..6 for Mon..Sun, or -1 when the date falls outside the week. */
export function dayIndexOf(weekStart: Date, d: Date): number {
  const ms = d.getTime() - weekStart.getTime();
  const idx = Math.floor(ms / 86_400_000);
  return idx >= 0 && idx < 7 ? idx : -1;
}

export function snap(minutes: number): number {
  return Math.round(minutes / SLOT_MIN) * SLOT_MIN;
}

export function slotToY(minutes: number): number {
  return ((minutes - DAY_START_MIN) / SLOT_MIN) * PX_PER_SLOT;
}

export function yToMinutes(y: number): number {
  return DAY_START_MIN + Math.round(y / PX_PER_SLOT) * SLOT_MIN;
}

export function fmtTime(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export function fmtDuration(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h}h` : `${h}h${String(m).padStart(2, "0")}`;
}

/**
 * Monday of the week containing `d`, as `yyyy-mm-dd`, evaluated in `timeZone`.
 *
 * The server renders in UTC, so it cannot use local-time helpers to decide
 * which week to show — at 01:00 Paris on a Monday, UTC is still Sunday and the
 * user would land on last week. This resolves the date in the app's zone.
 */
export function isoWeekStartInTimeZone(d: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  }).formatToParts(d);

  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  const dowMap: Record<string, number> = {
    Mon: 0,
    Tue: 1,
    Wed: 2,
    Thu: 3,
    Fri: 4,
    Sat: 5,
    Sun: 6,
  };

  // Anchored in UTC purely as integer date arithmetic — no zone conversion.
  const anchor = new Date(
    Date.UTC(Number(get("year")), Number(get("month")) - 1, Number(get("day"))),
  );
  anchor.setUTCDate(anchor.getUTCDate() - dowMap[get("weekday")]);

  const p = (n: number) => String(n).padStart(2, "0");
  return `${anchor.getUTCFullYear()}-${p(anchor.getUTCMonth() + 1)}-${p(anchor.getUTCDate())}`;
}

export function fmtWeekRange(weekStart: Date): string {
  const end = addDays(weekStart, 6);
  const f = (d: Date) =>
    d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  return `${f(weekStart)} – ${f(end)} ${end.getFullYear()}`;
}
