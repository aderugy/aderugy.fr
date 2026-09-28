import { fmtBb, type Terminal } from "@/lib/solver/gameState";

/** 51.25 → "51.3%", 0.4 → "0.40%": keep two significant-ish digits for small values. */
export function formatFrequency(pct: number): string {
  if (pct <= 0) return "0%";
  return `${pct < 1 ? pct.toFixed(2) : pct.toFixed(1)}%`;
}

export function terminalText(t: Terminal): string {
  switch (t.kind) {
    case "fold":
      return `Hand over — ${t.winner} wins ${fmtBb(t.potBb)} bb`;
    case "showdown":
      return `Showdown · pot ${fmtBb(t.potBb)} bb`;
    case "allin":
      return `All-in — runout · pot ${fmtBb(t.potBb)} bb`;
  }
}
