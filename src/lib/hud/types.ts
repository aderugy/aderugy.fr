/**
 * The PokerTracker 4 HUD (/poker/hud): the layout exported from PT4 and the
 * data PioBridge serves from the local PT4 database.
 *
 * layout.json is generated from a .pt4hud export:
 *   python scripts/poker/pt4hud_layout.py "Cash - HUD.pt4hud" src/lib/hud/layout.json
 */

/** HUD position filter: 0 all · 1 BB · 2 SB · 3 EP · 4 MP · 5 CO · 6 BTN. */
export type HudPos = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export type HudItem =
  | { t: "br" }
  | { t: "hr" }
  | { t: "text"; text: string }
  | {
      t: "stat";
      stat: string;
      pos: HudPos;
      prefix?: string;
      popup?: string;
      minSample?: number;
      color?: string;
      ranges?: [number, number, string][];
    };

export type HudGroup = {
  name: string;
  main: boolean;
  items: HudItem[];
  /** The group's popup menu in PT4 (title, group name). */
  menu?: { title: string; group: string }[];
};

export type HudLayout = { name: string; groups: HudGroup[]; customStats: string[] };

/** Per position (index = HudPos): [numerator, denominator]. */
export type StatValues = [number, number][];

export type PlayerHud = {
  id: number;
  name: string;
  site: string;
  /** Hands matching the filter. */
  hands: number;
  /** All the player's hands. */
  total: number;
  stats: Record<string, StatValues>;
  error?: string;
  ms: number;
};

export type Pt4Player = { id: number; name: string; site: string; hands: number };

export type Pt4Limit = { id: number; name: string; bb: number; currency: string; hands: number };

export type Pt4Status = {
  configured: boolean;
  connected: boolean;
  database?: string;
  error?: string;
  maxHand: number;
  cachedPlayers: number;
};

export type HudFilters = {
  /** Stake ids; empty = all. */
  limits: number[];
  /** Latest N hands; 0 = all. */
  lastHands: number;
  /** Latest N days; 0 = all. */
  days: number;
};

export const NO_FILTERS: HudFilters = { limits: [], lastHands: 0, days: 0 };
