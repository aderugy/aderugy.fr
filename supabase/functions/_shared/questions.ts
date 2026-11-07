/**
 * What a phone notification says when Claude asks Arthur a question on a
 * research project (/projects, migration 0030). Pure, like reminders.ts.
 *
 * Only `question` messages ring: handoffs and closed steps wait until he
 * opens the app.
 */
import type { ReminderPayload } from "./reminders.ts";

export type QuestionMessage = {
  id: string;
  body: string;
  slug: string;
};

/** Markdown down to the first lines a lock screen can show. */
function plain(body: string): string {
  return body
    .split("\n")
    .map((l) => l.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "").replace(/^#+\s*/, "").replace(/[*_`]/g, "").trim())
    .filter(Boolean)
    .join("\n");
}

export function questionFor(m: QuestionMessage): ReminderPayload {
  const text = plain(m.body);
  return {
    title: `${m.slug} · question de Claude`,
    body: text.length > 180 ? `${text.slice(0, 179)}…` : text,
    tag: `question-${m.id}`,
    url: `/projects/${encodeURIComponent(m.slug)}#messages`,
  };
}

/** Questions older than this are left alone: no flood after a deploy or an outage. */
export const QUESTION_MAX_AGE_MS = 24 * 3600_000;
