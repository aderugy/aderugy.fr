"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  EQUITY_FORMULA,
  MAX_OUTS,
  STREETS,
  asRatio,
  equity,
  foldEquityRows,
  initialSelection,
  normalizeSelection,
  pct,
  potOdds,
  rakeOn,
  readStoredSelection,
  resolveRake,
  storeSelection,
  trimNumber,
  type Rake,
  type RakeProfile,
  type RakeSelection,
  type Street,
} from "@/lib/poker";
import { RakeMenu } from "./RakeMenu";
import { Formula, Hint, NumberField, ResultCard, Segmented, Worked } from "./ui";

type Tab = "odds" | "fold";

const TABS: { id: Tab; label: string }[] = [
  { id: "odds", label: "Pot odds" },
  { id: "fold", label: "Fold equity" },
];

export function PokerCalculator({ profiles }: { profiles: RakeProfile[] }) {
  const [tab, setTab] = useState<Tab>("odds");
  const [selection, setSelection] = useState<RakeSelection>(() =>
    initialSelection(profiles),
  );

  // The stored choice is read after mount rather than during render: the server
  // has no localStorage, and rendering from it directly would hydrate into a
  // different menu than the HTML it is matching against.
  useEffect(() => {
    const stored = readStoredSelection();
    if (stored) setSelection(normalizeSelection(stored, profiles));
  }, [profiles]);

  const update = (next: RakeSelection) => {
    const normalized = normalizeSelection(next, profiles);
    setSelection(normalized);
    storeSelection(normalized);
  };

  const rake = useMemo(() => resolveRake(selection, profiles), [selection, profiles]);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Segmented value={tab} onChange={setTab} options={TABS} />
        <RakeMenu profiles={profiles} selection={selection} onChange={update} />
      </div>

      {tab === "odds" ? <PotOddsTab rake={rake} /> : <FoldEquityTab rake={rake} />}
    </div>
  );
}

/* ---------------------------------------------------------------- pot odds */

function PotOddsTab({ rake }: { rake: Rake }) {
  const [pot, setPot] = useState("100");
  const [call, setCall] = useState("50");
  const [outs, setOuts] = useState("9");
  const [street, setStreet] = useState<Street>("flop2");

  const P = toNumber(pot);
  const B = toNumber(call);
  const O = toOuts(outs);
  const result = potOdds({ pot: P, call: B, outs: O, street, rake });

  const requiredLabel = result.netPot > 0 ? pct(result.required) : "—";
  const impliedLabel =
    B <= 0
      ? "—"
      : result.implied === null
        ? "0 bb"
        : result.implied === Infinity
          ? "∞"
          : `+${result.implied.toFixed(1)} bb`;

  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-3">
        <NumberField
          label="Pot, villain's bet included"
          value={pot}
          onChange={setPot}
          suffix="bb"
        />
        <NumberField label="Bet to call" value={call} onChange={setCall} suffix="bb" />
        <NumberField
          label="Outs"
          value={outs}
          onChange={setOuts}
          min={0}
          max={MAX_OUTS}
          step={1}
        />
      </div>

      <StreetPicker value={street} onChange={setStreet} />

      <div className="grid gap-3 sm:grid-cols-3">
        <ResultCard
          label="Pot odds"
          value={requiredLabel}
          note={
            B > 0 && result.netPot > 0
              ? `pot lays ${(result.netPot / B).toFixed(1)} : 1`
              : "equity the call needs"
          }
          hint={
            <>
              <b>Pot odds</b> — the equity a call needs to break even. The rake comes
              off the pot before it pays you.
              <Formula>call / (pot + call − rake)</Formula>
              <Worked>
                {trimNumber(B, 1)} / ({trimNumber(P, 1)} + {trimNumber(B, 1)} −{" "}
                {result.rake.toFixed(2)}) = {requiredLabel}
              </Worked>
            </>
          }
        />
        <ResultCard
          label="Your equity"
          value={pct(result.equity)}
          note={
            asRatio(result.equity)
              ? `${asRatio(result.equity)} against you`
              : "chance to get there"
          }
          tone={result.equity >= result.required && B > 0 ? "good" : "accent"}
          hint={
            <>
              <b>Equity</b> — the chance one of your outs arrives.
              <Formula>{EQUITY_FORMULA[street]}</Formula>
              <Worked>
                O = {O} outs → {pct(result.equity)}
              </Worked>
            </>
          }
        />
        <ResultCard
          label="Implied odds"
          value={impliedLabel}
          note={
            B <= 0
              ? "future winnings needed"
              : result.implied === null
                ? "the call already stands alone"
                : result.implied === Infinity
                  ? "no out can get there"
                  : "to win later, on top of this pot"
          }
          tone={result.implied === null && B > 0 ? "good" : "accent"}
          hint={
            <>
              <b>Implied odds</b> — what you must still win on later streets when your
              equity is short of the price.
              <Formula>call / equity − (pot + call − rake)</Formula>
              <Worked>
                {result.implied === null
                  ? "equity already covers the price"
                  : result.implied === Infinity
                    ? "no equity, no price"
                    : `+${result.implied.toFixed(1)} bb to win later`}
              </Worked>
            </>
          }
        />
      </div>

      <Verdict>
        {B <= 0 ? (
          "Enter the bet you are facing."
        ) : result.profitable ? (
          <>
            {O} outs are worth <b className="font-medium text-foreground">
              {pct(result.equity)}
            </b>{" "}
            against the {requiredLabel} the pot asks — the call is +EV on its own.
          </>
        ) : (
          <>
            {pct(result.equity)} against {requiredLabel} required — the call needs{" "}
            <b className="font-medium text-foreground">{impliedLabel}</b> of later
            winnings to break even.
          </>
        )}
      </Verdict>
    </div>
  );
}

