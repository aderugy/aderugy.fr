/**
 * Wall-clock time in Europe/Paris, whatever zone the tests run in.
 * Run with `npm test`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addDaysISO,
  fmtClock,
  fmtDayHeading,
  fmtMinutes,
  fmtWhen,
  localDate,
  mondayOf,
  parseLocal,
  startOfLocalDay,
} from "./zoned";

const TZ = "Europe/Paris";

test("local times are read in Paris, summer and winter", () => {
  assert.equal(parseLocal("2026-10-09T18:00", TZ)!.toISOString(), "2026-10-09T16:00:00.000Z");
  assert.equal(parseLocal("2026-12-01 09:30", TZ)!.toISOString(), "2026-12-01T08:30:00.000Z");
  assert.equal(parseLocal("2026-10-09", TZ)!.toISOString(), "2026-10-08T22:00:00.000Z");
  assert.equal(parseLocal("2026-10-09T18:00Z", TZ)!.toISOString(), "2026-10-09T18:00:00.000Z");
  assert.equal(parseLocal("2026-10-09T18:00+02:00", TZ)!.toISOString(), "2026-10-09T16:00:00.000Z");
});

test("clock changes: the skipped hour moves forward, the repeated one takes the first", () => {
  // 29 Mar 2026, 02:00 → 03:00
  assert.equal(parseLocal("2026-03-29T02:30", TZ)!.toISOString(), "2026-03-29T01:30:00.000Z");
  assert.equal(fmtClock(parseLocal("2026-03-29T02:30", TZ)!, TZ), "03:30");
  // 25 Oct 2026, 03:00 → 02:00
  assert.equal(parseLocal("2026-10-25T02:30", TZ)!.toISOString(), "2026-10-25T00:30:00.000Z");
  assert.equal(parseLocal("2026-10-25T12:00", TZ)!.toISOString(), "2026-10-25T11:00:00.000Z");
  // The day of the change is 25 hours long.
  const len = startOfLocalDay("2026-10-26", TZ).getTime() - startOfLocalDay("2026-10-25", TZ).getTime();
  assert.equal(len, 25 * 3_600_000);
});

test("nonsense is refused", () => {
  assert.equal(parseLocal("2026-02-31T10:00", TZ), null);
  assert.equal(parseLocal("2026-10-09T25:00", TZ), null);
  assert.equal(parseLocal("tomorrow at 6", TZ), null);
});

test("days and weeks", () => {
  assert.equal(localDate(new Date("2026-10-08T22:30:00Z"), TZ), "2026-10-09");
  assert.equal(mondayOf("2026-10-11"), "2026-10-05");
  assert.equal(mondayOf("2026-10-05"), "2026-10-05");
  assert.equal(addDaysISO("2026-12-30", 3), "2027-01-02");
  assert.equal(fmtDayHeading("2026-10-09"), "Friday 9 Oct");
  assert.equal(fmtWhen("2026-10-09T16:00:00Z", TZ), "Fri 9 Oct 18:00");
  assert.equal(fmtMinutes(90), "1h30");
  assert.equal(fmtMinutes(120), "2h");
  assert.equal(fmtMinutes(45), "45 min");
});

/* -------------------------------------------------------- the week view */

import { busySpans, gaps, mergeSpans, minutesByCategory, allDayDates, weekSpan, type ViewBlock, type ViewEvent } from "./week-view";

const at = (s: string) => parseLocal(s, TZ)!.getTime();

test("gaps between busy spans, inside a window", () => {
  const window = { start: at("2026-10-09T08:00"), end: at("2026-10-09T22:00") };
  const busy = [
    { start: at("2026-10-09T09:00"), end: at("2026-10-09T10:00") },
    { start: at("2026-10-09T09:30"), end: at("2026-10-09T11:00") },
    { start: at("2026-10-09T11:10"), end: at("2026-10-09T12:00") },
    { start: at("2026-10-09T21:30"), end: at("2026-10-09T23:30") },
  ];
  assert.equal(mergeSpans(busy).length, 3);
  const free = gaps(window, busy, 30).map((g) => `${fmtClock(new Date(g.start), TZ)}-${fmtClock(new Date(g.end), TZ)}`);
  assert.deepEqual(free, ["08:00-09:00", "12:00-21:30"], "the 10-minute gap is too short");
});

const block = (over: Partial<ViewBlock>): ViewBlock => ({
  id: "b",
  starts_at: "2026-10-09T16:00:00Z",
  ends_at: "2026-10-09T17:00:00Z",
  description: null,
  status: "planned",
  created_by: "app",
  template: null,
  interview: null,
  tasks: [],
  ...over,
});

test("minutes by category: skipped blocks and all-day events do not count; events are clipped to the week", () => {
  const week = weekSpan("2026-10-05", TZ);
  const blocks = [
    block({ tasks: [{ task_id: "t1", category_id: "poker", description: null, minutes: 60, ad_hoc: true }], status: "done" }),
    block({ id: "b2", status: "skipped", tasks: [{ task_id: "t2", category_id: "poker", description: null, minutes: 90, ad_hoc: false }] }),
  ];
  const events: ViewEvent[] = [
    { calendar: "EPITA", category_id: "school", title: "ML", starts_at: "2026-10-12T06:00:00Z", ends_at: "2026-10-12T10:00:00Z", all_day: false, archived: false },
    { calendar: "EPITA", category_id: "school", title: "Sunday night", starts_at: "2026-10-11T21:00:00Z", ends_at: "2026-10-11T23:00:00Z", all_day: false, archived: false },
    { calendar: "Perso", category_id: "life", title: "Trip", starts_at: "2026-10-10T00:00:00Z", ends_at: "2026-10-12T00:00:00Z", all_day: true, archived: false },
  ];
  const m = minutesByCategory(blocks, events, week);
  assert.equal(m.planned.get("poker"), 60);
  assert.equal(m.done.get("poker"), 60);
  // Sunday 23:00–Monday 01:00 Paris: one hour inside the week. The Monday lecture is next week.
  assert.equal(m.external.get("school"), 60);
  assert.equal(m.external.get("life"), undefined);
  assert.deepEqual(allDayDates(events[2]), ["2026-10-10", "2026-10-11"]);
  assert.equal(busySpans(blocks, events).length, 3, "skipped block and all-day event are not busy");
});
