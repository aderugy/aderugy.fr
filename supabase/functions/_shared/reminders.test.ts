import { test } from "node:test";
import assert from "node:assert/strict";
import { reminderFor } from "./reminders.ts";
import type { PushBlock } from "./push-events.ts";

const block: PushBlock = {
  id: "3f2a9c1e-7b4d-4e8a-9f01-2c3d4e5f6a7b",
  // 14:00–15:30 in Paris (CEST)
  starts_at: "2026-10-08T12:00:00.000Z",
  ends_at: "2026-10-08T13:30:00.000Z",
  description: null,
  status: "planned",
  templateName: "Deep work",
  tasks: [],
};

const opts = { timeZone: "Europe/Paris", now: new Date("2026-10-08T11:50:00.000Z") };

test("says when, in local time, and how soon", () => {
  const r = reminderFor(block, opts);
  assert.equal(r.title, "Deep work");
  assert.equal(r.body, "14:00–15:30 · in 10 min");
  assert.equal(r.tag, `block-${block.id}`);
  assert.equal(r.url, "/agenda");
});

test("lists task descriptions in order, at most three", () => {
  const r = reminderFor(
    {
      ...block,
      templateName: null,
      tasks: [
        { categoryName: "poker", description: "review hands", minutes: 30, position: 1 },
        { categoryName: "poker", description: "solver drill", minutes: 30, position: 0 },
        { categoryName: "maths", description: "Cesàro", minutes: 10, position: 2 },
        { categoryName: "maths", description: "cards", minutes: 10, position: 3 },
        { categoryName: "maths", description: null, minutes: 10, position: 4 },
      ],
    },
    opts,
  );
  assert.equal(r.title, "poker · maths");
  assert.equal(
    r.body,
    ["14:00–15:30 · in 10 min", "• solver drill", "• review hands", "• Cesàro", "+1 more"].join("\n"),
  );
});

test("hours for longer leads", () => {
  const r = reminderFor(block, { ...opts, now: new Date("2026-10-08T10:45:00.000Z") });
  assert.match(r.body, /in 1 h 15$/);
});
