/**
 * Unit tests for the pure trainer model. Run with `npm test`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { SEATS, derivedPosition, firstToAct, isInPosition } from "../solver/seats";
import type { PokerNode, SpotSetup, StrategyWeights } from "../solver/types";
import { comboPool, pickWeighted } from "./deal";
import { byHandClass, confusions, handClass, mixDiscipline } from "./history";
import { compatibility, resolveEntry } from "./resolve";
import { sceneFromState, seatsFromHero } from "./scene";
import { answer, buildTree, handScore, startHand } from "./play";
import { walkPath } from "../solver/gameState";
import { comboToHand } from "../solver/cards";
import type { Seat } from "../solver/seats";
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

/* ------------------------------------------------------------ tree helpers */

const SRP: SpotSetup = { players: ["BTN", "BB"], street: "flop", potBb: 5.5, stackBb: 97.5 };

type Kid = [PokerNode["type"], object, Kid[]?];

/** Build a tree: each spec is [type, data, children]. Returns every node, parents first. */
function tree(specs: Kid[], parent: PokerNode | null = null, out: PokerNode[] = []): PokerNode[] {
  specs.forEach(([type, data, kids], i) => {
    const n = node(type, data, parent);
    n.position = i;
    out.push(n);
    if (kids) tree(kids, n, out);
  });
  return out;
}

const opt = (id: string, kind: string, label: string, sizePct: number | null = null) => ({ id, kind, label, sizePct, color: "#000" });
const act = (strategyActionId: string, kind: string, label: string, sizePct: number | null = null) => ({
  strategyActionId,
  kind,
  label,
  sizePct,
  color: "#000",
});

function drill(nodes: PokerNode[], weights: Record<string, StrategyWeights>, setup: SpotSetup = SRP) {
  return buildTree({ spotId: "spot", spotName: "SRP", setup, nodes }, weights)!;
}

const pure = (i: number, len: number) => Array.from({ length: len }, (_, k) => (k === i ? 100 : 0));

/* ----------------------------------------------------------------- resolve */

test("resolve: an entry's context comes from the walk (flop decision after a check)", () => {
  const nodes = tree([
    ["flop", { cards: ["Ks", "7d", "2c"] }, [
      ["strategy", { actions: [opt("x", "check", "Check"), opt("b", "bet", "Bet 33%", 33)] }, [
        ["action", act("x", "check", "Check"), [
          ["strategy", { actions: [opt("x2", "check", "Check"), opt("b2", "bet", "Bet 33%", 33)] }],
        ]],
      ]],
    ]],
  ]);
  const r = resolveEntry(SRP, nodes);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.context.street, "flop");
  assert.deepEqual(r.context.board, ["Ks", "7d", "2c"]);
  assert.deepEqual(r.context.line.map((l) => `${l.seat} ${l.kind}`), ["BB check"]);
  assert.equal(r.context.toAct, "BTN");
  assert.ok(Math.abs(r.context.potBb - 5.5) < 1e-9);
});

test("resolve: refusals — setup, invalid path, hand over", () => {
  const flop = tree([["flop", { cards: ["Ks", "7d", "2c"] }]]);
  assert.match((resolveEntry({ ...SRP, players: null }, flop) as { error: string }).error, /set up/);
  assert.match((resolveEntry({ ...SRP, potBb: null }, flop) as { error: string }).error, /pot/);
  const bad = tree([["flop", { cards: ["Ks", "7d"] }]]);
  assert.match((resolveEntry(SRP, bad) as { error: string }).error, /3 cards/);
  const fold = tree([
    ["flop", { cards: ["Ks", "7d", "2c"] }, [
      ["strategy", { actions: [opt("f", "fold", "Fold")] }, [["action", act("f", "fold", "Fold")]]],
    ]],
  ]);
  assert.match((resolveEntry(SRP, fold) as { error: string }).error, /over/);
});

test("compatibility: the spot's two seats must be the trainer's, either way round", () => {
  assert.deepEqual(compatibility(["BTN", "BB"], { hero_seat: "BB", villain_seat: "BTN" }), { ok: true });
  assert.deepEqual(compatibility(["BTN", "BB"], { hero_seat: "BTN", villain_seat: "BB" }), { ok: true });
  assert.equal(compatibility(["CO", "BB"], { hero_seat: "BTN", villain_seat: "BB" }).ok, false);
});

