import { test } from "node:test";
import assert from "node:assert/strict";
import { splitCards } from "./cards";

const cards = (s: string) => splitCards(s).filter((x) => x.t === "card").map((x) => x.text);

test("single cards and runs", () => {
  assert.deepEqual(cards("Ts, Ah, AsAh"), ["Ts", "Ah", "As", "Ah"]);
  assert.deepEqual(cards("3B KdQd7c pot"), ["Kd", "Qd", "7c"]);
  assert.deepEqual(cards("(Jh)"), ["Jh"]);
});

test("words and numbers stay text", () => {
  assert.deepEqual(cards("Asked twice, 8sec, Ks2, 10s, AKs, ts"), []);
});

test("segments keep every character, suits are set", () => {
  const segs = splitCards("c4b QQ vs 9h8h!");
  assert.equal(segs.map((s) => s.text).join(""), "c4b QQ vs 9h8h!");
  assert.deepEqual(
    segs.filter((s) => s.t === "card").map((s) => (s.t === "card" ? s.suit : "")),
    ["h", "h"],
  );
});
