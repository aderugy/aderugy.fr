"use client";

import { RANKS, SUITS, SUIT_COLORS, SUIT_SYMBOLS } from "@/lib/solver/cards";

/**
 * Pick up to `count` cards from a 4 × 13 grid (a suit per row): narrow enough
 * for a phone, one tap per card. Cards in `dead` are taken elsewhere.
 * Once full, a tap replaces the oldest pick.
 */
export function CardGrid({
  count,
  selected,
  dead,
  onChange,
}: {
  count: number;
  selected: string[];
  dead: Set<string>;
  onChange: (cards: string[]) => void;
}) {
  function toggle(card: string) {
    if (selected.includes(card)) return onChange(selected.filter((c) => c !== card));
    if (selected.length >= count) return onChange([...selected.slice(1), card]);
    onChange([...selected, card]);
  }
  return (
    <div className="grid grid-cols-13 gap-0.5">
      {SUITS.map((suit) =>
        RANKS.map((rank) => {
          const card = `${rank}${suit}`;
          const on = selected.includes(card);
          const isDead = dead.has(card) && !on;
          return (
            <button
              key={card}
              type="button"
              disabled={isDead}
              onClick={() => toggle(card)}
              aria-pressed={on}
              aria-label={card}
              className={[
                "flex h-9 min-w-0 flex-col items-center justify-center rounded border text-[12px] font-bold leading-none",
                on ? "border-accent bg-sky-100 ring-2 ring-accent" : isDead ? "border-black/10 bg-white opacity-20" : "border-black/10 bg-white",
              ].join(" ")}
              style={{ color: isDead ? undefined : SUIT_COLORS[suit] }}
            >
              <span>{rank}</span>
              <span className="text-[10px]">{SUIT_SYMBOLS[suit]}</span>
            </button>
          );
        }),
      )}
    </div>
  );
}
