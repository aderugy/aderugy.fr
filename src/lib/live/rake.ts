/**
 * The card room's rake, as a rule kept on the session.
 *
 * A room takes a share of every pot: `percent` of it, rounded up to the next
 * `step` (Pierre Charron counts in 0,50 € chips, so 4 % of 30 € = 1,20 € is
 * taken as 1,50 €), never less than one `step`, and never more than `cap` when
 * the room caps it. With `preflop` off, a hand that ends before the flop is
 * not raked ("no flop, no drop").
 *
 * The rule lives on the session rather than on the venue so a room that
 * changes its rake does not rewrite the hands already played under the old
 * one. A new session copies the rule of the last session at the same venue.
 */

export type RakeRule = {
  /** Share of the pot, in percent (4 = 4 %). */
  percent: number;
  /** Rake is taken in multiples of this, rounded up; also the minimum. 0 = exact. */
  step: number;
  /** Most taken from one hand, or null when the room does not cap. */
  cap: number | null;
  /** Whether a hand that ends preflop is raked. */
  preflop: boolean;
};

const r2 = (x: number) => Math.round(x * 100) / 100;

/** A rule read back from the database, or null when there is none or it is malformed. */
export function asRakeRule(raw: unknown): RakeRule | null {
  if (!raw || typeof raw !== "object") return null;
  const v = raw as Record<string, unknown>;
  const percent = Number(v.percent);
  const step = Number(v.step ?? 0);
  const cap = v.cap == null ? null : Number(v.cap);
  if (!(percent >= 0 && percent <= 100) || !(step >= 0)) return null;
  if (cap !== null && !(cap >= 0)) return null;
  return { percent, step, cap, preflop: v.preflop !== false };
}

/**
 * What the room takes from a hand whose pots total `pot`.
 *
 * `sawFlop` is false for a hand over before the flop was dealt. The rake never
 * exceeds the pot itself.
 */
export function rakeOn(pot: number, rule: RakeRule, sawFlop: boolean): number {
  if (!(pot > 0)) return 0;
  if (!sawFlop && !rule.preflop) return 0;
  let rake = r2((pot * rule.percent) / 100);
  if (rule.step > 0) {
    // r2 first, so 4 % of 25 (1.0000000000000002) stays 1,00 and not 1,50.
    rake = Math.max(rule.step, Math.ceil(r2(rake / rule.step) - 1e-9) * rule.step);
  }
  if (rule.cap !== null) rake = Math.min(rake, rule.cap);
  return r2(Math.min(rake, pot));
}

/** "4 %, by 0,50 rounded up, no cap, preflop raked". */
export function describeRake(rule: RakeRule, currency = "€"): string {
  const parts = [`${rule.percent} %`];
  if (rule.step > 0) parts.push(`in steps of ${rule.step.toFixed(2)} ${currency} rounded up (minimum ${rule.step.toFixed(2)} ${currency})`);
  parts.push(rule.cap === null ? "no cap" : `capped at ${rule.cap} ${currency}`);
  parts.push(rule.preflop ? "preflop pots raked" : "no flop, no drop");
  return parts.join(", ");
}
