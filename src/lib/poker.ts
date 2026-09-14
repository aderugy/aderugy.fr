/**
 * Pot odds, drawing equity and semi-bluff fold equity.
 *
 * Everything is expressed in big blinds, so a rake cap in euros is converted to
 * bb by the limit's own big blind before it is used. Nothing here touches the
 * DOM or React: the whole model is pure functions the UI calls on every
 * keystroke.
 */

/* ------------------------------------------------------------------ equity */

/** How many cards are still to come, and from how large a deck. */
export type Street = "flop2" | "flop1" | "turn";

export const STREETS: { id: Street; label: string }[] = [
  { id: "flop2", label: "Flop · 2 cards" },
  { id: "flop1", label: "Flop · 1 card" },
  { id: "turn", label: "Turn · 1 card" },
];

export const MAX_OUTS = 47;

/**
 * Probability of completing the draw.
 *
 * On the flop with both cards to come it is the complement of missing twice —
 * not twice the one-card number, which double-counts the hands that improve on
 * both streets.
 */
export function equity(outs: number, street: Street): number {
  const o = clamp(outs, 0, MAX_OUTS);
  if (street === "flop2") return 1 - ((47 - o) / 47) * ((46 - o) / 46);
  if (street === "flop1") return o / 47;
  return o / 46;
}

export const EQUITY_FORMULA: Record<Street, string> = {
  flop2: "1 − (47−O)/47 × (46−O)/46",
  flop1: "O / 47",
  turn: "O / 46",
};

/* -------------------------------------------------------------------- rake */

export type Platform = "winamax" | "betclic" | "manual";

export const WINAMAX_PERCENT = 5.75;

/** Cap in euros, indexed by `WINAMAX_TABLE_SIZES`. */
export const WINAMAX_LIMITS = {
  "0.01/0.02": { bb: 0.02, caps: [0.25, 0.3, 0.35, 0.4] },
  "0.02/0.05": { bb: 0.05, caps: [0.5, 0.65, 0.8, 1.0] },
  "0.05/0.10": { bb: 0.1, caps: [0.75, 1.0, 1.25, 1.5] },
  "0.10/0.20": { bb: 0.2, caps: [1.5, 1.75, 2.0, 2.5] },
  "0.15/0.30": { bb: 0.3, caps: [1.5, 2.0, 2.5, 3.0] },
  "0.25/0.50": { bb: 0.5, caps: [1.5, 2.0, 2.5, 3.0] },
  "0.50/1": { bb: 1, caps: [1.5, 2.0, 2.5, 3.0] },
} as const;

export type WinamaxLimit = keyof typeof WINAMAX_LIMITS;

export const WINAMAX_TABLE_SIZES = [
  "2 players",
  "3 players",
  "4 players",
  "5+ players",
];

export const BETCLIC_LIMITS = {
  NL5: { percent: 5.5, capBB: 20 },
  NL10: { percent: 5.5, capBB: 15 },
  NL25: { percent: 5.5, capBB: 10 },
  NL50: { percent: 5.5, capBB: 6 },
  NL100: { percent: 5.5, capBB: 4 },
} as const;

export type BetclicLimit = keyof typeof BETCLIC_LIMITS;

/** Everything the rake menu holds, whichever platform is selected. */
export type RakeConfig = {
  platform: Platform;
  winamaxLimit: WinamaxLimit;
  /** Index into the selected limit's caps. */
  winamaxSeats: number;
  betclicLimit: BetclicLimit;
  manualPercent: number;
  manualCapBB: number;
};

export const DEFAULT_RAKE_CONFIG: RakeConfig = {
  platform: "betclic",
  winamaxLimit: "0.25/0.50",
  winamaxSeats: 3,
  betclicLimit: "NL25",
  manualPercent: 5,
  manualCapBB: 3,
};

/** The two numbers every calculation below actually needs. */
export type Rake = { fraction: number; capBB: number };

export function resolveRake(config: RakeConfig): Rake {
  if (config.platform === "winamax") {
    const limit = WINAMAX_LIMITS[config.winamaxLimit];
    const capEuro = limit.caps[clamp(config.winamaxSeats, 0, limit.caps.length - 1)];
    return { fraction: WINAMAX_PERCENT / 100, capBB: capEuro / limit.bb };
  }
  if (config.platform === "betclic") {
    const limit = BETCLIC_LIMITS[config.betclicLimit];
    return { fraction: limit.percent / 100, capBB: limit.capBB };
  }
  return {
    fraction: Math.max(0, config.manualPercent) / 100,
    capBB: Math.max(0, config.manualCapBB),
  };
}

