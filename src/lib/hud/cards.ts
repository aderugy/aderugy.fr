/**
 * Cards written in notes ("Ts", "Ah", "AsAh", "KdQd7c"): found so they can be
 * shown bold in their suit's colour (4-colour deck: --suit-s/h/d/c).
 * A card is a rank (2–9, T, J, Q, K, A) then a lowercase suit; a run of cards
 * must stand alone — not glued to other letters or digits ("Asked", "8sec"
 * stay text).
 */

export type Suit = "s" | "h" | "d" | "c";
export type NoteSegment = { t: "text"; text: string } | { t: "card"; text: string; suit: Suit };

const RUN = /(?<![A-Za-z0-9])(?:[2-9TJQKA][shdc])+(?![A-Za-z0-9])/g;

export function splitCards(text: string): NoteSegment[] {
  const out: NoteSegment[] = [];
  let last = 0;
  for (const m of text.matchAll(RUN)) {
    if (m.index > last) out.push({ t: "text", text: text.slice(last, m.index) });
    for (let i = 0; i < m[0].length; i += 2) {
      out.push({ t: "card", text: m[0].slice(i, i + 2), suit: m[0][i + 1] as Suit });
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ t: "text", text: text.slice(last) });
  return out;
}

/** Tailwind class of a suit's colour. */
export const SUIT_CLASS: Record<Suit, string> = {
  s: "text-suit-s",
  h: "text-suit-h",
  d: "text-suit-d",
  c: "text-suit-c",
};
