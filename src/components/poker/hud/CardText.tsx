import { SUIT_CLASS, splitCards } from "@/lib/hud/cards";

/** Text with its cards (Ts, AsAh…) bold in their suit's colour (4-colour deck). */
export function CardText({ text }: { text: string }) {
  return (
    <>
      {splitCards(text).map((s, i) =>
        s.t === "card" ? (
          <b key={i} className={`font-bold ${SUIT_CLASS[s.suit]}`}>
            {s.text}
          </b>
        ) : (
          s.text
        ),
      )}
    </>
  );
}
