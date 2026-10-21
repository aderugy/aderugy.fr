import { dayEnd, reviewDay } from "./day";
import { recallNow } from "./scheduler";
import type { Card, Settings } from "./types";

/**
 * The review queue, as pure functions: the server builds it once per session
 * from the cards of a deck subtree and today's journal; the client consumes it
 * with `nextCard`, putting cards still in their steps back in on its own.
 */

/** Cards in their steps due within this window are shown rather than waited for. */
export const LEARN_AHEAD_MS = 20 * 60_000;

export type QueueInput = {
  cards: (Card & { note_created_at: string })[];
  /** Today's ratings (kind review): what was already introduced, reviewed, seen. */
  today: { card_id: string; note_id: string; state_before: string }[];
  settings: Settings;
  now: Date;
};

export type Queue = {
  /** Learning and relearning cards, by due time. */
  learning: Card[];
  /** Review cards due today, least likely to be recalled first, within the daily limit. */
  review: Card[];
  /** New cards, oldest note first, within the daily limit. */
  fresh: Card[];
  /** What the limits held back today, for the header. */
  heldBack: { review: number; fresh: number };
  /**
   * The cards behind those counts, in queue order. The limits are soft: the
   * session offers them once its own queue is done, after a warning.
   */
  extra: { review: Card[]; fresh: Card[] };
};

export function buildQueue({ cards, today, settings, now }: QueueInput): Queue {
  const day = reviewDay(now, settings);
  const end = dayEnd(now, settings).getTime();
  const nowMs = now.getTime();
  const buried = (c: Card) => c.buried_until !== null && c.buried_until >= day;

  const learning = cards
    .filter((c) => !c.suspended && (c.state === "learning" || c.state === "relearning"))
    .filter((c) => Date.parse(c.due) <= nowMs + LEARN_AHEAD_MS)
    .sort((a, b) => Date.parse(a.due) - Date.parse(b.due));

  // Siblings: one card per note per day among new and review cards.
  const seenNotes = new Set<string>([...today.map((r) => r.note_id), ...learning.map((c) => c.note_id)]);

  const reviewsDone = today.filter((r) => r.state_before === "review").length;
  const introduced = new Set(today.filter((r) => r.state_before === "new").map((r) => r.card_id)).size;
  const reviewRoom = Math.max(0, settings.reviewsPerDay - reviewsDone);
  const freshRoom = Math.max(0, settings.newPerDay - introduced);

  const dueReviews = cards
    .filter((c) => !c.suspended && !buried(c) && c.state === "review" && Date.parse(c.due) < end)
    .map((c) => ({ c, r: recallNow({ state: c.state, stability: c.stability, lastReview: c.last_review }, now) }))
    .sort((a, b) => a.r - b.r || Date.parse(a.c.due) - Date.parse(b.c.due))
    .map((x) => x.c);

  const review: Card[] = [];
  const reviewHeld: Card[] = [];
  for (const c of dueReviews) {
    if (seenNotes.has(c.note_id)) continue;
    if (review.length >= reviewRoom) {
      // One per note: a held card's siblings would wait anyway.
      seenNotes.add(c.note_id);
      reviewHeld.push(c);
      continue;
    }
    seenNotes.add(c.note_id);
    review.push(c);
  }

  const newCards = cards
    .filter((c) => !c.suspended && !buried(c) && c.state === "new")
    .sort((a, b) => a.note_created_at.localeCompare(b.note_created_at) || a.note_id.localeCompare(b.note_id) || a.ord - b.ord);

  const fresh: Card[] = [];
  const freshHeld: Card[] = [];
  for (const c of newCards) {
    if (seenNotes.has(c.note_id)) continue;
    if (fresh.length >= freshRoom) {
      seenNotes.add(c.note_id);
      freshHeld.push(c);
      continue;
    }
    seenNotes.add(c.note_id);
    fresh.push(c);
  }

  return {
    learning,
    review,
    fresh,
    heldBack: { review: reviewHeld.length, fresh: freshHeld.length },
    extra: { review: reviewHeld, fresh: freshHeld },
  };
}

export type Pick<T> = { card: T; from: "learning" | "review" | "fresh" } | null;

/**
 * The next card: a step that is due, then a review, then a new card, then a
 * step due within the learn-ahead window. Null when the session is over.
 */
export function nextCard<T extends { due: string }>(
  q: { learning: T[]; review: T[]; fresh: T[] },
  now: Date,
): Pick<T> {
  const nowMs = now.getTime();
  const learning = [...q.learning].sort((a, b) => Date.parse(a.due) - Date.parse(b.due));
  if (learning[0] && Date.parse(learning[0].due) <= nowMs) return { card: learning[0], from: "learning" };
  if (q.review[0]) return { card: q.review[0], from: "review" };
  if (q.fresh[0]) return { card: q.fresh[0], from: "fresh" };
  if (learning[0] && Date.parse(learning[0].due) <= nowMs + LEARN_AHEAD_MS) return { card: learning[0], from: "learning" };
  return null;
}
