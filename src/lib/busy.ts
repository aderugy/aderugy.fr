import type { ExternalEvent } from "./types";
import { DAY_END_MIN, DAY_START_MIN, clamp, dayIndexOf, minutesOfDay } from "./time";

export type BusyPreferences = {
  busyCalendarIds: string[];
  /** Declined invitations are not commitments. */
  includeDeclined: boolean;
  /** Most all-day entries are labels ("Semaine 42"), not blocked time. */
  includeAllDay: boolean;
};

export const DEFAULT_BUSY_PREFERENCES: Omit<BusyPreferences, "busyCalendarIds"> = {
  includeDeclined: false,
  includeAllDay: false,
};

/**
 * Which mirrored events actually block time.
 *
 * `transparency: "transparent"` is Google's own "show me as free" — honouring it
 * is the difference between a useful overlay and a wall of grey.
 */
export function isBusy(event: ExternalEvent, prefs: BusyPreferences): boolean {
  if (!prefs.busyCalendarIds.includes(event.google_calendar_id)) return false;
  if (event.status === "cancelled") return false;
  if (event.transparency !== "opaque") return false;
  if (event.all_day && !prefs.includeAllDay) return false;
  if (!prefs.includeDeclined && event.attendee_response === "declined") return false;
  return true;
}

export type BusySegment = {
  id: string;
  dayIndex: number;
  startMin: number;
  endMin: number;
  title: string | null;
};

/**
 * Cut busy events into per-day segments clipped to the visible grid.
 *
 * An event can straddle midnight, so one event may produce several segments —
 * an overnight flight must darken the end of one day and the start of the next.
 */
export function busySegments(
  events: ExternalEvent[],
  weekStart: Date,
  prefs: BusyPreferences,
): BusySegment[] {
  const segments: BusySegment[] = [];

  for (const event of events) {
    if (!isBusy(event, prefs)) continue;

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
        // Midnight reads as minute 0, which would collapse a segment that runs
        // to the end of the day; treat it as the bottom of the grid instead.
        const rawEnd = to.getTime() === dayEnd.getTime() ? DAY_END_MIN : minutesOfDay(to);
        const endMin = clamp(rawEnd, DAY_START_MIN, DAY_END_MIN);

        if (endMin > startMin) {
          segments.push({
            id: `${event.google_calendar_id}:${event.google_event_id}:${dayIndex}`,
            dayIndex,
            startMin,
            endMin,
            title: event.title,
          });
        }
      }

      cursor.setDate(cursor.getDate() + 1);
    }
  }

  return segments;
}

/** Merge overlapping segments so shared time is never counted twice. */
export function mergeSegments(segments: { startMin: number; endMin: number }[]) {
  const sorted = [...segments].sort((a, b) => a.startMin - b.startMin);
  const merged: { startMin: number; endMin: number }[] = [];

  for (const segment of sorted) {
    const last = merged[merged.length - 1];
    if (last && segment.startMin <= last.endMin) {
      last.endMin = Math.max(last.endMin, segment.endMin);
    } else {
      merged.push({ ...segment });
    }
  }
  return merged;
}

/** Busy minutes per weekday, overlaps counted once. */
export function busyMinutesByDay(segments: BusySegment[]): number[] {
  const byDay: BusySegment[][] = Array.from({ length: 7 }, () => []);
  for (const segment of segments) byDay[segment.dayIndex].push(segment);

  return byDay.map((day) =>
    mergeSegments(day).reduce((sum, s) => sum + (s.endMin - s.startMin), 0),
  );
}

/** True when a proposed block would land on committed time. */
export function overlapsBusy(
  segments: BusySegment[],
  dayIndex: number,
  startMin: number,
  endMin: number,
): boolean {
  return segments.some(
    (s) => s.dayIndex === dayIndex && s.startMin < endMin && startMin < s.endMin,
  );
}
