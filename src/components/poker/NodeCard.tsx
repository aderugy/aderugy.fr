"use client";

import { cardSuit, SUIT_COLORS, SUIT_SYMBOLS, type Suit } from "@/lib/solver/cards";
import {
  asAction,
  asFlop,
  asStrategy,
  asStreet,
  asText,
  NODE_LABELS,
  type PokerNode,
} from "@/lib/solver/types";
import { NODE_W, NODE_H } from "@/lib/solver/layout";

export function NodeCard({
  node,
  selected,
  hasChildren,
  expanded,
  onSelect,
  onToggle,
}: {
  node: PokerNode;
  selected: boolean;
  hasChildren: boolean;
  expanded: boolean;
  onSelect: () => void;
  onToggle: () => void;
}) {
  return (
    <div
      style={{ width: NODE_W, minHeight: NODE_H }}
      onClick={onSelect}
      className={[
        "flex cursor-pointer flex-col rounded-lg border bg-surface p-2.5 text-left shadow-sm transition-colors",
        selected ? "border-accent ring-1 ring-accent" : "border-line hover:border-accent",
      ].join(" ")}
    >
      <span className="text-[10px] font-semibold uppercase tracking-wide text-muted">
        {NODE_LABELS[node.type]}
      </span>
      <div className="mt-1 min-h-0 flex-1 text-sm">
        <NodeBody node={node} />
      </div>
      {hasChildren && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onToggle();
          }}
          className="mt-1 self-start text-[11px] text-muted hover:text-accent"
        >
          {expanded ? "▾ collapse" : "▸ expand"}
        </button>
      )}
    </div>
  );
}

function NodeBody({ node }: { node: PokerNode }) {
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
      const { actions, position, label } = asStrategy(node);
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
        </span>
      );
    }
    default:
      return null;
  }
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
