/**
 * What the table shows between two of hero's decisions, one frame at a time:
 * each action with its chips going in, the bets swept into the pot when a
 * round closes, each card dealt, and how the hand ends. Built from the hand's
 * steps (each carries the state right after it). Pure functions only.
 */

import { fmtBb, other, type HandState, type LogEntry } from "../solver/gameState";
import type { Seat } from "../solver/seats";
import { STREET_LABELS, type ActionKind } from "../solver/types";
import type { Hand, Step } from "./play";

export type Frame = {
  state: HandState;
  /** Who just acted, shown by their seat. */
  bubble: { seat: Seat; text: string; kind: ActionKind } | null;
  /** The bets in front fly into the pot. */
  sweep: boolean;
  /** Board cards dealt on this frame. */
  dealt: string[];
  /** The hand is over on this frame: villain's cards may show, the pot goes to the winner. */
  end: boolean;
  /** One line saying what happens. */
  caption: string;
  ms: number;
};

const EPS = 1e-9;
const sum = (r: Record<string, number>) => Object.values(r).reduce((a, b) => a + (b ?? 0), 0);

/** "Bet 75% · 4.5" / "Call 4.5" / "Check". */
export function actionText(e: LogEntry): string {
  if (e.amountBb == null) return e.label;
  const amt = fmtBb(e.amountBb);
  if (e.allIn) return `${e.label} · all-in ${amt}`;
  return e.label.includes(amt) ? e.label : `${e.label} · ${amt}`;
}

/** The state right after an action that closed the round, bets still in front. */
function beforeSweep(before: HandState, after: HandState, e: LogEntry): HandState {
  const bets = { ...before.bets };
  if (e.amountBb != null) bets[e.seat] = e.amountBb;
  if (e.kind === "call" && e.amountBb != null) {
    const opp = other(after, e.seat);
    bets[opp] = Math.min(bets[opp] ?? 0, e.amountBb);
  }
  return { ...after, bets, center: after.center - sum(bets) };
}

function endCaption(state: HandState, heroSeat: Seat): string {
  const t = state.terminal;
  if (!t) return "";
  const who = (s: Seat) => (s === heroSeat ? "You" : s);
  if (t.kind === "fold") return `${who(t.winner)} win${t.winner === heroSeat ? "" : "s"} ${fmtBb(t.potBb)} bb`;
  if (t.kind === "allin") return `All-in and called — ${fmtBb(t.potBb)} bb`;
  return `Showdown — ${fmtBb(t.potBb)} bb`;
}

/**
 * The frames from `before` through `steps`. With `deal`, the hand is new:
 * the first frame deals it. The last frame shows the state after the last step.
 */
export function replayFrames(before: HandState, steps: Step[], heroSeat: Seat, opts: { deal?: boolean } = {}): Frame[] {
  const frames: Frame[] = [];
  const base = { bubble: null, sweep: false, dealt: [] as string[], end: false };
  const who = (s: Seat) => (s === heroSeat ? "You" : s);
  if (opts.deal) {
    frames.push({
      ...base,
      state: before,
      dealt: before.board,
      caption: before.board.length ? `New hand · ${STREET_LABELS[before.street]}` : "New hand",
      ms: 900,
    });
  }
  let prev = before;
  for (const step of steps) {
    const after = step.after;
    if (step.type === "card") {
      frames.push({ ...base, state: after, dealt: step.cards, caption: `${STREET_LABELS[after.street]} ${step.cards.join(" ")}`, ms: 950 });
      prev = after;
      continue;
    }
    const e = after.log[after.log.length - 1];
    if (!e || after.log.length === prev.log.length) {
      prev = after;
      continue;
    }
    const bubble = { seat: e.seat, text: actionText(e), kind: e.kind };
    const caption = `${who(e.seat)} ${actionText(e).toLowerCase()}`;
    const closed = sum(after.bets) < EPS && after.center > prev.center + EPS;
    if (closed) {
      const held = beforeSweep(prev, after, e);
      frames.push({ ...base, state: held, bubble, caption, ms: 850 });
      frames.push({ ...base, state: held, bubble, sweep: true, caption, ms: 450 });
      frames.push({ ...base, state: after, caption, ms: 250 });
    } else {
      frames.push({ ...base, state: after, bubble, caption, ms: 850 });
    }
    prev = after;
  }
  if (prev.terminal) {
    frames.push({ ...base, state: prev, end: true, caption: endCaption(prev, heroSeat), ms: 1400 });
  }
  return frames;
}

/** The frames for what happened after hero's decision `index` (−1: from the deal). */
export function framesAfter(hand: Hand, index: number): Frame[] {
  if (index < 0) {
    const firstHero = hand.steps.findIndex((s) => s.type === "hero");
    const before = firstHero < 0 ? hand.steps : hand.steps.slice(0, firstHero);
    return replayFrames(hand.startState, before, hand.heroSeat, { deal: true });
  }
  const at = hand.steps.findIndex((s) => s.type === "hero" && s.decision === index);
  const d = hand.decisions[index];
  if (at < 0 || !d) return [];
  const nextHero = hand.steps.findIndex((s, i) => i > at && s.type === "hero");
  return replayFrames(d.state, hand.steps.slice(at, nextHero < 0 ? undefined : nextHero), hand.heroSeat);
}
