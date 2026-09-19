import { test } from "node:test";
import assert from "node:assert/strict";
import { bodyFor, eventFor, eventIdFor, titleFor, type PushBlock } from "./push-events.ts";

const base: PushBlock = {
  id: "3f2a9c1e-7b4d-4e8a-9f01-2c3d4e5f6a7b",
  starts_at: "2026-09-21T07:00:00.000Z",
  ends_at: "2026-09-21T08:30:00.000Z",
  description: null,
  status: "planned",
  templateName: null,
  tasks: [],
};

test("event id is the block id as base32hex, stable across calls", () => {
  const id = eventIdFor(base.id);
  assert.equal(id, "3f2a9c1e7b4d4e8a9f012c3d4e5f6a7b");
  assert.match(id, /^[0-9a-v]{5,1024}$/);
  assert.equal(eventIdFor(base.id.toUpperCase()), id);
});

test("title: template, then description, then task categories", () => {
  const tasks = [
    { categoryName: "reading", description: null, minutes: 30, position: 1 },
    { categoryName: "grind", description: "ch. 2", minutes: 60, position: 0 },
    { categoryName: "grind", description: "ch. 3", minutes: 15, position: 2 },
  ];
  assert.equal(titleFor({ ...base, tasks }), "grind · reading");
  assert.equal(titleFor({ ...base, tasks, description: "Deep work" }), "Deep work");
  assert.equal(
    titleFor({ ...base, tasks, description: "Deep work", templateName: "Morning routine" }),
    "Morning routine",
  );
  assert.equal(titleFor(base), "Planned block");
  assert.equal(titleFor({ ...base, description: "   " }), "Planned block");
});

test("title marks done and skipped blocks", () => {
  assert.equal(titleFor({ ...base, description: "Run", status: "done" }), "✓ Run");
  assert.equal(titleFor({ ...base, description: "Run", status: "skipped" }), "✕ Run");
});

test("body lists tasks in order with durations and the overwrite warning", () => {
  const body = bodyFor(
    {
      ...base,
      tasks: [
        { categoryName: "reading", description: null, minutes: 30, position: 1 },
        { categoryName: "grind", description: "ch. 2", minutes: 75, position: 0 },
      ],
    },
    "https://aderugy.fr/",
  );
  assert.equal(
    body,
    [
      "• grind — ch. 2 (1 h 15)",
      "• reading (30 min)",
      "",
      "Planned in Agenda. Edit it there — changes made here are overwritten.",
      "https://aderugy.fr/agenda",
    ].join("\n"),
  );
});

test("event: explicit confirmed status, UTC instants, skipped is transparent", () => {
  const event = eventFor({ ...base, description: "Gym" });
  assert.equal(event.id, eventIdFor(base.id));
  assert.equal(event.status, "confirmed");
  assert.equal(event.transparency, "opaque");
  assert.deepEqual(event.start, { dateTime: "2026-09-21T07:00:00.000Z" });
  assert.deepEqual(event.end, { dateTime: "2026-09-21T08:30:00.000Z" });
  assert.equal(event.extendedProperties.private.agendaBlockId, base.id);
  assert.equal(event.source, undefined);

  assert.equal(eventFor({ ...base, status: "skipped" }).transparency, "transparent");
  assert.equal(eventFor(base, "https://aderugy.fr").source?.url, "https://aderugy.fr/agenda");
});

test("event: an empty or inverted range is refused, not pushed", () => {
  assert.throws(() => eventFor({ ...base, ends_at: base.starts_at }));
  assert.throws(() => eventFor({ ...base, ends_at: "2026-09-21T06:00:00.000Z" }));
  assert.throws(() => eventFor({ ...base, starts_at: "nope" }));
});
