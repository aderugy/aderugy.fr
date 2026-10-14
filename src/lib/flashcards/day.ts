import { addDaysISO, fromWallTime, localDate, wallTime } from "@/lib/agenda/zoned";

/**
 * Review days. A review day starts at `dayStartsHour` in `timeZone` (4 h in
 * Paris by default), so a session after midnight still counts for the evening
 * before. Pure functions on Intl: right on a UTC server and across the
 * clock changes.
 */

type DayRule = { dayStartsHour: number; timeZone: string };

/** The review day an instant belongs to, "YYYY-MM-DD". */
export function reviewDay(instant: Date | number, rule: DayRule): string {
  const w = wallTime(instant, rule.timeZone);
  const date = localDate(instant, rule.timeZone);
  return w.hour < rule.dayStartsHour ? addDaysISO(date, -1) : date;
}

/** The instant a review day starts. */
export function dayStart(day: string, rule: DayRule): Date {
  const [year, month, d] = day.split("-").map(Number);
  return fromWallTime({ year, month, day: d, hour: rule.dayStartsHour }, rule.timeZone);
}

/** The instant the review day containing `instant` ends (= the next one starts). */
export function dayEnd(instant: Date | number, rule: DayRule): Date {
  return dayStart(addDaysISO(reviewDay(instant, rule), 1), rule);
}

/** Whole review days from `from` to `to` ("YYYY-MM-DD"), negative if earlier. */
export function daysBetween(from: string, to: string): number {
  const ms = Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`);
  return Math.round(ms / 86_400_000);
}

export { addDaysISO };
