import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAutoNote, parseRange, rangeShare } from "./ranges";

const hands = (s: string) => [...parseRange(s).hands].sort();

test("pairs: single, plus, dash", () => {
  assert.deepEqual(hands("55"), ["55"]);
  assert.deepEqual(hands("QQ+"), ["AA", "KK", "QQ"]);
  assert.deepEqual(hands("QQ-KK"), ["KK", "QQ"]);
  assert.deepEqual(hands("77-66"), ["66", "77"]);
});

test("non-pairs: suited / offsuit / both, plus, dash", () => {
  assert.deepEqual(hands("AKo"), ["AKo"]);
  assert.deepEqual(hands("AQs+"), ["AKs", "AQs"]);
  assert.deepEqual(hands("KJo+"), ["KJo", "KQo"]);
  assert.deepEqual(hands("A9o-ATo"), ["A9o", "ATo"]);
  assert.deepEqual(hands("AK"), ["AKo", "AKs"]);
  assert.deepEqual(hands("K2s"), ["K2s"]);
  assert.deepEqual(hands("ka"), ["AKo", "AKs"]); // either order, any case
});

test("a whole PT4 range, and junk kept apart", () => {
  const r = parseRange("66-77,44,AQs,ATs,A4s,KJs,K8s,98s,86s,42s,AJo,KJo+");
  assert.equal(r.hands.size, 14); // 66 77 44, 8 suited, AJo, KJo KQo
  assert.deepEqual(r.unknown, []);
  assert.deepEqual(parseRange("QQ, random, AKx").unknown, ["random", "AKx"]);
  assert.ok(Math.abs(rangeShare(parseRange("AA").hands) - 6 / 1326) < 1e-12);
  assert.equal(rangeShare(parseRange("22+,A2+,K2+,Q2+,J2+,T2+,92+,82+,72+,62+,52+,42+,32").hands), 1);
});

test("auto-note text split around ranges", () => {
  const segs = parseAutoNote("3Bet range {cardrange:QQ-KK,AQs+,AKo} vs BTN");
  assert.equal(segs.length, 3);
  assert.deepEqual(segs[0], { t: "text", text: "3Bet range " });
  assert.equal(segs[1].t === "range" && segs[1].range.hands.size, 5);
  assert.deepEqual(segs[2], { t: "text", text: " vs BTN" });
  assert.deepEqual(parseAutoNote("Raised Flop Cbet w/Overpair or less & no draw"), [
    { t: "text", text: "Raised Flop Cbet w/Overpair or less & no draw" },
  ]);
});
