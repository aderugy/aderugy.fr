import { test } from "node:test";
import assert from "node:assert/strict";
import { assignCombos, categoryIndex, groupFilter, quickSections, rangeCombos, summarize, type HandCategory } from "./categories";

const cats: HandCategory[] = [
  { id: "a", name: "Nuts", color: "#000", combos: ["AsAh", "KsKh"] },
  { id: "b", name: "Air", color: "#111", combos: ["7s6s"] },
];

test("a combo moves between categories, never in two", () => {
  const next = assignCombos(cats, ["KsKh", "7s6s", "QsQh"], "b");
  assert.deepEqual(next[0].combos, ["AsAh"]);
  assert.deepEqual(next[1].combos, ["KsKh", "7s6s", "QsQh"]);
  const back = assignCombos(next, ["7s6s"], null);
  assert.deepEqual(back[1].combos, ["KsKh", "QsQh"]);
  assert.equal(categoryIndex(back).get("AsAh"), "a");
  assert.equal(categoryIndex(back).has("7s6s"), false);
});

test("range, summaries and groups", () => {
  // AA: all in range, always bets; 76s: half in range, checks.
  const weights = { hands: { AA: [100, 0], "76s": [0, 50] }, combos: {} };
  const board = ["8h", "5d", "3d"];
  const range = rangeCombos(weights, 2, new Set(board));
  assert.equal(range.length, 6 + 4);
  const s = summarize(range, () => true, 2, null);
  assert.equal(s.weight, 8);
  assert.deepEqual(s.strategy, [75, 25]);
  const aa = summarize(range, (c) => c.hand === "AA", 2, null);
  assert.equal(aa.share, 75);
  assert.deepEqual(aa.strategy, [100, 0]);

  const sections = quickSections(range, board, null, null);
  const ids = sections.flatMap((x) => x.groups.map((g) => g.id));
  assert.ok(ids.includes("made:overpair"));
  assert.ok(ids.includes("draw:combo_draw")); // 7d6d
  assert.ok(!ids.includes("made:set"));
  const f = groupFilter(sections, new Set(["made:nothing", "draw:combo_draw"]))!;
  assert.deepEqual(range.filter(f).map((c) => c.combo), ["7d6d"]);
  assert.equal(groupFilter(sections, new Set()), null);
});
