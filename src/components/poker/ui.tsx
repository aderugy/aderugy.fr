"use client";

import type { ReactNode } from "react";

/**
 * The "i" that reveals the formula behind a number.
 *
 * Hover opens it, and so does focus — the button is real and keyboard
 * reachable, which is also what makes it work on touch.
 *
 * The wrapper is deliberately unpositioned: the panel then anchors to the
 * nearest positioned ancestor, which is the card, and drops *below* it instead
 * of covering the very number it is explaining. Every caller wraps it in a
 * `relative` container.
 */
export function Hint({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span className="static flex">
      <button
        type="button"
        aria-label={`How ${label} is computed`}
        className="peer size-4 shrink-0 rounded-full border border-line text-[10px] font-semibold leading-[14px] text-muted hover:border-accent hover:text-accent focus:border-accent focus:text-accent focus:outline-none"
      >
        i
      </button>
      <span
        role="tooltip"
        className="pointer-events-none absolute right-2 top-[calc(100%+0.25rem)] z-20 hidden w-64 rounded-lg border border-line bg-surface p-3 text-left text-xs font-normal leading-relaxed text-foreground shadow-lg peer-hover:block peer-focus:block"
      >
        {children}
      </span>
    </span>
  );
}

/** A formula line inside a hint. */
export function Formula({ children }: { children: ReactNode }) {
  return (
    <span className="mt-1.5 block font-mono text-[11px] text-accent">{children}</span>
  );
}

/** The same formula with this hand's numbers in it. */
export function Worked({ children }: { children: ReactNode }) {
  return (
    <span className="mt-1 block font-mono text-[11px] tabular-nums text-muted">
      {children}
    </span>
  );
}

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  size = "md",
}: {
  value: T;
  onChange: (value: T) => void;
  options: { id: T; label: string }[];
  size?: "sm" | "md";
}) {
  return (
    <div className="inline-flex flex-wrap rounded-lg border border-line bg-surface p-0.5">
      {options.map((option) => {
        const active = option.id === value;
        return (
          <button
            key={option.id}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(option.id)}
            className={[
              "rounded-md transition-colors",
              size === "sm" ? "px-2.5 py-1 text-xs" : "px-3 py-1.5 text-sm",
              active
                ? "bg-accent font-medium text-white"
                : "text-muted hover:text-foreground",
            ].join(" ")}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * A labelled number input.
 *
 * The value is kept as the raw string so a half-typed `1.` or an emptied field
 * survives the keystroke instead of snapping back to 0 under the cursor.
 */
export function NumberField({
  label,
  value,
  onChange,
  min = 0,
  max,
  step = 0.5,
  suffix,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
}) {
  return (
    <label className="block rounded-lg border border-line bg-surface px-3 py-2.5 focus-within:border-accent">
      <span className="text-xs text-muted">{label}</span>
      <span className="mt-0.5 flex items-baseline gap-1">
        <input
          type="number"
          inputMode="decimal"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onFocus={(event) => event.currentTarget.select()}
          className="w-full min-w-0 bg-transparent text-2xl font-semibold tabular-nums outline-none"
        />
        {suffix && <span className="text-xs text-muted">{suffix}</span>}
      </span>
    </label>
  );
}

export function ResultCard({
  label,
  value,
  note,
  hint,
  tone = "accent",
}: {
  label: string;
  value: string;
  note: string;
  hint: ReactNode;
  tone?: "accent" | "good" | "muted";
}) {
  const valueColor =
    tone === "good"
      ? "text-emerald-600 dark:text-emerald-400"
      : tone === "muted"
        ? "text-foreground"
        : "text-accent";

  return (
    <div className="relative rounded-lg border border-line bg-surface p-4">
      <div className="flex items-start justify-between gap-2">
        <span className="text-xs text-muted">{label}</span>
        <Hint label={label.toLowerCase()}>{hint}</Hint>
      </div>
      <p className={`mt-1 text-3xl font-semibold tabular-nums ${valueColor}`}>{value}</p>
      <p className="mt-1 text-xs text-muted">{note}</p>
    </div>
  );
}
