import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canUnschedule,
  counts,
  isMissed,
  minutesByCategory,
  moveReschedules,
  sessionMinutes,
  summaryFromRow,
} from "./sessions";
import type { SessionStatus } from "../types";

const NOW = Date.parse("2026-10-14T12:00:00Z");

const s = (starts: string, ends: string, status: SessionStatus = "planned", category_id: string | null = "poker") => ({
  starts_at: starts,
  ends_at: ends,
  status,
  category_id,
});

const before = s("2026-10-14T08:00:00Z", "2026-10-14T09:00:00Z");
const during = s("2026-10-14T11:30:00Z", "2026-10-14T12:30:00Z");
const after = s("2026-10-14T15:00:00Z", "2026-10-14T16:30:00Z");

test("minutes of a session", () => {
  assert.equal(sessionMinutes(before), 60);
  assert.equal(sessionMinutes(after), 90);
});

test("missed: planned and over — not while it runs, not once done or skipped", () => {
  assert.equal(isMissed(before, NOW), true);
  assert.equal(isMissed(during, NOW), false);
  assert.equal(isMissed(after, NOW), false);
  assert.equal(isMissed({ ...before, status: "done" }, NOW), false);
  assert.equal(isMissed({ ...before, status: "skipped" }, NOW), false);
  assert.equal(isMissed(s("2026-10-14T11:00:00Z", "2026-10-14T12:00:00Z"), NOW), true, "ends exactly now");
});

test("moving a slot keeps a trace once its start has passed", () => {
  assert.equal(moveReschedules(before, NOW), true);
  assert.equal(moveReschedules(during, NOW), true, "started counts, even if not over");
  assert.equal(moveReschedules(after, NOW), false);
  assert.equal(moveReschedules({ ...before, status: "done" }, NOW), false, "a done slot is only corrected");
});

test("only a planned slot that has not started leaves the grid without a trace", () => {
  assert.equal(canUnschedule(after, NOW), true);
  assert.equal(canUnschedule(during, NOW), false);
  assert.equal(canUnschedule(before, NOW), false);
  assert.equal(canUnschedule({ ...after, status: "skipped" }, NOW), false);
});

test("week totals: skipped slots count for nothing, done ones also count as done", () => {
  assert.equal(counts({ status: "skipped" }), false);
  const m = minutesByCategory([
    before,
    { ...after, status: "done" },
    { ...during, status: "skipped" },
    s("2026-10-14T17:00:00Z", "2026-10-14T17:30:00Z", "planned", "maths"),
    s("2026-10-14T18:00:00Z", "2026-10-14T18:30:00Z", "planned", null),
  ]);
  assert.equal(m.planned.get("poker"), 150);
  assert.equal(m.done.get("poker"), 90);
  assert.equal(m.planned.get("maths"), 30);
  assert.equal(m.done.get("maths"), undefined);
  assert.equal(m.planned.size, 2, "a slot without a category counts nowhere");
});

test("summary rows map field for field", () => {
  assert.deepEqual(
    summaryFromRow({
      planned_id: "x",
      planned_starts: "a",
      planned_ends: "b",
      done_count: 1,
      skipped_count: 2,
      last_skipped: "c",
    }),
    { plannedId: "x", plannedStarts: "a", plannedEnds: "b", doneCount: 1, skippedCount: 2, lastSkipped: "c" },
  );
});
