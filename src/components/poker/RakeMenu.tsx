"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { eventHitsElement } from "@/lib/dom";
import {
  BETCLIC_LIMITS,
  WINAMAX_LIMITS,
  WINAMAX_PERCENT,
  WINAMAX_TABLE_SIZES,
  resolveRake,
  trimNumber,
  type BetclicLimit,
  type Platform,
  type RakeConfig,
  type WinamaxLimit,
} from "@/lib/poker";

const PLATFORMS: { id: Platform; label: string }[] = [
  { id: "betclic", label: "Betclic" },
  { id: "winamax", label: "Winamax" },
  { id: "manual", label: "Manual" },
];

/**
 * The rake settings, shared by both tabs.
 *
 * Rake is the reason a marginal call is worse than the raw odds suggest, so it
 * belongs to the whole tool rather than to one tab — and it is set once a
 * session, which is why it lives behind a menu instead of taking up a field.
 */
export function RakeMenu({
  config,
  onChange,
}: {
  config: RakeConfig;
  onChange: (config: RakeConfig) => void;
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

  const patch = (next: Partial<RakeConfig>) => onChange({ ...config, ...next });

  const rake = resolveRake(config);
  const platformName = PLATFORMS.find((p) => p.id === config.platform)?.label ?? "";
  const summary = `${platformName} · ${trimNumber(rake.fraction * 100)}% / ${trimNumber(rake.capBB, 1)} bb`;

  const winamax = WINAMAX_LIMITS[config.winamaxLimit];
  const winamaxCapEuro = winamax.caps[config.winamaxSeats];

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

          <label className="block">
            <span className="text-muted">Platform</span>
            <select
              value={config.platform}
              onChange={(event) => patch({ platform: event.target.value as Platform })}
              className="mt-1 w-full rounded border border-line bg-surface px-2 py-1.5 outline-none focus:border-accent"
            >
              {PLATFORMS.map((platform) => (
                <option key={platform.id} value={platform.id}>
                  {platform.label}
                </option>
              ))}
            </select>
          </label>

          {config.platform === "betclic" && (
            <>
              <label className="mt-2 block">
                <span className="text-muted">Limit</span>
                <select
                  value={config.betclicLimit}
                  onChange={(event) =>
                    patch({ betclicLimit: event.target.value as BetclicLimit })
                  }
                  className="mt-1 w-full rounded border border-line bg-surface px-2 py-1.5 outline-none focus:border-accent"
                >
                  {Object.keys(BETCLIC_LIMITS).map((limit) => (
                    <option key={limit} value={limit}>
                      {limit} · 6-max+
                    </option>
                  ))}
                </select>
              </label>
              <Summary>
                {trimNumber(rake.fraction * 100)}% · cap{" "}
                <b className="font-medium text-foreground">
                  {trimNumber(rake.capBB, 1)} bb
                </b>
              </Summary>
            </>
          )}

          {config.platform === "winamax" && (
            <>
              <label className="mt-2 block">
                <span className="text-muted">Limit</span>
                <select
                  value={config.winamaxLimit}
                  onChange={(event) =>
                    patch({ winamaxLimit: event.target.value as WinamaxLimit })
                  }
                  className="mt-1 w-full rounded border border-line bg-surface px-2 py-1.5 outline-none focus:border-accent"
                >
                  {Object.keys(WINAMAX_LIMITS).map((limit) => (
                    <option key={limit} value={limit}>
                      {limit.replace("/", " / ")} €
                    </option>
                  ))}
                </select>
              </label>
              <label className="mt-2 block">
                <span className="text-muted">Players dealt in</span>
                <select
                  value={config.winamaxSeats}
                  onChange={(event) =>
                    patch({ winamaxSeats: Number(event.target.value) })
                  }
                  className="mt-1 w-full rounded border border-line bg-surface px-2 py-1.5 outline-none focus:border-accent"
                >
                  {WINAMAX_TABLE_SIZES.map((label, index) => (
                    <option key={label} value={index}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <Summary>
                {WINAMAX_PERCENT}% · cap{" "}
                <b className="font-medium text-foreground">
                  {winamaxCapEuro.toFixed(2)} €
                </b>{" "}
                ={" "}
                <b className="font-medium text-foreground">
                  {trimNumber(rake.capBB, 1)} bb
                </b>
              </Summary>
            </>
          )}

          {config.platform === "manual" && (
            <div className="mt-2 grid grid-cols-2 gap-2">
              <label className="block">
                <span className="text-muted">Percent</span>
                <input
                  type="number"
                  min={0}
                  max={100}
                  step={0.25}
                  inputMode="decimal"
                  value={config.manualPercent}
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
                  value={config.manualCapBB}
                  onChange={(event) =>
                    patch({ manualCapBB: Number(event.target.value) || 0 })
                  }
                  className="mt-1 w-full rounded border border-line bg-surface px-2 py-1.5 tabular-nums outline-none focus:border-accent"
                />
              </label>
            </div>
          )}

          <p className="mt-3 text-[11px] leading-relaxed text-muted">
            Taken as <span className="font-mono">min(percent × pot, cap)</span> and
            removed from the pot before it pays your call.
          </p>
        </div>
      )}
    </div>
  );
}

function Summary({ children }: { children: ReactNode }) {
  return (
    <p className="mt-2 rounded border border-line bg-background px-2 py-1.5 text-center tabular-nums text-muted">
      {children}
    </p>
  );
}
