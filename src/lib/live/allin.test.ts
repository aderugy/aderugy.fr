/**
 * All-in EV: the evaluator against the slow reference, exact equities, and
 * the EV after rake of a few real hands. Run with `npm test`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { allInLuck, allInOf, cardId, handValue, potEquities } from "./allin";
import { bestScore, compareScores } from "./eval";
import { playHand } from "./hand";
import type { RakeRule } from "./rake";
import type { HandAction } from "./types";

const RAKE: RakeRule = { percent: 4, step: 0.5, cap: null, preflop: true };
const ids = (s: string) => (s.match(/../g) ?? []).map(cardId);
const seats = (nums: number[], stacks: Record<number, number> = {}) =>
  nums.map((seat) => ({ seat, player_id: null, stack: stacks[seat] ?? null }));

test("handValue orders hands exactly like bestScore", () => {
  const deck = [..."23456789TJQKA"].flatMap((r) => [..."shdc"].map((s) => r + s));
  let seed = 7;
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let i = 0; i < 20000; i++) {
    const d = [...deck];
    for (let j = d.length - 1; j > 0; j--) {
      const k = Math.floor(rand() * (j + 1));
      [d[j], d[k]] = [d[k], d[j]];
    }
    const board = d.slice(0, 5);
    const a = [...d.slice(5, 7), ...board];
    const b = [...d.slice(7, 9), ...board];
    const slow = Math.sign(compareScores(bestScore(a), bestScore(b)));
    const fast = Math.sign(handValue(a.map(cardId)) - handValue(b.map(cardId)));
    assert.equal(fast, slow, `${a.join(" ")} vs ${b.join(" ")}`);
  }
});

test("handValue: categories and the wheel", () => {
  const v = (s: string) => handValue(ids(s));
  assert.ok(v("As2d3c4h5s9dKc") < v("2s3d4c5h6s9dKc")); // wheel < six-high straight
  assert.ok(v("AhKhQhJhTh2c3d") > v("9s9d9c9hAs2c3d")); // royal > quads
  assert.ok(v("KsKdKc2s2d2c7h") > v("QsQdQcAsAd5c7h")); // KKK22 > QQQAA
  assert.ok(v("AsAd7c7h5s5dKc") > v("AsAd7c7hQs5d2c")); // two pair: the best kicker counts, the third pair is just a kicker
});

test("potEquities: suit-swapped hands split exactly", () => {
  const holes = new Map<number, [number, number]>([
    [1, [cardId("Ah"), cardId("Kh")]],
    [2, [cardId("Ad"), cardId("Kd")]],
  ]);
  const { share, runouts } = potEquities(holes, ids("2c7s9c"), [], [[1, 2]]);
  assert.equal(runouts, 990); // C(45, 2)
  assert.equal(share[0].get(1), 0.5);
  assert.equal(share[0].get(2), 0.5);
});

test("potEquities: AA against KK preflop", () => {
  const holes = new Map<number, [number, number]>([
    [1, [cardId("Ah"), cardId("As")]],
    [2, [cardId("Kd"), cardId("Kc")]],
  ]);
  const { share, runouts } = potEquities(holes, [], [], [[1, 2]]);
  assert.equal(runouts, 1712304); // C(48, 5)
  const e = share[0].get(1)!;
  assert.ok(e > 0.81 && e < 0.83, String(e));
  assert.ok(Math.abs(e + share[0].get(2)! - 1) < 1e-9);
});

test("allInOf: AA all-in preflop against KK, after rake", () => {
  // MP (5) raises, UTG1 (3) 4-bets, MP shoves 410, UTG1 calls: pot 825, rake 33.
  const actions: HandAction[] = [
    { seat: 3, kind: "call" },
    { seat: 4, kind: "call" },
    { seat: 5, kind: "raise", to: 20 },
    { seat: 6, kind: "fold" },
    { seat: 7, kind: "fold" },
    { seat: 8, kind: "fold" },
    { seat: 9, kind: "fold" },
    { seat: 1, kind: "fold" },
    { seat: 2, kind: "fold" },
    { seat: 3, kind: "raise", to: 160 },
    { seat: 4, kind: "fold" },
    { seat: 5, kind: "raise", to: 410, all_in: true },
    { seat: 3, kind: "call" },
  ];
  const play = playHand({ seats: seats([1, 2, 3, 4, 5, 6, 7, 8, 9], { 5: 410 }), button: 9, sb: 1, bb: 2 }, actions);
  assert.ok(play.ok, play.error ?? "");
  const a = allInOf({ hero_seat: 5, hero_cards: "AhAs", board: ["9s", "8h", "4d", "Jd", "Jh"], shown: { "3": "KdKc" } }, play, RAKE);
  assert.ok(a);
  assert.equal(a.street, "preflop");
  // EV = equity × (825 − 33) − 410.
  assert.ok(Math.abs(a.ev - (a.equity * 792 - 410)) < 0.1, JSON.stringify(a)); // equity is rounded to 4 digits
  assert.ok(a.ev > 230 && a.ev < 245, JSON.stringify(a));
});

test("allInOf: flop all-in, an uncalled excess goes back, a folded hand is dead", () => {
  // Hero 5 (QsJc) vs 9 (KsTc) on Ts 9c 4h; 9 has 100 behind preflop.
  const actions: HandAction[] = [
    { seat: 1, kind: "fold" },
    { seat: 2, kind: "fold" },
    { seat: 3, kind: "fold" },
    { seat: 4, kind: "fold" },
    { seat: 5, kind: "raise", to: 14 },
    { seat: 6, kind: "fold" },
    { seat: 7, kind: "fold" },
    { seat: 8, kind: "fold" },
    { seat: 9, kind: "call" },
    { seat: 9, kind: "check" },
    { seat: 5, kind: "bet", to: 15 },
    { seat: 9, kind: "raise", to: 86, all_in: true },
    { seat: 5, kind: "call" },
  ];
  const play = playHand({ seats: seats([8, 9, 1, 2, 3, 4, 5, 6, 7], { 9: 100, 5: 1200 }), button: 7, sb: 1, bb: 2 }, actions);
  assert.ok(play.ok, play.error ?? "");
  const hand = { hero_seat: 5, hero_cards: "QsJc", board: ["Ts", "9c", "4h", "Kd", "4d"], shown: { "9": "KsTc" } };
  const a = allInOf(hand, play, RAKE)!;
  assert.equal(a.street, "flop");
  assert.equal(a.runouts, 990);
  // Pot 201, rake 8.5 → 192.5 to the winner; hero put in 100.
  assert.ok(Math.abs(a.ev - (a.equity * 192.5 - 100)) < 0.05);
  // Knowing a folded seat held two eights takes them out of the deck.
  const b = allInOf({ ...hand, shown: { ...hand.shown, "1": "8h8d" } }, play, RAKE)!;
  assert.equal(b.runouts, 903); // C(43, 2)
  assert.notEqual(a.equity, b.equity);
});

test("allInOf: no all-in, or cards not known, is not counted", () => {
  const actions: HandAction[] = [
    { seat: 5, kind: "raise", to: 6 },
    { seat: 1, kind: "call" },
    { seat: 2, kind: "call" },
    { seat: 1, kind: "check" },
    { seat: 2, kind: "check" },
    { seat: 5, kind: "bet", to: 10 },
    { seat: 1, kind: "fold" },
    { seat: 2, kind: "fold" },
  ];
  const play = playHand({ seats: seats([1, 2, 5]), button: 5, sb: 1, bb: 2 }, actions);
  assert.equal(allInOf({ hero_seat: 5, hero_cards: "AsKd", board: ["2c", "3d", "4h"], shown: {} }, play, RAKE), null);

  const shove: HandAction[] = [
    { seat: 5, kind: "raise", to: 100, all_in: true },
    { seat: 1, kind: "call" },
    { seat: 2, kind: "fold" },
  ];
  const p2 = playHand({ seats: seats([1, 2, 5], { 5: 100 }), button: 5, sb: 1, bb: 2 }, shove);
  assert.equal(allInOf({ hero_seat: 5, hero_cards: "AsKd", board: [], shown: {} }, p2, RAKE), null);
  assert.ok(allInOf({ hero_seat: 5, hero_cards: "AsKd", board: [], shown: { "1": "QsQd" } }, p2, RAKE));
});

test("allInLuck: actual minus EV over the hands that count", () => {
  const r = allInLuck([
    { hero_net: -76, allin: { street: "preflop", equity: 0.3, ev: -30, runouts: 1 } },
    { hero_net: 382, allin: { street: "preflop", equity: 0.82, ev: 240, runouts: 1 } },
    { hero_net: 50, allin: null },
    { hero_net: null, allin: { street: "flop", equity: 0.5, ev: 0, runouts: 1 } },
  ]);
  assert.deepEqual(r, { hands: 2, luck: 96 });
});

test("facingOdds: the price of a call once the room takes its rake", async () => {
  const { facingOdds } = await import("./odds");
  // Button 1 folds, SB 5 raises to 14, BB 9 calls; flop: 5 checks, 9 bets 15, 5 to act.
  const play = playHand({ seats: seats([1, 5, 9], { 5: 100, 9: 1200 }), button: 1, sb: 1, bb: 2 }, [
    { seat: 1, kind: "fold" },
    { seat: 5, kind: "raise", to: 14 },
    { seat: 9, kind: "call" },
    { seat: 5, kind: "check" },
    { seat: 9, kind: "bet", to: 15 },
  ]);
  assert.ok(play.ok, play.error ?? "");
  const o = facingOdds(play.state, RAKE)!;
  // Pot 14 + 14 = 28, + 15 bet, + 15 call = 58; rake 4 % = 2.32 → 2.5; net 55.5.
  assert.equal(o.seat, 5);
  assert.equal(o.toCall, 15);
  assert.equal(o.potAfter, 58);
  assert.equal(o.rake, 2.5);
  assert.ok(Math.abs(o.need - 15 / 55.5) < 1e-9);
  // Without rake: 15 / 58.
  assert.ok(Math.abs(facingOdds(play.state, null)!.need - 15 / 58) < 1e-9);
  // Nobody facing a bet: no odds.
  const after = playHand({ seats: seats([1, 5, 9]), button: 1, sb: 1, bb: 2 }, [
    { seat: 1, kind: "fold" },
    { seat: 5, kind: "call" },
    { seat: 9, kind: "check" },
    { seat: 5, kind: "check" },
  ]);
  assert.equal(facingOdds(after.state, RAKE), null);
});
