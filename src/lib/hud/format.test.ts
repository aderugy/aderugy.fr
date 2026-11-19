import assert from "node:assert/strict";
import { test } from "node:test";
import layout from "./layout.json" with { type: "json" };
import { describeFilters, filterParams, gridCells, formatStat, popupTabs, shortCount, showStat, statValue } from "./format";
import { LIMPERS } from "./extra";
import type { HudItem, HudLayout } from "./types";

type StatItem = Extract<HudItem, { t: "stat" }>;

const vpip: StatItem = {
  t: "stat",
  stat: "VPIP",
  pos: 0,
  prefix: "VP ",
  minSample: 10,
  ranges: [
    [0, 22.99, "#00ffff"],
    [23, 27.99, "#ff8000"],
    [28, 31.99, "#ff0000"],
    [32, 100, "#ff0080"],
  ],
};

test("values by kind", () => {
  assert.equal(statValue("VPIP", [3, 12]), 25);
  assert.equal(statValue("VPIP", [0, 0]), null);
  assert.equal(statValue("BB/100", [-9.5, 3]), (-9.5 / 3) * 100);
  assert.equal(statValue("BB Won", [-9.5, 3]), -9.5);
  assert.equal(statValue("Flop AF", [2, 0]), Infinity);
  assert.equal(statValue("Flop AF", [3, 2]), 1.5);
  assert.equal(statValue("Hands Abbreviated", [1234, 1234]), 1234);
});

test("formatting", () => {
  assert.equal(formatStat("VPIP", 25.4), "25");
  assert.equal(formatStat("VPIP", null), "–");
  assert.equal(formatStat("Flop AF", 1.5), "1.5");
  assert.equal(formatStat("Flop AF", Infinity), "∞");
  assert.equal(formatStat("Hands Abbreviated", 1234), "1.2k");
  assert.equal(shortCount(950), "950");
  assert.equal(shortCount(12_400), "12k");
});

test("colour ranges, including the 0.01 gaps between them", () => {
  const stats = { VPIP: [[229, 1000]] as [number, number][] }; // 22.9 %
  assert.equal(showStat(vpip, stats).color, "#00ffff");
  assert.equal(showStat(vpip, { VPIP: [[22995, 100000]] }).color, "#00ffff"); // 22.995 %
  assert.equal(showStat(vpip, { VPIP: [[2300, 10000]] }).color, "#ff8000");
  assert.equal(showStat(vpip, { VPIP: [[40, 100]] }).color, "#ff0080");
});

test("thin samples and titles", () => {
  const s = showStat(vpip, { VPIP: [[2, 5]] });
  assert.equal(s.text, "40");
  assert.equal(s.thin, true);
  assert.equal(s.title, "VPIP: 40 (2 / 5)");
  assert.equal(s.label, "VPIP");
  assert.equal(s.sample, "2 / 5");
  assert.equal(showStat({ ...vpip, pos: 6 }, { VPIP: [[0, 0], [0, 0], [0, 0], [0, 0], [0, 0], [0, 0], [1, 2]] }).label, "VPIP · BTN");
  assert.equal(showStat({ t: "stat", stat: "BB/100", pos: 0 }, { "BB/100": [[-12.5, 1234]] }).sample, "1,234 hands");
  assert.equal(showStat({ ...vpip, pos: 6 }, { VPIP: [[0, 0], [0, 0], [0, 0], [0, 0], [0, 0], [0, 0], [1, 2]] }).text, "50");
  assert.equal(showStat({ t: "stat", stat: "Player", pos: 0 }, {}, "Villain").text, "Villain");
});

test("filters", () => {
  assert.deepEqual(filterParams({ limits: [], lastHands: 0, days: 0 }), { limits: undefined, last: undefined, days: undefined });
  assert.deepEqual(filterParams({ limits: [1, 2], lastHands: 500, days: 30 }), { limits: "1,2", last: "500", days: "30" });
  assert.equal(describeFilters({ limits: [1], lastHands: 500, days: 0 }, new Map([[1, "NL200"]])), "NL200 · last 500 hands");
  assert.equal(describeFilters({ limits: [], lastHands: 0, days: 0 }, new Map()), "All hands");
});

test("the generated layout has one main group and every stat item is well formed", () => {
  const l = layout as HudLayout;
  assert.equal(l.groups.filter((g) => g.main).length, 1);
  assert.equal(l.groups[0].main, true);
  for (const g of l.groups) {
    for (const it of g.items) {
      if (it.t !== "stat") continue;
      assert.ok(it.pos >= 0 && it.pos <= 6, `${g.name} ${it.stat} pos`);
      if (it.popup) assert.ok(l.groups.some((x) => x.name === it.popup), `popup ${it.popup} exists`);
    }
  }
});

test("popup tabs: the HUD's menu first, then the popups its stats open", () => {
  const tabs = popupTabs(layout as HudLayout);
  assert.deepEqual(
    tabs.slice(0, 6).map((t) => [t.label, t.group.name]),
    [
      ["Tools", "Tools"],
      ["Preflop", "Preflop3"],
      ["Flop", "Flop"],
      ["Turn", "Turn"],
      ["River", "River"],
      ["RFI", "RFI"],
    ],
  );
  assert.ok(!tabs.some((t) => t.group.name === "Preflop2"), "unlinked groups are left out");
});

test("grid placement: spans push cells to their column (PT4's triangle)", () => {
  const g = (layout as HudLayout).groups.find((x) => x.name === "3bet position vs position")!;
  const { cells, columns } = gridCells(g.items);
  assert.equal(columns, 7);
  const at = (stat: string, pos: number) =>
    cells.find((c) => c.kind === "cell" && c.item.t === "stat" && c.item.stat === stat && c.item.pos === pos);
  const bbVsSb = at("BB vs SB Open - 3Bet", 0);
  assert.ok(bbVsSb && bbVsSb.kind === "cell");
  assert.equal(bbVsSb.col, 7); // under "BB"
  const coFromBtn = at("3Bet vs CO Open", 6);
  assert.ok(coFromBtn && coFromBtn.kind === "cell" && coFromBtn.col === 5); // under "BTN"
  const header = cells.filter((c) => c.kind === "cell" && c.row === 1);
  assert.equal(header.length, 7);
  assert.ok(cells.some((c) => c.kind === "hr" && c.row === 2));
  // Every row fills exactly the 7 columns.
  const widths = new Map<number, number>();
  for (const c of cells) if (c.kind === "cell") widths.set(c.row, (widths.get(c.row) ?? 0) + c.span);
  assert.deepEqual([...new Set(widths.values())], [7]);
});

test("the Limpers panel: header + two rows of 7 positions on one grid", () => {
  const { cells, columns } = gridCells(LIMPERS.items);
  assert.equal(columns, 8);
  const stats = cells.filter((c) => c.kind === "cell" && c.item.t === "stat");
  assert.equal(stats.length, 14);
  const btnIso = stats.find((c) => c.kind === "cell" && c.item.t === "stat" && c.item.stat === "Raise With Previous Limpers" && c.item.pos === 6);
  assert.ok(btnIso && btnIso.kind === "cell" && btnIso.col === 6); // under "BTN"
});
