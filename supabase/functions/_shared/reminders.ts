/**
 * What a reminder says. Pure, like `push-events.ts`, whose title it reuses so
 * the lock screen and the Google event name a slot the same way.
 */
import { titleFor, type PushSession } from "./push-events.ts";

export type ReminderPayload = {
  title: string;
  body: string;
  /** Replaces an earlier notification for the same slot (a moved slot). */
  tag: string;
  /** Opened on click, relative to the site. */
  url: string;
};

function clock(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone,
  }).format(new Date(iso));
}

function until(startsAt: string, now: Date): string {
  const minutes = Math.round((new Date(startsAt).getTime() - now.getTime()) / 60_000);
  if (minutes <= 0) return "now";
  if (minutes < 60) return `in ${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `in ${h} h ${String(m).padStart(2, "0")}` : `in ${h} h`;
}

export function reminderFor(
  session: PushSession,
  { timeZone, now = new Date() }: { timeZone: string; now?: Date },
): ReminderPayload {
  const when = `${clock(session.starts_at, timeZone)}–${clock(session.ends_at, timeZone)} · ${until(session.starts_at, now)}`;

  // The title names the category and the task. The first lines of the notes
  // say what to start with — three at most: a lock screen shows little more.
  const notes = (session.notes ?? "")
    .split("\n")
    .map((l) => l.replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, "").replace(/^#+\s*/, "").trim())
    .filter(Boolean);
  const shown = notes.slice(0, 3).map((t) => `• ${t}`);
  if (notes.length > 3) shown.push(`+${notes.length - 3} more`);

  return {
    title: titleFor(session),
    body: [when, ...shown].join("\n"),
    tag: `session-${session.id}`,
    url: "/agenda",
  };
}

export const TEST_REMINDER: ReminderPayload = {
  title: "Notifications are on",
  body: "Tasks on your agenda will remind you here before they start.",
  tag: "test",
  url: "/agenda/settings",
};
