/**
 * Hidden calendar events: one occurrence, or every event of a title in a
 * calendar. Run with `npm test`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { externalMinutesByCategory, hiddenBy, withoutHidden } from "../external";
import type { CalendarSource, ExternalEvent, HiddenEventRule } from "../types";

const source = (id: string): CalendarSource => ({
  id,
  provider: "google",
  external_id: id,
  display_name: id,
  color: "#336699",
  category_id: `cat-${id}`,
  enabled: true,
  include_all_day: true,
  include_free: false,
  include_declined: false,
  position: 0,
});

const ev = (calendar: string, id: string, title: string | null, day: number): ExternalEvent =>
  ({
    calendar_source_id: calendar,
    external_event_id: id,
    title,
    starts_at: `2026-10-${String(12 + day).padStart(2, "0")}T08:00:00Z`,
    ends_at: `2026-10-${String(12 + day).padStart(2, "0")}T10:00:00Z`,
    all_day: false,
    status: "confirmed",
    transparency: "opaque",
    attendee_response: null,
    archived_at: null,
  }) as ExternalEvent;

const rule = (r: Partial<HiddenEventRule> & Pick<HiddenEventRule, "calendar_source_id">): HiddenEventRule => ({
  id: "r",
  external_event_id: null,
  title: null,
  label: null,
  starts_at: null,
  created_at: "",
  ...r,
});

const week = [
  ev("school", "a1", "Algèbre", 0),
  ev("school", "a2", "Algèbre", 2),
  ev("school", "s1", "Stats", 1),
  ev("work", "w1", "Algèbre", 1),
  ev("school", "n1", null, 3),
];

test("an event rule hides that occurrence only", () => {
  const rules = [rule({ calendar_source_id: "school", external_event_id: "a1" })];
  assert.deepEqual(
    withoutHidden(week, rules).map((e) => e.external_event_id),
    ["a2", "s1", "w1", "n1"],
  );
});

test("a title rule hides every event of that title, in its calendar only", () => {
  const rules = [rule({ calendar_source_id: "school", title: "Algèbre" })];
  assert.deepEqual(
    withoutHidden(week, rules).map((e) => e.external_event_id),
    ["s1", "w1", "n1"],
    "the work calendar's Algèbre stays",
  );
  assert.equal(hiddenBy(week[3], rules), null);
  assert.equal(hiddenBy(ev("school", "n2", null, 4), rules), null, "an untitled event matches no title rule");
});

test("hidden events leave the totals", () => {
  const monday = new Date("2026-10-12T00:00:00Z");
  const sources = [source("school"), source("work")];
  const all = externalMinutesByCategory(week, sources, monday);
  assert.equal(all.get("cat-school"), 4 * 120);
  const shown = externalMinutesByCategory(withoutHidden(week, [rule({ calendar_source_id: "school", title: "Algèbre" })]), sources, monday);
  assert.equal(shown.get("cat-school"), 2 * 120);
  assert.equal(shown.get("cat-work"), 120);
});

test("no rules, nothing hidden", () => {
  assert.equal(withoutHidden(week, []), week);
});
