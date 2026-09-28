/**
 * Pio import, checked on the real solver's answers recorded by PioProbe on
 * 8h5d3d.cfr (tools/pio-bridge/testdata). Run with `npm test`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  matchPioAction,
  pioActions,
  pioSnapshot,
  pioStats,
  pioWeights,
  seatsFromPath,
  streetStartId,
  toStrategyActions,
  type PioDecision,
  type PioNode,
  type PioVector,
} from "./pio";
import { globalFrequencies } from "./strategy";
import { handDisplayVector } from "./strategy";

/* ------------------------------------------------ the recorded solver */

const transcript = readFileSync(path.join(process.cwd(), "tools/pio-bridge/testdata/probe-8h5d3d.txt"), "utf8");
const answers = new Map<string, string[]>();
{
  let cur: string | null = null;
  for (const line of transcript.split(/\r?\n/)) {
    if (line.startsWith(">>> ")) {
      cur = line.slice(4).trim();
      if (answers.has(cur)) cur = null;
      else answers.set(cur, []);
    } else if (line.startsWith("<<< ")) cur = null;
    else if (cur && !line.startsWith("### ")) answers.get(cur)!.push(line);
  }
}
function lines(cmd: string): string[] {
  const a = answers.get(cmd);
  assert.ok(a, `not recorded: ${cmd}`);
  return a.filter((l) => l.trim() !== "");
}
const vec = (l: string): PioVector => l.trim().split(/\s+/).map((x) => (x === "nan" || x.includes("nan") ? null : Number(x)));

function parseNode(block: string[]): PioNode {
  const [id, type, board, pot, children, flags] = block.map((l) => l.trim());
  const [oop, ip, start] = pot.split(/\s+/).map(Number);
  const f = flags.replace(/^flags:\s*/, "").split(/\s+/).filter(Boolean);
  const player = type.startsWith("OOP") ? "OOP" : type.startsWith("IP") ? "IP" : undefined;
  return {
    id,
    type,
    player,
    last: id.split(":").at(-1),
    board: board.split(/\s+/),
    pot: { oop, ip, start },
    children: parseInt(children, 10),
    flags: f,
    solved: player ? f.includes("PIO_ALG") : true,
  };
}
function node(id: string): PioNode {
  return parseNode(lines(`show_node ${id}`));
}
function children(id: string): PioNode[] {
  const out: PioNode[] = [];
  let cur: string[] = [];
  for (const l of lines(`show_children ${id}`)) {
    if (l.startsWith("child")) {
      if (cur.length) out.push(parseNode(cur));
      cur = [];
    } else cur.push(l);
  }
  if (cur.length) out.push(parseNode(cur));
  return out;
}
function decision(id: string, childEv: boolean): PioDecision {
  const n = node(id);
  const kids = children(id);
  const [eq, eqw, eqt] = lines(`calc_eq_node OOP ${id}`);
  const [ev, evw] = lines(`calc_ev OOP ${id}`);
  return {
    file: "BB vs BTN/Second souffle/8h5d3d.cfr",
    node: n,
    children: kids,
    player: "OOP",
    strategy: lines(`show_strategy ${id}`).map(vec),
    range: vec(lines(`show_range OOP ${id}`)[0]),
    villainRange: vec(lines(`show_range IP ${id}`)[0]),
    stats: {
      unit: "chips",
      equity: vec(eq),
      equityWeights: vec(eqw),
      equityTotal: Number(eqt),
      ev: vec(ev),
      evWeights: vec(evw),
      childEv: kids.map((k) => (childEv ? vec(lines(`calc_ev OOP ${k.id}`)[0]) : null)),
      notes: [],
    },
    ms: 0,
  };
}
const handOrder = lines("show_hand_order")[0].trim().split(/\s+/);
const STACK = 975;

/* ---------------------------------------------------------------- tests */

