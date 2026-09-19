import { SUIT_COLORS, SUIT_SYMBOLS, cardRank, cardSuit } from "@/lib/solver/cards";

const SIZES = {
  xs: "h-5 w-4 text-[10px] rounded-[3px]",
  sm: "h-9 w-7 text-sm rounded",
  md: "h-12 w-9 text-base rounded-md sm:h-14 sm:w-10 sm:text-lg",
  lg: "h-16 w-12 text-xl rounded-md sm:h-20 sm:w-14 sm:text-2xl",
} as const;

export type CardSize = keyof typeof SIZES;

/** A face-up card in the four-colour deck. */
export function PlayingCard({ card, size = "md" }: { card: string; size?: CardSize }) {
  const suit = cardSuit(card);
  return (
    <span
      className={`inline-flex shrink-0 flex-col items-center justify-center border border-black/10 bg-white font-bold leading-none shadow-sm ${SIZES[size]}`}
      style={{ color: SUIT_COLORS[suit] }}
      aria-label={card}
    >
      <span>{cardRank(card) === "T" ? "10" : cardRank(card)}</span>
      {size !== "xs" && <span className="mt-0.5">{SUIT_SYMBOLS[suit]}</span>}
    </span>
  );
}

/** A face-down card. */
export function CardBack({ size = "md" }: { size?: CardSize }) {
  return (
    <span
      className={`inline-block shrink-0 border border-white/30 shadow-sm ${SIZES[size]}`}
      style={{
        background:
          "repeating-linear-gradient(45deg, #3b5bdb 0 4px, #4c6ef5 4px 8px)",
      }}
    />
  );
}

export function BoardCards({ cards, size = "sm" }: { cards: string[]; size?: CardSize }) {
  return (
    <span className="inline-flex gap-0.5">
      {cards.map((c) =>
        size === "xs" ? (
          <span key={c} className="rounded-[3px] bg-white px-0.5 font-semibold" style={{ color: SUIT_COLORS[cardSuit(c)] }}>
            {cardRank(c)}
            {SUIT_SYMBOLS[cardSuit(c)]}
          </span>
        ) : (
          <PlayingCard key={c} card={c} size={size} />
        ),
      )}
    </span>
  );
}
