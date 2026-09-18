/**
 * Importing a solver strategy exported as CSV.
 *
 * Expected shape (GTO Wizard / solver export style):
 *
 *   Hand,RAISE 180,RAISE 126,CALL,FOLD
 *   4c3c,0,0,90.18,9.81
 *   AKs,50,0,50,0
 *
 * The first column holds either an exact combo ("4c3c") or a canonical hand
 * ("AKs", "QQ"); every other header names an action — a kind, optionally
 * followed by a sizing. The action set of the strategy node is generated from
 * those headers. Frequencies may be percentages (0–100) or fractions (0–1).
 * Pure functions only.
 */

import { PALETTE } from "@/lib/categories";
import { RANKS, SUITS, comboToHand, handCombos } from "./cards";
import type { ActionKind, StrategyAction, StrategyWeights } from "./types";

export type CsvStrategy = {
  actions: StrategyAction[];
  weights: StrategyWeights;
  /** Rows that were imported. */
  rows: number;
  /** Non-fatal problems (unparseable rows), capped for display. */
  warnings: string[];
};

export class CsvImportError extends Error {}

/* ------------------------------------------------------------------ headers */

type ParsedHeader = { kind: ActionKind; sizePct: number | null; label: string; allIn: boolean };

const KIND_ALIASES: Record<string, ActionKind> = {
  check: "check",
  x: "check",
  bet: "bet",
  b: "bet",
  raise: "raise",
  r: "raise",
  call: "call",
  c: "call",
  fold: "fold",
  f: "fold",
};

/** "RAISE 180" → raise, 180 · "CALL" → call · "ALLIN" → all-in (kind resolved later). */
export function parseActionHeader(raw: string): ParsedHeader | null {
  const text = raw.trim();
  const lower = text.toLowerCase().replace(/[\s_-]+/g, " ").trim();

  if (/^(all ?in|allin|jam|shove)\b/.test(lower)) {
    return { kind: "raise", sizePct: null, label: "All-in", allIn: true };
  }

  const m = lower.match(/^([a-z]+)\s*(\d+(?:[.,]\d+)?)?\s*(%|bb)?$/);
  if (!m) return null;
  const kind = KIND_ALIASES[m[1]];
  if (!kind) return null;

  const size = m[2] !== undefined ? Number(m[2].replace(",", ".")) : null;
  const name = kind[0].toUpperCase() + kind.slice(1);
  const label = size !== null ? `${name} ${formatNumber(size)}${m[3] === "bb" ? "bb" : ""}` : name;
  return { kind, sizePct: size, label, allIn: false };
}

function formatNumber(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}

/** Aggressive sizes get warm colours (biggest = reddest), passive ones cool. */
function colorsFor(headers: ParsedHeader[]): string[] {
  const warm = [PALETTE[6], PALETTE[2], PALETTE[7], PALETTE[3], PALETTE[0], PALETTE[8]];
  const aggressive = headers
    .map((h, i) => ({ h, i }))
    .filter(({ h }) => h.kind === "bet" || h.kind === "raise")
    .sort((a, b) => sizeRank(b.h) - sizeRank(a.h));
  const out = new Array<string>(headers.length);
  aggressive.forEach(({ i }, rank) => (out[i] = warm[rank % warm.length]));
  headers.forEach((h, i) => {
    if (out[i]) return;
    if (h.kind === "call") out[i] = PALETTE[5];
    else if (h.kind === "check") out[i] = PALETTE[1];
    else out[i] = PALETTE[4]; // fold
  });
  return out;
}

function sizeRank(h: ParsedHeader): number {
  return h.allIn ? Number.POSITIVE_INFINITY : (h.sizePct ?? 0);
}

/**
 * Build the action set from the CSV headers. An existing action with the same
 * kind + size keeps its id (and colour), so action nodes already linked to it
 * stay linked after a re-import.
 */
function buildActions(headers: ParsedHeader[], existing: StrategyAction[]): StrategyAction[] {
  const colors = colorsFor(headers);
  const taken = new Set<string>();
  return headers.map((h, i) => {
    const match = existing.find(
      (a) =>
        !taken.has(a.id) &&
        a.kind === h.kind &&
        (a.sizePct ?? null) === h.sizePct &&
        (!h.allIn || a.label === h.label),
    );
    if (match) taken.add(match.id);
    return {
      id: match?.id ?? crypto.randomUUID(),
      kind: h.kind,
      sizePct: h.sizePct,
      label: h.label,
      color: match?.color ?? colors[i],
    };
  });
}

/* ---------------------------------------------------------------- hand keys */

const RANK_SET = new Set<string>(RANKS);
const SUIT_SET = new Set<string>(SUITS);

/** Canonical combo key as produced by handCombos(), or null. */
export function normalizeCombo(raw: string): string | null {
  const s = raw.trim();
  if (s.length !== 4) return null;
  const c1 = s[0].toUpperCase() + s[1].toLowerCase();
  const c2 = s[2].toUpperCase() + s[3].toLowerCase();
  if (!RANK_SET.has(c1[0]) || !RANK_SET.has(c2[0])) return null;
  if (!SUIT_SET.has(c1[1]) || !SUIT_SET.has(c2[1])) return null;
  if (c1 === c2) return null;
  const hand = comboToHand(c1 + c2);
  const set = handCombos(hand);
  return set.find((c) => c === c1 + c2) ?? set.find((c) => c === c2 + c1) ?? null;
}

