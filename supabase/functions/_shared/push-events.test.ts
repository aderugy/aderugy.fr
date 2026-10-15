import { test } from "node:test";
import assert from "node:assert/strict";
import { bodyFor, eventFor, eventIdFor, titleFor, type PushSession } from "./push-events.ts";

const base: PushSession = {
  id: "3f2a9c1e-7b4d-4e8a-9f01-2c3d4e5f6a7b",
  starts_at: "2026-09-21T07:00:00.000Z",
  ends_at: "2026-09-21T08:30:00.000Z",
  status: "planned",
  categoryName: null,
  description: null,
  notes: null,
};

test("event id is the session id as base32hex, stable across calls", () => {
  const id = eventIdFor(base.id);
  assert.equal(id, "3f2a9c1e7b4d4e8a9f012c3d4e5f6a7b");
  assert.match(id, /^[0-9a-v]{5,1024}$/);
  assert.equal(eventIdFor(base.id.toUpperCase()), id);
});

test("title: the category leaf, then the task's description", () => {
  assert.equal(titleFor({ ...base, categoryName: "grind", description: "ch. 2" }), "grind — ch. 2");
  assert.equal(titleFor({ ...base, categoryName: "grind" }), "grind");
  assert.equal(titleFor({ ...base, description: "ch. 2" }), "ch. 2");
  assert.equal(titleFor(base), "Planned task");
  assert.equal(titleFor({ ...base, categoryName: "  ", description: "   " }), "Planned task");
});

test("title marks done and skipped slots", () => {
  assert.equal(titleFor({ ...base, categoryName: "Run", status: "done" }), "✓ Run");
  assert.equal(titleFor({ ...base, categoryName: "Run", status: "skipped" }), "✕ Run");
});

test("body: the task's notes, then the overwrite warning", () => {
  assert.equal(
    bodyFor({ ...base, notes: "- read ch. 2\n- do the exercises\n" }, "https://aderugy.fr/"),
    [
      "- read ch. 2",
      "- do the exercises",
      "",
      "Planned in Agenda. Edit it there — changes made here are overwritten.",
      "https://aderugy.fr/agenda",
    ].join("\n"),
  );
  assert.equal(bodyFor(base), "Planned in Agenda. Edit it there — changes made here are overwritten.");
});

test("body: very long notes are cut", () => {
  const body = bodyFor({ ...base, notes: "x".repeat(10_000) });
  assert.ok(body.length < 4_200);
  assert.match(body, /x…\n\nPlanned in Agenda/);
});

test("event: explicit confirmed status, UTC instants, skipped is transparent", () => {
  const event = eventFor({ ...base, categoryName: "Gym" });
  assert.equal(event.id, eventIdFor(base.id));
  assert.equal(event.summary, "Gym");
  assert.equal(event.status, "confirmed");
  assert.equal(event.transparency, "opaque");
  assert.deepEqual(event.start, { dateTime: "2026-09-21T07:00:00.000Z" });
  assert.deepEqual(event.end, { dateTime: "2026-09-21T08:30:00.000Z" });
  assert.equal(event.extendedProperties.private.agendaSessionId, base.id);
  assert.equal(event.source, undefined);

  assert.equal(eventFor({ ...base, status: "skipped" }).transparency, "transparent");
  assert.equal(eventFor(base, "https://aderugy.fr").source?.url, "https://aderugy.fr/agenda");
});

test("event: an empty or inverted range is refused, not pushed", () => {
  assert.throws(() => eventFor({ ...base, ends_at: base.starts_at }));
  assert.throws(() => eventFor({ ...base, ends_at: "2026-09-21T06:00:00.000Z" }));
  assert.throws(() => eventFor({ ...base, starts_at: "nope" }));
});
