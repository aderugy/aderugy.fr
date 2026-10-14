import {
  difficulteInitiale,
  intervalle,
  prochaineDifficulte,
  retrievabilite,
  stabiliteApresOubli,
  stabiliteApresSucces,
  stabiliteInitiale,
  type Note as FsrsRating,
} from "@/lib/maths/fsrs";
import { addDaysISO, dayStart, reviewDay } from "./day";
import type { Memory, Rating, Settings } from "./types";

/**
 * The flash-card scheduler: FSRS-4.5 from /maths for the memory model, plus
 * what a general-purpose deck needs on top — learning and relearning steps in
 * minutes, an adjustable target retention, review days that start at a set
 * hour, and leeches.
 *
 * FSRS only moves the memory state (stability S, difficulty D) on ratings at
 * least a review day apart. A new card takes its initial S and D from its
 * first rating; ratings during the learning steps then only move it through
 * the steps (FSRS-4.5 has no short-term model). A lapse updates S and D at
 * once, then the relearning steps run on that state.
 *
 *   state        Again              Hard                Good                     Easy
 *   new          init; step 1       init; step 1–2      init; step 2 or review   init; review
 *   learning     step 1             same step           next step or review      review
 *   review       FSRS lapse;        FSRS success        FSRS success             FSRS success
 *                relearning
 *   relearning   step 1             same step           next step or review      review
 *
 * Pure: the same card, rating, instant and settings give the same result.
 */

export type Outcome = {
  memory: Memory;
  /** Days since the previous rating, for the journal. */
  elapsedDays: number;
  /** Milliseconds from now until the card is due again (what the button shows). */
  inMs: number;
  /** The rating that crossed the leech threshold: suspend and tag. */
  leech: boolean;
};

const MINUTE = 60_000;

function clampStep(step: number, steps: number[]): number {
  return Math.min(Math.max(0, step), Math.max(0, steps.length - 1));
}

/** Delay of Hard at a step: halfway to the next step on the first, the step itself after. */
function hardDelay(steps: number[], step: number): number {
  if (step === 0) {
    if (steps.length > 1) return (steps[0] + steps[1]) / 2;
    return Math.min(steps[0] * 1.5, steps[0] + 1440);
  }
  return steps[step];
}

function elapsedDays(lastReview: string | null, now: Date): number {
  if (!lastReview) return 0;
  return Math.max(0, (now.getTime() - Date.parse(lastReview)) / 86_400_000);
}

/** Interval in days for a stability, at the target retention. At least 1. */
export function intervalDays(stability: number, settings: Settings): number {
  return intervalle(stability, settings.retention);
}

/** The instant a card `days` review days from today becomes due. */
function dueInDays(days: number, now: Date, settings: Settings): Date {
  return dayStart(addDaysISO(reviewDay(now, settings), days), settings);
}

function isLeech(lapses: number, threshold: number): boolean {
  if (lapses < threshold) return false;
  const every = Math.max(1, Math.ceil(threshold / 2));
  return (lapses - threshold) % every === 0;
}

/**
 * The four outcomes of rating a card now, keyed by rating. Hard ≤ Good < Easy
 * holds for every card that leaves the steps.
 */
