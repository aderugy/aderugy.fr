"use client";

import { useState } from "react";
import { NoteConflictError, pt4 } from "@/lib/hud/client";
import type { Pt4Note } from "@/lib/hud/types";
import { PioBridgeError } from "@/lib/solver/pioBridge";

/** PT4's colour labels offered here (0 = none). Their names live in PT4's settings. */
const COLORS = [1, 2, 3, 4, 5, 6, 7, 8];

type Draft = { text: string; color: number; base: string };

/**
 * The PokerTracker 4 note of one player, editable. Saving writes it to PT4
 * (Ctrl/⌘+Enter). If PT4 changed the note since it was loaded, the save is
 * refused and both versions are offered. While nothing is being edited, the
 * box follows the note as the page polls it.
 */
export function NotesBox({
  player,
  note,
  onSaved,
}: {
  player: number;
  note: Pt4Note | undefined;
  onSaved: (n: Pt4Note) => void;
}) {
  // A draft exists only while editing; otherwise the stored note is shown.
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<Pt4Note | null | undefined>(undefined);

  const text = draft?.text ?? note?.text ?? "";
  const color = draft?.color ?? note?.color ?? 0;
  const dirty = draft !== null && (draft.text !== (note?.text ?? "") || draft.color !== (note?.color ?? 0));

  const edit = (patch: Partial<Draft>) =>
    setDraft((d) => ({ text, color, base: d?.base ?? note?.date ?? "", ...d, ...patch }));

  const save = async (base = draft?.base ?? note?.date ?? "") => {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const saved = await pt4.saveNote(player, color, text, base);
      onSaved(saved);
      setDraft(null);
      setConflict(undefined);
    } catch (e) {
      if (e instanceof NoteConflictError) setConflict(e.current);
      else setError(e instanceof PioBridgeError ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-lg border border-line bg-surface p-2.5">
      <div className="mb-2 flex flex-wrap items-center gap-1">
        <span className="mr-1 text-xs text-muted">Note</span>
        <ColorChip value={0} active={color === 0} onClick={() => edit({ color: 0 })} />
        {COLORS.map((c) => (
          <ColorChip key={c} value={c} active={color === c} onClick={() => edit({ color: c })} />
        ))}
        <span className="ml-auto text-[11px] text-muted">
          {saving ? "saving…" : dirty ? "not saved · Ctrl+Enter" : note ? `saved ${note.date.replace("T", " ").slice(0, 16)}` : ""}
        </span>
      </div>
      <textarea
        value={text}
        onChange={(e) => edit({ text: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            if (dirty) void save();
          } else if (e.key === "Escape" && dirty) {
            setDraft(null);
            setConflict(undefined);
          }
        }}
        rows={Math.min(10, Math.max(3, text.split("\n").length + 1))}
        placeholder="No note on this player"
        spellCheck={false}
        className="w-full resize-y rounded-md border border-line bg-background px-2.5 py-1.5 font-mono text-sm leading-6 outline-none focus:border-accent"
      />
      <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs">
        {dirty && (
          <>
            <button
              type="button"
              disabled={saving}
              onClick={() => void save()}
              className="rounded-md bg-accent px-2.5 py-1 font-medium text-white disabled:opacity-60"
            >
              Save to PT4
            </button>
            <button
              type="button"
              onClick={() => {
                setDraft(null);
                setConflict(undefined);
              }}
              className="text-muted hover:text-foreground"
            >
              Cancel
            </button>
          </>
        )}
        {note?.rich && (
          <span className="text-muted">This note has PT4 formatting (bold, colours…): saving here keeps the text only.</span>
        )}
        {error && <span className="text-red-600">{error}</span>}
      </div>
      {conflict !== undefined && (
        <div className="mt-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs">
          <p className="font-medium">Changed in PokerTracker since you started editing.</p>
          {conflict ? (
            <pre className="mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap font-mono text-muted">
              {conflict.text || "(empty)"}
            </pre>
          ) : (
            <p className="mt-1 text-muted">PT4 has no note on this player any more.</p>
          )}
          <div className="mt-1.5 flex gap-3">
            <button type="button" onClick={() => void save(conflict?.date ?? "")} className="font-medium text-accent">
              Keep mine
            </button>
            <button
              type="button"
              onClick={() => {
                if (conflict) onSaved(conflict);
                setDraft(null);
                setConflict(undefined);
              }}
              className="text-muted hover:text-foreground"
            >
              Take PT4&apos;s
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function ColorChip({ value, active, onClick }: { value: number; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={value === 0 ? "No colour" : `PT4 colour ${value}`}
      className={[
        "h-6 min-w-6 rounded-md border px-1 font-mono text-[11px] tabular-nums",
        active ? "border-accent bg-accent text-white" : "border-line text-muted hover:text-foreground",
      ].join(" ")}
    >
      {value === 0 ? "–" : value}
    </button>
  );
}
