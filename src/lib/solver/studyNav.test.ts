/**
 * Unit tests for study-mode navigation. Run with `npm test`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  descend,
  entryStop,
  isStop,
  parentStop,
  pathTo,
  resolveStop,
  siblings,
  siblingStop,
  stopKind,
  studyTree,
  targets,
  sameLine,
  solutionName,
  solutionOf,
} from "./studyNav";
import type { PokerNode, StrategyAction } from "./types";

const ROOT = "__root__";
let pos = 0;

function n(id: string, type: PokerNode["type"], parent: string | null, data: object = {}): PokerNode {
  return {
    id,
    spot_id: "s",
    parent_id: parent,
    type,
    position: pos++,
    data: data as PokerNode["data"],
    created_at: "",
    updated_at: "",
  };
}
const opt = (id: string, label: string): StrategyAction => ({ id, kind: "check", label, color: "#000" });
const act = (id: string, parent: string, optionId: string) =>
  n(id, "action", parent, { strategyActionId: optionId, kind: "check", label: optionId, color: "#000" });

// Start → flop → BB (check | bet 33) ; check → BTN (check | bet 33 | bet 75)
// BTN check → two turns, each with a BB decision ; BTN bet 33 → BB (fold | call | raise)
// BB call → a turn with nothing below. Bet 75, BB bet 33, fold and raise are not developed.
const nodes: PokerNode[] = [
  n("flop", "flop", null, { cards: ["Ks", "7d", "2c"] }),
  n("d1", "strategy", "flop", { actions: [opt("x", "Check"), opt("b33", "Bet 33%")] }),
  act("a1x", "d1", "x"),
  n("d2", "strategy", "a1x", { actions: [opt("x", "Check"), opt("b33", "Bet 33%"), opt("b75", "Bet 75%")] }),
  act("a2x", "d2", "x"),
  n("tA", "turn", "a2x", { card: "Ah" }),
  n("d3a", "strategy", "tA", { actions: [] }),
  n("t5", "turn", "a2x", { card: "5h" }),
  n("d3b", "strategy", "t5", { actions: [] }),
  act("a2b", "d2", "b33"),
  n("d4", "strategy", "a2b", { actions: [opt("f", "Fold"), opt("c", "Call"), opt("r", "Raise")] }),
  act("a4c", "d4", "c"),
  n("t7", "turn", "a4c", { card: "7s" }),
];
const t = studyTree(nodes, ROOT);

test("stops: root, decisions, branching and leaf nodes; single-child nodes fold", () => {
  assert.equal(isStop(t, ROOT), true);
  assert.equal(isStop(t, "flop"), false);
  assert.equal(isStop(t, "d1"), true);
  assert.equal(isStop(t, "a1x"), false);
  assert.equal(isStop(t, "a2x"), true); // two runouts
  assert.equal(isStop(t, "tA"), false);
  assert.equal(isStop(t, "t7"), true); // leaf
  assert.equal(stopKind(t, ROOT), "root");
  assert.equal(stopKind(t, "d2"), "decision");
  assert.equal(stopKind(t, "a2x"), "branches");
  assert.equal(stopKind(t, "t7"), "leaf");
});

test("entry skips a root with one child and the flop it deals", () => {
  assert.equal(entryStop(t), "d1");
  assert.deepEqual(descend(t, "flop"), { stop: "d1", folded: [nodes[0]] });
});

test("a decision lists every option, undeveloped ones without a stop", () => {
  const ts = targets(t, "d1");
  assert.deepEqual(
    ts.map((x) => [x.option?.id, x.stop, x.folded.map((f) => f.id)]),
    [
      ["x", "d2", ["a1x"]],
      ["b33", null, []],
    ],
  );
  assert.deepEqual(
    targets(t, "d2").map((x) => [x.optionIndex, x.stop, x.folded.map((f) => f.id)]),
    [
      [0, "a2x", []],
      [1, "d4", ["a2b"]],
      [2, null, []],
    ],
  );
});

test("a branching action lists its runouts, each through its card to the decision", () => {
  assert.deepEqual(
    targets(t, "a2x").map((x) => [x.via?.id, x.stop, x.folded.map((f) => f.id)]),
    [
      ["tA", "d3a", ["tA"]],
      ["t5", "d3b", ["t5"]],
    ],
  );
  // A call that deals one turn still stops there: the other turns are picked there.
  assert.deepEqual(
    targets(t, "d4").map((x) => x.stop),
    [null, "a4c", null],
  );
  assert.equal(isStop(t, "a4c"), true);
  assert.equal(stopKind(t, "a4c"), "branches");
  assert.deepEqual(
    targets(t, "a4c").map((x) => [x.via?.id, x.stop]),
    [["t7", "t7"]],
  );
});

test("parent stop, path and resolving folded nodes", () => {
  assert.equal(parentStop(t, "d3a"), "a2x");
  assert.equal(parentStop(t, "a2x"), "d2");
  assert.equal(parentStop(t, "d2"), "d1");
  assert.equal(parentStop(t, "d1"), ROOT);
  assert.equal(parentStop(t, ROOT), null);
  assert.deepEqual(pathTo(t, "d3b"), [ROOT, "flop", "d1", "a1x", "d2", "a2x", "t5", "d3b"]);
  assert.equal(resolveStop(t, "a1x"), "d2");
  assert.equal(resolveStop(t, "t7"), "t7");
  assert.equal(resolveStop(t, "gone"), "d1");
  assert.equal(resolveStop(t, null), "d1");
  assert.equal(resolveStop(t, ROOT), ROOT);
});

test("siblings skip undeveloped options", () => {
  assert.deepEqual(
    (({ parent, index }) => ({ parent, index }))(siblings(t, "d3b")),
    { parent: "a2x", index: 1 },
  );
  assert.equal(siblingStop(t, "d3a", 1), "d3b");
  assert.equal(siblingStop(t, "d3b", 1), null);
  assert.equal(siblingStop(t, "d4", -1), "a2x");
  assert.equal(siblingStop(t, "d4", 1), null); // bet 75 isn't developed
  assert.equal(siblingStop(t, ROOT, 1), null);
});

test("a root with several top-level nodes is itself the entry", () => {
  const two = studyTree([n("f1", "flop", null), n("f2", "flop", null)], ROOT);
  assert.equal(entryStop(two), ROOT);
  assert.deepEqual(
    targets(two, ROOT).map((x) => x.stop),
    ["f1", "f2"],
  );
});

test("solutions: the fork, the solution a node is in, the same line in another", () => {
  // Flop with two solutions: the main one and a node-locked re-solve.
  const ns: PokerNode[] = [
    n("F", "flop", null, { cards: ["Ks", "7d", "2c"] }),
    n("m1", "strategy", "F", { actions: [opt("x", "Check")] }),
    act("mx", "m1", "x"),
    n("m2", "strategy", "mx", { actions: [opt("x", "Check")] }),
    act("mxx", "m2", "x"),
    n("mT", "turn", "mxx", { card: "5h" }),
    n("m3", "strategy", "mT", { actions: [] }),
    n("l1", "strategy", "F", { actions: [opt("x", "Check")], solution: { name: "Nodelock BTN" } }),
    act("lx", "l1", "x"),
    n("l2", "strategy", "lx", { actions: [opt("x", "Check")] }),
  ];
  const tt = studyTree(ns, ROOT);
  const s = solutionOf(tt, "m3")!;
  assert.equal(s.fork, "F");
  assert.deepEqual(s.roots.map((r) => r.id), ["m1", "l1"]);
  assert.equal(s.current.id, "m1");
  assert.equal(solutionName(s.roots[0], 0), "Main");
  assert.equal(solutionName(s.roots[1], 1), "Nodelock BTN");
  assert.equal(solutionOf(tt, "l2")!.current.id, "l1");
  assert.equal(solutionOf(t, "d3a"), null); // no fork in the main fixture
  // m2 (after BB check) → l2; m3 (turn 5h) → as deep as the locked tree goes: l2.
  assert.equal(sameLine(tt, "m2", "m1", "l1"), "l2");
  assert.equal(sameLine(tt, "m3", "m1", "l1"), "l2");
  assert.equal(sameLine(tt, "l2", "l1", "m1"), "m2");
  // The fork is a stop: two decisions below it.
  assert.equal(stopKind(tt, "F"), "branches");
});
