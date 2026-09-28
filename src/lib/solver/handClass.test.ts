import { test } from "node:test";
import assert from "node:assert/strict";
import { drawClass, handStrength, madeClass } from "./handClass";

const B = (s: string) => s.match(/../g)!;

test("made hands on 8h5d3d", () => {
  const board = B("8h5d3d");
  const cases: [string, string][] = [
    ["8s8c", "set"],
    ["8s5s", "two_pair"],
    ["QsQc", "overpair"],
    ["8cAs", "top_pair"],
    ["7s7c", "pp_below_top"],
    ["5sAs", "2nd_pair"],
    ["4s4c", "pp_below_2nd"],
    ["3sKs", "3rd_pair"],
    ["2s2c", "underpair"],
    ["AsKc", "ace_high"],
    ["KsQc", "king_high"],
    ["QsJc", "nothing"],
    ["AdKd", "ace_high"],
  ];
  for (const [combo, want] of cases) assert.equal(madeClass(combo, board), want, combo);
});

test("paired boards and full boards", () => {
  assert.equal(madeClass("8sAc", B("8h8d3c")), "trips");
  assert.equal(madeClass("3s3h", B("8h8d3c")), "full_house");
  assert.equal(madeClass("8s8c", B("8h8d3c")), "quads");
  assert.equal(madeClass("3sAc", B("8h8d3c")), "2nd_pair");
  assert.equal(madeClass("AdKd", B("8d5d3d2d")), "flush");
  // Board plays: the hole cards add nothing.
  assert.equal(madeClass("AsKc", B("5h6d7c8s9h")), "ace_high");
  assert.equal(madeClass("TsKc", B("5h6d7c8s9h")), "straight");
  assert.equal(madeClass("4d6d", B("5d7d8d2c")), "straight_flush");
  assert.equal(madeClass("7c6c", B("8h5d4d")), "straight");
  assert.equal(madeClass("As2c", B("5h4d3c")), "straight");
});

test("draws", () => {
  const board = B("8h5d3d");
  assert.equal(drawClass("AdKd", board), "flush_draw");
  assert.equal(drawClass("7d6d", board), "combo_draw");
  assert.equal(drawClass("7s6c", board), "oesd");
  assert.equal(drawClass("As2c", board), "gutshot"); // only a 4 (wheel, or 2-6 with a 6 still missing)
  assert.equal(drawClass("Ts9c", board), "no_draw");
  assert.equal(drawClass("7s4c", board), "gutshot"); // a 6
  assert.equal(drawClass("7sTc", board), "no_draw");
  assert.equal(drawClass("6s4c", board), "oesd"); // a 2 or a 7
  assert.equal(drawClass("AhKh", board), "backdoor_fd");
  assert.equal(drawClass("AdKd", B("8h5d3d2c7s")), "no_draw");
});

test("strength orders hands", () => {
  const board = B("8h5d3d");
  const s = (c: string) => handStrength([...B(c), ...board]);
  assert.ok(s("8s8c") > s("QsQc"));
  assert.ok(s("QsQc") > s("8cAs"));
  assert.ok(s("8cAs") > s("8cKs"));
});
