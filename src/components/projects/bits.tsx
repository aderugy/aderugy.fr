"use client";

import { useState, type ReactNode } from "react";
import type { Item, StepStatus, Triage, Who } from "@/lib/projects/types";
import { TRIAGES, TRIAGE_LABELS, TRIAGE_SHORT } from "@/lib/projects/types";

export { Section, useAction } from "@/components/jobs/controls";

export const input =
  "w-full rounded border border-line bg-background px-2 py-1.5 text-sm outline-none focus:border-accent";
export const btn =
  "rounded border border-line px-2.5 py-1 text-sm hover:border-accent disabled:opacity-50";
export const btnPrimary = "rounded bg-accent px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50";

/** C / S / L chip. Tapping cycles core → support → logistics → none. */
export function TriageChip({
  triage,
  onChange,
  disabled,
}: {
  triage: Triage | null;
  onChange?: (next: Triage | null) => void;
  disabled?: boolean;
}) {
  const next = (): Triage | null => {
    if (triage === null) return TRIAGES[0];
    const i = TRIAGES.indexOf(triage);
    return i === TRIAGES.length - 1 ? null : TRIAGES[i + 1];
  };
  const tone =
    triage === "core"
      ? "border-accent text-accent"
      : triage === "support"
        ? "border-line text-foreground"
        : triage === "logistics"
          ? "border-line text-muted"
          : "border-dashed border-line text-muted";
  return (
    <button
      type="button"
      disabled={disabled || !onChange}
      onClick={() => onChange?.(next())}
      title={triage ? `${TRIAGE_LABELS[triage]} — toucher pour changer` : "non trié — toucher pour trier"}
      className={`flex h-5 w-5 shrink-0 items-center justify-center rounded border font-mono text-[11px] ${tone}`}
    >
      {triage ? TRIAGE_SHORT[triage] : "·"}
    </button>
  );
}

export function OriginBadge({ origin }: { origin: Who }) {
  return (
    <span
      title={origin === "claude" ? "soulevé par Claude" : "soulevé par Arthur"}
      className={`shrink-0 rounded px-1 font-mono text-[10px] ${
        origin === "claude" ? "bg-accent/15 text-accent" : "bg-line text-muted"
      }`}
    >
      {origin === "claude" ? "C" : "A"}
    </span>
  );
}

/** Roadmap pill: todo hollow, open ringed, done filled with its ratio, cut hatched, dropped struck. */
export function StepPill({
  code,
  status,
  ratio,
  onClick,
}: {
  code: string;
  status: StepStatus;
  ratio: number | null;
  onClick: () => void;
}) {
  const base = "inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 font-mono text-xs";
  const style: Record<StepStatus, string> = {
    todo: "border border-line text-muted",
    open: "border border-accent ring-2 ring-accent/40 text-foreground font-semibold",
    done: "bg-accent/15 text-foreground",
    cut: "border border-line text-foreground",
    dropped: "text-muted line-through opacity-60",
  };
  const hatch =
    status === "cut"
      ? { backgroundImage: "repeating-linear-gradient(135deg, transparent 0 4px, color-mix(in srgb, var(--accent) 22%, transparent) 4px 6px)" }
      : undefined;
  const mark = status === "open" ? "◉" : status === "done" ? "✓" : status === "cut" ? "✂" : status === "dropped" ? "×" : "○";
  return (
    <button type="button" onClick={onClick} className={`${base} ${style[status]}`} style={hatch}>
      <span aria-hidden>{mark}</span>
      {code}
      {ratio !== null && <span className="text-[10px] text-muted">{ratio.toFixed(2)}</span>}
    </button>
  );
}

/** A two-tap destructive button. */
export function ConfirmButton({
  label,
  confirmLabel,
  onConfirm,
  disabled,
  className = "",
}: {
  label: ReactNode;
  confirmLabel: ReactNode;
  onConfirm: () => void;
  disabled?: boolean;
  className?: string;
}) {
  const [armed, setArmed] = useState(false);
  if (!armed) {
    return (
      <button type="button" disabled={disabled} onClick={() => setArmed(true)} className={`text-xs text-muted underline hover:text-red-500 ${className}`}>
        {label}
      </button>
    );
  }
  return (
    <span className={`inline-flex items-center gap-2 text-xs ${className}`}>
      <button type="button" disabled={disabled} onClick={onConfirm} className="font-medium text-red-500 underline">
        {confirmLabel}
      </button>
      <button type="button" onClick={() => setArmed(false)} className="text-muted underline">
        annuler
      </button>
    </span>
  );
}

export function sortItems(items: Item[]): Item[] {
  const rank = { open: 0, done: 1, dropped: 2 } as const;
  return [...items].sort(
    (a, b) => rank[a.status] - rank[b.status] || a.position - b.position || a.created_at.localeCompare(b.created_at),
  );
}
