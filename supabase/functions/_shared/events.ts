/**
 * Pure mapping between Google's event shape and our `external_events` rows.
 *
 * No Deno or network APIs here on purpose: this is the part worth testing, and
 * it runs the same under Deno and Node.
 */

export type GoogleEvent = {
  id: string;
  status?: string;
  summary?: string;
  transparency?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  attendees?: { self?: boolean; responseStatus?: string }[];
};

export type ExternalEventRow = {
  user_id: string;
  google_calendar_id: string;
  google_event_id: string;
  title: string | null;
  starts_at: string;
  ends_at: string;
  all_day: boolean;
  status: string;
  transparency: string;
  attendee_response: string | null;
  updated_at: string;
};

/** How the caller should treat one entry from an events.list page. */
export type Mapped =
  | { action: "delete"; eventId: string }
  | { action: "upsert"; row: ExternalEventRow };

/**
 * All-day events carry a bare `YYYY-MM-DD` with no zone, and Google's end date
 * is exclusive. We anchor them at UTC midnight and keep `all_day` true: the UI
 * reads only the date parts for these, so no zone conversion can shift the day.
 * Timed events keep their real instants.
 */
export function mapEvent(
  userId: string,
  calendarId: string,
  event: GoogleEvent,
): Mapped | null {
  if (!event.id) return null;

  // Incremental syncs report deletions as cancelled entries.
  if (event.status === "cancelled") {
    return { action: "delete", eventId: event.id };
  }

  const allDay = Boolean(event.start?.date);

  const startRaw = event.start?.dateTime ?? event.start?.date;
  const endRaw = event.end?.dateTime ?? event.end?.date;
  if (!startRaw || !endRaw) return null; // nothing usable to place on a grid

  const starts = allDay ? `${startRaw}T00:00:00Z` : startRaw;
  const ends = allDay ? `${endRaw}T00:00:00Z` : endRaw;

  const startsAt = new Date(starts);
  const endsAt = new Date(ends);
  if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())) return null;
  if (endsAt <= startsAt) return null;

  const self = event.attendees?.find((a) => a.self);

  return {
    action: "upsert",
    row: {
      user_id: userId,
      google_calendar_id: calendarId,
      google_event_id: event.id,
      title: event.summary ?? null,
      starts_at: startsAt.toISOString(),
      ends_at: endsAt.toISOString(),
      all_day: allDay,
      status: event.status ?? "confirmed",
      transparency: event.transparency ?? "opaque",
      attendee_response: self?.responseStatus ?? null,
      updated_at: new Date().toISOString(),
    },
  };
}

export function mapPage(
  userId: string,
  calendarId: string,
  items: GoogleEvent[],
): { upserts: ExternalEventRow[]; deletes: string[] } {
  const upserts: ExternalEventRow[] = [];
  const deletes: string[] = [];

  for (const item of items) {
    const mapped = mapEvent(userId, calendarId, item);
    if (!mapped) continue;
    if (mapped.action === "delete") deletes.push(mapped.eventId);
    else upserts.push(mapped.row);
  }

  return { upserts, deletes };
}
