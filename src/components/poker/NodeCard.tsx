"use client";

import { cardSuit, SUIT_COLORS, SUIT_SYMBOLS, type Suit } from "@/lib/solver/cards";
import {
  asAction,
  asMeta,
  asFlop,
  asStrategy,
  asStreet,
  NODE_LABELS,
  type PokerNode,
  type StrategyWeights,
} from "@/lib/solver/types";
import { effectiveStack, fmtBb, toCall, totalPot, type NodeState, type Terminal } from "@/lib/solver/gameState";
import { NODE_W, NODE_H } from "@/lib/solver/layout";
import { StrategyGrid } from "@/components/poker/StrategyGrid";

export type CanvasMode = "edit" | "revision";

export function NodeCard({
  node,
  mode,
  selected,
  hasChildren,
  expanded,
  weights,
  dead,
  frequency,
  onSelect,
  onToggle,
  trainerCount = 0,
  ns,
  developed,
  onDevelop,
}: {
  node: PokerNode;
  mode: CanvasMode;
  selected: boolean;
  hasChildren: boolean;
  expanded: boolean;
  weights?: StrategyWeights | null;
  dead?: Set<string>;
  /** Action nodes: global frequency (%) of the action in its parent strategy. */
  frequency?: number | null;
  /** How many trainers start hands at this node. */
  trainerCount?: number;
  /** The hand's state after this node (null while the spot isn't set up). */
  ns?: NodeState | null;
  /** Decision nodes: ids of the options that already have a branch. */
  developed?: Set<string>;
  /** Decision nodes, edit mode: grow a branch for an undeveloped option. */
  onDevelop?: (actionId: string) => void;
  onSelect: () => void;
  onToggle: () => void;
}) {
  const { summary, notes } = asMeta(node);
  return (
    <div
      style={{ width: NODE_W, minHeight: NODE_H }}
      onClick={onSelect}
      className={[
        "flex cursor-pointer flex-col rounded-lg border bg-surface p-2.5 text-left shadow-sm transition-colors",
        selected ? "border-accent ring-1 ring-accent" : "border-line hover:border-accent",
      ].join(" ")}
    >
      <div className="flex items-center gap-1">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-muted">
          {NODE_LABELS[node.type]}
        </span>
        {notes.trim() && (
          <span title="Has notes" className="text-muted">
            <NotesIcon />
          </span>
        )}
        {ns?.overridden && (
          <span title="Pot and stack set by hand here" className="rounded bg-amber-500/15 px-1 text-[10px] font-medium text-amber-700 dark:text-amber-400">
            manual
          </span>
        )}
        {trainerCount > 0 && (
          <span
            title={`Hands start here in ${trainerCount} trainer${trainerCount > 1 ? "s" : ""}`}
            className="rounded bg-accent/10 px-1 text-[10px] font-medium text-accent"
          >
            ▶ {trainerCount}
          </span>
        )}
        {hasChildren && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onToggle();
            }}
            title={expanded ? "Collapse children" : "Expand children"}
            className="-m-1 ml-auto rounded p-1 text-muted hover:bg-background hover:text-accent"
          >
            <EyeIcon open={expanded} />
          </button>
        )}
      </div>
      <div className="mt-1 min-h-0 flex-1 text-sm">
        <NodeBody
          node={node}
          mode={mode}
          weights={weights}
          dead={dead}
          frequency={frequency}
          ns={ns}
          developed={developed}
          onDevelop={onDevelop}
        />
      </div>
      {summary && (
        <p className="mt-1.5 line-clamp-3 whitespace-pre-line text-xs text-muted">{summary}</p>
      )}
      {ns && <StateLine node={node} ns={ns} />}
    </div>
  );
}

/**
 * The hand at this node in one line: who acts and what it costs on a
 * decision, the pot and stacks on a card, how the hand ended on the action
 * that ends it, or why the node can't happen.
 */
