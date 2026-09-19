/**
 * Unit tests for the pure trainer model. Run with `npm test`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { SEATS, derivedPosition, firstToAct, isInPosition } from "../solver/seats";
import type { PokerNode, StrategyWeights } from "../solver/types";
import { comboPool, pickWeighted } from "./deal";
import { byHandClass, confusions, handClass, mixDiscipline } from "./history";
import { compatibility, resolveNodeContext } from "./resolve";
import { buildScene, seatsFromHero } from "./scene";
import { bandIndex, bands, playableFreqs, rollRng, scoreAnswer, sessionScore } from "./score";
import type { TrainerAnswer } from "./types";

/* ----------------------------------------------------------------- helpers */

let seq = 0;
function node(type: PokerNode["type"], data: object, parent: PokerNode | null): PokerNode {
  seq++;
  return {
    id: `n${seq}`,
    spot_id: "spot",
    parent_id: parent?.id ?? null,
    type,
    position: 0,
    data: data as PokerNode["data"],
    created_at: "",
    updated_at: "",
  };
}

function chain(...specs: [PokerNode["type"], object][]): PokerNode[] {
  const out: PokerNode[] = [];
  for (const [type, data] of specs) out.push(node(type, data, out[out.length - 1] ?? null));
  return out;
}

const strat = (seat: string | null, vsSeat: string | null) => ({ seat, vsSeat, actions: [] });

/** Deterministic PRNG (mulberry32). */
function seeded(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------------------------------------------- seats */

test("IP/OOP for all 30 seat pairs: exactly one of each pair is in position", () => {
  let pairs = 0;
  for (const a of SEATS) {
    for (const b of SEATS) {
      if (a === b) continue;
      pairs++;
      assert.notEqual(isInPosition(a, b), isInPosition(b, a));
      assert.equal(derivedPosition(a, b), isInPosition(a, b) ? "IP" : "OOP");
    }
  }
  assert.equal(pairs, 30);
  assert.equal(derivedPosition("BTN", "BB"), "IP");
  assert.equal(derivedPosition("SB", "BB"), "OOP");
  assert.equal(derivedPosition("BB", "CO"), "OOP");
  assert.equal(derivedPosition("BTN", null), null);
  assert.equal(derivedPosition("BTN", "BTN"), null);
});

test("first to act: UTG before BB preflop, BB before BTN postflop", () => {
  assert.equal(firstToAct("preflop", "BB", "UTG"), "UTG");
  assert.equal(firstToAct("flop", "BTN", "BB"), "BB");
  assert.equal(firstToAct("river", "SB", "CO"), "SB");
});

/* ----------------------------------------------------------------- resolve */

test("resolve: flop decision after a check, board and line read from the tree", () => {
  const path = chain(
    ["text", { title: "BTN vs BB SRP", body: "" }],
    ["flop", { cards: ["Ah", "7d", "2c"] }],
    ["strategy", strat("BB", "BTN")],
    ["action", { kind: "check", label: "Check", color: "" }],
    ["strategy", strat("BTN", "BB")],
  );
  const r = resolveNodeContext(path);
  assert.ok(r.ok, !r.ok ? r.error : "");
  if (!r.ok) return;
  assert.equal(r.context.street, "flop");
  assert.deepEqual(r.context.board, ["Ah", "7d", "2c"]);
  assert.deepEqual(r.context.line, [{ seat: "BB", kind: "check", sizePct: null, label: "Check" }]);
  assert.equal(r.context.seat, "BTN");
  assert.equal(r.context.vsSeat, "BB");
});

test("resolve: the line resets on each new street; turn and river extend the board", () => {
  const path = chain(
    ["flop", { cards: ["Ah", "7d", "2c"] }],
    ["strategy", strat("BB", "BTN")],
    ["action", { kind: "check", label: "Check", color: "" }],
    ["strategy", strat("BTN", "BB")],
    ["action", { kind: "bet", sizePct: 33, label: "Bet 33%", color: "" }],
    ["strategy", strat("BB", "BTN")],
    ["action", { kind: "call", label: "Call", color: "" }],
    ["turn", { card: "Ks" }],
    ["strategy", strat("BB", "BTN")],
    ["action", { kind: "bet", sizePct: 75, label: "Bet 75%", color: "" }],
    ["strategy", strat("BTN", "BB")],
  );
  const r = resolveNodeContext(path);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.context.street, "turn");
  assert.deepEqual(r.context.board, ["Ah", "7d", "2c", "Ks"]);
  assert.equal(r.context.line.length, 1);
  assert.equal(r.context.line[0].seat, "BB");
  assert.equal(r.context.line[0].sizePct, 75);
});

