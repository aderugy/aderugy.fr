/**
 * Le sous-ensemble de l'API `expect` de Vitest dont les tests du parcours ont
 * besoin, posé sur `node:test` et `node:assert`.
 *
 * Le dépôt lance ses tests avec `tsx --test` : garder la syntaxe d'origine
 * évite de réécrire soixante-seize assertions, et évite d'ajouter un second
 * lanceur de tests pour trois fichiers.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

export { describe, it };

function closeTo(actual: number, expected: number, digits: number) {
  // Même tolérance que Vitest : |a - e| < 10^-digits / 2.
  return Math.abs(actual - expected) < 10 ** -digits / 2;
}

function matches(actual: unknown, expected: Record<string, unknown>): boolean {
  if (typeof actual !== "object" || actual === null) return false;
  return Object.entries(expected).every(([k, v]) => {
    const a = (actual as Record<string, unknown>)[k];
    if (v !== null && typeof v === "object" && !Array.isArray(v))
      return matches(a, v as Record<string, unknown>);
    try {
      assert.deepStrictEqual(a, v);
      return true;
    } catch {
      return false;
    }
  });
}

function matchers(actual: unknown, negated: boolean) {
  const check = (ok: boolean, message: string) => {
    if (ok === negated) assert.fail(`${negated ? "not " : ""}${message}`);
  };
  const n = actual as number;
  return {
    toBe: (e: unknown) => check(Object.is(actual, e), `expected ${String(actual)} to be ${String(e)}`),
    toEqual: (e: unknown) => {
      let ok = true;
      try {
        assert.deepStrictEqual(actual, e);
      } catch {
        ok = false;
      }
      check(ok, `expected ${JSON.stringify(actual)} to equal ${JSON.stringify(e)}`);
    },
    toMatchObject: (e: Record<string, unknown>) =>
      check(matches(actual, e), `expected ${JSON.stringify(actual)} to match ${JSON.stringify(e)}`),
    toBeCloseTo: (e: number, digits = 2) =>
      check(closeTo(n, e, digits), `expected ${n} to be close to ${e} (${digits} digits)`),
    toBeGreaterThan: (e: number) => check(n > e, `expected ${n} > ${e}`),
    toBeGreaterThanOrEqual: (e: number) => check(n >= e, `expected ${n} >= ${e}`),
    toBeLessThan: (e: number) => check(n < e, `expected ${n} < ${e}`),
    toBeLessThanOrEqual: (e: number) => check(n <= e, `expected ${n} <= ${e}`),
    toHaveLength: (e: number) =>
      check((actual as { length: number }).length === e, `expected length ${e}`),
    toContain: (e: unknown) =>
      check((actual as unknown[]).includes(e), `expected ${JSON.stringify(actual)} to contain ${String(e)}`),
  };
}

export function expect(actual: unknown) {
  return Object.assign(matchers(actual, false), { not: matchers(actual, true) });
}
