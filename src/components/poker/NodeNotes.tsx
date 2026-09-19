"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { asMeta, type NodeMeta, type PokerNode } from "@/lib/solver/types";
import { Markdown } from "@/components/poker/Markdown";
import { Segmented } from "@/components/poker/ui";

/**
 * Summary + Markdown notes editor for any node, shown in the inspector.
 * The summary is a one-liner displayed on the canvas card; the notes are
 * free-form Markdown with a write/preview toggle and a full-screen editor.
 * Edits save on a short debounce and are flushed on unmount.
 */
export function NodeNotes({
  node,
  onPatch,
}: {
  node: PokerNode;
  onPatch: (patch: NodeMeta) => void;
}) {
  const initial = asMeta(node);
  const [summary, setSummary] = useState(initial.summary);
  const [notes, setNotes] = useState(initial.notes);
  const [tab, setTab] = useState<"write" | "preview">(initial.notes ? "preview" : "write");
  const [full, setFull] = useState(false);

  // Debounced save of whatever changed, flushed on unmount.
  const pending = useRef<NodeMeta>({});
  const timer = useRef<number | null>(null);
  const onPatchRef = useRef(onPatch);
  useEffect(() => {
    onPatchRef.current = onPatch;
  });

  function flush() {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = null;
    if (Object.keys(pending.current).length === 0) return;
    onPatchRef.current(pending.current);
    pending.current = {};
  }
  function queue(patch: NodeMeta) {
    pending.current = { ...pending.current, ...patch };
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(flush, 500);
  }
  useEffect(() => () => flush(), []);

  return (
    <div className="space-y-3 border-t border-line pt-3">
      <label className="block text-xs text-muted">
        Summary <span className="text-[10px]">(shown on the node)</span>
        <textarea
          value={summary}
          rows={2}
          onChange={(e) => {
            setSummary(e.target.value);
            queue({ summary: e.target.value });
          }}
          onBlur={flush}
          placeholder="e.g. Bet small with the whole range"
          className="mt-0.5 w-full resize-y rounded border border-line bg-background px-2 py-1 text-sm text-foreground outline-none focus:border-accent"
        />
      </label>

      <div>
        <div className="mb-1 flex items-center gap-2">
          <span className="text-xs text-muted">Notes</span>
          <div className="ml-auto flex items-center gap-2">
            <Segmented
              size="sm"
              value={tab}
              onChange={setTab}
              options={[
                { id: "write", label: "Write" },
                { id: "preview", label: "Preview" },
              ]}
            />
            <button
              type="button"
              onClick={() => setFull(true)}
              title="Open the full-screen editor"
              className="rounded border border-line px-1.5 py-0.5 text-xs text-muted hover:border-accent hover:text-foreground"
            >
              ⤢
            </button>
          </div>
        </div>
        {tab === "write" ? (
          <textarea
            value={notes}
            rows={10}
            onChange={(e) => {
              setNotes(e.target.value);
              queue({ notes: e.target.value });
            }}
            onBlur={flush}
            placeholder={"Markdown supported: **bold**, lists, tables…"}
            className="w-full resize-y rounded border border-line bg-background px-2 py-1.5 font-mono text-xs text-foreground outline-none focus:border-accent"
          />
        ) : notes.trim() ? (
          <div className="rounded border border-line bg-background p-2">
            <Markdown source={notes} />
          </div>
        ) : (
          <p className="text-xs text-muted">No notes yet.</p>
        )}
      </div>

      {full && (
        <FullEditor
          title={initial.summary || "Notes"}
          value={notes}
          onChange={(v) => {
            setNotes(v);
            queue({ notes: v });
          }}
          onClose={() => {
            flush();
            setFull(false);
          }}
        />
      )}
    </div>
  );
}

/** Side-by-side Markdown editor and live preview, over the whole page. */
function FullEditor({
  title,
  value,
  onChange,
  onClose,
}: {
  title: string;
  value: string;
  onChange: (value: string) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="flex h-full max-h-[90vh] w-full max-w-6xl flex-col overflow-hidden rounded-lg border border-line bg-surface shadow-xl">
        <div className="flex shrink-0 items-center gap-3 border-b border-line px-4 py-2.5">
          <h2 className="truncate text-sm font-medium">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto rounded border border-line px-2 py-1 text-xs hover:border-accent"
          >
            Done
          </button>
        </div>
        <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-2">
          <textarea
            autoFocus
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder="Markdown supported"
            className="min-h-0 resize-none border-b border-line bg-background p-3 font-mono text-sm text-foreground outline-none md:border-b-0 md:border-r"
          />
          <div className="min-h-0 overflow-y-auto p-4">
            {value.trim() ? (
              <Markdown source={value} />
            ) : (
              <p className="text-sm text-muted">Preview appears here.</p>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** Read-only rendering of a node's summary and notes (revision mode). */
export function NotesView({ node }: { node: PokerNode }) {
  const { summary, notes } = asMeta(node);
  if (!summary && !notes.trim()) {
    return <p className="text-xs text-muted">No notes on this node.</p>;
  }
  return (
    <div className="space-y-2">
      {summary && <p className="text-sm font-medium">{summary}</p>}
      {notes.trim() && <Markdown source={notes} />}
    </div>
  );
}
