import type { HudFilters, HudGroup, HudItem, HudLayout, StatValues } from "./types";

/**
 * How a stat's [numerator, denominator] becomes the number PT4 shows. Most
 * stats are percentages; the exceptions are listed here (same kinds as the
 * bridge's catalogue, tools/pio-bridge/internal/pt4/stats.go).
 */
export type StatKind = "pct" | "ratio" | "count" | "bb100" | "sum";

const KINDS: Record<string, StatKind> = {
  "Hands Abbreviated": "count",
  Player: "count",
  "BB/100": "bb100",
  "BB Won": "sum",
  "River Call Efficiency": "ratio",
  "Avg All-In Equity PF": "ratio",
  "Preflop AF": "ratio",
  "Flop AF": "ratio",
  "Turn AF": "ratio",
  "River AF": "ratio",
};

export function statKind(stat: string): StatKind {
  return KINDS[stat] ?? "pct";
}

/** The stat's value, or null when there is no opportunity yet. */
export function statValue(stat: string, v: [number, number] | undefined): number | null {
  if (!v) return null;
  const [num, den] = v;
  switch (statKind(stat)) {
    case "count":
      return num;
    case "sum":
      return den > 0 ? num : null;
    case "bb100":
      return den > 0 ? (num / den) * 100 : null;
    case "ratio":
      if (den > 0) return num / den;
      return num > 0 ? Infinity : null;
    default:
      return den > 0 ? (num / den) * 100 : null;
  }
}

/** Hands in a short form: 950, 1.2k, 12k. */
export function shortCount(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return `${Math.round(n / 1000)}k`;
}

export function formatStat(stat: string, value: number | null): string {
  if (value === null || Number.isNaN(value)) return "–";
  if (value === Infinity) return "∞";
  switch (statKind(stat)) {
    case "count":
      return shortCount(value);
    case "ratio":
      return stat === "Avg All-In Equity PF" && value <= 1 ? `${Math.round(value * 100)}` : value.toFixed(1);
    case "bb100":
    case "sum":
      return value.toFixed(1);
    default:
      return String(Math.round(value));
  }
}

/** The colour of a value from the stat's PT4 colour ranges. */
export function statColor(item: Extract<HudItem, { t: "stat" }>, value: number | null): string | undefined {
  if (value !== null && Number.isFinite(value) && item.ranges) {
    for (const [lo, hi, color] of item.ranges) {
      // PT4 ranges leave gaps of 0.01 (0–22.99, 23–27.99…): a value in a gap
      // (22.995) belongs to the range below it.
      if (value >= lo && value < hi + 0.01) return color;
    }
  }
  return item.color;
}

export type ShownStat = {
  text: string;
  color?: string;
  /** Fewer opportunities than the stat's minimum sample. */
  thin: boolean;
  title: string;
  /** For the hover card: stat name with its position filter ("VPIP · BTN"). */
  label: string;
  /** For the hover card: "12 / 48" (occurrences / opportunities) or "48 hands". */
  sample: string;
};

/** Everything needed to draw one stat of the HUD. */
export function showStat(
  item: Extract<HudItem, { t: "stat" }>,
  stats: Record<string, StatValues> | undefined,
  playerName = "",
): ShownStat {
  if (item.stat === "Player") return { text: playerName, thin: false, title: playerName, label: "Player", sample: "" };
  const v = stats?.[item.stat]?.[item.pos];
  const value = statValue(item.stat, v);
  const text = formatStat(item.stat, value);
  const den = v?.[1] ?? 0;
  const kind = statKind(item.stat);
  const num = v?.[0] ?? 0;
  const sample =
    kind === "pct" || kind === "ratio"
      ? `${round2(num)} / ${round2(den)}`
      : kind === "bb100" || kind === "sum"
        ? `${den.toLocaleString("en")} hands`
        : "";
  const label = `${item.stat}${POS_SUFFIX[item.pos]}`;
  return {
    text,
    color: statColor(item, value),
    thin: item.minSample !== undefined && kind === "pct" && den < item.minSample,
    title: `${label}: ${text}${sample ? ` (${sample})` : ""}`,
    label,
    sample,
  };
}

const POS_SUFFIX = ["", " · BB", " · SB", " · EP", " · MP", " · CO", " · BTN"];

/** Counts are whole numbers; amounts (River Call Efficiency) keep 2 decimals. */
function round2(x: number): string {
  return Number.isInteger(x) ? x.toLocaleString("en") : (Math.round(x * 100) / 100).toLocaleString("en");
}

/** Query parameters for /pt4/hud. */
export function filterParams(f: HudFilters): Record<string, string | undefined> {
  return {
    limits: f.limits.length ? f.limits.join(",") : undefined,
    last: f.lastHands > 0 ? String(Math.floor(f.lastHands)) : undefined,
    days: f.days > 0 ? String(f.days) : undefined,
  };
}

/** One-line summary of the filters, e.g. "NL200 · last 500 hands · 30 days". */
export function describeFilters(f: HudFilters, limitNames: Map<number, string>): string {
  const parts: string[] = [];
  if (f.limits.length) parts.push(f.limits.map((l) => limitNames.get(l) ?? `#${l}`).join(", "));
  if (f.lastHands > 0) parts.push(`last ${f.lastHands} hands`);
  if (f.days > 0) parts.push(`last ${f.days} days`);
  return parts.length ? parts.join(" · ") : "All hands";
}

/**
 * The popups to offer as tabs: the main group's popup menu first (titles
 * without PT4's version digits: "Preflop3" → "Preflop"), then the popups its
 * stats open, in the order they appear. Groups nothing links to are left out
 * (old versions kept in the export).
 */
export function popupTabs(layout: HudLayout): { label: string; group: HudGroup }[] {
  const byName = new Map(layout.groups.map((g) => [g.name, g]));
  const main = layout.groups.find((g) => g.main) ?? layout.groups[0];
  const out: { label: string; group: HudGroup }[] = [];
  const seen = new Set<string>([main.name]);
  const push = (name: string, label: string) => {
    const g = byName.get(name);
    if (!g || seen.has(name)) return;
    seen.add(name);
    out.push({ label, group: g });
  };
  for (const m of main.menu ?? []) push(m.group, m.title.replace(/\d+$/, "").trim() || m.title);
  for (const it of main.items) if (it.t === "stat" && it.popup) push(it.popup, it.popup);
  // Popups opened from popups.
  for (let i = 0; i < out.length; i++)
    for (const it of out[i].group.items) if (it.t === "stat" && it.popup) push(it.popup, it.popup);
  return out;
}
