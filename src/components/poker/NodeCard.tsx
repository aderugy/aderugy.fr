"use client";

import { cardSuit, SUIT_COLORS, SUIT_SYMBOLS, type Suit } from "@/lib/solver/cards";
import {
  asAction,
  asMeta,
  asFlop,
  asStrategy,
  strategyPositionText,
  asStreet,
  asText,
  NODE_LABELS,
  type PokerNode,
  type StrategyWeights,
} from "@/lib/solver/types";
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
  /** Strategy nodes: how many trainers drill this node. */
  trainerCount?: number;
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
        {trainerCount > 0 && (
          <span
            title={`In ${trainerCount} trainer${trainerCount > 1 ? "s" : ""}`}
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
        <NodeBody node={node} mode={mode} weights={weights} dead={dead} frequency={frequency} />
      </div>
      {summary && (
        <p className="mt-1.5 line-clamp-3 whitespace-pre-line text-xs text-muted">{summary}</p>
      )}
    </div>
  );
}

function NodeBody({
  node,
  mode,
  weights,
  dead,
  frequency,
}: {
  node: PokerNode;
  mode: CanvasMode;
  weights?: StrategyWeights | null;
  dead?: Set<string>;
  frequency?: number | null;
}) {
  switch (node.type) {
    case "text": {
      const { title, body } = asText(node);
      return (
        <div>
          <p className="font-medium">{title || "Untitled"}</p>
          {body && <p className="mt-0.5 line-clamp-2 text-xs text-muted">{body}</p>}
        </div>
      );
    }
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
      const position = strategyPositionText(data);
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
            {actions.map((a) => (
              <span
                key={a.id}
                className="flex items-center gap-1 rounded-sm px-1 text-[10px] text-white"
                style={{ backgroundColor: a.color }}
              >
                {a.label}
              </span>
            ))}
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
          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-white"
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
function formatFrequency(pct: number): string {
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
      const position = strategyPositionText(data);
      const text = [position, data.label].filter(Boolean).join(" · ");
      return <span className="truncate font-medium">{text || "Strategy"}</span>;
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
    case "text":
      return <span className="truncate">{asText(node).title || "Note"}</span>;
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