/* ------------------------------------------------------------- fold equity */

function FoldEquityTab({ rake }: { rake: Rake }) {
  const [pot, setPot] = useState("100");
  const [outs, setOuts] = useState("9");
  const [street, setStreet] = useState<Street>("flop2");

  const P = toNumber(pot);
  const O = toOuts(outs);
  const rows = foldEquityRows({ pot: P, outs: O, street, rake });
  const eq = equity(O, street);

  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2">
        <NumberField
          label="Pot before your bet"
          value={pot}
          onChange={setPot}
          suffix="bb"
        />
        <NumberField
          label="Outs"
          value={outs}
          onChange={setOuts}
          min={0}
          max={MAX_OUTS}
          step={1}
        />
      </div>

      <StreetPicker value={street} onChange={setStreet} />

      <div className="rounded-lg border border-line bg-surface">
        <div className="relative flex items-start justify-between gap-2 border-b border-line px-4 py-3">
          <div>
            <p className="text-sm font-medium">Semi-bluff</p>
            <p className="mt-0.5 text-xs text-muted">
              How often villain must fold for the bet to break even.
            </p>
          </div>
          <Hint label="fold equity">
            <>
              <b>Fold equity</b> — three branches: he folds and the pot is yours, he
              calls and you hit, he calls and you miss. Set the whole thing to zero and
              solve for the fold rate.
              <Formula>
                f·(pot − rake) + (1−f)·[eq·(pot + bet − rake) − (1−eq)·bet] = 0
              </Formula>
              <Worked>
                equity = {EQUITY_FORMULA[street]} = {pct(eq)}
              </Worked>
              <Worked>
                rake = min({trimNumber(rake.fraction * 100)}% × pot ;{" "}
                {trimNumber(rake.capBB, 1)} bb) = {rakeOn(P, rake).toFixed(2)} bb when he
                folds
              </Worked>
              <Worked>0% = +EV even if he never folds</Worked>
            </>
          </Hint>
        </div>

        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-muted">
              <th className="px-4 py-2 text-left font-normal">Sizing</th>
              <th className="px-4 py-2 text-right font-normal">Bet</th>
              <th className="px-4 py-2 text-right font-normal">Folds needed</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.sizing} className="border-t border-line">
                <td className="px-4 py-2 tabular-nums">{row.sizing}%</td>
                <td className="px-4 py-2 text-right tabular-nums text-muted">
                  {row.bet.toFixed(1)} bb
                </td>
                <td
                  className={`px-4 py-2 text-right font-medium tabular-nums ${
                    row.free
                      ? "text-emerald-600 dark:text-emerald-400"
                      : row.unreachable
                        ? "text-muted"
                        : "text-accent"
                  }`}
                >
                  {row.free ? "0%" : row.unreachable ? "≥ 100%" : pct(row.required, 0)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Verdict>
        {O} outs are worth{" "}
        <b className="font-medium text-foreground">{pct(eq)}</b> here. A green 0% means
        the bet is already +EV on equity alone; ≥ 100% means no fold rate saves it.
      </Verdict>
    </div>
  );
}

/* ------------------------------------------------------------------ shared */

function StreetPicker({
  value,
  onChange,
}: {
  value: Street;
  onChange: (street: Street) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <span className="text-xs text-muted">Cards to come</span>
      <Segmented
        size="sm"
        value={value}
        onChange={onChange}
        options={STREETS.map((street) => ({ id: street.id, label: street.label }))}
      />
    </div>
  );
}

function Verdict({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-lg border border-line bg-background px-4 py-3 text-xs leading-relaxed text-muted">
      {children}
    </p>
  );
}

function toNumber(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

function toOuts(value: string): number {
  return Math.min(MAX_OUTS, Math.max(0, Math.round(toNumber(value))));
}