test("street start ids", () => {
  assert.equal(streetStartId("r:0"), "r:0");
  assert.equal(streetStartId("r:0:b45"), "r:0");
  assert.equal(streetStartId("r:0:c:c:As"), "r:0:c:c:As");
  assert.equal(streetStartId("r:0:c:c:As:c:b60"), "r:0:c:c:As");
  assert.equal(streetStartId("r"), "r");
});

test("flop options: bets in bb and % of the pot, check", () => {
  const n = node("r:0");
  const opts = pioActions(n, children("r:0"), n.pot, STACK);
  assert.deepEqual(
    opts.map((o) => [o.kind, o.sizeBb, o.potPct, o.label]),
    [
      ["bet", 4.5, 75, "Bet 75%"],
      ["bet", 2, 33.3, "Bet 33%"],
      ["check", null, null, "Check"],
    ],
  );
});

test("facing a bet: raise-to in bb, call, fold", () => {
  // IP facing BB's 4.5bb flop bet (pot line 45 0 60): raise to 13.5bb.
  const n = { ...children("r:0")[0], player: "IP" as const };
  const opts = pioActions(n, children("r:0:b45"), node("r:0").pot, STACK);
  assert.deepEqual(
    opts.map((o) => [o.kind, o.sizeBb, o.label]),
    [
      ["raise", 13.5, "Raise 13.5bb"],
      ["call", null, "Call"],
      ["fold", null, "Fold"],
    ],
  );
});

test("turn after bet / call: sizes count from the street, all-in detected", () => {
  const turn = node("r:0:b45:c:2c");
  assert.deepEqual(turn.pot, { oop: 45, ip: 45, start: 60 });
  const opts = pioActions(turn, children("r:0:b45:c:2c"), turn.pot, STACK);
  // 495 = 45 already in + a 450 bet into 150: 300% of the pot.
  assert.deepEqual(opts[0], { kind: "bet", sizeBb: 45, potPct: 300, allIn: false, label: "Bet 300%", childId: "r:0:b45:c:2c:b495" });
  // Facing it, IP's only raise is all-in (975 = the effective stack).
  const facing = { ...node("r:0:b45:c:2c:b495"), player: "IP" as const };
  const answer = pioActions(facing, children("r:0:b45:c:2c:b495"), turn.pot, STACK);
  assert.deepEqual(
    answer.map((o) => [o.kind, o.sizeBb, o.allIn, o.label]),
    [
      ["raise", 93, true, "All-in"],
      ["call", null, false, "Call"],
      ["fold", null, false, "Fold"],
    ],
  );
  assert.deepEqual(pioSnapshot(turn, STACK), { potBb: 15, stackBb: 93 });
});

test("app actions find their Pio option", () => {
  const n = node("r:0");
  const opts = pioActions(n, children("r:0"), n.pot, STACK);
  const find = (a: Parameters<typeof matchPioAction>[0]) => matchPioAction(a, opts)?.childId ?? null;
  assert.equal(find({ kind: "bet", sizePct: 4.5, sizeUnit: "bb", label: "Bet 4.5bb" }), "r:0:b45");
  assert.equal(find({ kind: "bet", sizePct: 33, sizeUnit: "pct", label: "Bet 33%" }), "r:0:b20");
  assert.equal(find({ kind: "bet", sizePct: 75, sizeUnit: null, label: "Bet 75%" }), "r:0:b45");
  assert.equal(find({ kind: "check", label: "Check" }), "r:0:c");
  assert.equal(find({ kind: "bet", sizePct: 50, sizeUnit: "pct", label: "Bet 50%" }), null);
  assert.equal(find({ kind: "fold", label: "Fold" }), null);
});

