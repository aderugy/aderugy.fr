import { RANKS, handCombos } from "@/lib/solver/cards";

/**
 * PokerTracker 4 auto-notes embed hand ranges as `{cardrange:QQ-KK,AQs+,AKo}`.
 * This turns them into the 169-hand grid's hands.
 *
 * Range syntax (PT4 / PokerStove): `55`, `QQ+`, `66-77`, `AKs`, `AQs+` (kicker
 * up to just below the top card), `A9o-ATo` (kickers between), and a hand
 * without s/o for both.
 */

const R = "AKQJT98765432";
const rank = (c: string) => RANKS.indexOf(c.toUpperCase() as (typeof RANKS)[number]); // 0 = A … 12 = 2

function hand(hi: number, lo: number, suit: "s" | "o"): string {
  return `${RANKS[hi]}${RANKS[lo]}${suit}`;
}

function suits(s: string | undefined): ("s" | "o")[] {
  return s === "s" ? ["s"] : s === "o" ? ["o"] : ["s", "o"];
}

/** The hands of one range token, or null if it isn't one. */
function token(tok: string): string[] | null {
  const t = tok.trim();
  let m = t.match(new RegExp(`^([${R}])\\1(\\+)?$`, "i"));
  if (m) {
    const r = rank(m[1]);
    const out: string[] = [];
    for (let i = m[2] ? 0 : r; i <= r; i++) out.push(`${RANKS[i]}${RANKS[i]}`);
    return out;
  }
  m = t.match(new RegExp(`^([${R}])\\1-([${R}])\\2$`, "i"));
  if (m) {
    const [a, b] = [rank(m[1]), rank(m[2])].sort((x, y) => x - y);
    const out: string[] = [];
    for (let i = a; i <= b; i++) out.push(`${RANKS[i]}${RANKS[i]}`);
    return out;
  }
  m = t.match(new RegExp(`^([${R}])([${R}])([so])?(\\+)?$`, "i"));
  if (m) {
    const [x, y] = [rank(m[1]), rank(m[2])];
    if (x === y) return null;
    const [hi, lo] = x < y ? [x, y] : [y, x];
    const out: string[] = [];
    // "+": the kicker climbs up to just below the top card.
    for (let k = m[4] ? hi + 1 : lo; k <= lo; k++) for (const s of suits(m[3]?.toLowerCase())) out.push(hand(hi, k, s));
    return out;
  }
  m = t.match(new RegExp(`^([${R}])([${R}])([so])?-([${R}])([${R}])([so])?$`, "i"));
  if (m) {
    const [h1, k1, h2, k2] = [rank(m[1]), rank(m[2]), rank(m[4]), rank(m[5])];
    if (h1 !== h2 || h1 >= k1 || h2 >= k2) return null;
    const [a, b] = [k1, k2].sort((x, y) => x - y);
    const out: string[] = [];
    for (let k = a; k <= b; k++) for (const s of suits((m[3] ?? m[6])?.toLowerCase())) out.push(hand(h1, k, s));
    return out;
  }
  return null;
}

export type ParsedRange = { hands: Set<string>; unknown: string[] };

export function parseRange(range: string): ParsedRange {
  const hands = new Set<string>();
  const unknown: string[] = [];
  for (const tok of range.split(",")) {
    if (!tok.trim()) continue;
    const hs = token(tok);
    if (hs) hs.forEach((h) => hands.add(h));
    else unknown.push(tok.trim());
  }
  return { hands, unknown };
}

/** Share of the 1326 starting combos. */
export function rangeShare(hands: Set<string>): number {
  let n = 0;
  for (const h of hands) n += handCombos(h).length;
  return n / 1326;
}

export type NoteSegment = { t: "text"; text: string } | { t: "range"; raw: string; range: ParsedRange };

/** Splits an auto-note into text and ranges. */
export function parseAutoNote(text: string): NoteSegment[] {
  const out: NoteSegment[] = [];
  const re = /\{cardrange:([^}]*)\}/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > last) out.push({ t: "text", text: text.slice(last, m.index) });
    out.push({ t: "range", raw: m[1], range: parseRange(m[1]) });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ t: "text", text: text.slice(last) });
  return out;
}

/** PT4's auto-note categories, as far as the data shows. */
export const AUTO_CATEGORIES: Record<number, string> = { 1: "Preflop", 2: "Flop", 3: "Turn", 4: "River" };