function StateLine({ node, ns }: { node: PokerNode; ns: NodeState }) {
  if (ns.error) {
    return <p className="mt-1.5 line-clamp-2 text-[11px] text-red-500">⚠ {ns.error}</p>;
  }
  const s = ns.state;
  if (node.type === "strategy") {
    const call = ns.actor ? toCall(s, ns.actor) : 0;
    return (
      <p className="mt-1.5 text-[11px] tabular-nums text-muted">
        <b className="text-foreground">{ns.actor}</b> to act{call > 0 ? ` · ${fmtBb(call)} to call` : ""} · pot {fmtBb(totalPot(s))}
      </p>
    );
  }
  if (s.terminal) return <TerminalBadge terminal={s.terminal} />;
  if (node.type === "action") {
    const last = s.log[s.log.length - 1];
    const put = last && last.amountBb != null && last.kind !== "call" ? ` to ${fmtBb(last.amountBb)}` : "";
    return (
      <p className="mt-1.5 text-[11px] tabular-nums text-muted">
        <b className="text-foreground">{last?.seat}</b>
        {put}
        {s.status === "deal" ? " · round closed" : ""} · pot {fmtBb(totalPot(s))}
      </p>
    );
  }
  return (
    <p className="mt-1.5 text-[11px] tabular-nums text-muted">
      Pot {fmtBb(totalPot(s))} · Eff. {fmtBb(effectiveStack(s))}
    </p>
  );
}

export function terminalText(t: Terminal): string {
  switch (t.kind) {
    case "fold":
      return `Hand over — ${t.winner} wins ${fmtBb(t.potBb)} bb`;
    case "showdown":
      return `Showdown · pot ${fmtBb(t.potBb)} bb`;
    case "allin":
      return `All-in — runout · pot ${fmtBb(t.potBb)} bb`;
  }
}

function TerminalBadge({ terminal }: { terminal: Terminal }) {
  return (
    <p className="mt-1.5 rounded bg-foreground/5 px-1.5 py-0.5 text-[11px] font-medium tabular-nums">
      ■ {terminalText(terminal)}
    </p>
  );
}

function NodeBody({
  node,
  mode,
  weights,
  dead,
  frequency,
  ns,
  developed,
  onDevelop,
}: {
  node: PokerNode;
  mode: CanvasMode;
  weights?: StrategyWeights | null;
  dead?: Set<string>;
  frequency?: number | null;
  ns?: NodeState | null;
  developed?: Set<string>;
  onDevelop?: (actionId: string) => void;
}) {
  switch (node.type) {
    case "flop": {
      const { cards } = asFlop(node);
      return <Cards cards={cards} placeholder="Pick 3 cards" />;
    }
    case "turn":
    case "river": {
      const { card } = asStreet(node);
      return <Cards cards={card ? [card] : []} placeholder="Pick a card" />;
    }
    case "strategy": {
      const data = asStrategy(node);
      const { actions, label } = data;
      const position = ns?.actor ?? null;
      // Revision mode: show a tiny live grid preview instead of the chips.
      if (mode === "revision" && weights && actions.length > 0) {
        return (
          <div>
            {(label || position) && (
              <p className="mb-1 truncate text-xs text-muted">
                {label}
                {label && position ? " · " : ""}
                {position}
              </p>
            )}
            <div className="mx-auto w-28">
              <StrategyGrid
                actions={actions}
                weights={weights}
                dead={dead ?? new Set()}
                variant="mini"
              />
            </div>
          </div>
        );
      }
      return (
        <div>
          {(label || position) && (
            <p className="text-xs text-muted">
              {label}
              {label && position ? " · " : ""}
              {position}
            </p>
          )}
          <div className="mt-1 flex flex-wrap gap-1">
            {actions.map((a) => {
              const open = developed && !developed.has(a.id);
              if (open && onDevelop && mode === "edit") {
                // A11: an option with no branch yet, one click grows it.
                return (
                  <button
                    key={a.id}
                    type="button"
                    title="Not developed — click to add its branch"
                    onClick={(e) => {
                      e.stopPropagation();
                      onDevelop(a.id);
                    }}
                    className="flex items-center gap-1 rounded-sm border border-dashed px-1 text-[10px] hover:bg-background"
                    style={{ borderColor: a.color, color: a.color }}
                  >
                    ＋ {a.label}
                  </button>
                );
              }
              return (
                <span
                  key={a.id}
                  className={[
                    "flex items-center gap-1 rounded-sm px-1 text-[10px] text-white",
                    open ? "opacity-50" : "",
                  ].join(" ")}
                  style={{ backgroundColor: a.color }}
                >
                  {a.label}
                </span>
              );
            })}
            {actions.length === 0 && (
              <span className="text-xs text-muted">No actions yet</span>
            )}
          </div>
        </div>
      );
    }
    case "action": {
      const a = asAction(node);
      return (
        <span
          className="inline-flex items-center gap-1 whitespace-nowrap rounded px-1.5 py-0.5 text-xs text-white"
          style={{ backgroundColor: a.color }}
        >
          {a.label}
          {frequency != null && (
            <span className="tabular-nums opacity-90">· {formatFrequency(frequency)}</span>
          )}
        </span>
      );
    }
    default:
      return null;
  }
}

