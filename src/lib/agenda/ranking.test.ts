/**
 * Unit tests for the backlog page's ordering, deadline labels and quick add.
 * Run with `npm test`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  comparator,
  daysUntil,
  deadlineLabel,
  matchesDeadline,
  parseQuickAdd,
  urgency,
} from "./ranking";

const TODAY = "2026-10-08"; // a Thursday
const at = (date: string) => `${date}T00:00:00+00:00`;
const task = (priority: number, deadline: string | null, created = "2026-10-01T10:00:00Z") => ({
  priority,
  deadline: deadline ? at(deadline) : null,
  created_at: created,
});

test("daysUntil counts calendar days", () => {
  assert.equal(daysUntil(at("2026-10-08"), TODAY), 0);
  assert.equal(daysUntil(at("2026-10-09"), TODAY), 1);
  assert.equal(daysUntil(at("2026-10-05"), TODAY), -3);
  // Across the October DST change: still whole days.
  assert.equal(daysUntil(at("2026-10-26"), TODAY), 18);
});

test("a close deadline outranks a higher priority with none", () => {
  const normalTomorrow = task(3, "2026-10-09");
  const highNoDeadline = task(2, null);
  const urgentNoDeadline = task(1, null);
  assert.ok(urgency(normalTomorrow, TODAY) < urgency(highNoDeadline, TODAY));
  assert.ok(urgency(urgentNoDeadline, TODAY) < urgency(normalTomorrow, TODAY));
});

test("smart sort: urgency, then nearest deadline, then priority, then oldest", () => {
  const list = [
    { id: "someday", ...task(4, null) },
    { id: "normal-far", ...task(3, "2026-12-01") },
    { id: "overdue-normal", ...task(3, "2026-10-01") },
    { id: "urgent", ...task(1, null) },
    { id: "high", ...task(2, null) },
    { id: "normal-tomorrow", ...task(3, "2026-10-09") },
  ];
  const order = [...list].sort(comparator("smart", TODAY)).map((t) => t.id);
  assert.deepEqual(order, [
    "overdue-normal",
    "urgent",
    "normal-tomorrow",
    "high",
    "normal-far",
    "someday",
  ]);
});

test("deadline sort puts undated last; recent sort is newest first", () => {
  const a = { id: "a", ...task(3, null, "2026-10-01T00:00:00Z") };
  const b = { id: "b", ...task(3, "2026-10-20", "2026-10-02T00:00:00Z") };
  const c = { id: "c", ...task(1, "2026-10-10", "2026-10-03T00:00:00Z") };
  assert.deepEqual([a, b, c].sort(comparator("deadline", TODAY)).map((t) => t.id), ["c", "b", "a"]);
  assert.deepEqual([a, b, c].sort(comparator("recent", TODAY)).map((t) => t.id), ["c", "b", "a"]);
  assert.deepEqual([a, b, c].sort(comparator("priority", TODAY)).map((t) => t.id), ["c", "b", "a"]);
});

test("deadline labels", () => {
  assert.deepEqual(deadlineLabel(at("2026-10-08"), TODAY), { text: "Today", tone: "soon" });
  assert.deepEqual(deadlineLabel(at("2026-10-09"), TODAY), { text: "Tomorrow", tone: "soon" });
  assert.deepEqual(deadlineLabel(at("2026-10-07"), TODAY), { text: "Yesterday", tone: "overdue" });
  assert.deepEqual(deadlineLabel(at("2026-10-04"), TODAY), { text: "4d late", tone: "overdue" });
  assert.equal(deadlineLabel(at("2026-10-12"), TODAY).text, "Mon");
  assert.deepEqual(deadlineLabel(at("2026-10-23"), TODAY), { text: "Fri 23 Oct", tone: "later" });
});

test("deadline filters", () => {
  assert.equal(matchesDeadline(null, "none", TODAY), true);
  assert.equal(matchesDeadline(at("2026-10-01"), "overdue", TODAY), true);
  assert.equal(matchesDeadline(at("2026-10-08"), "overdue", TODAY), false);
  assert.equal(matchesDeadline(at("2026-10-15"), "week", TODAY), true);
  assert.equal(matchesDeadline(at("2026-10-16"), "week", TODAY), false);
  assert.equal(matchesDeadline(null, "week", TODAY), false);
});

test("quick add pulls out duration and priority", () => {
  assert.deepEqual(parseQuickAdd("review BTN vs BB 3bp 45m !2"), {
    description: "review BTN vs BB 3bp",
    minutes: 45,
    priority: 2,
  });
  assert.deepEqual(parseQuickAdd("1h30 read chapter 4"), {
    description: "read chapter 4",
    minutes: 90,
    priority: null,
  });
  assert.equal(parseQuickAdd("2h").minutes, 120);
  assert.equal(parseQuickAdd("90min").minutes, 90);
  // Not shortcuts: out of range, or part of a word.
  assert.deepEqual(parseQuickAdd("buy h2o x!2 2m"), {
    description: "buy h2o x!2 2m",
    minutes: null,
    priority: null,
  });
});