/** Canonical hand label ("aks" → "AKs", "KAo" → "AKo"), or null. */
export function normalizeHand(raw: string): string | null {
  const s = raw.trim();
  if (s.length < 2 || s.length > 3) return null;
  const r1 = s[0].toUpperCase();
  const r2 = s[1].toUpperCase();
  if (!RANK_SET.has(r1) || !RANK_SET.has(r2)) return null;
  const [hi, lo] = (RANKS as string[]).indexOf(r1) <= (RANKS as string[]).indexOf(r2) ? [r1, r2] : [r2, r1];
  if (hi === lo) return s.length === 2 ? hi + lo : null;
  const suffix = s[2]?.toLowerCase();
  if (suffix !== "s" && suffix !== "o") return null;
  return `${hi}${lo}${suffix}`;
}

/* -------------------------------------------------------------------- parse */

function detectDelimiter(headerLine: string): string {
  const counts = [",", ";", "\t"].map((d) => [d, headerLine.split(d).length] as const);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][0];
}

function splitLine(line: string, delim: string): string[] {
  return line.split(delim).map((c) => c.trim().replace(/^"(.*)"$/, "$1"));
}

function parseNumber(cell: string): number {
  if (cell === "") return 0;
  const n = Number(cell.replace(",", "."));
  return Number.isFinite(n) ? n : NaN;
}

const round = (x: number) => Math.round(x * 1000) / 1000;

export function parseStrategyCsv(text: string, existing: StrategyAction[] = []): CsvStrategy {
  const lines = text
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length < 2) throw new CsvImportError("The file needs a header row and at least one hand.");

  const delim = detectDelimiter(lines[0]);
  const header = splitLine(lines[0], delim);
  if (header.length < 2) throw new CsvImportError("No action columns found in the header.");

  const parsedHeaders: ParsedHeader[] = [];
  for (const h of header.slice(1)) {
    const p = parseActionHeader(h);
    if (!p) throw new CsvImportError(`Unrecognised action column "${h}".`);
    parsedHeaders.push(p);
  }
  // All-in is a raise when facing a bet, a bet otherwise.
  const facingBet = parsedHeaders.some(
    (h) => !h.allIn && (h.kind === "raise" || h.kind === "call" || h.kind === "fold"),
  );
  for (const h of parsedHeaders) if (h.allIn) h.kind = facingBet ? "raise" : "bet";

  const len = parsedHeaders.length;
  const warnings: string[] = [];
  const rows: { combo: string | null; hand: string; vec: number[] }[] = [];

  for (let li = 1; li < lines.length; li++) {
    const cells = splitLine(lines[li], delim);
    const key = cells[0] ?? "";
    const combo = normalizeCombo(key);
    const hand = combo ? comboToHand(combo) : normalizeHand(key);
    if (!hand) {
      warnings.push(`Line ${li + 1}: unknown hand "${key}"`);
      continue;
    }
    const vec = parsedHeaders.map((_, i) => parseNumber(cells[i + 1] ?? ""));
    if (vec.some((x) => Number.isNaN(x))) {
      warnings.push(`Line ${li + 1}: non-numeric frequency`);
      continue;
    }
    rows.push({ combo, hand, vec });
  }
  if (rows.length === 0) throw new CsvImportError("No valid hand rows found.");

  // Fractions (0–1) → percentages.
  const maxTotal = Math.max(...rows.map((r) => r.vec.reduce((a, b) => a + b, 0)));
  const scale = maxTotal <= 1.0001 ? 100 : 1;

  const hands: Record<string, number[]> = {};
  const comboRows = new Map<string, Map<string, number[]>>(); // hand → combo → vec

  for (const r of rows) {
    const vec = r.vec.map((x) => round(x * scale));
    if (r.combo) {
      const m = comboRows.get(r.hand) ?? new Map<string, number[]>();
      m.set(r.combo, vec);
      comboRows.set(r.hand, m);
    } else {
      hands[r.hand] = vec;
    }
  }

  // Per-combo rows: the hand default is the average of the imported combos
  // (so combos absent from the file — e.g. blocked by the board — fall back
  // to it); combos are only stored as overrides where they differ.
  const combos: Record<string, number[]> = {};
  for (const [hand, m] of comboRows) {
    const vecs = [...m.values()];
    const avg = new Array<number>(len).fill(0);
    for (const v of vecs) for (let i = 0; i < len; i++) avg[i] += v[i] / vecs.length;
    const handVec = hands[hand] ?? avg.map(round);
    hands[hand] = handVec;
    for (const [combo, v] of m) {
      if (v.some((x, i) => Math.abs(x - handVec[i]) > 0.05)) combos[combo] = v;
    }
  }

  return {
    actions: buildActions(parsedHeaders, existing),
    weights: { hands, combos },
    rows: rows.length,
    warnings: warnings.slice(0, 5).concat(warnings.length > 5 ? [`…and ${warnings.length - 5} more`] : []),
  };
}