/* ------------------------------------------------------------------- scene */

test("scene: facing a 33% c-bet, from the engine's state", () => {
  const setup = { ...SRP, players: ["BTN", "BB"] as [Seat, Seat] };
  const nodes = tree([
    ["flop", { cards: ["Ks", "7d", "2c"] }, [
      ["strategy", { actions: [] }, [
        ["action", act("x", "check", "Check"), [
          ["strategy", { actions: [] }, [["action", act("b", "bet", "Bet 33%", 33)]]],
        ]],
      ]],
    ]],
  ]);
  const states = walkPath(setup, nodes);
  const scene = sceneFromState({
    state: states[states.length - 1].state,
    heroSeat: "BB",
    villainSeat: "BTN",
    stackBb: 100,
    heroActions: [
      { id: "f", kind: "fold", label: "Fold", color: "" },
      { id: "c", kind: "call", label: "Call", color: "" },
      { id: "r", kind: "raise", sizePct: 50, label: "Raise 50%", color: "" },
    ],
  });
  assert.ok(Math.abs(scene.toCallBb - 1.815) < 1e-9);
  assert.ok(Math.abs(scene.totalPotBb - 7.315) < 1e-9);
  assert.equal(scene.centerBb, 5.5);
  assert.ok(Math.abs((scene.actions[1].amountBb ?? 0) - 1.815) < 1e-9);
  assert.ok(Math.abs((scene.actions[2].amountBb ?? 0) - 6.38) < 1e-9);
  assert.deepEqual(scene.line.map((l) => l.seat), ["BB", "BTN"]);
  assert.equal(scene.seats.find((x) => x.seat === "CO")?.role, "folded");
});

/* -------------------------------------------------------------------- play */

// BB (hero) checks or bets; BTN c-bets or checks back; BB calls or folds; turn.
function cbetTree(opts: { developBet?: boolean; turns?: string[] } = {}) {
  const turns = (opts.turns ?? ["5h"]).map((c): Kid => ["turn", { card: c }, [["strategy", { actions: [opt("t", "check", "Check")] }]]]);
  const bbFacing: Kid = ["strategy", { actions: [opt("f", "fold", "Fold"), opt("c", "call", "Call"), opt("r", "raise", "Raise 50%", 50)] }, [
    ["action", act("f", "fold", "Fold")],
    ["action", act("c", "call", "Call"), turns],
  ]];
  const btnKids: Kid[] = [["action", act("bb", "bet", "Bet 33%", 33), [bbFacing]]];
  if (opts.developBet !== false) btnKids.push(["action", act("bx", "check", "Check")]);
  return tree([
    ["flop", { cards: ["Ks", "7d", "2c"] }, [
      ["strategy", { actions: [opt("x", "check", "Check"), opt("b", "bet", "Bet 75%", 75)] }, [
        ["action", act("x", "check", "Check"), [
          ["strategy", { actions: [opt("bb", "bet", "Bet 33%", 33), opt("bx", "check", "Check")] }, btnKids],
        ]],
      ]],
    ]],
  ]);
}

function ids(nodes: PokerNode[]) {
  const byLabel = (type: string, i = 0) => nodes.filter((n) => n.type === type)[i];
  return { flop: byLabel("flop"), bbFlop: byLabel("strategy", 0), btn: byLabel("strategy", 1), bbFacing: byLabel("strategy", 2) };
}

