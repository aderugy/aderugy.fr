/**
 * Notes, cards, the queue, decks and text tools. Run with `npm test`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { cardOrds, cleanNote, cleanTags, findGaps, renderCloze, sameAnswer, sidesOf } from "./notes";
import { buildQueue, nextCard } from "./queue";
import { deckTree, findDeck, flatten, subtreeIds } from "./decks";
import { diffAnswer, parseCsv, toCsvRow } from "./text";
import { DEFAULT_SETTINGS, type Card, type Deck } from "./types";

test("cloze gaps keep LaTeX braces and read hints", () => {
  const text = "Si $X \\sim \\mathcal{P}(\\lambda)$, $E[X] = {{c1::\\frac{\\lambda}{1}}}$ et $V(X) = {{c2::\\lambda::variance}}$.";
  const gaps = findGaps(text);
  assert.deepEqual(gaps.map((g) => [g.n, g.answer, g.hint]), [
    [1, "\\frac{\\lambda}{1}", null],
    [2, "\\lambda", "variance"],
  ]);
  assert.equal(renderCloze(text, 2, "question"), "Si $X \\sim \\mathcal{P}(\\lambda)$, $E[X] = \\frac{\\lambda}{1}$ et $V(X) = **[variance]**$.");
  assert.ok(renderCloze(text, 1, "answer").includes("**\\frac{\\lambda}{1}**"));
});

test("an unclosed gap is left as text", () => {
  assert.deepEqual(findGaps("{{c1::oops"), []);
  assert.deepEqual(findGaps("{{x::no}} {{c1::yes}}").map((g) => g.answer), ["yes"]);
});

test("each kind of note generates its cards", () => {
  assert.deepEqual(cardOrds({ kind: "basic", front: "q", back: "a" }), [0]);
  assert.deepEqual(cardOrds({ kind: "reversed", front: "q", back: "a" }), [0, 1]);
  assert.deepEqual(cardOrds({ kind: "reversed", front: "q", back: " " }), [0]);
  assert.deepEqual(cardOrds({ kind: "type_answer", front: "q", back: "a" }), [0]);
  assert.deepEqual(cardOrds({ kind: "cloze", front: "{{c2::b}} {{c1::a}} {{c2::c}}", back: "" }), [1, 2]);
});

test("a reversed card swaps the sides; a typed card compares plain text", () => {
  assert.deepEqual(sidesOf({ kind: "reversed", front: "q", back: "a" }, 1), { question: "a", answer: "q", expected: null });
  assert.equal(sidesOf({ kind: "type_answer", front: "alpha à 1/2 pot ?", back: "**33 %**" }, 0).expected, "33 %");
  assert.ok(sameAnswer("  33   %", "33 %"));
  assert.ok(!sameAnswer("34 %", "33 %"));
});

test("notes are checked before saving", () => {
  assert.throws(() => cleanNote({ kind: "basic", front: " ", back: "a" }), /front is empty/);
  assert.throws(() => cleanNote({ kind: "basic", front: "q", back: "" }), /back is empty/);
  assert.throws(() => cleanNote({ kind: "cloze", front: "no gap", back: "" }), /at least one gap/);
  const ok = cleanNote({ kind: "cloze", front: " {{c1::x}} ", back: "", tags: "poker::mdf Poker::MDF maths" });
  assert.equal(ok.front, "{{c1::x}}");
  assert.deepEqual(ok.tags, ["poker::mdf", "maths"]);
  assert.throws(() => cleanTags(["a".repeat(61)]), /at most 60/);
});

const card = (p: Partial<Card> & { id: string; note_id: string }, created = "2026-10-01T00:00:00Z") => ({
  ord: 0,
  state: "new" as const,
  step: 0,
  stability: 0,
  difficulty: 0,
  due: "2026-10-14T02:00:00Z",
  last_review: null,
  reps: 0,
  lapses: 0,
  suspended: false,
  buried_until: null,
  flagged: false,
  note_created_at: created,
  ...p,
});

const NOW = new Date("2026-10-14T08:00:00Z");

test("the queue: steps first, reviews most at risk first, new within the limit, one card per note", () => {
  const q = buildQueue({
    now: NOW,
    settings: { ...DEFAULT_SETTINGS, newPerDay: 2 },
    today: [{ card_id: "x", note_id: "n-seen", state_before: "new" }],
    cards: [
      card({ id: "l1", note_id: "n1", state: "learning", stability: 3, due: "2026-10-14T08:10:00Z" }),
      card({ id: "l2", note_id: "n2", state: "learning", stability: 3, due: "2026-10-14T09:00:00Z" }), // later than 20 min
      card({ id: "r-safe", note_id: "n3", state: "review", stability: 50, last_review: "2026-10-04T08:00:00Z", due: "2026-10-13T02:00:00Z" }),
      card({ id: "r-risky", note_id: "n4", state: "review", stability: 5, last_review: "2026-10-04T08:00:00Z", due: "2026-10-14T02:00:00Z" }),
      card({ id: "r-tomorrow", note_id: "n5", state: "review", stability: 5, last_review: "2026-10-12T08:00:00Z", due: "2026-10-15T02:00:00Z" }),
      card({ id: "r-sibling", note_id: "n1", state: "review", stability: 5, last_review: "2026-10-04T08:00:00Z" }),
      card({ id: "new-a0", note_id: "na", ord: 0 }, "2026-10-02T00:00:00Z"),
      card({ id: "new-a1", note_id: "na", ord: 1 }, "2026-10-02T00:00:00Z"),
      card({ id: "new-old", note_id: "nb" }, "2026-09-01T00:00:00Z"),
      card({ id: "new-seen", note_id: "n-seen" }),
      card({ id: "new-c", note_id: "nc" }, "2026-10-03T00:00:00Z"),
      card({ id: "susp", note_id: "nd", suspended: true }),
      card({ id: "buried", note_id: "ne", buried_until: "2026-10-14" }),
    ],
  });
  assert.deepEqual(q.learning.map((c) => c.id), ["l1"]);
  assert.deepEqual(q.review.map((c) => c.id), ["r-risky", "r-safe"]);
  // One introduced today already → room for one more; oldest note first; siblings held.
  assert.deepEqual(q.fresh.map((c) => c.id), ["new-old"]);
  assert.equal(q.heldBack.fresh, 2);
  // The limit is soft: what it held back is still there to study, in order.
  assert.deepEqual(q.extra.fresh.map((c) => c.id), ["new-a0", "new-c"]);
  assert.deepEqual(q.extra.review, []);
});

test("the next card: a due step, then reviews, then new, then a step due soon", () => {
  const q = {
    learning: [{ id: "l", due: "2026-10-14T08:15:00Z" }],
    review: [] as { id: string; due: string }[],
    fresh: [{ id: "f", due: "2026-10-14T02:00:00Z" }],
  };
  assert.equal(nextCard(q, NOW)?.card.id, "f");
  assert.equal(nextCard({ ...q, fresh: [] }, NOW)?.card.id, "l");
  assert.equal(nextCard({ ...q, fresh: [] }, new Date("2026-10-14T07:00:00Z")), null);
  assert.equal(nextCard(q, new Date("2026-10-14T08:16:00Z"))?.card.id, "l");
});

test("decks: tree, paths, subtrees", () => {
  const decks: Deck[] = [
    { id: "m", parent_id: null, name: "Maths", position: 1, archived_at: null },
    { id: "l", parent_id: "m", name: "Lois", position: 0, archived_at: null },
    { id: "c", parent_id: "l", name: "Continues", position: 0, archived_at: null },
    { id: "p", parent_id: null, name: "Poker", position: 0, archived_at: null },
  ];
  assert.deepEqual(flatten(deckTree(decks)).map((d) => d.path), ["Poker", "Maths", "Maths::Lois", "Maths::Lois::Continues"]);
  assert.deepEqual(subtreeIds(decks, "m").sort(), ["c", "l", "m"]);
  assert.equal(findDeck(decks, " maths :: LOIS ")?.id, "l");
  assert.equal(findDeck(decks, "Maths::Nope"), null);
});

test("typed answers are diffed character by character", () => {
  assert.deepEqual(diffAnswer("33 %", "34 %"), [
    { kind: "same", text: "3" },
    { kind: "missing", text: "3" },
    { kind: "extra", text: "4" },
    { kind: "same", text: " %" },
  ]);
});

test("CSV: quotes, newlines, delimiters, round trip", () => {
  assert.deepEqual(parseCsv('front,back\n"a, b","line 1\nline ""2"""\n\n'), [
    ["front", "back"],
    ["a, b", 'line 1\nline "2"'],
  ]);
  assert.deepEqual(parseCsv("q\ta\r\nq2\ta2"), [
    ["q", "a"],
    ["q2", "a2"],
  ]);
  assert.deepEqual(parseCsv("﻿q;a"), [["q", "a"]]);
  const row = ["a, b", 'say "hi"', "x\ny"];
  assert.deepEqual(parseCsv(toCsvRow(row)), [row]);
});
