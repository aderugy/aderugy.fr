/**
 * Unit tests for /poker/live: the hand engine, the table log, money and time.
 * Run with `npm test`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyAction,
  clockwiseFrom,
  describeStep,
  foldsUntil,
  options,
  playHand,
  positions,
  potRaiseTo,
  settle,
  startHand,
  type HandSetup,
} from "./hand";
import { buttonFor, checkSeatEvent, dealtIn, heroSeatAt, nextButton, seatedTogether, tableAt } from "./table";
import { fmtDuration, summarize, totals } from "./session";
import type { HandAction, SeatEvent, SessionEvent } from "./types";
import { fmtMoney, isBlankUnknown, parseAmount, splitCards, unknownLabel, unknownName } from "./types";

const seats = (nums: number[], stacks: Record<number, number> = {}) =>
  nums.map((seat) => ({ seat, player_id: null, stack: stacks[seat] ?? null }));

const nine: HandSetup = { seats: seats([1, 2, 3, 4, 5, 6, 7, 8, 9]), button: 5, sb: 1, bb: 2 };

/* ------------------------------------------------------------ the engine */

test("clockwise order starts after the button and wraps", () => {
  assert.deepEqual(clockwiseFrom(5, [1, 3, 5, 7, 9]), [7, 9, 1, 3, 5]);
  assert.deepEqual(clockwiseFrom(9, [1, 3, 9]), [1, 3, 9]);
  // A dead button: seat 4 is empty.
  assert.deepEqual(clockwiseFrom(4, [1, 3, 5, 7]), [5, 7, 1, 3]);
});

test("blinds after the button, first to act after the big blind", () => {
  const s = startHand(nine);
  assert.equal(s.sbSeat, 6);
  assert.equal(s.bbSeat, 7);
  assert.equal(s.toAct, 8);
  assert.equal(s.currentBet, 2);
  assert.equal(s.street, "preflop");
});