/** 51.25 → "51.3%", 0.4 → "0.40%": keep two significant-ish digits for small values. */
export function formatFrequency(pct: number): string {
  if (pct <= 0) return "0%";
  return `${pct < 1 ? pct.toFixed(2) : pct.toFixed(1)}%`;
}

/**
 * A collapsed child, shrunk to its essentials: the action for an action node,
 * position + name for a strategy, the card(s) for a street, the title for a
 * note. Clicking it expands the parent.
 */
export function MiniNodeCard({ node, onClick }: { node: PokerNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title="Expand"
      className="flex max-w-[150px] items-center gap-1 rounded-md border border-line bg-surface px-1.5 py-1 text-[10px] leading-none shadow-sm hover:border-accent"
    >
      <MiniBody node={node} />
    </button>
  );
}

function MiniBody({ node }: { node: PokerNode }) {
  switch (node.type) {
    case "action": {
      const a = asAction(node);
      return (
        <span className="truncate rounded-sm px-1 py-0.5 text-white" style={{ backgroundColor: a.color }}>
          {a.label}
        </span>
      );
    }
    case "strategy": {
      const data = asStrategy(node);
      return <span className="truncate font-medium">{data.label || "Decision"}</span>;
    }
    case "flop": {
      const { cards } = asFlop(node);
      return cards.length ? <MiniCards cards={cards} /> : <span className="text-muted">Flop</span>;
    }
    case "turn":
    case "river": {
      const { card } = asStreet(node);
      return card ? <MiniCards cards={[card]} /> : <span className="text-muted">{NODE_LABELS[node.type]}</span>;
    }
    default:
      return <span className="text-muted">{NODE_LABELS[node.type]}</span>;
  }
}

function MiniCards({ cards }: { cards: string[] }) {
  return (
    <span className="flex gap-0.5">
      {cards.map((card) => {
        const suit = cardSuit(card) as Suit;
        return (
          <span
            key={card}
            className="rounded-sm border border-line bg-background px-0.5 py-px font-semibold"
            style={{ color: SUIT_COLORS[suit] }}
          >
            {card[0]}
            {SUIT_SYMBOLS[suit]}
          </span>
        );
      })}
    </span>
  );
}

function EyeIcon({ open }: { open: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
      <circle cx="12" cy="12" r="3" />
      {!open && <path d="M3 3l18 18" />}
    </svg>
  );
}

function NotesIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
      <path d="M14 3v6h6M8 13h8M8 17h5" />
    </svg>
  );
}

function Cards({ cards, placeholder }: { cards: string[]; placeholder: string }) {
  if (cards.length === 0) {
    return <span className="text-xs text-muted">{placeholder}</span>;
  }
  return (
    <div className="flex gap-1">
      {cards.map((card) => {
        const suit = cardSuit(card) as Suit;
        return (
          <span
            key={card}
            className="flex h-7 w-6 items-center justify-center rounded border border-line bg-background text-xs font-semibold"
            style={{ color: SUIT_COLORS[suit] }}
          >
            {card[0]}
            {SUIT_SYMBOLS[suit]}
          </span>
        );
      })}
    </div>
  );
}