test("resolve: free-form actions alternate from the first player to act", () => {
  const path = chain(
    ["flop", { cards: ["Ah", "7d", "2c"] }],
    ["action", { kind: "check", label: "Check", color: "" }],
    ["action", { kind: "bet", sizePct: 50, label: "Bet 50%", color: "" }],
    ["strategy", strat("BB", "BTN")],
  );
  const r = resolveNodeContext(path);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.deepEqual(r.context.line.map((a) => a.seat), ["BB", "BTN"]);
});

test("resolve: preflop node keeps every action from the root", () => {
  const path = chain(
    ["strategy", strat("CO", "BB")],
    ["action", { kind: "raise", sizePct: 2.5, label: "Raise 2.5bb", color: "" }],
    ["strategy", strat("BB", "CO")],
  );
  const r = resolveNodeContext(path);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.context.street, "preflop");
  assert.deepEqual(r.context.board, []);
  assert.equal(r.context.line[0].seat, "CO");
});

test("resolve: every refusal", () => {
  const refused = (path: PokerNode[], pattern: RegExp) => {
    const r = resolveNodeContext(path);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, pattern);
  };
  refused(chain(["flop", { cards: ["Ah"] }]), /Only a strategy/);
  refused(chain(["flop", { cards: ["Ah", "7d", "2c"] }], ["strategy", strat(null, "BB")]), /positions/);
  refused(chain(["strategy", strat("BB", "BB")]), /same/);
  refused(chain(["flop", { cards: ["Ah", "7d"] }], ["strategy", strat("BB", "BTN")]), /3 cards/);
  refused(chain(["turn", { card: "Ks" }], ["strategy", strat("BB", "BTN")]), /no flop/);
  refused(
    chain(["flop", { cards: ["Ah", "7d", "2c"] }], ["river", { card: "Ks" }], ["strategy", strat("BB", "BTN")]),
    /no turn/,
  );
  refused(
    chain(["flop", { cards: ["Ah", "7d", "2c"] }], ["turn", { card: null }], ["strategy", strat("BB", "BTN")]),
    /no card/,
  );
  refused(
    chain(["flop", { cards: ["Ah", "7d", "2c"] }], ["turn", { card: "Ah" }], ["strategy", strat("BB", "BTN")]),
    /twice/,
  );
  refused(
    chain(["strategy", strat(null, null)], ["action", { kind: "check", label: "Check", color: "" }], ["strategy", strat("BTN", "BB")]),
    /no positions/,
  );
  refused(
    chain(["strategy", strat("CO", "BB")], ["action", { kind: "check", label: "Check", color: "" }], ["strategy", strat("BTN", "BB")]),
    /CO vs BB/,
  );
  const broken = chain(["flop", { cards: ["Ah", "7d", "2c"] }], ["strategy", strat("BB", "BTN")]);
  broken[1] = { ...broken[1], parent_id: "elsewhere" };
  refused(broken, /Broken/);
});

test("compatibility: exact seats and same street", () => {
  const ctx = { seat: "BTN" as const, vsSeat: "BB" as const, street: "flop" as const };
  assert.deepEqual(compatibility(ctx, { hero_seat: "BTN", villain_seat: "BB", street: null }), { ok: true });
  assert.deepEqual(compatibility(ctx, { hero_seat: "BTN", villain_seat: "BB", street: "flop" }), { ok: true });
  assert.equal(compatibility(ctx, { hero_seat: "CO", villain_seat: "BB", street: "flop" }).ok, false);
  assert.equal(compatibility(ctx, { hero_seat: "BB", villain_seat: "BTN", street: "flop" }).ok, false);
  assert.equal(compatibility(ctx, { hero_seat: "BTN", villain_seat: "BB", street: "turn" }).ok, false);
});

/* ------------------------------------------------------------------- scene */

const acts = [
  { id: "f", kind: "fold" as const, label: "Fold", color: "" },
  { id: "c", kind: "call" as const, label: "Call", color: "" },
  { id: "r", kind: "raise" as const, sizePct: 100, label: "Raise 100%", color: "" },
  { id: "j", kind: "raise" as const, sizePct: null, label: "All-in", color: "" },
];

