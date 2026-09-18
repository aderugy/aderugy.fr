"use client";

import { useEffect, useRef, useState } from "react";
import { PALETTE } from "@/lib/categories";
import { CardPicker } from "@/components/poker/CardPicker";
import { Segmented } from "@/components/poker/ui";
import {
  ACTION_KIND_LABELS,
  ACTION_KINDS,
  asAction,
  asFlop,
  asStrategy,
  asStreet,
  asText,
  kindHasSize,
  NODE_LABELS,
  type ActionKind,
  type NodeData,
  type NodeType,
  type PokerNode,
} from "@/lib/solver/types";

export type ImportResult =
  | { ok: true; message: string; warnings: string[] }
  | { ok: false; error: string };

export function NodeInspector({
  node,
  parent,
  dead,
  childSuggestions,
  onPatch,
  onAddChild,
  onDelete,
  onOpenStrategy,
  onImportCsv,
  onClose,
}: {
  node: PokerNode;
  parent: PokerNode | null;
  dead: Set<string>;
  childSuggestions: NodeType[];
  onPatch: (data: NodeData) => void;
  onAddChild: (type: NodeType) => void;
  onDelete: () => void;
  onOpenStrategy: () => void;
  onImportCsv: (text: string) => Promise<ImportResult>;
  onClose: () => void;
}) {
  return (
    <aside className="absolute right-0 top-0 z-20 flex h-full w-80 max-w-full flex-col border-l border-line bg-surface shadow-xl">
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted">
          {NODE_LABELS[node.type]}
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
        <Editor
          node={node}
          parent={parent}
          dead={dead}
          onPatch={onPatch}
          onOpenStrategy={onOpenStrategy}
          onImportCsv={onImportCsv}
        />

        <div>
          <p className="mb-1 text-xs font-medium text-muted">Add child</p>
          <div className="flex flex-wrap gap-1">
            {childSuggestions.map((type) => (
              <button
                key={type}
                type="button"
                onClick={() => onAddChild(type)}
                className="rounded border border-line px-2 py-1 text-xs hover:border-accent"
              >
                ＋ {NODE_LABELS[type]}
              </button>
            ))}
          </div>
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
    case "text":
      return <TextEditor key={node.id} node={node} onPatch={onPatch} />;
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

function TextEditor({ node, onPatch }: { node: PokerNode; onPatch: (data: NodeData) => void }) {
  const initial = asText(node);
  const [title, setTitle] = useState(initial.title);
  const [body, setBody] = useState(initial.body);

  return (
    <div className="space-y-2">
      <label className="block text-xs text-muted">
        Title
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => onPatch({ title, body })}
          className="mt-0.5 w-full rounded border border-line bg-background px-2 py-1 text-sm text-foreground outline-none focus:border-accent"
        />
      </label>
      <label className="block text-xs text-muted">
        Notes
        <textarea
          value={body}
          rows={5}
          onChange={(e) => setBody(e.target.value)}
          onBlur={() => onPatch({ title, body })}
          className="mt-0.5 w-full resize-y rounded border border-line bg-background px-2 py-1 text-sm text-foreground outline-none focus:border-accent"
        />
      </label>
    </div>
  );
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
        <p className="mb-1 text-xs text-muted">Position</p>
        <Segmented
          size="sm"
          value={data.position ?? "none"}
          onChange={(v) => onPatch({ ...data, position: v === "none" ? null : (v as "OOP" | "IP") })}
          options={[
            { id: "none", label: "—" },
            { id: "OOP", label: "OOP" },
            { id: "IP", label: "IP" },
          ]}
        />
      </div>
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
          action node each; rows are combos (<code>4c3c</code>) or hands (<code>AKs</code>).
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
  const [label, setLabel] = useState(data.label);

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
          Linked to the parent strategy&apos;s action set. Edit sizings there.
        </p>
      </div>
    );
  }

  // Free-form action (parent is not a strategy).
  return (
    <div className="space-y-2">
      <label className="block text-xs text-muted">
        Label
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          onBlur={() => onPatch({ ...data, label: label.trim() || "Action" })}
          className="mt-0.5 w-full rounded border border-line bg-background px-2 py-1 text-sm text-foreground outline-none focus:border-accent"
        />
      </label>
      <label className="block text-xs text-muted">
        Kind
        <select
          value={data.kind}
          onChange={(e) => onPatch({ ...data, kind: e.target.value as ActionKind })}
          className="mt-0.5 w-full rounded border border-line bg-background px-2 py-1 text-sm text-foreground outline-none focus:border-accent"
        >
          {ACTION_KINDS.map((k) => (
            <option key={k} value={k}>
              {ACTION_KIND_LABELS[k]}
            </option>
          ))}
        </select>
      </label>
      {kindHasSize(data.kind) && (
        <label className="block text-xs text-muted">
          Size (% pot)
          <input
            type="number"
            min={0}
            value={data.sizePct ?? ""}
            onChange={(e) =>
              onPatch({ ...data, sizePct: e.target.value === "" ? null : Number(e.target.value) })
            }
            className="mt-0.5 w-full rounded border border-line bg-background px-2 py-1 text-sm text-foreground outline-none focus:border-accent"
          />
        </label>
      )}
      <div>
        <span className="text-xs text-muted">Colour</span>
        <div className="mt-1 flex flex-wrap gap-1">
          {PALETTE.map((color) => (
            <button
              key={color}
              type="button"
              onClick={() => onPatch({ ...data, color })}
              className={[
                "size-5 rounded-sm border",
                data.color === color ? "border-foreground" : "border-transparent",
              ].join(" ")}
              style={{ backgroundColor: color }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
