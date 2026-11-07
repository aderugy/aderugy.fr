/**
 * Unit tests for the step clock, the focus line and the project stats.
 * Run with `npm test`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clockOf,
  clockState,
  defaultCut,
  fmtMinutes,
  focusLine,
  median,
  overrunRatio,
  parseMinutes,
  parisWeekStart,
  projectStats,
} from "./clock";
import { compareSteps, groupByMilestone, isUnreadFor, type Message, type Step } from "./types";

test("minutes read like the database prints them", () => {
  assert.equal(fmtMinutes(0), "0 min");
  assert.equal(fmtMinutes(40), "40 min");
  assert.equal(fmtMinutes(60), "1h00");
  assert.equal(fmtMinutes(190), "3h10");
  assert.equal(fmtMinutes(-15), "-15 min");
  assert.equal(fmtMinutes(-65), "-1h05");
});

test("default cut line is 1.5 × budget, within bounds", () => {
  assert.equal(defaultCut(120), 180);
  assert.equal(defaultCut(5), 8);
  assert.equal(defaultCut(6000), 9000);
});

test("clock state thresholds", () => {
  // budget 120, cut 180
  assert.equal(clockState(0, 120, 180), "ok");
  assert.equal(clockState(120, 120, 180), "ok");
  assert.equal(clockState(121, 120, 180), "over");
  assert.equal(clockState(144, 120, 180), "over"); // exactly 1.2 ×
  assert.equal(clockState(145, 120, 180), "drift");
  assert.equal(clockState(179, 120, 180), "drift");
  assert.equal(clockState(180, 120, 180), "closing");
  // A cut line below 1.2 × budget: closing wins over drift.
  assert.equal(clockState(130, 120, 130), "closing");
  assert.equal(clockState(125, 120, 130), "over");
});

test("clock numbers", () => {
  const c = clockOf(145, 120, 180);
  assert.equal(c.leftBudget, -25);
  assert.equal(c.leftCut, 35);
  assert.equal(c.overrunPct, 21);
  assert.equal(overrunRatio(185, 120), 1.54);
});

test("focus line, as in the spec", () => {
  const project = { slug: "MAD", status: "active" as const, next_action: "tables matchs + mises à jour", next_action_minutes: 40 };
  assert.equal(
    focusLine({
      project,
      open: { code: "2.1", title: "Ranger les données", budget_minutes: 120, cut_minutes: 180, spent: 190 },
      unread: 2,
    }),
    "MAD · 2.1 Ranger les données · ⏱ 3h10 / 2h00 (cut line 3h00) · closing · next: tables matchs + mises à jour (≈ 40 min) · 2 messages",
  );
  assert.equal(
    focusLine({
      project,
      open: { code: "2.1", title: "Ranger les données", budget_minutes: 120, cut_minutes: 180, spent: 145 },
      unread: 1,
    }),
    "MAD · 2.1 Ranger les données · ⏱ 2h25 / 2h00 (cut line 3h00) · drift +21 % · next: tables matchs + mises à jour (≈ 40 min) · 1 message",
  );
  assert.equal(
    focusLine({ project: { ...project, next_action: null }, open: null, unread: 0 }),
    "MAD · no open step",
  );
  assert.equal(
    focusLine({ project: { slug: "THESE", status: "draft", next_action: null, next_action_minutes: null }, open: null, unread: 0 }),
    "THESE · draft — contract not validated",
  );
});

test("focus line after a negative correction", () => {
  const line = focusLine({
    project: { slug: "MAD", status: "active", next_action: null, next_action_minutes: null },
    open: { code: "2.1", title: "X", budget_minutes: 60, cut_minutes: 90, spent: 0 },
    unread: 0,
  });
  assert.equal(line, "MAD · 2.1 X · ⏱ 0 min / 1h00 (cut line 1h30) · ok");
});

test("median with 1, 2 and 5 values", () => {
  assert.equal(median([]), null);
  assert.equal(median([1.5]), 1.5);
  assert.equal(median([1, 2]), 1.5);
  assert.equal(median([3, 1, 2, 5, 4]), 3);
});

test("Paris weeks across the DST change", () => {
  // Sunday 26 Oct 2025, 23:30 Paris (CET, UTC+1) is still the week of the 20th.
  assert.equal(parisWeekStart("2025-10-26T22:30:00Z"), "2025-10-20");
  // Monday 27 Oct, 00:30 Paris = Sunday 23:30 UTC: already the next week.
  assert.equal(parisWeekStart("2025-10-26T23:30:00Z"), "2025-10-27");
  // Spring: Monday 31 March 2025, 00:30 CEST = Sunday 22:30 UTC.
  assert.equal(parisWeekStart("2025-03-30T22:30:00Z"), "2025-03-31");
  assert.equal(parisWeekStart("2025-03-30T21:30:00Z"), "2025-03-24");
});

test("project stats", () => {
  const now = new Date("2026-11-07T10:00:00Z"); // Saturday; week of 2 Nov
  const steps = [
    { status: "done" as const, budget_minutes: 60, spent: 60, closed_at: "2026-11-03T10:00:00Z" },
    { status: "cut" as const, budget_minutes: 100, spent: 154, closed_at: "2026-11-02T08:00:00Z" },
    { status: "done" as const, budget_minutes: 50, spent: 40, closed_at: "2026-10-20T08:00:00Z" },
    { status: "done" as const, budget_minutes: 50, spent: 60, closed_at: "2026-09-01T08:00:00Z" }, // too old for the weeks
    { status: "dropped" as const, budget_minutes: 50, spent: 500, closed_at: "2026-11-04T08:00:00Z" },
    { status: "open" as const, budget_minutes: 50, spent: 10, closed_at: null },
  ];
  const items = [
    { created_as: "park" as const, origin: "claude" as const, created_at: "2026-11-06T10:00:00Z" },
    { created_as: "park" as const, origin: "arthur" as const, created_at: "2026-11-01T10:00:00Z" },
    { created_as: "park" as const, origin: "claude" as const, created_at: "2026-10-30T10:00:00Z" },
    { created_as: "park" as const, origin: "claude" as const, created_at: "2026-10-01T10:00:00Z" }, // outside 14 days
    { created_as: "todo" as const, origin: "claude" as const, created_at: "2026-11-06T10:00:00Z" },
  ];
  const s = projectStats(steps, items, now);
  // ratios 1, 1.54, 0.8, 1.2 → median 1.1 (dropped and open steps excluded)
  assert.equal(s.medianRatio, 1.1);
  assert.equal(s.closedSteps, 4);
  assert.equal(s.shareCut, 0.25);
  assert.deepEqual(s.stepsPerWeek, [
    { week: "2026-10-12", count: 0 },
    { week: "2026-10-19", count: 1 },
    { week: "2026-10-26", count: 0 },
    { week: "2026-11-02", count: 2 },
  ]);
  assert.equal(s.parkedPerDay, 0.2); // 3 in 14 days
  assert.equal(s.parkedByClaude, 2 / 3);
});

test("stats of a project with no closed step", () => {
  const s = projectStats([], [], new Date("2026-11-07T10:00:00Z"));
  assert.equal(s.medianRatio, null);
  assert.equal(s.shareCut, null);
  assert.equal(s.parkedByClaude, null);
});

test("steps sort by position then code, numbers as numbers", () => {
  const steps = [
    { position: 0, code: "2.10" },
    { position: 0, code: "2.2" },
    { position: -1, code: "9" },
  ];
  assert.deepEqual([...steps].sort(compareSteps).map((s) => s.code), ["9", "2.2", "2.10"]);
});

test("milestones keep plan order, unnamed last", () => {
  const base = { project_id: "p", title: "t", good_enough: null, budget_minutes: 60, cut_minutes: 90, status: "todo" as const, opened_at: null, closed_at: null, close_note: null };
  const steps: Step[] = [
    { ...base, id: "a", code: "1.0", milestone: "Jalon 1", position: 0 },
    { ...base, id: "b", code: "x", milestone: null, position: 1 },
    { ...base, id: "c", code: "2.0", milestone: "Jalon 2", position: 2 },
    { ...base, id: "d", code: "1.1", milestone: "Jalon 1", position: 3 },
  ];
  assert.deepEqual(
    groupByMilestone(steps).map((g) => [g.milestone, g.steps.map((s) => s.code)]),
    [["Jalon 1", ["1.0", "1.1"]], ["Jalon 2", ["2.0"]], [null, ["x"]]],
  );
});

test("unread means from the other side, not a next-action log line", () => {
  const m = (over: Partial<Message>): Message => ({
    id: "m", project_id: "p", step_id: null, author: "arthur", kind: "note", body: "b",
    surface: "app", read_at: null, created_at: "2026-11-07T10:00:00Z", ...over,
  });
  assert.equal(isUnreadFor(m({}), "claude"), true);
  assert.equal(isUnreadFor(m({}), "arthur"), false);
  assert.equal(isUnreadFor(m({ read_at: "2026-11-07T11:00:00Z" }), "claude"), false);
  assert.equal(isUnreadFor(m({ kind: "next_action" }), "claude"), false);
});

test("typed durations", () => {
  assert.equal(parseMinutes("40"), 40);
  assert.equal(parseMinutes("90m"), 90);
  assert.equal(parseMinutes("1h30"), 90);
  assert.equal(parseMinutes("2h"), 120);
  assert.equal(parseMinutes("1:05"), 65);
  assert.equal(parseMinutes("-15"), -15);
  assert.equal(parseMinutes(" 1 h 10 "), 70);
  assert.equal(parseMinutes(""), null);
  assert.equal(parseMinutes("abc"), null);
});
