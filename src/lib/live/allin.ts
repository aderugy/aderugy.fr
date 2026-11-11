/**
 * All-in EV: what a hand was worth when the money went in, rather than what
 * the board then gave. Pure functions.
 *
 * A hand counts when betting stopped with someone all-in before the river
 * (the rest of the board was just dealt: `end.runout`), Arthur was still in,
 * and every other seat still in showed its cards. Then, over every way the
 * rest of the board can come (exact enumeration, no sampling):
 *
 *   equity_p  = Arthur's average share of pot p (1 when he wins it alone,
 *               1/k when k seats tie, 0 when he loses)
 *   EV        = Σ_p equity_p × (amount_p − rake_p) − what Arthur put in
 *   luck      = actual net − EV
 *
 * `amount_p − rake_p` is the pot the winner really takes. The room's rake
 * depends only on the total pot, which is fixed once everyone is all-in, so it
 * is the same whatever the runout and comes off the main pot first, exactly as
 * settle() takes it. The money nobody called goes back to its owner and is in
 * no pot. Cards known to be out of the deck — Arthur's, the board dealt so far,
 * every card shown, folded hands included — are left out of the runouts.
 *
 * A session's all-in EV adjusted result is its real result minus the luck of
 * its hands: cash-out − buy-ins − Σ (net − EV).
 */

import { settle, type HandState, type PlayResult } from "./hand";
import type { RakeRule } from "./rake";
import { BOARD_SIZE, splitCards, type Street } from "./types";

export type AllIn = {
  /** The street the money went in on. */
  street: Street;
  /** Arthur's share of the pots he could win, weighted by what each is worth after rake. */
  equity: number;
  /** Expected net, after rake. */
  ev: number;
  /** Board runouts enumerated. */
  runouts: number;
};

const r2 = (x: number) => Math.round(x * 100) / 100;

/* ------------------------------------------------------------ evaluator */

const RANKS = "23456789TJQKA";
const SUITS = "shdc";

/** "Ah" → 0..51 (rank × 4 + suit). */
export function cardId(card: string): number {
  const r = RANKS.indexOf(card[0]);
  const s = SUITS.indexOf(card[1]);
  if (r < 0 || s < 0 || card.length !== 2) throw new Error(`"${card}" is not a card.`);
  return r * 4 + s;
}

const POP = new Uint8Array(8192);
const STRAIGHT = new Int8Array(8192);
for (let m = 0; m < 8192; m++) {
  let c = 0;
  for (let b = 0; b < 13; b++) if (m & (1 << b)) c++;
  POP[m] = c;
  let top = -1;
  for (let hi = 12; hi >= 4 && top < 0; hi--) if (((m >> (hi - 4)) & 31) === 31) top = hi;
  // The wheel: A-2-3-4-5, its top card the five.
  if (top < 0 && (m & 0b1000000001111) === 0b1000000001111) top = 3;
  STRAIGHT[m] = top;
}

const CAT = 1 << 20;

/** The `n` highest ranks set in `mask`, packed four bits each. */
function kickers(mask: number, n: number): number {
  let v = 0;
  let k = 0;
  for (let r = 12; r >= 0 && k < n; r--) {
    if (mask & (1 << r)) {
      v = (v << 4) | r;
      k++;
    }
  }
  return v << (4 * (5 - n));
}

const counts = new Uint8Array(13);