test("scene: facing a 33% c-bet in a 6bb pot", () => {
  const s = buildScene({
    heroSeat: "BB",
    villainSeat: "BTN",
    potBb: 6,
    stackBb: 97,
    street: "flop",
    board: ["Ah", "7d", "2c"],
    line: [
      { seat: "BB", kind: "check", sizePct: null, label: "Check" },
      { seat: "BTN", kind: "bet", sizePct: 33, label: "Bet 33%" },
    ],
    heroActions: acts,
  });
  assert.equal(s.centerBb, 6);
  assert.equal(s.toCallBb, 1.98);
  assert.equal(s.totalPotBb, 7.98);
  const btn = s.seats.find((x) => x.seat === "BTN")!;
  assert.equal(btn.bet, 1.98);
  assert.equal(btn.stack, 95.02);
  const [fold, call, raise, jam] = s.actions;
  assert.equal(fold.amountBb, null);
  assert.equal(call.amountBb, 1.98);
  // pot after call = 7.98 + 1.98 = 9.96 → raise to 1.98 + 9.96
  assert.equal(raise.amountBb, 11.94);
  assert.equal(jam.amountBb, 97);
  assert.equal(jam.allIn, true);
  assert.equal(s.seats.filter((x) => x.role === "folded").length, 4);
});

test("scene: sizes are capped at the stack", () => {
  const s = buildScene({
    heroSeat: "BB",
    villainSeat: "BTN",
    potBb: 100,
    stackBb: 20,
    street: "turn",
    board: ["Ah", "7d", "2c", "Ks"],
    line: [{ seat: "BB", kind: "check", sizePct: null, label: "Check" }, { seat: "BTN", kind: "bet", sizePct: 75, label: "Bet 75%" }],
    heroActions: acts,
  });
  assert.equal(s.toCallBb, 20);
  assert.equal(s.actions[2].amountBb, 20);
  assert.equal(s.actions[2].allIn, true);
});

test("scene: preflop blinds posted, raise-to in bb", () => {
  const s = buildScene({
    heroSeat: "BB",
    villainSeat: "CO",
    potBb: 1.5,
    stackBb: 100,
    street: "preflop",
    board: [],
    line: [{ seat: "CO", kind: "raise", sizePct: 2.5, label: "Raise 2.5bb" }],
    heroActions: [
      { id: "f", kind: "fold", label: "Fold", color: "" },
      { id: "c", kind: "call", label: "Call", color: "" },
      { id: "r", kind: "raise", sizePct: 11, label: "Raise 11bb", color: "" },
    ],
  });
  assert.equal(s.centerBb, 0.5); // the dead SB
  assert.equal(s.seats.find((x) => x.seat === "BB")!.bet, 1);
  assert.equal(s.toCallBb, 1.5);
  assert.equal(s.actions[1].amountBb, 1.5);
  assert.equal(s.actions[2].amountBb, 11);
});

test("seatsFromHero rotates the table with hero first", () => {
  assert.deepEqual(seatsFromHero("BTN"), ["BTN", "SB", "BB", "UTG", "HJ", "CO"]);
});

/* ------------------------------------------------------------------- score */

test("bands follow button order and cover 0–99", () => {
  assert.deepEqual(bands([30, 50, 20]), [
    { start: 0, end: 30 },
    { start: 30, end: 80 },
    { start: 80, end: 100 },
  ]);
  assert.equal(bandIndex([30, 50, 20], 0), 0);
  assert.equal(bandIndex([30, 50, 20], 29), 0);
  assert.equal(bandIndex([30, 50, 20], 30), 1);
  assert.equal(bandIndex([30, 50, 20], 79), 1);
  assert.equal(bandIndex([30, 50, 20], 80), 2);
  assert.equal(bandIndex([30, 50, 20], 99), 2);
  // An empty action never owns a roll, and the last live band reaches 100.
  assert.equal(bandIndex([0, 100, 0], 0), 1);
  assert.equal(bandIndex([0, 100, 0], 99), 1);
  const thirds = [100 / 3, 100 / 3, 100 / 3];
  for (let r = 0; r < 100; r++) assert.notEqual(bandIndex(thirds, r), -1);
});

test("partial-range combos are rescaled; solver noise is cut", () => {
  // 40% in range: 30 raise / 10 call → 75 / 25
  assert.deepEqual(playableFreqs([30, 10, 0]), [75, 25, 0]);
  // 0.4% fold is noise
  const p = playableFreqs([99.6, 0, 0.4])!;
  assert.equal(p[2], 0);
  assert.equal(Math.round(p[0]), 100);
});