test("position names around a 9-handed table", () => {
  const p = positions([1, 2, 3, 4, 5, 6, 7, 8, 9], 5);
  assert.deepEqual(
    [6, 7, 8, 9, 1, 2, 3, 4, 5].map((s) => p.get(s)),
    ["SB", "BB", "UTG", "UTG+1", "UTG+2", "LJ", "HJ", "CO", "BTN"],
  );
  const ten = positions([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 10);
  assert.equal(ten.get(5), "UTG+2");
  assert.equal(ten.get(6), "MP");
  assert.equal(ten.get(9), "CO");
});

test("folds to the button, raise, call, then a bet takes it down", () => {
  let s = startHand(nine);
  const folds = foldsUntil(s, 5)!;
  assert.deepEqual(folds.map((a) => a.seat), [8, 9, 1, 2, 3, 4]);
  for (const a of folds) s = applyAction(s, a).state;
  assert.equal(s.toAct, 5);
  assert.equal(potRaiseTo(s), 7, "a pot raise preflop is to 3.5 bb");
  s = applyAction(s, { seat: 5, kind: "raise", to: 6 }).state;
  s = applyAction(s, { seat: 6, kind: "fold" }).state;
  const r = applyAction(s, { seat: 7, kind: "call" });
  assert.equal(r.step.added, 4);
  assert.equal(describeStep(r.step), "calls 4");
  s = r.state;
  assert.equal(s.street, "flop");
  assert.equal(s.pot, 13);
  assert.equal(s.toAct, 7, "out of position acts first postflop");
  s = applyAction(s, { seat: 7, kind: "check" }).state;
  s = applyAction(s, { seat: 5, kind: "bet", to: 8 }).state;
  s = applyAction(s, { seat: 7, kind: "fold" }).state;
  assert.deepEqual(s.end, { reason: "fold", winner: 5 });

  const out = settle(s);
  assert.deepEqual(out.refund, { seat: 5, amount: 8 });
  assert.equal(out.net.get(5), 7);
  assert.equal(out.net.get(7), -6);
  assert.equal(out.net.get(6), -1);
});

test("the big blind has the option when everyone limps", () => {
  const setup: HandSetup = { seats: seats([2, 4, 6]), button: 2, sb: 1, bb: 2 };
  let s = startHand(setup);
  assert.equal(s.toAct, 2, "three-handed the button opens");
  s = applyAction(s, { seat: 2, kind: "call" }).state;
  s = applyAction(s, { seat: 4, kind: "call" }).state;
  assert.equal(s.toAct, 6);
  assert.equal(options(s)!.canCheck, true);
  s = applyAction(s, { seat: 6, kind: "check" }).state;
  assert.equal(s.street, "flop");
  assert.equal(s.pot, 6);
});

test("what cannot be done is refused with a sentence", () => {
  const s = startHand(nine);
  assert.throws(() => applyAction(s, { seat: 9, kind: "fold" }), /Seat 8 acts now/);
  assert.throws(() => applyAction(s, { seat: 8, kind: "check" }), /cannot check: 2 to call/);
  assert.throws(() => applyAction(s, { seat: 8, kind: "bet", to: 6 }), /that is a raise/);
  assert.throws(() => applyAction(s, { seat: 8, kind: "raise", to: 3 }), /minimum raise is to 4/);
  const raised = applyAction(s, { seat: 8, kind: "raise", to: 6 }).state;
  assert.throws(() => applyAction(raised, { seat: 9, kind: "raise", to: 9 }), /minimum raise is to 10/);
  assert.equal(options(raised)!.minTo, 10);
});

test("heads-up the button is the small blind and acts first preflop only", () => {
  let s = startHand({ seats: seats([3, 8]), button: 3, sb: 1, bb: 2 });
  assert.equal(s.sbSeat, 3);
  assert.equal(s.bbSeat, 8);
  assert.equal(s.toAct, 3);
  s = applyAction(s, { seat: 3, kind: "call" }).state;
  s = applyAction(s, { seat: 8, kind: "check" }).state;
  assert.equal(s.toAct, 8);
  const p = positions([3, 8], 3);
  assert.equal(p.get(3), "BTN");
  assert.equal(p.get(8), "BB");
});

test("a straddle acts last preflop and sets the minimum raise", () => {
  const s = startHand({ ...nine, straddle: 4 });
  assert.equal(s.straddleSeat, 8);
  assert.equal(s.toAct, 9);
  assert.equal(options(s)!.minTo, 8);
});

test("known stacks: all-ins, a run-out, a side pot", () => {
  const setup: HandSetup = { seats: seats([1, 2, 3], { 1: 50, 2: 100, 3: 200 }), button: 3, sb: 1, bb: 2 };
  const r = playHand(setup, [
    { seat: 3, kind: "raise", to: 200 },
    { seat: 1, kind: "call" },
    { seat: 2, kind: "call" },
  ]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.state.end, { reason: "showdown", runout: true });
  assert.equal(r.steps[0].allIn, true);
  assert.equal(describeStep(r.steps[1]), "calls 49 (all-in)");

  // Seat 1 has the best hand, seat 3 the second best.
  const out = settle(r.state, [[1], [3]]);
  assert.deepEqual(out.refund, { seat: 3, amount: 100 });
  assert.deepEqual(out.pots.map((p) => p.amount), [150, 100]);
  assert.deepEqual(out.pots.map((p) => p.eligible), [[1, 2, 3], [2, 3]]);
  assert.equal(out.net.get(1), 100);
  assert.equal(out.net.get(2), -100);
  assert.equal(out.net.get(3), 0);

  // Who won the side pot is not said: it stays unassigned.
  const half = settle(r.state, [[1]]);
  assert.deepEqual(half.pots[1].takers, []);
  assert.equal(half.net.get(3), -100);
});

test("a raise above the stack is refused; one equal to it is all-in", () => {
  const s = startHand({ seats: seats([1, 2], { 1: 30, 2: 500 }), button: 1, sb: 1, bb: 2 });
  assert.throws(() => applyAction(s, { seat: 1, kind: "raise", to: 40 }), /only 30/);
  const r = applyAction(s, { seat: 1, kind: "raise", to: 30 });
  assert.equal(r.step.allIn, true);
  assert.equal(options(r.state)!.toCall, 28);
});

test("all-in without a known stack ends the seat's betting", () => {
  const r = playHand({ seats: seats([1, 2, 3]), button: 1, sb: 1, bb: 2 }, [
    { seat: 1, kind: "raise", to: 80, all_in: true },
    { seat: 2, kind: "fold" },
    { seat: 3, kind: "call" },
  ]);
  assert.equal(r.ok, true);
  assert.equal(r.state.end?.reason, "showdown");
});

test("a split pot gives each winner half", () => {
  const r = playHand({ seats: seats([1, 2]), button: 1, sb: 1, bb: 2 }, [
    { seat: 1, kind: "call" },
    { seat: 2, kind: "check" },
    { seat: 2, kind: "check" },
    { seat: 1, kind: "check" },
    { seat: 2, kind: "check" },
    { seat: 1, kind: "check" },
    { seat: 2, kind: "check" },
    { seat: 1, kind: "check" },
  ]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.state.end, { reason: "showdown", runout: false });
  const out = settle(r.state, [[1, 2]]);
  assert.equal(out.net.get(1), 0);
  assert.equal(out.net.get(2), 0);
});

test("a bad action stops the replay where it is", () => {
  const actions: HandAction[] = [
    { seat: 8, kind: "fold" },
    { seat: 1, kind: "call" },
  ];
  const r = playHand(nine, actions);
  assert.equal(r.ok, false);
  assert.equal(r.failedAt, 1);
  assert.equal(r.steps.length, 1);
  assert.equal(r.state.toAct, 9);
});

/* --------------------------------------------------------------- table */

let n = 0;
const ev = (seat: number, kind: SeatEvent["kind"], at: string, player_id: string | null = null): SeatEvent => ({
  id: `e${++n}`,
  session_id: "s",
  seat,
  kind,
  player_id,
  at,
  created_at: `2026-10-07T00:00:00.${String(n).padStart(3, "0")}Z`,
});

test("the table is a fold over its log", () => {
  const log = [
    ev(4, "hero_move", "2026-10-07T18:00:00Z"),
    ev(2, "sit", "2026-10-07T18:00:00Z", "p1"),
    ev(7, "sit", "2026-10-07T18:00:00Z"),
    ev(2, "sit_out", "2026-10-07T19:00:00Z", "p1"),
    ev(7, "leave", "2026-10-07T19:30:00Z"),
    ev(7, "sit", "2026-10-07T19:45:00Z", "p2"),
    ev(1, "hero_move", "2026-10-07T20:00:00Z"),
  ];
  const at1830 = tableAt(log, "2026-10-07T18:30:00Z");
  assert.deepEqual([...at1830.keys()].sort(), [2, 7]);
  assert.equal(at1830.get(7)!.player_id, null);
  const now = tableAt(log);
  assert.equal(now.get(2)!.sittingOut, true);
  assert.equal(now.get(7)!.player_id, "p2");
  assert.deepEqual(dealtIn(now, 1), [1, 7]);
  assert.equal(heroSeatAt(log, 9, "2026-10-07T19:00:00Z"), 4);
  assert.equal(heroSeatAt(log, 9), 1);
});

test("the button moves to the next seat dealt in", () => {
  assert.equal(nextButton(5, [1, 3, 5, 8]), 8);
  assert.equal(nextButton(8, [1, 3, 5, 8]), 1);
  assert.equal(nextButton(6, [1, 3, 5, 8]), 8, "from a seat now empty");
  assert.equal(nextButton(null, [3, 5]), 3);
});

test("seat events that make no sense are refused", () => {
  const t = tableAt([ev(2, "sit", "2026-10-07T18:00:00Z")]);
  assert.match(checkSeatEvent(t, 4, 9, "sit", 2)!, /taken/);
  assert.match(checkSeatEvent(t, 4, 9, "sit", 4)!, /yours/);
  assert.match(checkSeatEvent(t, 4, 9, "sit", 10)!, /no seat 10/);
  assert.match(checkSeatEvent(t, 4, 9, "back", 2)!, /already playing/);
  assert.match(checkSeatEvent(t, 4, 9, "leave", 3)!, /Nobody/);
  assert.equal(checkSeatEvent(t, 4, 9, "sit_out", 2), null);
  assert.equal(checkSeatEvent(t, 4, 10, "hero_move", 10), null);
});

/* ------------------------------------------------------------ session */

const sev = (kind: SessionEvent["kind"], at: string, amount: number | null = null): SessionEvent => ({
  id: `${kind}${at}`,
  session_id: "s",
  kind,
  amount,
  at,
});

test("time played leaves out breaks; the result needs a cash-out", () => {
  const events = [
    sev("buy_in", "2026-10-07T18:00:00Z", 200),
    sev("rebuy", "2026-10-07T19:00:00Z", 100),
    sev("break_start", "2026-10-07T20:00:00Z"),
    sev("break_end", "2026-10-07T20:30:00Z"),
  ];
  const running = summarize(
    { started_at: "2026-10-07T18:00:00Z", ended_at: null, cash_out: null, big_blind: 2 },
    events,
    Date.parse("2026-10-07T21:00:00Z"),
  );
  assert.equal(running.invested, 300);
  assert.equal(running.playedMs, 2.5 * 3_600_000);
  assert.equal(running.net, null);
  assert.equal(running.onBreakSince, null);

  const done = summarize(
    { started_at: "2026-10-07T18:00:00Z", ended_at: "2026-10-07T22:30:00Z", cash_out: 520, big_blind: 2 },
    events,
  );
  assert.equal(done.net, 220);
  assert.equal(done.hourly, 55);
  assert.equal(done.bbPerHour, 27.5);
  assert.equal(fmtDuration(done.playedMs), "4h00");
  assert.deepEqual(totals([running, done]), { sessions: 1, net: 220, playedMs: 4 * 3_600_000, hourly: 55 });
});

test("an open break counts up to now and is reported", () => {
  const s = summarize(
    { started_at: "2026-10-07T18:00:00Z", ended_at: null, cash_out: null, big_blind: 2 },
    [sev("break_start", "2026-10-07T19:00:00Z")],
    Date.parse("2026-10-07T19:20:00Z"),
  );
  assert.equal(s.onBreakSince, "2026-10-07T19:00:00Z");
  assert.equal(s.playedMs, 3_600_000);
});

/* ------------------------------------------------------------ helpers */

test("amounts and cards", () => {
  assert.equal(parseAmount("1 200,50 €"), 1200.5);
  assert.equal(parseAmount(""), null);
  assert.ok(Number.isNaN(parseAmount("abc")!));
  assert.equal(fmtMoney(-35.5), "−35.50 €");
  assert.equal(fmtMoney(40, "€", true), "+40 €");
  assert.deepEqual(splitCards("AhKd"), ["Ah", "Kd"]);
  assert.equal(splitCards("AhAh"), null);
});

/* ------------------------------------------------------- saving a hand */

import { checkHand, computedHeroNet } from "./validate";
import { readableSeatLog } from "./table";
import { handText } from "./describe";
import type { HandInput, LiveHand } from "./types";

const base: HandInput = {
  button_seat: 5,
  hero_seat: 6,
  small_blind: 1,
  big_blind: 2,
  straddle: null,
  seats: seats([2, 5, 6, 7]),
  actions: [],
  hero_cards: "AhKd",
  board: [],
  shown: {},
  winners: [],
  hero_net: null,
  starred: false,
  notes: null,
};

test("a hand is checked before it is saved", () => {
  assert.throws(() => checkHand({ ...base, seats: seats([2, 10]) }, 9), /no seat 10/);
  assert.throws(() => checkHand({ ...base, hero_seat: 3 }, 9), /not dealt in/);
  assert.throws(() => checkHand({ ...base, board: ["Ah", "2c", "3d"] }, 9), /Ah appears twice/);
  assert.throws(() => checkHand({ ...base, board: ["2c", "3d", "4h"] }, 9), /hand stopped before/);
  assert.throws(() => checkHand({ ...base, actions: [{ seat: 5, kind: "fold" }] }, 9), /Action 1: Seat 2 acts now/);

  const done = checkHand(
    {
      ...base,
      actions: [
        { seat: 2, kind: "raise", to: 6 },
        { seat: 5, kind: "fold" },
        { seat: 6, kind: "call" },
        { seat: 7, kind: "fold" },
        { seat: 6, kind: "check" },
        { seat: 2, kind: "bet", to: 10 },
        { seat: 6, kind: "call" },
        { seat: 6, kind: "check" },
        { seat: 2, kind: "check" },
        { seat: 6, kind: "check" },
        { seat: 2, kind: "check" },
      ],
      board: ["2c", "3d", "4h", "9s", "Jc"],
      shown: { "2": "QsQd", "6": "ignored" },
      winners: [[6, 99]],
    },
    9,
  );
  assert.deepEqual(done.input.shown, { "2": "QsQd" }, "the hero's own cards are not 'shown'; seat 2's are");
  assert.deepEqual(done.input.winners, [[6]], "winners are kept per pot, among those eligible");
  assert.equal(computedHeroNet(done, 6), 18, "won 6+2 from the BB and seat 2's 16");
});

test("a change of seat reads as one line", () => {
  const log = [
    ev(3, "sit", "2026-10-07T18:00:00Z", "p1"),
    ev(3, "leave", "2026-10-07T19:00:00Z", "p1"),
    ev(8, "sit", "2026-10-07T19:00:00Z", "p1"),
    ev(5, "sit", "2026-10-07T19:00:00Z", "p2"),
  ];
  const lines = readableSeatLog(log);
  assert.equal(lines.length, 3);
  assert.equal(lines[1].event.kind, "leave");
  assert.equal(lines[1].movedTo?.seat, 8);
});

test("a hand reads like a hand history", () => {
  const hand: LiveHand = {
    ...base,
    id: "h1",
    session_id: "s",
    number: 4,
    played_at: "2026-10-07T20:00:00Z",
    actions: [
      { seat: 2, kind: "raise", to: 6 },
      { seat: 5, kind: "fold" },
      { seat: 6, kind: "fold" },
      { seat: 7, kind: "fold" },
    ],
    seats: [
      { seat: 2, player_id: "p2", stack: 300 },
      { seat: 5, player_id: null, stack: null },
      { seat: 6, player_id: null, stack: null },
      { seat: 7, player_id: null, stack: null },
    ],
    winners: [[2]],
    hero_net: -1,
    created_at: "",
    updated_at: "",
  } as LiveHand;
  const text = handText(hand, (id) => (id === "p2" ? "Marco" : null), "€");
  assert.match(text, /### Hand #4/);
  assert.match(text, /2 Marco \(UTG\) 300/);
  assert.match(text, /Preflop: Marco \(UTG\) raises to 6, seat 5 \(BTN\) folds, Arthur \(SB\) folds, seat 7 \(BB\) folds/);
  assert.match(text, /Pot 5 → Marco \(UTG\)/);
  assert.match(text, /Arthur's net: -1 €/);
});

/* ------------------------------------------ unknowns, button, blinds back */

test("an unknown player is blank until something is put on them", () => {
  const p = { known: false, name: unknownName(4), description: null, tag_ids: [] as string[], note_count: 0 };
  assert.equal(p.name, "Unknown 4");
  assert.equal(isBlankUnknown(p), true);
  assert.equal(isBlankUnknown({ ...p, tag_ids: ["fish"] }), false);
  assert.equal(isBlankUnknown({ ...p, description: "red cap" }), false);
  assert.equal(isBlankUnknown({ ...p, note_count: 1 }), false);
  assert.equal(isBlankUnknown({ ...p, name: "Red cap" }), false, "renamed while still unknown");
  assert.equal(isBlankUnknown({ ...p, known: true }), false);
  assert.equal(unknownLabel(p), "?");
  assert.equal(unknownLabel({ ...p, description: "red cap, 50s. Calls a lot" }), "red cap");
  assert.equal(unknownLabel({ ...p, name: "Cap guy" }), "Cap guy");
});

test("the button for the next hand skips seats no longer dealt in", () => {
  assert.equal(buttonFor(5, [1, 3, 5, 8]), 5);
  assert.equal(buttonFor(6, [1, 3, 5, 8]), 8, "its player left");
  assert.equal(buttonFor(9, [1, 3, 5, 8]), 1, "wraps");
  assert.equal(buttonFor(null, [3, 5]), 3, "before the first hand");
  // Saving a hand moves it on one seat, then the next hand starts there.
  assert.equal(buttonFor(nextButton(5, [1, 3, 5, 8]), [1, 3, 5, 8]), 8);
});

test("two players seated together are two people; a change of seat is not", () => {
  const apart = [
    ev(2, "sit", "2026-10-07T18:00:00Z", "a"),
    ev(2, "leave", "2026-10-07T19:00:00Z", "a"),
    ev(5, "sit", "2026-10-07T19:30:00Z", "b"),
  ];
  assert.equal(seatedTogether(apart, "a", "b"), false);
  const moved = [
    ev(2, "sit", "2026-10-07T18:00:00Z", "a"),
    // a change of seat: the sit can be logged before the leave
    ev(6, "sit", "2026-10-07T19:00:00Z", "a"),
    ev(2, "leave", "2026-10-07T19:00:00Z", "a"),
    ev(2, "sit", "2026-10-07T19:10:00Z", "b"),
  ];
  assert.equal(seatedTogether(moved, "a", "b"), true, "a is in 6 when b sits in 2");
  assert.equal(seatedTogether(moved.slice(0, 3), "a", "b"), false, "a alone, moving");
  const together = [ev(2, "sit", "2026-10-07T18:00:00Z", "a"), ev(5, "sit", "2026-10-07T18:00:00Z", "b")];
  assert.equal(seatedTogether(together, "a", "b"), true);
});

test("blinds bought back: the big blind live with the option, the small blind dead", () => {
  // Button 5: SB 6, BB 7. Seat 2 comes back and posts 2 + 1 dead.
  const setup: HandSetup = { ...nine, posts: [{ seat: 2, live: 2, dead: 1 }] };
  const s = startHand(setup);
  assert.equal(s.pot, 1, "the dead small blind is in the pot");
  assert.equal(s.dead, 1);
  assert.equal(s.currentBet, 2);
  const two = s.seats.find((x) => x.seat === 2)!;
  assert.equal(two.street, 2);
  assert.equal(two.committed, 3);

  // Everyone limps or folds round to seat 2: it has the option, like the big blind.
  const r = playHand(setup, [
    { seat: 8, kind: "fold" },
    { seat: 9, kind: "fold" },
    { seat: 1, kind: "fold" },
    { seat: 2, kind: "check" },
    { seat: 3, kind: "fold" },
    { seat: 4, kind: "fold" },
    { seat: 5, kind: "call" },
    { seat: 6, kind: "fold" },
    { seat: 7, kind: "check" },
  ]);
  assert.equal(r.ok, true, r.error ?? "");
  assert.equal(r.state.street, "flop");
  assert.equal(r.state.pot, 1 + 2 + 2 + 1 + 2, "dead 1, seat 2's 2, button 2, SB 1, BB 2");
  const out = settle(r.state, [[2]]);
  assert.equal(out.refund, null, "dead money is not an uncalled bet");
  assert.equal(out.total, 8);
  assert.equal(out.net.get(2), 5, "seat 2 put in 3 and takes 8");
  assert.equal(out.net.get(6), -1);
});

test("blinds bought back that do not fit are refused", () => {
  assert.throws(() => startHand({ ...nine, posts: [{ seat: 6, live: 2, dead: 0 }] }), /already in a blind/);
  assert.throws(() => startHand({ ...nine, seats: seats([1, 5, 6, 7]), posts: [{ seat: 2, live: 2, dead: 0 }] }), /not dealt in/);
  assert.throws(() => startHand({ ...nine, posts: [{ seat: 2, live: 5, dead: 0 }] }), /at most the big blind/);
  assert.throws(
    () =>
      startHand({
        ...nine,
        posts: [
          { seat: 2, live: 2, dead: 0 },
          { seat: 2, live: 2, dead: 0 },
        ],
      }),
    /posts twice/,
  );
});

test("a hand with blinds bought back is checked and written out", () => {
  const c = checkHand({ ...base, posts: [{ seat: 5, live: 2, dead: 1 }, { seat: 7, live: 0, dead: 0 }] }, 9);
  assert.deepEqual(c.input.posts, [{ seat: 5, live: 2, dead: 1 }], "empty posts are dropped");
  const hand = { ...base, ...c.input, id: "h", session_id: "s", number: 1, played_at: "", created_at: "", updated_at: "" } as LiveHand;
  assert.match(handText(hand, () => null, "€"), /Blinds bought back: seat 5 \(BTN\) posts 2 \+ 1 dead/);
});