/** A comparable value for the best five of these cards (5 to 7): higher wins. */
export function handValue(cards: ArrayLike<number>, n = cards.length): number {
  let s0 = 0, s1 = 0, s2 = 0, s3 = 0;
  counts.fill(0);
  for (let i = 0; i < n; i++) {
    const c = cards[i];
    const r = c >> 2;
    const bit = 1 << r;
    switch (c & 3) {
      case 0: s0 |= bit; break;
      case 1: s1 |= bit; break;
      case 2: s2 |= bit; break;
      default: s3 |= bit;
    }
    counts[r]++;
  }
  const flush = POP[s0] >= 5 ? s0 : POP[s1] >= 5 ? s1 : POP[s2] >= 5 ? s2 : POP[s3] >= 5 ? s3 : 0;
  if (flush && STRAIGHT[flush] >= 0) return 8 * CAT + (STRAIGHT[flush] << 16);

  const all = s0 | s1 | s2 | s3;
  let quad = -1, trip1 = -1, trip2 = -1, pair1 = -1, pair2 = -1, pair3 = -1;
  for (let r = 12; r >= 0; r--) {
    const k = counts[r];
    if (k === 4) quad = r;
    else if (k === 3) {
      if (trip1 < 0) trip1 = r;
      else if (trip2 < 0) trip2 = r;
    } else if (k === 2) {
      if (pair1 < 0) pair1 = r;
      else if (pair2 < 0) pair2 = r;
      else if (pair3 < 0) pair3 = r;
    }
  }
  if (quad >= 0) return 7 * CAT + (quad << 16) + kickers(all & ~(1 << quad), 1) / 16;
  if (trip1 >= 0 && (trip2 >= 0 || pair1 >= 0)) return 6 * CAT + (trip1 << 16) + (Math.max(trip2, pair1) << 12);
  if (flush) return 5 * CAT + kickers(flush, 5);
  if (STRAIGHT[all] >= 0) return 4 * CAT + (STRAIGHT[all] << 16);
  if (trip1 >= 0) return 3 * CAT + (trip1 << 16) + kickers(all & ~(1 << trip1), 2) / 16;
  if (pair2 >= 0) {
    const rest = all & ~(1 << pair1) & ~(1 << pair2);
    return 2 * CAT + (pair1 << 16) + (pair2 << 12) + (kickers(rest, 1) >> 8);
  }
  if (pair1 >= 0) return 1 * CAT + (pair1 << 16) + kickers(all & ~(1 << pair1), 3) / 16;
  void pair3;
  return kickers(all, 5);
}

/* --------------------------------------------------------------- equity */

/**
 * Each seat's average share of each pot over every runout of the board.
 * `pots[i]` lists the seats eligible for pot i; the result is
 * `share[i].get(seat)`, between 0 and 1.
 */
export function potEquities(
  holes: Map<number, [number, number]>,
  board: number[],
  dead: number[],
  pots: number[][],
): { share: Map<number, number>[]; runouts: number } {
  const used = new Set<number>([...board, ...dead]);
  for (const [a, b] of holes.values()) {
    used.add(a);
    used.add(b);
  }
  const deck: number[] = [];
  for (let c = 0; c < 52; c++) if (!used.has(c)) deck.push(c);
  const need = 5 - board.length;
  if (need < 0) throw new Error("A board has five cards at most.");

  const seats = [...holes.keys()];
  const hand = new Int32Array(7);
  const values = new Map<number, number>();
  const share = pots.map(() => new Map<number, number>(seats.map((s) => [s, 0])));
  const full = new Array<number>(5);
  for (let i = 0; i < board.length; i++) full[i] = board[i];
  let runouts = 0;

  const score = () => {
    runouts++;
    for (const s of seats) {
      const [a, b] = holes.get(s)!;
      hand[0] = a;
      hand[1] = b;
      for (let i = 0; i < 5; i++) hand[2 + i] = full[i];
      values.set(s, handValue(hand, 7));
    }
    for (let p = 0; p < pots.length; p++) {
      let best = -1;
      let n = 0;
      for (const s of pots[p]) {
        const v = values.get(s)!;
        if (v > best) {
          best = v;
          n = 1;
        } else if (v === best) n++;
      }
      const m = share[p];
      for (const s of pots[p]) if (values.get(s) === best) m.set(s, m.get(s)! + 1 / n);
    }
  };

  const walk = (from: number, depth: number) => {
    if (depth === need) return score();
    for (let i = from; i <= deck.length - (need - depth); i++) {
      full[board.length + depth] = deck[i];
      walk(i + 1, depth + 1);
    }
  };
  walk(0, 0);

  for (const m of share) for (const [s, v] of m) m.set(s, v / runouts);
  return { share, runouts };
}

