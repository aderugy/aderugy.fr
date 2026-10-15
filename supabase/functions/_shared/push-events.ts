/**
 * Pure mapping from a session on the grid to the Google event that shows it.
 *
 * No Deno or network APIs here, for the same reason as `events.ts`: this is
 * the part worth testing, and it runs the same under Deno and Node.
 */

export type PushSession = {
  id: string;
  starts_at: string;
  ends_at: string;
  status: "planned" | "done" | "skipped" | string;
  /** The task's category leaf — what this slot counts as. */
  categoryName: string | null;
  /** The task's description: what distinguishes two slots of one category. */
  description: string | null;
  /** The task's Markdown notes, carried into the event body. */
  notes: string | null;
};

export type GoogleEventBody = {
  id: string;
  summary: string;
  description: string;
  start: { dateTime: string };
  end: { dateTime: string };
  status: "confirmed";
  transparency: "opaque" | "transparent";
  extendedProperties: { private: { agendaSessionId: string } };
  source?: { title: string; url: string };
};

/**
 * Google event ids are base32hex (`a-v`, `0-9`), 5 to 1024 characters. A uuid
 * without its dashes is lowercase hex, which is a subset — so the session id
 * itself is the event id, and a retried insert is recognised (409) instead of
 * creating a duplicate. A session that took over a block (migration 0027)
 * kept the block's id, so it updates the block's event in place.
 */
export function eventIdFor(sessionId: string): string {
  const id = sessionId.replaceAll("-", "").toLowerCase();
  if (!/^[0-9a-v]{5,1024}$/.test(id)) {
    throw new Error(`Session id ${sessionId} does not map to a valid event id`);
  }
  return id;
}

/** Google has no use for an essay in an event body. */
const MAX_NOTES = 4000;

/**
 * The same words the grid shows: the category leaf, then what the task is.
 * "✓" and "✕" mark a slot done or skipped, so the calendar keeps the history
 * the app keeps.
 */
export function titleFor(s: PushSession): string {
  const category = s.categoryName?.trim() || "";
  const description = s.description?.trim() || "";
  const base =
    category && description
      ? `${category} — ${description}`
      : category || description || "Planned task";

  if (s.status === "done") return `✓ ${base}`;
  if (s.status === "skipped") return `✕ ${base}`;
  return base;
}

export function bodyFor(s: PushSession, appUrl?: string | null): string {
  const notes = s.notes?.trim();
  const shown = notes
    ? notes.length > MAX_NOTES
      ? `${notes.slice(0, MAX_NOTES).trimEnd()}…`
      : notes
    : null;

  const footer = ["Planned in Agenda. Edit it there — changes made here are overwritten."];
  if (appUrl) footer.push(`${appUrl.replace(/\/$/, "")}/agenda`);

  return [...(shown ? [shown, ""] : []), ...footer].join("\n").trim();
}

export function eventFor(s: PushSession, appUrl?: string | null): GoogleEventBody {
  const starts = new Date(s.starts_at);
  const ends = new Date(s.ends_at);
  if (Number.isNaN(starts.getTime()) || Number.isNaN(ends.getTime()) || ends <= starts) {
    throw new Error(`Session ${s.id} has an invalid time range`);
  }

  const event: GoogleEventBody = {
    id: eventIdFor(s.id),
    summary: titleFor(s),
    description: bodyFor(s, appUrl),
    start: { dateTime: starts.toISOString() },
    end: { dateTime: ends.toISOString() },
    // Explicit, so an update revives an event deleted by hand in Google rather
    // than writing into a cancelled one.
    status: "confirmed",
    // A skipped slot is not time you are spending; don't let it make you look
    // busy to anyone checking your free/busy.
    transparency: s.status === "skipped" ? "transparent" : "opaque",
    extendedProperties: { private: { agendaSessionId: s.id } },
  };

  if (appUrl) {
    event.source = { title: "Agenda", url: `${appUrl.replace(/\/$/, "")}/agenda` };
  }
  return event;
}
