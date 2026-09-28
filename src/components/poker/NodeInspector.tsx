"use client";

import { useEffect, useRef, useState } from "react";
import { CardPicker } from "@/components/poker/CardPicker";
import { NodeNotes } from "@/components/poker/NodeNotes";
import { TrainFromHere } from "@/components/poker/trainer/AddToTrainer";
import { BoardCards } from "@/components/poker/trainer/Cards";
import {
  effectiveStack,
  fmtBb,
  stepNode,
  toCall,
  totalPot,
  type HandState,
  type NodeState,
} from "@/lib/solver/gameState";
import {
  asAction,
  asFlop,
  asOverride,
  asStrategy,
  asStreet,
  NODE_LABELS,
  STREET_LABELS,
  type NodeData,
  type NodeType,
  type PioLink,
  type PokerNode,
  type SpotSetup,
} from "@/lib/solver/types";
import { terminalText } from "@/components/poker/format";

export type ImportResult =
  | { ok: true; message: string; warnings: string[] }
  | { ok: false; error: string };

export function NodeInspector({
  node,
  parent,
  dead,
  ns,
  before,
  setup,
  childTypes,
  childLabel,
  onPatch,
  onAddChild,
  onDelete,
  onOpenStrategy,
  onImportCsv,
  onClose,
  withNotes = true,
  pio,
}: {
  node: PokerNode;
  parent: PokerNode | null;
  dead: Set<string>;
  /** The hand after this node (null while the spot isn't set up). */
  ns: NodeState | null;
  /** The hand before this node. */
  before: HandState | null;
  setup: SpotSetup;
  childTypes: NodeType[];
  childLabel: (type: NodeType) => string;
  onPatch: (data: NodeData) => void;
  onAddChild: (type: NodeType) => void;
  onDelete: () => void;
  onOpenStrategy: () => void;
  onImportCsv: (text: string) => Promise<ImportResult>;
  onClose: () => void;
  /** The notes editor (off when the page shows it inline for this node). */
  withNotes?: boolean;
  /** Flop nodes: the PioSOLVER save the line below comes from. */
  pio?: { link: PioLink | null; onLink: () => void };
}) {
  return (
    <aside className="absolute right-0 top-0 z-20 flex h-full w-80 max-w-full flex-col border-l border-line bg-surface shadow-xl">
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted">
          {NODE_LABELS[node.type]}
          {node.type === "strategy" && ns?.actor ? ` · ${ns.actor}` : ""}
        </span>
        <button
          type="button"
          onClick={onClose}
          className="ml-auto text-xs text-muted hover:text-foreground"
        >
          Close
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3">
        {ns && <HandSummary node={node} ns={ns} />}

        <Editor
          node={node}
          parent={parent}
          dead={dead}
          onPatch={onPatch}
          onOpenStrategy={onOpenStrategy}
          onImportCsv={onImportCsv}
        />

        {pio && (
          <div className="rounded border border-line p-2 text-xs">
            <p className="mb-1 font-medium text-muted">PioSOLVER save</p>
            {pio.link ? (
              <p className="break-all text-foreground">{pio.link.file}</p>
            ) : (
              <p className="text-muted">None: link one to import this flop&apos;s decisions from the solver.</p>
            )}
            <button type="button" onClick={pio.onLink} className="mt-1.5 rounded border border-line px-2 py-1 hover:border-accent">
              {pio.link ? "Change…" : "Link a save…"}
            </button>
          </div>
        )}

        {ns && !ns.error && <TrainFromHere node={node} setup={setup} ns={ns} />}

        {before && <OverrideField key={`override-${node.id}`} node={node} parent={parent} before={before} onPatch={onPatch} />}

        {withNotes && <NodeNotes key={`notes-${node.id}`} node={node} onPatch={onPatch} />}

        <div>
          <p className="mb-1 text-xs font-medium text-muted">Add child</p>
          {childTypes.length === 0 ? (
            <p className="text-[11px] text-muted">
              {ns?.error ? "Fix this node first." : ns?.state.terminal ? "The hand is over here." : "Nothing can follow here."}
            </p>
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

      <div className="shrink-0 border-t border-line p-3">
        <button
          type="button"
          onClick={() => {
            if (confirm("Delete this node and everything under it?")) onDelete();
          }}
          className="w-full rounded border border-line px-2 py-1 text-xs text-muted hover:border-red-500 hover:text-red-500"
        >
          Delete node
        </button>
      </div>
    </aside>
  );
}

/** A12: where the hand is at this node — street, board, pot, stacks, who acts — and how it got here. */
function HandSummary({ node, ns }: { node: PokerNode; ns: NodeState }) {
  if (ns.error) {
    return (
      <p className="rounded border border-red-500/40 bg-red-500/10 px-2 py-1.5 text-[11px] text-red-500">{ns.error}</p>
    );
  }
  const s = ns.state;
  const who = node.type === "strategy" ? ns.actor : s.toAct;
  const call = who ? toCall(s, who) : 0;
  return (
    <div className="space-y-1.5 rounded border border-line bg-background/50 px-2 py-1.5 text-[11px]">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-medium">{STREET_LABELS[s.street]}</span>
        {s.board.length > 0 && <BoardCards cards={s.board} size="xs" />}
        <span className="tabular-nums text-muted">
          Pot {fmtBb(totalPot(s))} · Eff. {fmtBb(effectiveStack(s))}
        </span>
      </div>
      <p className="text-muted">
        {s.terminal
          ? terminalText(s.terminal)
          : s.status === "deal"
            ? `Round closed — the ${s.nextStreet} comes next`
            : `${who} to act${call > 0 ? ` · ${fmtBb(call)} to call` : " · nothing to call"}`}
      </p>
      {s.log.length > 0 && <p className="leading-relaxed text-muted">{lineText(s)}</p>}
    </div>
  );
}

/** `BTN 2.5 · BB call · [Ks7d2c] BB x · BTN 1.82 · BB call` */
function lineText(s: HandState): string {
  const parts: string[] = [];
  let street = s.log[0]?.street;
  const boardAt: Record<string, string> = {
    flop: s.board.slice(0, 3).join(""),
    turn: s.board[3] ?? "",
    river: s.board[4] ?? "",
  };
  for (const e of s.log) {
    if (e.street !== street) {
      street = e.street;
      if (boardAt[street]) parts.push(`[${boardAt[street]}]`);
    }
    const amount = e.amountBb != null && e.kind !== "call" ? ` ${fmtBb(e.amountBb)}` : "";
    parts.push(`${e.seat} ${e.kind}${amount}`);
  }
  return parts.join(" · ");
}

/**
 * A5: force the pot and stacks here when the tree can't give them (a bet
 * without size, a skipped part of the tree). The reconstructed values stay
 * visible next to the forced ones.
 */
function OverrideField({
  node,
  parent,
  before,
  onPatch,
}: {
  node: PokerNode;
  parent: PokerNode | null;
  before: HandState;
  onPatch: (data: NodeData) => void;
}) {
  const current = asOverride(node);
  const step = stepNode(before, node, parent);
  const rebuilt = step.error ? null : step.state;
  const [on, setOn] = useState(!!current);
  const [pot, setPot] = useState(String(current?.potBb ?? (rebuilt ? Math.round(totalPot(rebuilt) * 100) / 100 : "")));
  const [stack, setStack] = useState(
    String(current?.stackBb ?? (rebuilt ? Math.round(effectiveStack(rebuilt) * 100) / 100 : "")),
  );

  function save(p: string, st: string) {
    const potBb = Number(p);
    const stackBb = Number(st);
    if (Number.isFinite(potBb) && potBb > 0 && Number.isFinite(stackBb) && stackBb >= 0) {
      onPatch({ override: { potBb, stackBb } });
    }
  }

  const input =
    "mt-0.5 w-full rounded border border-line bg-background px-2 py-1 text-sm text-foreground outline-none focus:border-accent";

  return (
    <div className="rounded border border-line p-2">
      <label className="flex items-center gap-2 text-xs">
        <input
          type="checkbox"
          checked={on}
          onChange={(e) => {
            setOn(e.target.checked);
            if (e.target.checked) save(pot, stack);
            else onPatch({ override: null });
          }}
        />
        Set pot &amp; stack by hand here
      </label>
      {on && (
        <div className="mt-2 space-y-1">
          <div className="grid grid-cols-2 gap-2">
            <label className="block text-[11px] text-muted">
              Pot (bb, bets in)
              <input type="number" step="any" min="0" value={pot} onChange={(e) => setPot(e.target.value)} onBlur={() => save(pot, stack)} className={input} />
            </label>
            <label className="block text-[11px] text-muted">
              Stack behind (bb)
              <input type="number" step="any" min="0" value={stack} onChange={(e) => setStack(e.target.value)} onBlur={() => save(pot, stack)} className={input} />
            </label>
          </div>
          {rebuilt && (
            <p className="text-[11px] tabular-nums text-muted">
              From the action: pot {fmtBb(totalPot(rebuilt))} · stack {fmtBb(effectiveStack(rebuilt))}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function Editor({
  node,
  parent,
  dead,
  onPatch,
  onOpenStrategy,
  onImportCsv,
}: {
  node: PokerNode;
  parent: PokerNode | null;
  dead: Set<string>;
  onPatch: (data: NodeData) => void;
  onOpenStrategy: () => void;
  onImportCsv: (text: string) => Promise<ImportResult>;
}) {
  switch (node.type) {
    case "flop":
      return (
        <div>
          <p className="mb-1 text-xs font-medium text-muted">Flop cards</p>
          <CardPicker
            count={3}
            selected={asFlop(node).cards}
            dead={dead}
            onChange={(cards) => onPatch({ cards })}
          />
        </div>
      );
    case "turn":
    case "river":
      return (
        <div>
          <p className="mb-1 text-xs font-medium text-muted">{NODE_LABELS[node.type]} card</p>
          <CardPicker
            count={1}
            selected={asStreet(node).card ? [asStreet(node).card as string] : []}
            dead={dead}
            onChange={(cards) => onPatch({ card: cards[0] ?? null })}
          />
        </div>
      );
    case "strategy":
      return (
        <StrategyMeta
          key={node.id}
          node={node}
          onPatch={onPatch}
          onOpenStrategy={onOpenStrategy}
          onImportCsv={onImportCsv}
        />
      );
    case "action":
      return <ActionEditor key={node.id} node={node} parent={parent} onPatch={onPatch} />;
    default:
      return null;
  }
}

function StrategyMeta({
  node,
  onPatch,
  onOpenStrategy,
  onImportCsv,
}: {
  node: PokerNode;
  onPatch: (data: NodeData) => void;
  onOpenStrategy: () => void;
  onImportCsv: (text: string) => Promise<ImportResult>;
}) {
  const data = asStrategy(node);
  const [label, setLabel] = useState(data.label ?? "");
  const fileRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);

  async function runImport(text: string) {
    setImporting(true);
    setImportResult(null);
    try {
      setImportResult(await onImportCsv(text));
    } finally {
      setImporting(false);
    }
  }

  async function handleFile(file: File) {
    await runImport(await file.text());
  }

  async function pasteFromClipboard() {
    let text: string;
    try {
      text = await navigator.clipboard.readText();
    } catch {
      setImportResult({ ok: false, error: "Clipboard access blocked — press Ctrl+V instead" });
      return;
    }
    await runImport(text);
  }

  // Ctrl+V anywhere (outside a text field) while this strategy is selected
  // imports the clipboard as CSV.
  const runImportRef = useRef(runImport);
  useEffect(() => {
    runImportRef.current = runImport;
  });
  useEffect(() => {
    function onPaste(e: ClipboardEvent) {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      const text = e.clipboardData?.getData("text/plain") ?? "";
      if (!text.trim()) return;
      e.preventDefault();
      void runImportRef.current(text);
    }
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, []);

  return (
    <div className="space-y-3">
      <label className="block text-xs text-muted">
        Label
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          onBlur={() => onPatch({ ...data, label: label.trim() || undefined })}
          placeholder="e.g. c-bet decision"
          className="mt-0.5 w-full rounded border border-line bg-background px-2 py-1 text-sm text-foreground outline-none focus:border-accent"
        />
      </label>
      <div>
        <p className="mb-1 text-xs text-muted">Actions</p>
        <div className="flex flex-wrap gap-1">
          {data.actions.map((a) => (
            <span
              key={a.id}
              className="rounded px-1.5 py-0.5 text-[11px] text-white"
              style={{ backgroundColor: a.color }}
            >
              {a.label}
            </span>
          ))}
          {data.actions.length === 0 && <span className="text-xs text-muted">none</span>}
        </div>
      </div>
      <button
        type="button"
        onClick={onOpenStrategy}
        className="w-full rounded bg-accent px-3 py-2 text-sm text-white"
      >
        Edit strategy grid
      </button>
      <div>
        <input
          ref={fileRef}
          type="file"
          accept=".csv,.tsv,.txt,text/csv"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = ""; // allow re-importing the same file
            if (file) void handleFile(file);
          }}
        />
        <div className="flex gap-1">
          <button
            type="button"
            disabled={importing}
            onClick={() => fileRef.current?.click()}
            className="flex-1 rounded border border-line px-3 py-1.5 text-xs hover:border-accent disabled:opacity-50"
          >
            {importing ? "Importing…" : "Import CSV…"}
          </button>
          <button
            type="button"
            disabled={importing}
            onClick={() => void pasteFromClipboard()}
            className="flex-1 rounded border border-line px-3 py-1.5 text-xs hover:border-accent disabled:opacity-50"
          >
            Paste CSV
          </button>
        </div>
        <p className="mt-1 text-[11px] text-muted">
          Or press <kbd>Ctrl</kbd>+<kbd>V</kbd> with this strategy selected. Header row <code>Hand,RAISE 180,CALL,FOLD…</code> sets the actions and creates one
          action node each; rows are combos (<code>4c3c</code>) or hands (<code>AKs</code>). Bare sizes are NL1000
          chips (<code>BET 45</code> = 4.5bb); <code>33%</code> or <code>18bb</code> are read as written.
        </p>
        {importResult && (
          <div
            className={[
              "mt-2 rounded border px-2 py-1.5 text-[11px]",
              importResult.ok
                ? "border-line text-muted"
                : "border-red-500/40 bg-red-500/10 text-red-500",
            ].join(" ")}
          >
            {importResult.ok ? importResult.message : importResult.error}
            {importResult.ok &&
              importResult.warnings.map((w) => (
                <div key={w} className="text-amber-600">
                  {w}
                </div>
              ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ActionEditor({
  node,
  parent,
  onPatch,
}: {
  node: PokerNode;
  parent: PokerNode | null;
  onPatch: (data: NodeData) => void;
}) {
  const data = asAction(node);

  // Linked: an action under a strategy picks from that strategy's action set.
  if (parent && parent.type === "strategy") {
    const actions = asStrategy(parent).actions;
    return (
      <div className="space-y-2">
        <label className="block text-xs text-muted">
          Represents which action
          <select
            value={data.strategyActionId ?? ""}
            onChange={(e) => {
              const chosen = actions.find((a) => a.id === e.target.value);
              if (!chosen) return;
              onPatch({
                strategyActionId: chosen.id,
                kind: chosen.kind,
                sizePct: chosen.sizePct ?? null,
                sizeUnit: chosen.sizeUnit ?? null,
                label: chosen.label,
                color: chosen.color,
              });
            }}
            className="mt-0.5 w-full rounded border border-line bg-background px-2 py-1 text-sm text-foreground outline-none focus:border-accent"
          >
            <option value="" disabled>
              Choose an action
            </option>
            {actions.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </select>
        </label>
        <p className="text-xs text-muted">
          One of the decision&apos;s options. Edit sizings in its grid editor.
        </p>
      </div>
    );
  }

  // Not under a decision: the tree walk flags it; nothing to edit here.
  return (
    <p className="text-xs text-muted">
      {data.label} — an action must hang from a decision node to be part of the hand.
    </p>
  );
}
