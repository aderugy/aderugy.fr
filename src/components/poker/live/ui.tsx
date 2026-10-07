"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { DEFAULT_COLOR } from "@/lib/categories";
import { APP_TIMEZONE } from "@/lib/jobs/format";
import type { LiveTag } from "@/lib/live/types";

/** Sessions · Players · Tags, under the poker header. */
export function LiveNav() {
  const path = usePathname();
  const links = [
    { href: "/poker/live", label: "Sessions", active: path === "/poker/live" || /^\/poker\/live\/(?!players|tags)/.test(path) },
    { href: "/poker/live/players", label: "Players", active: path.startsWith("/poker/live/players") },
    { href: "/poker/live/tags", label: "Tags", active: path.startsWith("/poker/live/tags") },
  ];
  return (
    <nav className="flex h-9 shrink-0 items-center gap-4 border-b border-line px-3 text-xs sm:px-5">
      {links.map((l) => (
        <Link
          key={l.href}
          href={l.href}
          className={l.active ? "font-semibold text-foreground" : "text-muted hover:text-foreground"}
        >
          {l.label}
        </Link>
      ))}
    </nav>
  );
}

/**
 * A panel over the page: a bottom sheet on a phone, a centred dialog from
 * `sm` up. Tapping outside or Esc closes it.
 */
export function Sheet({
  open,
  onClose,
  title,
  children,
  wide = false,
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center" role="dialog" aria-modal="true">
      <button type="button" aria-label="Close" onClick={onClose} className="absolute inset-0 bg-black/40" />
      <div
        className={[
          "relative flex max-h-[88dvh] w-full flex-col rounded-t-2xl border border-line bg-background shadow-xl sm:rounded-2xl",
          wide ? "sm:max-w-2xl" : "sm:max-w-md",
        ].join(" ")}
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-line px-4 py-2.5">
          <div className="min-w-0 flex-1 text-sm font-semibold">{title}</div>
          <button type="button" onClick={onClose} className="-mr-1 px-2 text-lg leading-none text-muted hover:text-foreground" aria-label="Close">
            ×
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">{children}</div>
      </div>
    </div>
  );
}

export function TagDots({ tags, max = 4 }: { tags: Pick<LiveTag, "color" | "name">[]; max?: number }) {
  if (!tags.length) return null;
  return (
    <span className="inline-flex items-center gap-0.5" title={tags.map((t) => t.name).join(", ")}>
      {tags.slice(0, max).map((t, i) => (
        <span key={i} className="size-1.5 rounded-full" style={{ backgroundColor: t.color ?? DEFAULT_COLOR }} />
      ))}
    </span>
  );
}

/** Tags of a player as chips to switch on and off. */
export function TagToggles({
  tags,
  active,
  onToggle,
  disabled = false,
}: {
  tags: LiveTag[];
  active: string[];
  onToggle: (tagId: string, on: boolean) => void;
  disabled?: boolean;
}) {
  if (!tags.length) {
    return (
      <p className="text-xs text-muted">
        No tags yet —{" "}
        <Link href="/poker/live/tags" className="underline">
          make some
        </Link>
        .
      </p>
    );
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {tags.map((t) => {
        const on = active.includes(t.id);
        return (
          <button
            key={t.id}
            type="button"
            disabled={disabled}
            aria-pressed={on}
            onClick={() => onToggle(t.id, !on)}
            className={[
              "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs",
              on ? "border-transparent text-white" : "border-line text-muted",
            ].join(" ")}
            style={on ? { backgroundColor: t.color ?? DEFAULT_COLOR } : undefined}
          >
            {!on && <span className="size-1.5 rounded-full" style={{ backgroundColor: t.color ?? DEFAULT_COLOR }} />}
            {t.name}
          </button>
        );
      })}
    </div>
  );
}

/** A big tap target for the bottom bars. */
export function BarButton({
  children,
  onClick,
  tone = "plain",
  disabled = false,
}: {
  children: ReactNode;
  onClick: () => void;
  tone?: "plain" | "accent" | "danger";
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={[
        "flex h-11 min-w-0 flex-1 items-center justify-center rounded-lg px-2 text-sm font-medium transition-colors disabled:opacity-40",
        tone === "accent"
          ? "bg-accent text-white"
          : tone === "danger"
            ? "border border-red-500/40 text-red-600 dark:text-red-400"
            : "border border-line bg-surface",
      ].join(" ")}
    >
      {children}
    </button>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block">
      <span className="text-[11px] font-medium tracking-wide text-muted uppercase">{label}</span>
      <div className="mt-1">{children}</div>
      {hint && <span className="mt-0.5 block text-[11px] text-muted">{hint}</span>}
    </label>
  );
}

export const INPUT =
  "w-full rounded-lg border border-line bg-surface px-3 py-2 text-base outline-none focus:border-accent sm:text-sm";

/** Re-renders every `ms` so running clocks move. */
export function useNow(ms = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

// The app's zone, not the runtime's: server and browser render the same
// text (no hydration mismatch), and it is where the games are.
const TZ = APP_TIMEZONE;

/** "21:42", or "Wed 7 Oct · 21:42" with the day. */
export function fmtClock(iso: string, withDay = false): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: TZ });
  if (!withDay) return time;
  return `${fmtShortDay(iso)} · ${time}`;
}

/** "Wed 7 Oct 2026" */
export function fmtDay(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: TZ });
}

/** "Wed 7 Oct" */
export function fmtShortDay(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: TZ });
}

/** A datetime-local value for an ISO time, in the viewer's zone. */
export function toLocalInput(iso: string | null | undefined): string {
  const d = iso ? new Date(iso) : new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fromLocalInput(v: string): string | null {
  if (!v) return null;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** A signed amount, green or red. `whole` rounds it (rates per hour). */
export function NetText({ value, currency, whole = false }: { value: number | null; currency: string; whole?: boolean }) {
  if (value === null) return <span className="text-muted">—</span>;
  const abs = whole ? Math.round(Math.abs(value)) : Math.abs(value);
  const body = Number.isInteger(abs) ? String(abs) : abs.toFixed(2);
  return (
    <span className={`whitespace-nowrap tabular-nums ${value > 0 ? "text-emerald-600 dark:text-emerald-400" : value < 0 ? "text-red-600 dark:text-red-400" : ""}`}>
      {value > 0 ? "+" : value < 0 ? "−" : ""}
      {body} {currency}
    </span>
  );
}
