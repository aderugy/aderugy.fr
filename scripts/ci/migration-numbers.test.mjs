import { test } from "node:test";
import assert from "node:assert/strict";
import { afterMerge, clashes, unnumbered, versionOf } from "./migration-numbers.mjs";

const main = ["0020_block_reminders.sql", "0022_live_unknown_players.sql", "0023_flashcards.sql"];
const add = (name) => ({ filename: `supabase/migrations/${name}`, status: "added" });

test("the version is the number before the first underscore", () => {
  assert.equal(versionOf("0023_flashcards.sql"), "0023");
  assert.equal(versionOf("20261014120000_x.sql"), "20261014120000");
  assert.equal(versionOf("flashcards.sql"), null);
  assert.equal(versionOf("0023-flashcards.sql"), null);
});

test("a pull request reusing a number already on main fails", () => {
  const { names, added } = afterMerge(main, [add("0023_hidden_external_events.sql")]);
  assert.deepEqual(clashes(names, added), [
    { version: "0023", names: ["0023_flashcards.sql", "0023_hidden_external_events.sql"] },
  ]);
});

test("two new files with the same number in one pull request fail", () => {
  const { names, added } = afterMerge(main, [add("0024_a.sql"), add("0024_b.sql")]);
  assert.equal(clashes(names, added).length, 1);
});

test("a fresh number passes, and so does a pull request with no migration", () => {
  let r = afterMerge(main, [add("0024_hidden_external_events.sql")]);
  assert.deepEqual(clashes(r.names, r.added), []);
  r = afterMerge(main, [{ filename: "src/app/page.tsx", status: "modified" }]);
  assert.deepEqual(clashes(r.names, r.added), []);
});

test("renaming away from a taken number fixes it", () => {
  const files = [
    {
      filename: "supabase/migrations/0024_hidden_external_events.sql",
      previous_filename: "supabase/migrations/0023_hidden_external_events.sql",
      status: "renamed",
    },
  ];
  const { names, added } = afterMerge([...main, "0023_hidden_external_events.sql"], files);
  assert.ok(!names.includes("0023_hidden_external_events.sql"));
  assert.deepEqual(clashes(names, added), []);
});

test("a clash already on main is not blamed on an unrelated pull request", () => {
  const base = [...main, "0023_other.sql"];
  const { names, added } = afterMerge(base, [add("0030_x.sql")]);
  assert.deepEqual(clashes(names, added), []);
  assert.equal(clashes(names).length, 1);
});

test("files outside the top level of the folder are ignored", () => {
  const { names } = afterMerge(main, [
    { filename: "supabase/migrations/old/0023_x.sql", status: "added" },
    { filename: "supabase/tests/0023_x.sql", status: "added" },
  ]);
  assert.deepEqual(names, main);
});

test("a new file without a number is reported", () => {
  const { names, added } = afterMerge(main, [add("flashcards.sql")]);
  assert.deepEqual(unnumbered(names, added), ["flashcards.sql"]);
});