export function preview(card: Memory, now: Date, settings: Settings): Record<Rating, Outcome> {
  const nowMs = now.getTime();
  const t = elapsedDays(card.lastReview, now);
  const base = {
    reps: card.reps + 1,
    lapses: card.lapses,
    lastReview: now.toISOString(),
  };

  const inSteps = (
    state: "learning" | "relearning",
    step: number,
    minutes: number,
    s: number,
    d: number,
    lapses = card.lapses,
  ): Memory => ({
    ...base,
    lapses,
    state,
    step,
    stability: s,
    difficulty: d,
    due: new Date(nowMs + minutes * MINUTE).toISOString(),
  });

  const inReview = (days: number, s: number, d: number, lapses = card.lapses): Memory => ({
    ...base,
    lapses,
    state: "review",
    step: 0,
    stability: s,
    difficulty: d,
    due: dueInDays(days, now, settings).toISOString(),
  });

  const outcome = (memory: Memory, leech = false): Outcome => ({
    memory,
    elapsedDays: t,
    inMs: Date.parse(memory.due) - nowMs,
    leech,
  });

  // Graduating from the steps: Good gets the FSRS interval, Easy at least a day more.
  const graduate = (s: number, d: number, easy: boolean, sGood = s): number => {
    const good = intervalDays(sGood, settings);
    const own = intervalDays(s, settings);
    return easy ? Math.max(own, good + 1) : own;
  };

  if (card.state === "new" || (card.state !== "review" && card.stability <= 0)) {
    const steps = settings.learningSteps;
    const init = (r: Rating) => ({ s: stabiliteInitiale(r as FsrsRating), d: difficulteInitiale(r as FsrsRating) });
    const a = init(1);
    const h = init(2);
    const g = init(3);
    const e = init(4);
    const good =
      steps.length > 1
        ? outcome(inSteps("learning", 1, steps[1], g.s, g.d))
        : outcome(inReview(graduate(g.s, g.d, false), g.s, g.d));
    return {
      1: outcome(inSteps("learning", 0, steps[0], a.s, a.d)),
      2: outcome(inSteps("learning", 0, hardDelay(steps, 0), h.s, h.d)),
      3: good,
      4: outcome(inReview(graduate(e.s, e.d, true, g.s), e.s, e.d)),
    };
  }

  if (card.state === "learning" || card.state === "relearning") {
    const steps = card.state === "learning" ? settings.learningSteps : settings.relearningSteps;
    const s = card.stability;
    const d = card.difficulty;
    if (steps.length === 0) {
      // Relearning steps removed in the settings while the card was in them.
      const r = outcome(inReview(graduate(s, d, false), s, d));
      return { 1: r, 2: r, 3: r, 4: outcome(inReview(graduate(s, d, true), s, d)) };
    }
    const step = clampStep(card.step, steps);
    const next = step + 1;
    return {
      1: outcome(inSteps(card.state, 0, steps[0], s, d)),
      2: outcome(inSteps(card.state, step, hardDelay(steps, step), s, d)),
      3:
        next < steps.length
          ? outcome(inSteps(card.state, next, steps[next], s, d))
          : outcome(inReview(graduate(s, d, false), s, d)),
      4: outcome(inReview(graduate(s, d, true), s, d)),
    };
  }

  // Review.
  const r = retrievabilite(t, card.stability);
  const nextD = (rating: Rating) => prochaineDifficulte(card.difficulty, rating as FsrsRating);
  const success = (rating: Rating) =>
    stabiliteApresSucces(card.stability, card.difficulty, r, rating as FsrsRating);

  const sHard = success(2);
  const sGood = success(3);
  const sEasy = success(4);
  let hard = intervalDays(sHard, settings);
  let good = intervalDays(sGood, settings);
  let easy = intervalDays(sEasy, settings);
  hard = Math.min(hard, good);
  good = Math.max(good, hard + 1);
  easy = Math.max(easy, good + 1);

  const lapses = card.lapses + 1;
  const sLapse = stabiliteApresOubli(card.stability, card.difficulty, r);
  const dLapse = nextD(1);
  const leech = isLeech(lapses, settings.leechThreshold);
  const relearn = settings.relearningSteps;
  const again =
    relearn.length > 0
      ? outcome(inSteps("relearning", 0, relearn[0], sLapse, dLapse, lapses), leech)
      : outcome(inReview(intervalDays(sLapse, settings), sLapse, dLapse, lapses), leech);

  return {
    1: again,
    2: outcome(inReview(hard, sHard, nextD(2))),
    3: outcome(inReview(good, sGood, nextD(3))),
    4: outcome(inReview(easy, sEasy, nextD(4))),
  };
}

/** Rate a card: its next state. */
export function schedule(card: Memory, rating: Rating, now: Date, settings: Settings): Outcome {
  return preview(card, now, settings)[rating];
}

/** Probability of recall now, for a card in review (1 for others). */
export function recallNow(card: Pick<Memory, "state" | "stability" | "lastReview">, now: Date): number {
  if (card.state !== "review" || !card.lastReview || card.stability <= 0) return 1;
  return retrievabilite(elapsedDays(card.lastReview, now), card.stability);
}

/** "1m", "10m", "6h", "3d", "1.5mo", "2.1y" — what a rating button shows. */
export function formatDelay(ms: number): string {
  const minutes = ms / MINUTE;
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const hours = minutes / 60;
  if (hours < 20) return `${Math.round(hours)}h`;
  const days = Math.max(1, Math.round(hours / 24));
  if (days < 30) return `${days}d`;
  if (days < 365) return `${trim(days / 30.4)}mo`;
  return `${trim(days / 365)}y`;
}

function trim(n: number): string {
  return n >= 10 ? String(Math.round(n)) : n.toFixed(1).replace(/\.0$/, "");
}
