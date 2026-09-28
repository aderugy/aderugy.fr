"use client";

import { useState } from "react";
import { NodeNotes } from "@/components/poker/NodeNotes";
import { Segmented } from "@/components/poker/ui";
import { SEATS, isSeat, type Seat } from "@/lib/solver/seats";
import { fmtBb } from "@/lib/solver/gameState";
import {
  STREET_LABELS,
  STREETS,
  setupProblem,
  type NodeType,
  type PokerNode,
  type SpotSetup,
  type Street,
} from "@/lib/solver/types";

/** The id the study layout gives the spot's start (it is not a stored node). */
export const ROOT_ID = "__root__";

export function setupLine(setup: SpotSetup): string {
  const start =
    setup.street === "preflop"
      ? `Preflop · ${fmtBb(setup.stackBb)} bb deep`
      : `${STREET_LABELS[setup.street]} · pot ${setup.potBb ? fmtBb(setup.potBb) : "?"} · ${fmtBb(setup.stackBb)} bb behind`;
  return start;
}

/**
 * Editing the root: the two seats, where the tree starts, pot and stacks,
 * and the root's notes. Numbers save on blur / change; the whole tree's state
 * follows immediately.
 */
export function RootInspector({
  setup,
  childTypes,
  childLabel,
  onChange,
  onAddChild,
  onAddFromPio,
  onClose,
  withNotes = true,
}: {
  setup: SpotSetup;
  childTypes: NodeType[];
  childLabel: (type: NodeType) => string;
  onChange: (setup: SpotSetup) => void;
  onAddChild: (type: NodeType) => void;
  /** Add a flop from a PioSOLVER save (sets the start from it). */
  onAddFromPio?: () => void;
  onClose: () => void;
  /** The notes editor (off when the page edits them inline). */
  withNotes?: boolean;
}) {
  const [pot, setPot] = useState(setup.potBb ? String(setup.potBb) : "");
  const [stack, setStack] = useState(String(setup.stackBb));
  const [seats, setSeats] = useState<[Seat | null, Seat | null]>(setup.players ?? [null, null]);
  const [a, b] = seats;
  const problem = setupProblem(setup);

  // Both seats are kept locally while one is still missing or they clash.
  function setPlayers(x: Seat | null, y: Seat | null) {
    setSeats([x, y]);
    if (x && y && x !== y) onChange({ ...setup, players: [x, y] });
  }

  // NodeNotes edits a node's summary / notes; the root keeps them in the setup.
  const notesNode = {
    id: ROOT_ID,
    data: { summary: setup.summary ?? "", notes: setup.notes ?? "" },
  } as unknown as PokerNode;

  const input =
    "mt-0.5 w-full rounded border border-line bg-background px-2 py-1 text-sm text-foreground outline-none focus:border-accent";

  return (
    <aside className="absolute right-0 top-0 z-20 flex h-full w-80 max-w-full flex-col border-l border-line bg-surface shadow-xl">
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted">Start of the hand</span>
        <button type="button" onClick={onClose} className="ml-auto text-xs text-muted hover:text-foreground">
          Close
        </button>
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3">
        <div>
          <p className="mb-1 text-xs text-muted">Players (heads-up)</p>
          <div className="flex items-center gap-1.5 text-xs">
            <SeatSelect label="First seat" value={a} onChange={(x) => setPlayers(x, b)} />
            <span className="text-muted">vs</span>
            <SeatSelect label="Second seat" value={b} onChange={(y) => setPlayers(a, y)} />
          </div>
          {a && b && a === b && <p className="mt-1 text-[11px] text-red-500">Pick two different seats.</p>}
          <p className="mt-1 text-[11px] text-muted">Who acts at each decision follows from the seats and the action.</p>
        </div>

        <div>
          <p className="mb-1 text-xs text-muted">The tree starts</p>
          <Segmented
            size="sm"
            value={setup.street}
            onChange={(street: Street) => onChange({ ...setup, street })}
            options={STREETS.map((s) => ({ id: s, label: STREET_LABELS[s] }))}
          />
          <p className="mt-1 text-[11px] text-muted">
            {setup.street === "preflop"
              ? "Blinds are posted from the stack; the pot follows the action."
              : `Pot and stacks when the ${setup.street} betting starts. The board is dealt by the first card nodes.`}
          </p>
        </div>

        <div className="grid grid-cols-2 gap-2">
          {setup.street !== "preflop" && (
            <label className="block text-xs text-muted">
              Pot (bb)
              <input
                type="number"
                step="any"
                min="0"
                value={pot}
                onChange={(e) => setPot(e.target.value)}
                onBlur={() => {
                  const n = Number(pot);
                  onChange({ ...setup, potBb: Number.isFinite(n) && n > 0 ? n : null });
                }}
                className={input}
              />
            </label>
          )}
          <label className="block text-xs text-muted">
            {setup.street === "preflop" ? "Stacks (bb)" : "Stack behind (bb)"}
            <input
              type="number"
              step="any"
              min="0"
              value={stack}
              onChange={(e) => setStack(e.target.value)}
              onBlur={() => {
                const n = Number(stack);
                if (Number.isFinite(n) && n > 0) onChange({ ...setup, stackBb: n });
                else setStack(String(setup.stackBb));
              }}
              className={input}
            />
          </label>
        </div>

        {problem && (
          <p className="rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-700 dark:text-amber-400">
            {problem}
          </p>
        )}

        {withNotes && <NodeNotes
          key="root-notes"
          node={notesNode}
          onPatch={(patch) => onChange({ ...setup, ...(patch.summary !== undefined ? { summary: patch.summary } : {}), ...(patch.notes !== undefined ? { notes: patch.notes } : {}) })}
        />}

        <div>
          <p className="mb-1 text-xs font-medium text-muted">Add child</p>
          {onAddFromPio && (
            <button type="button" onClick={onAddFromPio} className="mb-1.5 rounded bg-accent px-2 py-1 text-xs text-white">
              ＋ Flop from a PioSOLVER save
            </button>
          )}
          {childTypes.length === 0 ? (
            <p className="text-[11px] text-muted">{problem ? "Finish the setup first (or add a flop from Pio: it sets the start)." : "Nothing can follow here."}</p>
          ) : (
            <div className="flex flex-wrap gap-1">
              {childTypes.map((type) => (
                <button
                  key={type}
                  type="button"
                  onClick={() => onAddChild(type)}
                  className="rounded border border-line px-2 py-1 text-xs hover:border-accent"
                >
                  ＋ {childLabel(type)}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}

export function SeatSelect({
  label,
  value,
  onChange,
}: {
  label: string;
  value: Seat | null;
  onChange: (seat: Seat | null) => void;
}) {
  return (
    <select
      aria-label={label}
      value={value ?? ""}
      onChange={(e) => onChange(isSeat(e.target.value) ? e.target.value : null)}
      className="rounded border border-line bg-background px-1.5 py-1 text-xs text-foreground outline-none focus:border-accent"
    >
      <option value="">—</option>
      {SEATS.map((seat) => (
        <option key={seat} value={seat}>
          {seat}
        </option>
      ))}
    </select>
  );
}