/** Rake actually taken from a pot of `potBB`, capped. */
export function rakeOn(potBB: number, rake: Rake): number {
  return Math.min(rake.fraction * Math.max(0, potBB), rake.capBB);
}

/* ---------------------------------------------------------------- pot odds */

export type PotOddsResult = {
  /** Rake taken once the call is in. */
  rake: number;
  /** What the pot pays the call, net of rake. */
  netPot: number;
  /** Equity the call needs to break even. */
  required: number;
  /** Equity the draw actually has. */
  equity: number;
  /** Already +EV on its own. */
  profitable: boolean;
  /**
   * Extra bb that must be won on later streets for a −EV call to break even.
   * `null` when the call needs nothing, `Infinity` when no out can get there.
   */
  implied: number | null;
};

/**
 * `pot` is the pot as it stands in front of you — villain's bet included — so
 * calling makes it `pot + call` and the call is priced against that.
 */
export function potOdds(input: {
  pot: number;
  call: number;
  outs: number;
  street: Street;
  rake: Rake;
}): PotOddsResult {
  const pot = Math.max(0, input.pot);
  const call = Math.max(0, input.call);

  const rake = rakeOn(pot + call, input.rake);
  const netPot = pot + call - rake;
  const required = netPot > 0 ? call / netPot : 0;
  const eq = equity(input.outs, input.street);
  const profitable = call <= 0 || eq >= required;

  let implied: number | null = null;
  if (call > 0 && !profitable) implied = eq > 0 ? Math.max(0, call / eq - netPot) : Infinity;

  return { rake, netPot, required, equity: eq, profitable, implied };
}

/* ------------------------------------------------------------ fold equity */

export const SIZINGS = [25, 35, 50, 65, 75, 100, 150, 200, 300];

export type FoldEquityRow = {
  /** Bet as a percentage of the pot. */
  sizing: number;
  bet: number;
  /** Share of the time villain must fold to break even. */
  required: number;
  /** +EV even if villain never folds. */
  free: boolean;
  /** Not reachable: even a 100% fold rate leaves it −EV. */
  unreachable: boolean;
};

/**
 * How often villain has to fold for a semi-bluff to break even, per sizing.
 *
 * Three branches: he folds and the pot (minus rake) is yours; he calls and you
 * hit; he calls and you miss. Setting the whole expectation to zero and solving
 * for the fold frequency `f` gives `f = −C / (A − C)`, with `C` the expectation
 * of the called branch and `A` the folded one.
 *
 * `pot` here is the pot *before* your bet, since the sizings are a share of it.
 */
export function foldEquityRows(input: {
  pot: number;
  outs: number;
  street: Street;
  rake: Rake;
}): FoldEquityRow[] {
  const pot = Math.max(0, input.pot);
  const eq = equity(input.outs, input.street);

  return SIZINGS.map((sizing) => {
    const bet = (pot * sizing) / 100;

    const folded = pot - rakeOn(pot, input.rake);
    const won = pot + bet - rakeOn(pot + 2 * bet, input.rake);
    const lost = -bet;
    const called = eq * won + (1 - eq) * lost;

    const denominator = folded - called;
    const f = denominator !== 0 ? -called / denominator : 0;

    return {
      sizing,
      bet,
      required: clamp(f, 0, 1),
      free: called >= 0,
      unreachable: called < 0 && f >= 1,
    };
  });
}

/* ------------------------------------------------------------------ format */

export const pct = (x: number, digits = 1) => `${(x * 100).toFixed(digits)}%`;

/** `33.3%` as `2.0 : 1`, the way odds are called at the table. */
export function asRatio(probability: number): string | null {
  if (!(probability > 0) || probability >= 1) return null;
  return `${((1 - probability) / probability).toFixed(1)} : 1`;
}

export function trimNumber(x: number, digits = 2): string {
  return x
    .toFixed(digits)
    .replace(/(\.\d*?)0+$/, "$1")
    .replace(/\.$/, "");
}

function clamp(x: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, x));
}
