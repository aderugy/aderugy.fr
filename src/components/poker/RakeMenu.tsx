"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { eventHitsElement } from "@/lib/dom";
import {
  MANUAL_PLATFORM,
  findRakeProfile,
  formatAmount,
  rakePlatforms,
  rakeSeats,
  rakeStakes,
  resolveRake,
  trimNumber,
  type RakeProfile,
  type RakeSelection,
} from "@/lib/poker";

/**
 * The rake settings, shared by both tabs.
 *
 * Rake is the reason a marginal call is worse than the raw odds suggest, so it
 * belongs to the whole tool rather than to one tab — and it is set once and
 * then left alone, which is why it lives behind a menu instead of taking up a
 * field, and why the choice is remembered between visits.
 *
 * Everything but the manual fields is driven by `profiles`, straight from the
 * database: a new site or a corrected cap appears here without a deploy.
 */
export function RakeMenu({
  profiles,
  selection,
  onChange,
}: {
  profiles: RakeProfile[];
  selection: RakeSelection;
  onChange: (selection: RakeSelection) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!eventHitsElement(event, ref.current)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const patch = (next: Partial<RakeSelection>) => onChange({ ...selection, ...next });

  const platforms = rakePlatforms(profiles);
  const stakes = rakeStakes(profiles, selection.platform);
  const seats = rakeSeats(profiles, selection.platform, selection.stakes);
  const active = findRakeProfile(profiles, selection);

  const rake = resolveRake(selection, profiles);
  const platformName =
    selection.platform === MANUAL_PLATFORM
      ? "Manual"
      : (active?.platformLabel ??
        platforms.find((p) => p.id === selection.platform)?.label ??
        selection.platform);
  const summary = `${platformName} · ${trimNumber(rake.fraction * 100)}% / ${trimNumber(rake.capBB, 1)} bb`;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className={`rounded-lg border px-3 py-1.5 text-xs transition-colors ${
          open
            ? "border-accent text-foreground"
            : "border-line text-muted hover:border-accent hover:text-foreground"
        }`}
      >
        Rake · <span className="tabular-nums">{summary}</span> ▾
      </button>

      {open && (
        <div className="absolute right-0 top-10 z-30 w-72 rounded-lg border border-line bg-surface p-3 text-xs shadow-xl">
          <p className="mb-2 font-medium">Rake taken by the site</p>

          <Select
            label="Platform"
            value={selection.platform}
            onChange={(value) => patch({ platform: value })}
            options={[
              ...platforms.map((platform) => ({ value: platform.id, label: platform.label })),
              { value: MANUAL_PLATFORM, label: "Manual" },
            ]}
          />

          {selection.platform !== MANUAL_PLATFORM && stakes.length > 0 && (
            <Select
              label="Limit"
              value={selection.stakes ?? ""}
              onChange={(value) => patch({ stakes: value })}
              options={stakes.map((option) => ({ value: option.id, label: option.label }))}
            />
          )}

          {selection.platform !== MANUAL_PLATFORM && seats.length > 0 && (
            <Select
              label="Players dealt in"
              value={String(selection.seats ?? "")}
              onChange={(value) => patch({ seats: Number(value) })}
              options={seats.map((profile) => ({
                value: String(profile.seats),
                label: profile.seatsLabel ?? `${profile.seats} players`,
              }))}
            />
          )}

          {selection.platform === MANUAL_PLATFORM ? (
            <div className="mt-2 grid grid-cols-2 gap-2">
              <label className="block">
                <span className="text-muted">Percent</span>
                <input
                  type="number"
                  min={0}
                  max={100}
                  step={0.25}
                  inputMode="decimal"
                  value={selection.manualPercent}
                  onChange={(event) =>
                    patch({ manualPercent: Number(event.target.value) || 0 })
                  }
                  className="mt-1 w-full rounded border border-line bg-surface px-2 py-1.5 tabular-nums outline-none focus:border-accent"
                />
              </label>
              <label className="block">
                <span className="text-muted">Cap (bb)</span>
                <input
                  type="number"
                  min={0}
                  step={0.5}
                  inputMode="decimal"
                  value={selection.manualCapBB}
                  onChange={(event) =>
                    patch({ manualCapBB: Number(event.target.value) || 0 })
                  }
                  className="mt-1 w-full rounded border border-line bg-surface px-2 py-1.5 tabular-nums outline-none focus:border-accent"
                />
              </label>
            </div>
          ) : (
            <Summary>
              {trimNumber(rake.fraction * 100)}% · cap{" "}
              {active?.capAmount != null && active.currency ? (
                <>
                  <b className="font-medium text-foreground">
                    {formatAmount(active.capAmount, active.currency)}
                  </b>{" "}
                  = <b className="font-medium text-foreground">{trimNumber(rake.capBB, 1)} bb</b>
                </>
              ) : (
                <b className="font-medium text-foreground">{trimNumber(rake.capBB, 1)} bb</b>
              )}
            </Summary>
          )}

          {profiles.length === 0 && (
            <p className="mt-2 text-[11px] leading-relaxed text-amber-600 dark:text-amber-500">
              No presets loaded — set the rake by hand.
            </p>
          )}

          <p className="mt-3 text-[11px] leading-relaxed text-muted">
            Taken as <span className="font-mono">min(percent × pot, cap)</span> and removed
            from the pot before it pays your call. Your choice is remembered on this
            device.
          </p>
        </div>
      )}
    </div>
  );
}

function Select({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <label className="mt-2 block first:mt-0">
      <span className="text-muted">{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="mt-1 w-full rounded border border-line bg-surface px-2 py-1.5 outline-none focus:border-accent"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function Summary({ children }: { children: ReactNode }) {
  return (
    <p className="mt-2 rounded border border-line bg-background px-2 py-1.5 text-center tabular-nums text-muted">
      {children}
    </p>
  );
}