test("re-import keeps action ids, CSV-imported sizes included", () => {
  const n = node("r:0");
  const opts = pioActions(n, children("r:0"), n.pot, STACK);
  const first = toStrategyActions(opts);
  const again = toStrategyActions(opts, first);
  assert.deepEqual(again.map((a) => a.id), first.map((a) => a.id));
  // A CSV header "BET 45" was stored as 4.5bb.
  const csv = [{ id: "csv-45", kind: "bet" as const, sizePct: 4.5, sizeUnit: "bb" as const, label: "Bet 4.5bb", color: "" }];
  assert.equal(toStrategyActions(opts, csv)[0].id, "csv-45");
  // Bigger bets get the darker colour.
  assert.notEqual(first[0].color, first[1].color);
});

test("grid: range-weighted strategy matches the solver's global frequencies", () => {
  const d = decision("r:0", true);
  const w = pioWeights(d, handOrder, d.node.board);
  const freqs = globalFrequencies(w, 3, new Set(d.node.board))!;
  // Solver strategy averaged over OOP's range (computed from the same answers).
  const want = [0, 1, 2].map((a) => {
    let s = 0;
    let t = 0;
    for (let h = 0; h < 1326; h++) {
      const r = d.range[h] ?? 0;
      s += r * (d.strategy[a][h] ?? 0);
      t += r;
    }
    return (s / t) * 100;
  });
  for (let a = 0; a < 3; a++) assert.ok(Math.abs(freqs[a] - want[a]) < 0.05, `action ${a}: ${freqs[a]} vs ${want[a]}`);
  // 99 is half in BB's range (99:0.5): its cell is half high.
  const nines = handDisplayVector(w, "99", 3)!;
  assert.ok(Math.abs(nines.reduce((x, y) => x + y, 0) - 50) < 0.5, `99 total ${nines}`);
  // Board cards block combos: no 8h in any stored combo.
  assert.ok(!Object.keys(w.combos).some((c) => c.includes("8h")));
});

test("stats: equity for both players, EV of the node and of each action in bb", () => {
  const d = decision("r:0:c:c:As", true);
  const s = pioStats(d, handOrder, { seats: { OOP: "BB", IP: "BTN" }, importedAt: "2026-09-28T00:00:00Z" })!;
  assert.equal(s.actor, "OOP");
  assert.equal(s.players.OOP!.equityTotal, 44.3);
  assert.ok(Object.keys(s.players.IP!.range).length > 300, "villain range kept");
  // 8s8c: EV 122.79 chips = 12.279 bb, equity 96.4%, EV per action from the children.
  assert.equal(s.ev!.node["8s8c"], 12.279);
  assert.equal(s.players.OOP!.equity["8s8c"], 96.4);
  assert.equal(s.ev!.actions["8s8c"].length, 6);
  // Node EV = Σ strategy × action EV (per combo), still true in bb.
  const i = handOrder.indexOf("8s8c");
  const sum = d.strategy.reduce((acc, row, a) => acc + (row[i] ?? 0) * (s.ev!.actions["8s8c"][a] ?? 0), 0);
  assert.ok(Math.abs(sum - s.ev!.node["8s8c"]) < 0.01);
  // The weight lines already include the player's reach (a combo at 86% reach
  // weighs 86% of a full one): averaging equity by them alone gives the
  // solver's own range equity, so EV is averaged the same way (22.99 chips).
  const eq = d.stats!.equity;
  const ew = d.stats!.equityWeights;
  let num = 0;
  let den = 0;
  for (let h = 0; h < 1326; h++) {
    if (eq[h] == null || !(ew[h]! > 0)) continue;
    num += eq[h]! * ew[h]!;
    den += ew[h]!;
  }
  assert.ok(Math.abs((num / den) * 100 - 44.3037) < 0.001);
  assert.ok(Math.abs(s.ev!.total! - 2.299) < 0.001, `total ${s.ev!.total}`);
});

test("seats from the save's path", () => {
  assert.deepEqual(seatsFromPath("BB vs BTN/Second souffle/8h5d3d.cfr"), ["BB", "BTN"]);
  assert.equal(seatsFromPath("Misc/8h5d3d.cfr"), null);
});
