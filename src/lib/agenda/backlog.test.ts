/**
 * Unit tests for the backlog rules shared with the Claude connector.
 * Run with `npm test`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  compareTasks,
  normalizePath,
  parseDeadline,
  resolveCategoryRef,
  subtreeOf,
  withInheritedArchive,
  type CategoryPathRow,
} from "./backlog";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function cat(n: number, parent: number | null, path: string, archived = false): CategoryPathRow {
  const parts = path.split(" > ");
  return {
    id: id(n),
    parent_id: parent === null ? null : id(parent),
    name: parts[parts.length - 1],
    path,
    archived,
  };
}

const TREE: CategoryPathRow[] = [
  cat(1, null, "poker"),
  cat(2, 1, "poker > grind"),
  cat(3, 1, "poker > session review"),
  cat(4, null, "studies"),
  cat(5, 4, "studies > SCIA"),
  cat(6, 5, "studies > SCIA > NLP"),
  cat(7, 4, "studies > review"),
  cat(8, null, "old", true),
  cat(9, 8, "old > stuff"),
];

test("normalizePath folds case, spacing and separators", () => {
  assert.equal(normalizePath("  Poker>Grind "), "poker > grind");
  assert.equal(normalizePath("studies / scia /  nlp"), "studies > scia > nlp");
  assert.equal(normalizePath("session   review"), "session review");
});

test("resolves an exact path, case-insensitively", () => {
  const r = resolveCategoryRef(TREE, "Poker > Grind");
  assert.deepEqual(r, { ok: true, id: id(2), path: "poker > grind" });
});

test("resolves an id", () => {
  const r = resolveCategoryRef(TREE, id(6));
  assert.equal(r.ok && r.path, "studies > SCIA > NLP");
});

test("resolves a unique leaf name and a unique suffix", () => {
  const leaf = resolveCategoryRef(TREE, "grind");
  assert.equal(leaf.ok && leaf.id, id(2));
  const suffix = resolveCategoryRef(TREE, "scia/nlp");
  assert.equal(suffix.ok && suffix.id, id(6));
});

test("an exact top-level path wins over a same-named leaf", () => {
  const r = resolveCategoryRef(TREE, "studies");
  assert.equal(r.ok && r.id, id(4));
});

test("a leaf matches whole segments only", () => {
  // "session review" ends in "review" but is not a segment named "review".
  const r = resolveCategoryRef(TREE, "review");
  assert.equal(r.ok && r.path, "studies > review");
});

test("an ambiguous leaf lists every match", () => {
  const tree = [...TREE, cat(10, 1, "poker > review")];
  const r = resolveCategoryRef(tree, "review");
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.match(r.error, /several/);
    assert.deepEqual(r.candidates, ["poker > review", "studies > review"]);
  }
});

test("an unknown name suggests close paths and never creates", () => {
  const r = resolveCategoryRef(TREE, "poker > grnd");
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.match(r.error, /not created automatically/);
    assert.ok(r.candidates.includes("poker > grind"));
  }
});

test("archived categories and their children are not targets", () => {
  const own = resolveCategoryRef(TREE, "old");
  assert.equal(own.ok, false);
  const child = resolveCategoryRef(TREE, "old > stuff");
  assert.equal(child.ok, false);
  if (!child.ok) assert.match(child.error, /archived/);
  const byId = resolveCategoryRef(TREE, id(9));
  assert.equal(byId.ok, false);
});

test("archive flag is inherited down the tree", () => {
  const rows = withInheritedArchive(TREE);
  assert.equal(rows.find((c) => c.id === id(9))!.archived, true);
  assert.equal(rows.find((c) => c.id === id(6))!.archived, false);
});

test("an empty reference is refused", () => {
  assert.equal(resolveCategoryRef(TREE, "  ").ok, false);
});

test("subtree includes the root and every descendant", () => {
  assert.deepEqual([...subtreeOf(TREE, id(4))].sort(), [id(4), id(5), id(6), id(7)].sort());
  assert.deepEqual([...subtreeOf(TREE, id(2))], [id(2)]);
});

test("deadlines are dates stored as midnight UTC, like the backlog table", () => {
  assert.deepEqual(parseDeadline("2026-10-09"), {
    ok: true,
    value: "2026-10-09T00:00:00.000Z",
  });
  assert.deepEqual(parseDeadline(null), { ok: true, value: null });
  assert.deepEqual(parseDeadline(""), { ok: true, value: null });
  assert.equal(parseDeadline("2026-02-30").ok, false);
  assert.equal(parseDeadline("next friday").ok, false);
  assert.equal(parseDeadline("2026-10-09T18:00").ok, false);
});

test("tasks sort by priority, then nearest deadline, then age", () => {
  const t = (priority: number, deadline: string | null, created_at: string) => ({
    priority,
    deadline,
    created_at,
  });
  const list = [
    t(3, null, "2026-01-01"),
    t(2, null, "2026-01-02"),
    t(2, "2026-10-01", "2026-01-03"),
    t(2, "2026-09-01", "2026-01-04"),
    t(1, null, "2026-01-05"),
    t(2, null, "2026-01-01"),
  ].sort(compareTasks);
  assert.deepEqual(
    list.map((x) => [x.priority, x.deadline, x.created_at]),
    [
      [1, null, "2026-01-05"],
      [2, "2026-09-01", "2026-01-04"],
      [2, "2026-10-01", "2026-01-03"],
      [2, null, "2026-01-01"],
      [2, null, "2026-01-02"],
      [3, null, "2026-01-01"],
    ],
  );
});
