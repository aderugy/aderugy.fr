/**
 * The flash-card scheduler and review days. Run with `npm test`.
 *
 * As for the FSRS of /maths, these test properties (which state a rating
 * leads to, what order the buttons are in, where a review day starts), not
 * numbers copied from the implementation.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { dayEnd, dayStart, reviewDay } from "./day";
import { formatDelay, preview, recallNow, schedule } from "./scheduler";
import { DEFAULT_SETTINGS, type Memory, type Settings } from "./types";

const S: Settings = DEFAULT_SETTINGS;
// Wednesday 14 Oct 2026, 10:00 in Paris.
const NOW = new Date("2026-10-14T08:00:00Z");
const minutes = (ms: number) => Math.round(ms / 60_000);
const days = (ms: number) => ms / 86_400_000;

const fresh = (): Memory => ({
  state: "new",
  step: 0,
  stability: 0,
  difficulty: 0,
  due: NOW.toISOString(),
  lastReview: null,
  reps: 0,
  lapses: 0,
});

const mature = (p: Partial<Memory> = {}): Memory => ({
  state: "review",
  step: 0,
  stability: 20,
  difficulty: 5,
  due: "2026-10-14T02:00:00Z",
  lastReview: "2026-09-24T08:00:00Z",
  reps: 6,
  lapses: 0,
  ...p,
});

test("review days start at 4 h in Paris, across the clock change", () => {
  assert.equal(reviewDay(new Date("2026-10-14T01:30:00Z"), S), "2026-10-13"); // 03:30 Paris
  assert.equal(reviewDay(new Date("2026-10-14T02:30:00Z"), S), "2026-10-14"); // 04:30 Paris
  assert.equal(dayStart("2026-10-14", S).toISOString(), "2026-10-14T02:00:00.000Z"); // summer time
  assert.equal(dayStart("2026-10-26", S).toISOString(), "2026-10-26T03:00:00.000Z"); // winter time
  // Clocks go back at 03:00 on 25 Oct: the review day of the 24th is 25 hours long.
  assert.equal(dayEnd(new Date("2026-10-24T12:00:00Z"), S).getTime() - dayStart("2026-10-24", S).getTime(), 25 * 3_600_000);
});

test("a new card walks the learning steps", () => {
  const p = preview(fresh(), NOW, S);
  assert.equal(p[1].memory.state, "learning");
  assert.equal(minutes(p[1].inMs), 1);
  assert.equal(minutes(p[2].inMs), 6); // halfway between 1 and 10
  assert.equal(p[3].memory.state, "learning");
  assert.equal(p[3].memory.step, 1);
  assert.equal(minutes(p[3].inMs), 10);
  assert.equal(p[4].memory.state, "review");
  assert.ok(days(p[4].inMs) >= 1);
  for (const r of [1, 2, 3, 4] as const) {
    assert.equal(p[r].memory.reps, 1);
    assert.equal(p[r].memory.lapses, 0, "Again on a new card is not a lapse");
    assert.ok(p[r].memory.stability > 0);
  }
  assert.ok(p[4].memory.stability > p[3].memory.stability);
});

test("Good on the last step graduates; Easy lands at least a day after Good", () => {
  const learning = schedule(fresh(), 3, NOW, S).memory;
  const later = new Date(NOW.getTime() + 10 * 60_000);
  const p = preview(learning, later, S);
  assert.equal(p[3].memory.state, "review");
  assert.equal(p[3].memory.stability, learning.stability, "steps do not move the memory state");
  assert.ok(days(p[4].inMs) >= days(p[3].inMs) + 0.9);
  assert.equal(p[1].memory.step, 0);
  assert.equal(p[2].memory.step, 1);
  assert.equal(minutes(p[2].inMs), 10, "Hard repeats the step");
});

test("a graduated card is due at the start of its review day", () => {
  const out = schedule(fresh(), 4, NOW, S).memory;
  const due = new Date(out.due);
  assert.equal(dayStart(reviewDay(due, S), S).getTime(), due.getTime());
});

test("in review, the buttons keep their order and Again is a lapse", () => {
  const card = mature();
  const at = new Date("2026-10-14T08:00:00Z"); // 20 days on, R ≈ 0.9
  const p = preview(card, at, S);
  assert.ok(p[2].inMs <= p[3].inMs);
  assert.ok(p[3].inMs < p[4].inMs);
  assert.ok(days(p[2].inMs) >= 1);
  assert.equal(p[1].memory.state, "relearning");
  assert.equal(p[1].memory.lapses, 1);
  assert.ok(p[1].memory.stability < card.stability, "a lapse lowers stability");
  assert.equal(minutes(p[1].inMs), 10);
  assert.ok(p[3].memory.stability > card.stability, "a success raises stability");
  assert.ok(p[1].memory.difficulty > card.difficulty && p[4].memory.difficulty < card.difficulty);
  assert.ok(Math.abs(p[3].elapsedDays - 20) < 1e-9);
});

test("a higher target retention brings cards back sooner", () => {
  const card = mature();
  const at = new Date("2026-10-14T08:00:00Z");
  const low = preview(card, at, { ...S, retention: 0.8 })[3].inMs;
  const high = preview(card, at, { ...S, retention: 0.95 })[3].inMs;
  assert.ok(high < low);
});

test("relearning ends back in review on the stability the lapse left", () => {
  const lapsed = schedule(mature(), 1, NOW, S).memory;
  const back = schedule(lapsed, 3, new Date(NOW.getTime() + 10 * 60_000), S).memory;
  assert.equal(back.state, "review");
  assert.equal(back.stability, lapsed.stability);
  assert.equal(back.lapses, 1);
});

test("with no relearning steps, a lapse goes straight back to review", () => {
  const out = schedule(mature(), 1, NOW, { ...S, relearningSteps: [] }).memory;
  assert.equal(out.state, "review");
  assert.equal(out.lapses, 1);
});

test("leeches: at the threshold, then every half threshold", () => {
  const leechAt = (lapses: number) => schedule(mature({ lapses }), 1, NOW, S).leech;
  assert.equal(leechAt(6), false); // → 7
  assert.equal(leechAt(7), true); // → 8
  assert.equal(leechAt(8), false); // → 9
  assert.equal(leechAt(11), true); // → 12
});

test("a step index past the configured steps is clamped", () => {
  const card: Memory = { ...mature(), state: "learning", step: 5, stability: 3 };
  const out = schedule(card, 3, NOW, S).memory;
  assert.equal(out.state, "review");
});

test("recall now is 1 outside review and falls with time", () => {
  assert.equal(recallNow({ state: "learning", stability: 3, lastReview: NOW.toISOString() }, NOW), 1);
  const soon = recallNow(mature(), new Date("2026-09-25T08:00:00Z"));
  const late = recallNow(mature(), new Date("2026-11-25T08:00:00Z"));
  assert.ok(soon > late);
});

test("delays read like a rating button", () => {
  assert.equal(formatDelay(60_000), "1m");
  assert.equal(formatDelay(10 * 60_000), "10m");
  assert.equal(formatDelay(6 * 3_600_000), "6h");
  assert.equal(formatDelay(3 * 86_400_000), "3d");
  assert.equal(formatDelay(45 * 86_400_000), "1.5mo");
  assert.equal(formatDelay(800 * 86_400_000), "2.2y");
});
