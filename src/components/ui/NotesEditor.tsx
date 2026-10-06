"use client";

import { useState } from "react";
import { Markdown } from "./Markdown";

/**
 * Markdown notes: rendered, or a textarea. Same keys as the backlog's task
 * notes — Ctrl+Enter saves, Esc cancels. Empty notes open straight in the
 * editor unless `startClosed` asks for a one-line "Add …" instead, which is
 * what a page with several notes wants.
 */
export function NotesEditor({
  value,
  onSave,
  placeholder = "Markdown: context, links, checklists…",
  addLabel = "Add notes",
  editLabel = "Edit",
  startClosed = false,
  rows = 6,
}: {
  value: string | null;
  onSave: (next: string | null) => void;
  placeholder?: string;
  addLabel?: string;
  editLabel?: string;
  startClosed?: boolean;
  rows?: number;
}) {
  const [editing, setEditing] = useState(!value && !startClosed);
  const [draft, setDraft] = useState(value ?? "");

  if (!editing) {
    if (!value) {
      return (
        <button
          onClick={() => {
            setDraft("");
            setEditing(true);
          }}
          className="text-xs text-muted hover:text-foreground"
        >
          + {addLabel}
        </button>
      );
    }
    return (
      <div className="group">
        <Markdown source={value} />
        <button
          onClick={() => {
            setDraft(value);
            setEditing(true);
          }}
          className="mt-2 text-xs text-muted hover:text-foreground"
        >
          {editLabel}
        </button>
      </div>
    );
  }

  const save = () => {
    const next = draft.trim() ? draft : null;
    if (next !== (value ?? null)) onSave(next);
    setEditing(false);
  };
  const cancel = () => {
    setDraft(value ?? "");
    setEditing(false);
  };

  return (
    <div>
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            save();
          }
          if (e.key === "Escape") cancel();
        }}
        autoFocus={startClosed || !!value}
        rows={Math.min(24, Math.max(rows, draft.split("\n").length + 1))}
        placeholder={placeholder}
        className="w-full resize-y rounded border border-line bg-background px-2 py-1 font-mono text-xs outline-none focus:border-accent"
      />
      <div className="mt-1 flex items-center gap-2 text-xs">
        <span className="flex-1 text-muted">Markdown · Ctrl+Enter to save · Esc to cancel</span>
        {(value || startClosed) && (
          <button onClick={cancel} className="text-muted hover:text-foreground">
            Cancel
          </button>
        )}
        <button onClick={save} className="rounded bg-accent px-2 py-0.5 font-medium text-white">
          Save
        </button>
      </div>
    </div>
  );
}