/* ---------------------------------------------------------------- hands */

export type AllInInput = {
  hero_seat: number | null;
  hero_cards: string | null;
  board: string[];
  /** Cards seen, by seat. */
  shown: Record<string, string>;
};

/**
 * The all-in EV of a hand, or null when it does not count: no all-in before
 * the river, Arthur not in at the end, or a seat still in whose cards are
 * not known.
 */
export function allInOf(hand: AllInInput, play: PlayResult, rake: RakeRule | null): AllIn | null {
  const state: HandState = play.state;
  const hero = hand.hero_seat;
  if (!state.end || state.end.reason !== "showdown" || !state.end.runout) return null;
  if (hero === null || play.steps.length === 0) return null;
  const heroCards = splitCards(hand.hero_cards);
  if (!heroCards) return null;

  const live = state.seats.filter((s) => !s.folded).map((s) => s.seat);
  if (!live.includes(hero) || live.length < 2) return null;

  const street = play.steps[play.steps.length - 1].street;
  const known = BOARD_SIZE[street];
  if (known >= 5 || hand.board.length < known) return null;

  const holes = new Map<number, [number, number]>();
  holes.set(hero, [cardId(heroCards[0]), cardId(heroCards[1])]);
  for (const seat of live) {
    if (seat === hero) continue;
    const c = splitCards(hand.shown[String(seat)]);
    if (!c) return null;
    holes.set(seat, [cardId(c[0]), cardId(c[1])]);
  }
  // Cards shown by seats that folded are out of the deck too.
  const dead: number[] = [];
  for (const [k, v] of Object.entries(hand.shown)) {
    if (live.includes(Number(k))) continue;
    const c = splitCards(v);
    if (c) dead.push(cardId(c[0]), cardId(c[1]));
  }

  // Pots and rake as settle() makes them; with no winner named, the pots that
  // are contested stay open and Arthur's net is minus what he put in, plus any
  // pot he alone could win.
  const base = settle(state, [], rake);
  const open = base.pots.map((p, i) => ({ p, i })).filter(({ p }) => p.eligible.length > 1 && p.eligible.includes(hero));
  if (open.length === 0) return null;

  const { share, runouts } = potEquities(
    holes,
    hand.board.slice(0, known).map(cardId),
    dead,
    open.map(({ p }) => p.eligible),
  );

  let ev = base.net.get(hero) ?? 0;
  let worth = 0;
  let expected = 0;
  open.forEach(({ p }, k) => {
    const net = p.amount - p.rake;
    const e = share[k].get(hero) ?? 0;
    ev += e * net;
    expected += e * net;
    worth += net;
  });
  return {
    street,
    equity: worth > 0 ? Math.round((expected / worth) * 10000) / 10000 : 0,
    ev: r2(ev),
    runouts,
  };
}

/** Read back a stored all-in, or null. */
export function asAllIn(raw: unknown): AllIn | null {
  if (!raw || typeof raw !== "object") return null;
  const v = raw as Record<string, unknown>;
  const ev = Number(v.ev);
  const equity = Number(v.equity);
  if (!Number.isFinite(ev) || !Number.isFinite(equity)) return null;
  const street = (["preflop", "flop", "turn", "river"] as const).find((s) => s === v.street) ?? "preflop";
  return { street, equity, ev, runouts: Number(v.runouts) || 0 };
}

/**
 * The luck in a set of hands: Σ (actual net − EV) over the hands with an
 * all-in EV and a known net. Subtract it from a result to get the all-in EV
 * adjusted result.
 */
export function allInLuck(hands: { hero_net: number | null; allin: AllIn | null }[]): { hands: number; luck: number } {
  let n = 0;
  let luck = 0;
  for (const h of hands) {
    if (!h.allin || h.hero_net === null) continue;
    n++;
    luck += h.hero_net - h.allin.ev;
  }
  return { hands: n, luck: r2(luck) };
}
