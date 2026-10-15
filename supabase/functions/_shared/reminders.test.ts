import { test } from "node:test";
import assert from "node:assert/strict";
import { reminderFor } from "./reminders.ts";
import type { PushSession } from "./push-events.ts";

const session: PushSession = {
  id: "3f2a9c1e-7b4d-4e8a-9f01-2c3d4e5f6a7b",
  // 14:00–15:30 in Paris (CEST)
  starts_at: "2026-10-08T12:00:00.000Z",
  ends_at: "2026-10-08T13:30:00.000Z",
  status: "planned",
  categoryName: "grind",
  description: "review hands",
  notes: null,
};

const opts = { timeZone: "Europe/Paris", now: new Date("2026-10-08T11:50:00.000Z") };

test("says what, when in local time, and how soon", () => {
  const r = reminderFor(session, opts);
  assert.equal(r.title, "grind — review hands");
  assert.equal(r.body, "14:00–15:30 · in 10 min");
  assert.equal(r.tag, `session-${session.id}`);
  assert.equal(r.url, "/agenda");
});

test("adds the first lines of the notes, without list or heading marks, at most three", () => {
  const r = reminderFor(
    {
      ...session,
      notes: "## Plan\n\n- [ ] solver drill\n* review the river spots\n1. Cesàro\n- cards\n",
    },
    opts,
  );
  assert.equal(
    r.body,
    ["14:00–15:30 · in 10 min", "• Plan", "• solver drill", "• review the river spots", "+2 more"].join("\n"),
  );
});

test("hours for longer leads", () => {
  const r = reminderFor(session, { ...opts, now: new Date("2026-10-08T10:45:00.000Z") });
  assert.match(r.body, /in 1 h 15$/);
});