test("play: C2 — two hero decisions, villain bets, a runout, then end of solution", () => {
  const nodes = cbetTree();
  const n = ids(nodes);
  const weights: Record<string, StrategyWeights> = {
    [n.bbFlop.id]: { hands: { "87s": pure(0, 2) }, combos: {} },
    [n.btn.id]: { hands: { AA: pure(0, 2) }, combos: {} },
    [n.bbFacing.id]: { hands: { "87s": [0, 100, 0] }, combos: {} },
  };
  const t = drill(nodes, weights);
  let h = startHand(t, n.flop.id, "BB", "h1", { rand: seeded(1) })!;
  assert.ok(h.pending);
  assert.equal(h.pending!.nodeId, n.bbFlop.id);
  assert.equal(comboToHand(h.combo!), "87s");
  h = answer(t, h, 0, { rand: seeded(2) });
  assert.equal(h.decisions[0].scored?.grade, "correct");
  // Villain always bets (AA bets 100%); hero now faces 1.815.
  assert.equal(h.pending?.nodeId, n.bbFacing.id);
  assert.deepEqual(h.steps.map((s) => s.type), ["hero", "villain"]);
  h = answer(t, h, 1, { rand: seeded(3) });
  assert.equal(h.end?.reason, "end_of_solution");
  assert.deepEqual(h.state.board, ["Ks", "7d", "2c", "5h"]);
  assert.ok(Math.abs(h.state.center - 9.13) < 1e-9);
  assert.deepEqual(handScore(h), { decisions: 2, correct: 2 });
});

test("play: villain draws only among developed branches", () => {
  const nodes = cbetTree({ developBet: false });
  const n = ids(nodes);
  const weights: Record<string, StrategyWeights> = {
    [n.bbFlop.id]: { hands: { "87s": pure(0, 2) }, combos: {} },
    // BTN checks back 90% of the time, but only the bet has a branch.
    [n.btn.id]: { hands: { AA: [10, 90] }, combos: {} },
  };
  const t = drill(nodes, weights);
  for (let i = 0; i < 20; i++) {
    let h = startHand(t, n.flop.id, "BB", `h${i}`, { rand: seeded(10 + i) })!;
    h = answer(t, h, 0, { rand: seeded(100 + i) });
    const v = h.steps.find((s) => s.type === "villain");
    assert.equal(v && v.type === "villain" ? v.label : null, "Bet 33%");
  }
});

test("play: hero's option with no branch ends the hand; fold ends it too", () => {
  const nodes = cbetTree();
  const n = ids(nodes);
  const weights: Record<string, StrategyWeights> = {
    [n.bbFlop.id]: { hands: { "87s": [50, 50] }, combos: {} },
    [n.btn.id]: { hands: { AA: pure(0, 2) }, combos: {} },
    [n.bbFacing.id]: { hands: { "87s": [30, 40, 30] }, combos: {} },
  };
  const t = drill(nodes, weights);
  let h = startHand(t, n.flop.id, "BB", "a", { rand: seeded(5) })!;
  const bet = answer(t, h, 1, { rand: seeded(6) });
  assert.equal(bet.end?.reason, "branch_not_developed");
  assert.equal(bet.end?.nodeId, n.bbFlop.id);

  h = answer(t, h, 0, { rand: seeded(7) });
  const raise = answer(t, h, 2, { rand: seeded(8) });
  assert.equal(raise.end?.reason, "branch_not_developed");
  const fold = answer(t, h, 0, { rand: seeded(8) });
  assert.equal(fold.end?.reason, "fold");
});

test("play: off range when hero's hand has no strategy at a later decision", () => {
  const nodes = cbetTree();
  const n = ids(nodes);
  const weights: Record<string, StrategyWeights> = {
    [n.bbFlop.id]: { hands: { "87s": pure(0, 2) }, combos: {} },
    [n.btn.id]: { hands: { AA: pure(0, 2) }, combos: {} },
    [n.bbFacing.id]: { hands: { QQ: [0, 100, 0] }, combos: {} },
  };
  const t = drill(nodes, weights);
  let h = startHand(t, n.flop.id, "BB", "o", { rand: seeded(9) })!;
  h = answer(t, h, 0, { rand: seeded(9) });
  assert.equal(h.end?.reason, "off_range");
});

test("play: runouts skip hero's cards; none left ends the hand", () => {
  const weightsFor = (nodes: PokerNode[]) => {
    const n = ids(nodes);
    return {
      [n.bbFlop.id]: { hands: {}, combos: { AhQh: pure(0, 2) } },
      [n.btn.id]: { hands: { AA: pure(0, 2) }, combos: {} },
      [n.bbFacing.id]: { hands: {}, combos: { AhQh: [0, 100, 0] } },
    } as Record<string, StrategyWeights>;
  };
  const only = cbetTree({ turns: ["Ah"] });
  const t1 = drill(only, weightsFor(only));
  let h = startHand(t1, ids(only).flop.id, "BB", "r", { rand: seeded(1) })!;
  h = answer(t1, answer(t1, h, 0, { rand: seeded(1) }), 1, { rand: seeded(1) });
  assert.equal(h.end?.reason, "no_runout");

  const two = cbetTree({ turns: ["Ah", "5c"] });
  const t2 = drill(two, weightsFor(two));
  for (let i = 0; i < 10; i++) {
    let g = startHand(t2, ids(two).flop.id, "BB", "r2", { rand: seeded(i) })!;
    g = answer(t2, answer(t2, g, 0, { rand: seeded(i) }), 1, { rand: seeded(i) });
    assert.deepEqual(g.state.board.slice(3), ["5c"]);
  }
});

