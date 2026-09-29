"use client";

import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { DECK, RANKS, SUITS } from "@/lib/solver/cards";
import { pioBridge, PioBridgeError, type PioFileEntry } from "@/lib/solver/pioBridge";
import { PlayingCard } from "@/components/poker/trainer/Cards";

/** A centred dialog over the page. */
export function Modal({
  title,
  onClose,
  children,
  footer,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4" onPointerDown={onClose}>
      <div
        role="dialog"
        aria-label={title}
        onPointerDown={(e) => e.stopPropagation()}
        className={`flex max-h-[90dvh] w-full flex-col overflow-hidden rounded-t-xl border border-line bg-surface shadow-xl sm:rounded-xl ${wide ? "sm:max-w-2xl" : "sm:max-w-lg"}`}
      >
        <div className="flex shrink-0 items-center gap-3 border-b border-line px-4 py-2.5">
          <h2 className="truncate text-sm font-semibold">{title}</h2>
          <button type="button" onClick={onClose} className="ml-auto text-xs text-muted hover:text-foreground">
            Close
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
        {footer && <div className="shrink-0 border-t border-line px-4 py-2.5">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

/**
 * Browse the solves folder through PioBridge and pick a `.cfr`. Starts in the
 * folder of `near` (a save already used in this spot) when given.
 */
export function PioFilePicker({
  title = "Pick a PioSOLVER save",
  near,
  onPick,
  onClose,
  children,
}: {
  /** Shown above the file list (e.g. a name field). */
  children?: React.ReactNode;
  title?: string;
  near?: string | null;
  onPick: (path: string) => void;
  onClose: () => void;
}) {
  const [dir, setDir] = useState(() => (near ? near.split("/").slice(0, -1).join("/") : ""));
  const [entries, setEntries] = useState<PioFileEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    pioBridge
      .files(dir)
      .then((r) => {
        if (cancelled) return;
        setEntries(r.entries);
        setError(null);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setEntries([]);
        setError(e instanceof PioBridgeError ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [dir]);

  const crumbs = dir ? dir.split("/") : [];
  return (
    <Modal title={title} onClose={onClose}>
      {children}
      <nav className="mb-3 flex flex-wrap items-center gap-1 text-xs">
        <button type="button" onClick={() => setDir("")} className="rounded px-1 text-muted hover:bg-background hover:text-foreground">
          Solves
        </button>
        {crumbs.map((c, i) => (
          <span key={i} className="flex items-center gap-1">
            <span className="text-muted/60">/</span>
            <button
              type="button"
              onClick={() => setDir(crumbs.slice(0, i + 1).join("/"))}
              className="rounded px-1 text-muted hover:bg-background hover:text-foreground"
            >
              {c}
            </button>
          </span>
        ))}
      </nav>
      {error && <p className="mb-3 rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-500">{error}</p>}
      {entries === null ? (
        <p className="text-sm text-muted">Asking PioBridge…</p>
      ) : entries.length === 0 && !error ? (
        <p className="text-sm text-muted">Nothing here.</p>
      ) : (
        <ul className="divide-y divide-line rounded-md border border-line">
          {entries.map((e) => (
            <li key={e.path}>
              <button
                type="button"
                onClick={() => (e.kind === "dir" ? setDir(e.path) : onPick(e.path))}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-background"
              >
                <span className="w-4 text-center text-muted">{e.kind === "dir" ? "▸" : "♠"}</span>
                <span className="min-w-0 flex-1 truncate">{e.name}</span>
                {e.kind === "cfr" && e.size != null && (
                  <span className="text-[11px] tabular-nums text-muted">{Math.round(e.size / 1e6)} MB</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

/**
 * Choose the runouts to import: the cards the solver has below this line
 * (every other card is disabled), several at once.
 */
export function RunoutPicker({
  street,
  available,
  existing,
  onPick,
  onClose,
}: {
  street: "turn" | "river";
  /** Cards the save holds below this node. */
  available: string[];
  /** Cards already in the tree here. */
  existing: string[];
  onPick: (cards: string[]) => void;
  onClose: () => void;
}) {
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const can = new Set(available.filter((c) => !existing.includes(c)));
  const toggle = (c: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(c)) next.delete(c);
      else next.add(c);
      return next;
    });
  return (
    <Modal
      title={`Import ${street} cards from Pio`}
      onClose={onClose}
      wide
      footer={
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => setPicked(new Set(can))} className="text-xs text-muted hover:text-foreground">
            All {can.size}
          </button>
          <button type="button" onClick={() => setPicked(new Set())} className="text-xs text-muted hover:text-foreground">
            None
          </button>
          <button
            type="button"
            disabled={picked.size === 0}
            onClick={() => onPick(DECK.filter((c) => picked.has(c)))}
            className="ml-auto rounded bg-accent px-3 py-1.5 text-sm text-white disabled:opacity-40"
          >
            Import {picked.size || ""} {picked.size === 1 ? "card" : "cards"}
          </button>
        </div>
      }
    >
      <div className="grid grid-cols-4 gap-2 sm:grid-cols-[repeat(13,minmax(0,1fr))] sm:gap-1">
        {SUITS.map((s) =>
          RANKS.map((r) => {
            const c = `${r}${s}`;
            const done = existing.includes(c);
            const ok = can.has(c);
            return (
              <button
                key={c}
                type="button"
                disabled={!ok}
                onClick={() => toggle(c)}
                title={done ? "Already in the tree" : ok ? c : "Not in the save"}
                className={[
                  "flex justify-center rounded-md border p-0.5 transition-colors",
                  picked.has(c) ? "border-accent bg-accent/15" : "border-transparent",
                  ok ? "hover:border-accent" : done ? "opacity-60" : "opacity-20",
                ].join(" ")}
              >
                <PlayingCard card={c} size="sm" />
              </button>
            );
          }),
        )}
      </div>
      {existing.length > 0 && <p className="mt-3 text-[11px] text-muted">Faded cards are already in the tree.</p>}
    </Modal>
  );
}

/**
 * A new solution of the spot from a node: its name, then the save it comes
 * from (a node-locked re-solve of the flop, a turn solved on its own…).
 */
export function SolutionDialog({
  near,
  onPick,
  onClose,
}: {
  near?: string | null;
  onPick: (name: string, file: string) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  return (
    <PioFilePicker
      title="Add a solution from here"
      near={near}
      onClose={onClose}
      onPick={(file) => onPick(name.trim() || (file.split("/").pop() ?? file).replace(/\.cfr$/i, ""), file)}
    >
      <label className="mb-3 block text-xs">
        <span className="text-muted">Name (e.g. “Nodelock BTN cbet”, “Turn 2 sizes”) — the save&apos;s name if left empty</span>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="mt-1 w-full rounded-md border border-line bg-surface px-2 py-1.5 text-sm outline-none focus:border-accent"
          placeholder="Solution name"
        />
      </label>
      <p className="mb-2 text-[11px] text-muted">Then pick its save: one of the whole flop (same line is used) or one starting at this node.</p>
    </PioFilePicker>
  );
}
