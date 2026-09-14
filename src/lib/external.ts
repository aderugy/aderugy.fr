import type { AllDayItem, CalendarSource, ExternalEvent, GridItem } from "./types";
import { DAY_END_MIN, DAY_START_MIN, clamp, dayIndexOf, minutesOfDay } from "./time";

/**
 * Does this mirrored event belong on the grid?
 *
 * `transparency: "transparent"` is the provider's own "show me as free", and a
 * declined invitation is not a commitment. Neither counts unless the calendar
 * says otherwise — the difference between a useful week and a wall of colour.
 */
export function countsAsCommitted(
  event: ExternalEvent,
  source: CalendarSource,
): boolean {
  if (!source.enabled) return false;
  if (event.status === "cancelled") return false;
  if (!source.include_free && event.transparency !== "opaque") return false;
  if (!source.include_declined && event.attendee_response === "declined") return false;
  return true;
}

/**
 * Split external events into timed grid items and all-day chips.
 *
 * An event can straddle midnight, so one event may produce several grid items —
 * an overnight session must darken the end of one day and the start of the next.
 */
export function externalItems(
  events: ExternalEvent[],
  sources: CalendarSource[],
  weekStart: Date,
): { items: GridItem[]; allDay: AllDayItem[] } {
  const byId = new Map(sources.map((s) => [s.id, s]));
  const items: GridItem[] = [];
  const allDay: AllDayItem[] = [];

  for (const event of events) {
    const source = byId.get(event.calendar_source_id);
    if (!source || !countsAsCommitted(event, source)) continue;

    if (event.all_day) {
      if (!source.include_all_day) continue;
      // All-day boundaries are stored at UTC midnight precisely so the date
      // parts can be read back without a zone shifting the day.
      const start = new Date(event.starts_at);
      const end = new Date(event.ends_at);
      for (let cursor = new Date(start); cursor < end; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
        const local = new Date(
          cursor.getUTCFullYear(),
          cursor.getUTCMonth(),
          cursor.getUTCDate(),
        );
        const dayIndex = dayIndexOf(weekStart, local);
        if (dayIndex < 0) continue;
        allDay.push({
          id: `${event.calendar_source_id}:${event.external_event_id}:${dayIndex}`,
          dayIndex,
          label: source.display_name,
          title: event.title,
          color: source.color,
        });
      }
      continue;
    }

    const start = new Date(event.starts_at);
    const end = new Date(event.ends_at);

    const cursor = new Date(start);
    cursor.setHours(0, 0, 0, 0);

    let guard = 0;
    while (cursor < end && guard++ < 14) {
      const dayIndex = dayIndexOf(weekStart, cursor);
      const dayStart = new Date(cursor);
      const dayEnd = new Date(cursor);
      dayEnd.setDate(dayEnd.getDate() + 1);

      if (dayIndex >= 0) {
        const from = start > dayStart ? start : dayStart;
        const to = end < dayEnd ? end : dayEnd;

        const startMin = clamp(minutesOfDay(from), DAY_START_MIN, DAY_END_MIN);
        // Midnight reads as minute 0, which would collapse a segment running to
        // the end of the day; treat it as the bottom of the grid instead.
        const rawEnd = to.getTime() === dayEnd.getTime() ? DAY_END_MIN : minutesOfDay(to);
        const endMin = clamp(rawEnd, DAY_START_MIN, DAY_END_MIN);

        if (endMin > startMin) {
          const segmentStart = new Date(dayStart);
          segmentStart.setHours(0, startMin, 0, 0);
          const segmentEnd = new Date(dayStart);
          segmentEnd.setHours(0, endMin, 0, 0);

          items.push({
            id: `${event.calendar_source_id}:${event.external_event_id}:${dayIndex}`,
            kind: "external",
            startsAt: segmentStart.toISOString(),
            endsAt: segmentEnd.toISOString(),
            // The calendar names it; the event describes it.
            label: source.display_name,
            description: event.title,
            color: source.color,
            done: false,
            movable: false,
          });
        }
      }

      cursor.setDate(cursor.getDate() + 1);
    }
  }

  return { items, allDay };
}

/** Merge overlapping spans so shared time is never counted twice. */
export function mergeSpans(spans: { startMin: number; endMin: number }[]) {
  const sorted = [...spans].sort((a, b) => a.startMin - b.startMin);
  const merged: { startMin: number; endMin: number }[] = [];

  for (const span of sorted) {
    const last = merged[merged.length - 1];
    if (last && span.startMin <= last.endMin) {
      last.endMin = Math.max(last.endMin, span.endMin);
    } else {
      merged.push({ ...span });
    }
  }
  return merged;
}

/**
 * Minutes per category for the week, counting both what you planned and what
 * your calendars already committed.
 */
export function externalMinutesByCategory(
  events: ExternalEvent[],
  sources: CalendarSource[],
  weekStart: Date,
): Map<string, number> {
  const byId = new Map(sources.map((s) => [s.id, s]));
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 7);

  const out = new Map<string, number>();

  for (const event of events) {
    const source = byId.get(event.calendar_source_id);
    if (!source?.category_id || !countsAsCommitted(event, source)) continue;
    if (event.all_day) continue;

    // Clipped to the week: an overnight event on the boundary contributes only
    // the part that falls inside it.
    const start = Math.max(new Date(event.starts_at).getTime(), weekStart.getTime());
    const end = Math.min(new Date(event.ends_at).getTime(), weekEnd.getTime());
    if (end <= start) continue;

    const minutes = Math.round((end - start) / 60_000);
    out.set(source.category_id, (out.get(source.category_id) ?? 0) + minutes);
  }

  return out;
}
