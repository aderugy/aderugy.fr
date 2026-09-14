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

/**
 * One row of `public.rake_profiles`: a site's rake at one limit, for one table
 * size where that matters.
 *
 * The presets live in the database rather than in this file so a limit can be
 * corrected without a deploy. `capBB` is what the maths uses; `capAmount`,
 * `bigBlind` and `currency` exist only to show the cap the way the site states
 * it ("1,50 € = 3 bb").
 */
export type RakeProfile = {
  platform: string;
  platformLabel: string;
  stakes: string;
  stakesLabel: string;
  seats: number | null;
  seatsLabel: string | null;
  percent: number;
  capBB: number;
  capAmount: number | null;
  bigBlind: number | null;
  currency: string | null;
  isDefault: boolean;
  position: number;
};

/** The platform value that means "I am typing the numbers myself". */
export const MANUAL_PLATFORM = "manual";

/** What the user picked. Persisted to localStorage; never sent anywhere. */
export type RakeSelection = {
  platform: string;
  stakes: string | null;
  seats: number | null;
  manualPercent: number;
  manualCapBB: number;
};

export const MANUAL_DEFAULTS = { percent: 5, capBB: 3 };

/** The two numbers every calculation below actually needs. */
export type Rake = { fraction: number; capBB: number };

const byPosition = (a: RakeProfile, b: RakeProfile) => a.position - b.position;

/** Platforms present in the presets, in their configured order. */
export function rakePlatforms(profiles: RakeProfile[]): { id: string; label: string }[] {
  const seen = new Map<string, RakeProfile>();
  for (const profile of profiles) {
    const current = seen.get(profile.platform);
    if (!current || profile.position < current.position) seen.set(profile.platform, profile);
  }
  return [...seen.values()]
    .sort(byPosition)
    .map((profile) => ({ id: profile.platform, label: profile.platformLabel }));
}

/** Limits offered by one platform, in their configured order. */
export function rakeStakes(
  profiles: RakeProfile[],
  platform: string,
): { id: string; label: string }[] {
  const seen = new Map<string, RakeProfile>();
  for (const profile of profiles) {
    if (profile.platform !== platform) continue;
    const current = seen.get(profile.stakes);
    if (!current || profile.position < current.position) seen.set(profile.stakes, profile);
  }
  return [...seen.values()]
    .sort(byPosition)
    .map((profile) => ({ id: profile.stakes, label: profile.stakesLabel }));
}

/**
 * Table sizes offered for one limit — empty when the site's cap does not depend
 * on how many players were dealt in.
 */
export function rakeSeats(profiles: RakeProfile[], platform: string, stakes: string | null) {
  return profiles
    .filter((p) => p.platform === platform && p.stakes === stakes && p.seats !== null)
    .sort(byPosition);
}

export function findRakeProfile(
  profiles: RakeProfile[],
  selection: RakeSelection,
): RakeProfile | null {
  return (
    profiles.find(
      (profile) =>
        profile.platform === selection.platform &&
        profile.stakes === selection.stakes &&
        profile.seats === selection.seats,
    ) ?? null
  );
}

/** The selection a first-time visitor gets: the preset flagged as default. */
export function initialSelection(profiles: RakeProfile[]): RakeSelection {
  const preferred =
    [...profiles].sort(byPosition).find((profile) => profile.isDefault) ??
    [...profiles].sort(byPosition)[0];

  if (!preferred) {
    return {
      platform: MANUAL_PLATFORM,
      stakes: null,
      seats: null,
      manualPercent: MANUAL_DEFAULTS.percent,
      manualCapBB: MANUAL_DEFAULTS.capBB,
    };
  }
  return {
    platform: preferred.platform,
    stakes: preferred.stakes,
    seats: preferred.seats,
    manualPercent: MANUAL_DEFAULTS.percent,
    manualCapBB: MANUAL_DEFAULTS.capBB,
  };
}

