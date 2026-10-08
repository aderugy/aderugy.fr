/**
 * What a block reminder says. Pure, like `push-events.ts`, whose title it
 * reuses so the lock screen and the Google event name a block the same way.
 */
import { titleFor, type PushBlock } from "./push-events.ts";

export type ReminderPayload = {
  title: string;
  body: string;
  /** Replaces an earlier notification for the same block (a moved block). */
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
  block: PushBlock,
  { timeZone, now = new Date() }: { timeZone: string; now?: Date },
): ReminderPayload {
  const when = `${clock(block.starts_at, timeZone)}–${clock(block.ends_at, timeZone)} · ${until(block.starts_at, now)}`;

  // The title already names the template or the categories; the tasks' own
  // descriptions are what tells two "poker" blocks apart. Three lines at most:
  // a lock screen shows little more.
  const tasks = [...block.tasks]
    .sort((a, b) => a.position - b.position)
    .map((t) => t.description?.trim())
    .filter(Boolean) as string[];
  const shown = tasks.slice(0, 3).map((t) => `• ${t}`);
  if (tasks.length > 3) shown.push(`+${tasks.length - 3} more`);

  return {
    title: titleFor(block),
    body: [when, ...shown].join("\n"),
    tag: `block-${block.id}`,
    url: "/agenda",
  };
}

export const TEST_REMINDER: ReminderPayload = {
  title: "Notifications are on",
  body: "Blocks on your agenda will remind you here before they start.",
  tag: "test",
  url: "/agenda/settings",
};
