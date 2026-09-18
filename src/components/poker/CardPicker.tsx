"use client";

import { RANKS, SUITS, SUIT_COLORS, SUIT_SYMBOLS } from "@/lib/solver/cards";

/**
 * Pick up to `count` cards from a rank×suit grid. Cards in `dead` (used by an
 * ancestor board node) are disabled. Selection order is preserved.
 */
export function CardPicker({
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
    if (selected.includes(card)) {
      onChange(selected.filter((c) => c !== card));
      return;
    }
    if (selected.length >= count) {
      // Replace the oldest pick once full so a single tap keeps working.
      onChange([...selected.slice(1), card]);
      return;
    }
    onChange([...selected, card]);
  }

  return (
    <div className="space-y-1">
      {RANKS.map((rank) => (
        <div key={rank} className="flex gap-1">
          {SUITS.map((suit) => {
            const card = `${rank}${suit}`;
            const isSelected = selected.includes(card);
            const isDead = dead.has(card) && !isSelected;
            return (
              <button
                key={card}
                type="button"
                disabled={isDead}
                onClick={() => toggle(card)}
                aria-pressed={isSelected}
                title={isDead ? "Already on the board" : card}
                className={[
                  "flex h-8 w-9 items-center justify-center rounded border text-xs font-semibold tabular-nums transition-colors",
                  isSelected
                    ? "border-accent bg-accent/10"
                    : isDead
                      ? "cursor-not-allowed border-line opacity-30"
                      : "border-line bg-surface hover:border-accent",
                ].join(" ")}
                style={{ color: isDead ? undefined : SUIT_COLORS[suit] }}
              >
                {rank}
                {SUIT_SYMBOLS[suit]}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