test("grades: correct, wrong band, mistake, blunder", () => {
  const v = [70, 28.5, 1.5, 0]; // raise, call, fold (noise), check (never)
  assert.equal(scoreAnswer(v, 10, 0)!.grade, "correct");
  assert.equal(scoreAnswer(v, 10, 1)!.grade, "wrong_band");
  assert.equal(scoreAnswer(v, 85, 1)!.grade, "correct");
  assert.equal(scoreAnswer(v, 85, 2)!.grade, "mistake");
  assert.equal(scoreAnswer(v, 85, 3)!.grade, "blunder");
  assert.equal(scoreAnswer([0, 0], 5, 0), null);
  assert.equal(sessionScore(0, 0), null);
  assert.equal(sessionScore(20, 15), 75);
});

test("rolls are uniform over 0–99", () => {
  const rand = seeded(7);
  const counts = new Array(100).fill(0);
  const n = 100_000;
  for (let i = 0; i < n; i++) counts[rollRng(rand)]++;
  for (const c of counts) assert.ok(Math.abs(c - n / 100) < n / 100 * 0.1);
  assert.equal(rollRng(() => 0.99999999), 99);
});

/* -------------------------------------------------------------------- deal */

test("deal: combos come up in proportion to how much of them is in range", () => {
  const weights: StrategyWeights = {
    hands: { AA: [100, 0], KK: [20, 20] },
    combos: { AhAd: [0, 0] },
  };
  const pool = comboPool(weights, 2, new Set(["As"]));
  // AA: 6 combos − 3 with As − AhAd zeroed = 2 left; KK: 6 at 0.4
  const aa = pool.filter((c) => c.hand === "AA");
  const kk = pool.filter((c) => c.hand === "KK");
  assert.equal(aa.length, 2);
  assert.equal(kk.length, 6);
  assert.ok(pool.every((c) => !c.combo.includes("As")));
  assert.ok(kk.every((c) => Math.abs(c.weight - 0.4) < 1e-9));

  const rand = seeded(42);
  let aaCount = 0;
  const n = 50_000;
  for (let i = 0; i < n; i++) if (pickWeighted(pool, (c) => c.weight, rand)!.hand === "AA") aaCount++;
  // expected share: 2 / (2 + 6 × 0.4) = 0.4545…
  assert.ok(Math.abs(aaCount / n - 2 / 4.4) < 0.01);
});

test("pickWeighted returns null when nothing has weight", () => {
  assert.equal(pickWeighted([1, 2], () => 0), null);
});

/* ----------------------------------------------------------------- history */


function ans(combo: string, grade: TrainerAnswer["grade"], chosen: string, expected: string, freqs: number[]): TrainerAnswer {
  return {
    id: combo + grade + chosen,
    session_id: "s",
    node_id: "n",
    combo,
    board: [],
    actions: [
      { id: "b", kind: "bet", sizePct: 75, label: "Bet", color: "" },
      { id: "x", kind: "check", label: "Check", color: "" },
    ],
    freqs,
    rng: 0,
    expected_action_id: expected,
    chosen_action_id: chosen,
    chosen_freq: 0,
    grade,
    answered_ms: 0,
    answered_at: "",
  };
}

test("history: hand classes, confusions, mix discipline", () => {
  assert.equal(handClass("AhAd"), "Big pairs");
  assert.equal(handClass("5h5d"), "Small & mid pairs");
  assert.equal(handClass("KhQh"), "Suited broadways");
  assert.equal(handClass("As5c"), "Offsuit aces");
  assert.equal(handClass("9h8h"), "Suited connectors");
  assert.equal(handClass("9h4d"), "Offsuit others");

  const answers = [
    ans("9h8h", "wrong_band", "x", "b", [50, 50]),
    ans("9h8h", "correct", "b", "b", [50, 50]),
    ans("AhKd", "blunder", "x", "b", [100, 0]),
    ans("AhKc", "correct", "b", "b", [100, 0]),
  ];
  assert.deepEqual(confusions(answers), [{ label: "Check instead of Bet", count: 2 }]);
  const classes = byHandClass(answers, 1);
  assert.equal(classes[0].hands, 2);
  // Only the two mixed 9h8h answers count: solver 50/50, chosen bet once, check once.
  const mix = mixDiscipline(answers);
  assert.deepEqual(mix.map((m) => [m.label, m.solver, m.chosen, m.hands]), [
    ["Bet", 50, 50, 2],
    ["Check", 50, 50, 2],
  ]);
});
