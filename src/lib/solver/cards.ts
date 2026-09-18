/**
 * Cards, hands and combos for the solver-notes tool.
 *
 * A card is a two-char string like "Ah" (rank + suit). A hand is a canonical
 * starting-hand label like "AA", "AKs" or "AKo". A combo is an exact two-card
 * holding like "AhKs". Nothing here touches the DOM.
 */

export type Rank =
  | "A" | "K" | "Q" | "J" | "T"
  | "9" | "8" | "7" | "6" | "5" | "4" | "3" | "2";

export type Suit = "s" | "h" | "d" | "c";

/** High to low; index doubles as the 13×13 grid row/column. */
export const RANKS: Rank[] = [
  "A", "K", "Q", "J", "T", "9", "8", "7", "6", "5", "4", "3", "2",
];

export const SUITS: Suit[] = ["s", "h", "d", "c"];

/** Four-colour deck: spade black, heart red, diamond blue, club green. */
export const SUIT_COLORS: Record<Suit, string> = {
  s: "#1a1a19",
  h: "#e03131",
  d: "#1c7ed6",
  c: "#2f9e44",
};

export const SUIT_SYMBOLS: Record<Suit, string> = {
  s: "♠",
  h: "♥",
  d: "♦",
  c: "♣",
};

const RANK_INDEX: Record<string, number> = Object.fromEntries(
  RANKS.map((r, i) => [r, i]),
);

/** The full 52-card deck, ordered rank-major then suit. */
export const DECK: string[] = RANKS.flatMap((r) => SUITS.map((s) => `${r}${s}`));

export function cardRank(card: string): Rank {
  return card[0] as Rank;
}

export function cardSuit(card: string): Suit {
  return card[1] as Suit;
}

/** Lower index = higher card. Used to order the two cards of a combo. */
function rankOrder(rank: string): number {
  return RANK_INDEX[rank] ?? 99;
}

/**
 * The 169 canonical hands in 13×13 grid order (row-major, A→2 on both axes):
 * the diagonal is pairs, upper-right is suited (higher rank first) and
 * lower-left is offsuit.
 */
export function handAt(row: number, col: number): string {
  const hi = RANKS[Math.min(row, col)];
  const lo = RANKS[Math.max(row, col)];
  if (row === col) return `${hi}${lo}`; // pair
  if (row < col) return `${hi}${lo}s`; // suited
  return `${hi}${lo}o`; // offsuit
}

export const GRID_HANDS: string[] = RANKS.flatMap((_, row) =>
  RANKS.map((__, col) => handAt(row, col)),
);

export type HandShape = "pair" | "suited" | "offsuit";

export function handShape(hand: string): HandShape {
  if (hand.length === 2) return "pair";
  return hand[2] === "s" ? "suited" : "offsuit";
}

/** The exact combos that make up a hand: pair→6, suited→4, offsuit→12. */
export function handCombos(hand: string): string[] {
  const a = hand[0];
  const b = hand[1];
  const shape = handShape(hand);
  const out: string[] = [];

  if (shape === "pair") {
    for (let i = 0; i < SUITS.length; i++) {
      for (let j = i + 1; j < SUITS.length; j++) {
        out.push(`${a}${SUITS[i]}${a}${SUITS[j]}`);
      }
    }
    return out;
  }

  if (shape === "suited") {
    for (const s of SUITS) out.push(`${a}${s}${b}${s}`);
    return out;
  }

  // offsuit
  for (const s1 of SUITS) {
    for (const s2 of SUITS) {
      if (s1 !== s2) out.push(`${a}${s1}${b}${s2}`);
    }
  }
  return out;
}

/** Split a combo string like "AhKs" into its two cards. */
export function comboCards(combo: string): [string, string] {
  return [combo.slice(0, 2), combo.slice(2, 4)];
}

/** The canonical hand a combo belongs to ("AhKs" → "AKo"). */
export function comboToHand(combo: string): string {
  const [c1, c2] = comboCards(combo);
  const r1 = cardRank(c1);
  const r2 = cardRank(c2);
  if (r1 === r2) return `${r1}${r2}`;
  const [hi, lo] = rankOrder(r1) < rankOrder(r2) ? [r1, r2] : [r2, r1];
  const suited = cardSuit(c1) === cardSuit(c2);
  return `${hi}${lo}${suited ? "s" : "o"}`;
}

/** Does the combo use a card that is already on the board (a blocker)? */
export function comboBlocked(combo: string, dead: Set<string>): boolean {
  if (dead.size === 0) return false;
  const [c1, c2] = comboCards(combo);
  return dead.has(c1) || dead.has(c2);
}

/** How many of a hand's combos survive the dead cards (0 = fully blocked). */
export function liveCombos(hand: string, dead: Set<string>): number {
  return handCombos(hand).filter((c) => !comboBlocked(c, dead)).length;
}