test("play: stop at end of street; entry on an action starts facing the bet", () => {
  const nodes = cbetTree();
  const n = ids(nodes);
  const weights: Record<string, StrategyWeights> = {
    [n.bbFlop.id]: { hands: { "87s": pure(0, 2) }, combos: {} },
    [n.btn.id]: { hands: { AA: pure(0, 2) }, combos: {} },
    [n.bbFacing.id]: { hands: { "87s": [0, 100, 0] }, combos: {} },
  };
  const t = drill(nodes, weights);
  let h = startHand(t, n.flop.id, "BB", "s", { rand: seeded(1), stopAtStreetEnd: true })!;
  h = answer(t, h, 0, { rand: seeded(1), stopAtStreetEnd: true });
  h = answer(t, h, 1, { rand: seeded(1), stopAtStreetEnd: true });
  assert.equal(h.end?.reason, "end_of_street");

  const betNode = nodes.find((x) => x.type === "action" && (x.data as { strategyActionId?: string }).strategyActionId === "bb")!;
  const f = startHand(t, betNode.id, "BB", "e", { rand: seeded(2) })!;
  assert.equal(f.pending?.nodeId, n.bbFacing.id);
  assert.ok(Math.abs(f.pending!.state.bets.BTN - 1.815) < 1e-9);
  assert.equal(f.steps.length, 0);
});

test("play: showdown draws villain's hand from the option he took", () => {
  const setup: SpotSetup = { players: ["BTN", "BB"], street: "river", potBb: 20, stackBb: 80 };
  const nodes = tree([
    ["flop", { cards: ["Ks", "7d", "2c"] }, [
      ["turn", { card: "5h" }, [
        ["river", { card: "9s" }, [
          ["strategy", { actions: [opt("x", "check", "Check")] }, [
            ["action", act("x", "check", "Check"), [
              ["strategy", { actions: [opt("b", "bet", "Bet 50%", 50), opt("k", "check", "Check")] }, [
                ["action", act("b", "bet", "Bet 50%", 50), [
                  ["strategy", { actions: [opt("f", "fold", "Fold"), opt("c", "call", "Call")] }, [
                    ["action", act("f", "fold", "Fold")],
                    ["action", act("c", "call", "Call")],
                  ]],
                ]],
                ["action", act("k", "check", "Check")],
              ]],
            ]],
          ]],
        ]],
      ]],
    ]],
  ]);
  const [bb1, btn, bb2] = nodes.filter((x) => x.type === "strategy");
  const weights: Record<string, StrategyWeights> = {
    [bb1.id]: { hands: { QQ: [100] }, combos: {} },
    // AA always bets, 33 always checks: after a bet, villain holds AA.
    [btn.id]: { hands: { AA: [100, 0], "33": [0, 100] }, combos: {} },
    [bb2.id]: { hands: { QQ: [0, 100] }, combos: {} },
  };
  const t = drill(nodes, weights, setup);
  for (let i = 0; i < 10; i++) {
    let h = startHand(t, nodes[0].id, "BB", "sd", { rand: seeded(i) })!;
    h = answer(t, h, 0, { rand: seeded(i) });
    if (h.pending) h = answer(t, h, 1, { rand: seeded(i + 50) });
    assert.equal(h.end?.reason, "showdown");
    const v = h.steps.find((s) => s.type === "villain");
    const vHand = comboToHand(h.villainCombo!);
    assert.equal(vHand, v && v.type === "villain" && v.label === "Check" ? "33" : "AA");
  }
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
    hand_id: null,
    step: null,
    line: null,
    pot_bb: null,
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