/**
 * Pull a selection back onto something that exists.
 *
 * A stored selection can name a limit that has since been renamed or removed,
 * and changing platform or limit leaves the other fields pointing at the old
 * one. Rather than scatter that repair across the menu's handlers, every change
 * goes through here.
 */
export function normalizeSelection(
  selection: RakeSelection,
  profiles: RakeProfile[],
): RakeSelection {
  const manualPercent = Number.isFinite(selection.manualPercent)
    ? Math.max(0, selection.manualPercent)
    : MANUAL_DEFAULTS.percent;
  const manualCapBB = Number.isFinite(selection.manualCapBB)
    ? Math.max(0, selection.manualCapBB)
    : MANUAL_DEFAULTS.capBB;

  if (selection.platform === MANUAL_PLATFORM || profiles.length === 0) {
    return {
      platform: MANUAL_PLATFORM,
      stakes: null,
      seats: null,
      manualPercent,
      manualCapBB,
    };
  }

  const platform = rakePlatforms(profiles).some((p) => p.id === selection.platform)
    ? selection.platform
    : (rakePlatforms(profiles)[0]?.id ?? MANUAL_PLATFORM);

  const stakes = rakeStakes(profiles, platform);
  const chosenStakes = stakes.some((s) => s.id === selection.stakes)
    ? selection.stakes
    : (stakes[0]?.id ?? null);

  const seats = rakeSeats(profiles, platform, chosenStakes);
  const chosenSeats = seats.some((s) => s.seats === selection.seats)
    ? selection.seats
    : (seats[seats.length - 1]?.seats ?? null);

  return {
    platform,
    stakes: chosenStakes,
    seats: chosenSeats,
    manualPercent,
    manualCapBB,
  };
}

export function resolveRake(selection: RakeSelection, profiles: RakeProfile[]): Rake {
  if (selection.platform !== MANUAL_PLATFORM) {
    const profile = findRakeProfile(profiles, selection);
    if (profile) return { fraction: profile.percent / 100, capBB: profile.capBB };
  }
  return {
    fraction: Math.max(0, selection.manualPercent) / 100,
    capBB: Math.max(0, selection.manualCapBB),
  };
}

/** Rake actually taken from a pot of `potBB`, capped. */
export function rakeOn(potBB: number, rake: Rake): number {
  return Math.min(rake.fraction * Math.max(0, potBB), rake.capBB);
}

/* ------------------------------------------------------- stored selection */

export const RAKE_STORAGE_KEY = "aderugy:poker:rake";

/**
 * The rake you play is a property of where you play, not of this hand, so it
 * survives the tab. Storage can throw (private windows, blocked site data) and
 * can hold anything, so every field is re-checked on the way back in.
 */
export function readStoredSelection(): RakeSelection | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(RAKE_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const value = parsed as Record<string, unknown>;
    if (typeof value.platform !== "string") return null;
    return {
      platform: value.platform,
      stakes: typeof value.stakes === "string" ? value.stakes : null,
      seats: typeof value.seats === "number" ? value.seats : null,
      manualPercent:
        typeof value.manualPercent === "number"
          ? value.manualPercent
          : MANUAL_DEFAULTS.percent,
      manualCapBB:
        typeof value.manualCapBB === "number" ? value.manualCapBB : MANUAL_DEFAULTS.capBB,
    };
  } catch {
    return null;
  }
}

export function storeSelection(selection: RakeSelection): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(RAKE_STORAGE_KEY, JSON.stringify(selection));
  } catch {
    // A visitor with site data blocked still gets a working calculator.
  }
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

/** `1.5` with currency `EUR` → `1,50 €` in the reader's own locale. */
export function formatAmount(amount: number, currency: string | null): string {
  if (!currency) return trimNumber(amount);
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(amount);
  } catch {
    return `${trimNumber(amount)} ${currency}`;
  }
}

function clamp(x: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, x));
}
