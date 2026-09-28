import { test } from "node:test";
import assert from "node:assert/strict";
import type { PioNode, PioRunouts } from "./pio";
import { asRunoutGroups, assignCards, runoutReport, summarizeRunouts, typicalCard } from "./runouts";

const pot = { oop: 30, ip: 30, start: 0 };
const node = (id: string, extra: Partial<PioNode> = {}): PioNode => ({
  id,
  type: "OOP_DEC",
  player: "OOP",
  last: id.split(":").at(-1),
  board: ["8h", "5d", "3d"],
  pot,
  children: 2,
  flags: ["PIO_ALG"],
  solved: true,
  ...extra,
});
const card = (c: string, eqOOP: number, evOOP: number, bet: number) => ({
  card: c,
  node: node(`r:0:c:c:${c}`),
  children: [node(`r:0:c:c:${c}:b75`, { type: "IP_DEC", player: "IP" }), node(`r:0:c:c:${c}:c`, { type: "IP_DEC", player: "IP" })],
  strategy: [bet, 1 - bet],
  equity: { OOP: eqOOP, IP: 1 - eqOOP },
  ev: { OOP: evOOP, IP: 60 - evOOP },
  notes: [],
});

const answer: PioRunouts = {
  file: "BB vs BTN/x.cfr",
  node: node("r:0:c:c", { type: "SPLIT_NODE", player: undefined }),
  cards: [
    card("2c", 0.5, 32, 0.2),
    card("Kh", 0.4, 22, 0.1),
    card("7s", 0.52, 34, 0.3),
    { ...card("As", 0.4, 20, 0), node: node("r:0:c:c:As", { solved: false }) },
  ],
  ms: 10,
};

test("runout report: %, bb, labels, missing cards", () => {
  const r = runoutReport(answer, 975, "t");
  assert.equal(r.actor, "OOP");
  assert.deepEqual(r.actions.map((a) => a.label), ["Bet 75%", "Check"]);
  assert.deepEqual(r.missing, ["As"]);
  assert.equal(r.rows.length, 3);
  const two = r.rows.find((x) => x.card === "2c")!;
  assert.deepEqual(two.equity, { OOP: 50, IP: 50 });
  assert.deepEqual(two.ev, { OOP: 3.2, IP: 2.8 });
  assert.deepEqual(two.strategy, [20, 80]);
  const s = summarizeRunouts(r.rows, 2);
  assert.ok(Math.abs(s.equity.OOP! - 47.333) < 0.01);
  assert.ok(Math.abs(s.strategy![0] - 20) < 1e-9);
});

test("runout groups: one group per card, the card to study", () => {
  const r = runoutReport(answer, 975, "t");
  let g = asRunoutGroups([{ id: "a", name: "Bricks", color: "#000", cards: ["2c"], study: "2c" }, { id: "b", name: "Broadway", color: "#111", cards: [] }]);
  g = assignCards(g, ["7s", "Kh"], "a");
  assert.deepEqual(g[0].cards, ["2c", "7s", "Kh"]);
  g = assignCards(g, ["2c", "Kh"], "b");
  assert.deepEqual(g[0].cards, ["7s"]);
  assert.equal(g[0].study, null); // 2c left the group
  assert.deepEqual(g[1].cards, ["2c", "Kh"]);
  // 2c (50%, 3.2bb, 20% bet) is closer to the average of the three than Kh or 7s.
  assert.equal(typicalCard(r.rows, ["2c", "Kh", "7s"]), "2c");
});
