"use client";

import { useState } from "react";
import { NoteConflictError, pt4 } from "@/lib/hud/client";
import type { Pt4AutoNote, Pt4Note } from "@/lib/hud/types";
import { AutoNotes } from "./AutoNotes";
import { NOTE_COLORS, noteColor } from "@/lib/hud/noteColors";
import { PioBridgeError } from "@/lib/solver/pioBridge";


type Draft = { text: string; color: number; base: string };

/**
 * The PokerTracker 4 note of one player, editable, with PT4's auto-notes
 * under it (the notes column of the HUD page). Saving writes it to PT4
 * (Ctrl/⌘+Enter). If PT4 changed the note since it was loaded, the save is
 * refused and both versions are offered. While nothing is being edited, the
 * box follows the note as the page polls it.
 */
export function NotesBox({
  player,
  note,
  autos = [],
  onSaved,
}: {
  player: number;
  note: Pt4Note | undefined;
  /** PT4's auto-notes, shown read-only under the note when expanded. */
  autos?: Pt4AutoNote[];
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
    <div
      className={[
        "flex flex-col rounded-lg bg-neutral-950 p-2.5 font-mono text-neutral-100",
        conflict !== undefined ? "ring-1 ring-amber-500" : "",
      ].join(" ")}
    >
      <div className="mb-1.5 flex flex-wrap items-center gap-1 text-[11px] text-neutral-400">
        <ColorChip value={0} active={color === 0} onClick={() => edit({ color: 0 })} />
        {NOTE_COLORS.map((c) => (
          <ColorChip key={c.id} value={c.id} active={color === c.id} onClick={() => edit({ color: c.id })} />
        ))}
        <span className={`ml-auto ${dirty ? "text-amber-400" : ""}`}>
          {saving ? "saving…" : dirty ? "not saved" : note ? `saved ${note.date.replace("T", " ").slice(0, 16)}` : ""}
        </span>
      </div>
      <textarea
        value={text}
        onChange={(e) => edit({ text: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            if (dirty) void save();
          } else if (e.key === "Escape") {
            if (dirty) {
              setDraft(null);
              setConflict(undefined);
            }
            e.currentTarget.blur();
          }
        }}
        rows={Math.min(14, Math.max(4, text.split("\n").length + 1))}
        placeholder="No note on this player"
        spellCheck={false}
        className="w-full resize-y rounded-md border border-neutral-800 bg-neutral-900 px-2 py-1.5 text-xs leading-5 text-neutral-100 outline-none placeholder:text-neutral-600 focus:border-accent"
      />
      {(dirty || note?.rich || error) && (
        <div className="mt-1.5 flex flex-wrap items-center gap-2 font-sans text-xs">
          {dirty && (
            <>
              <button
                type="button"
                disabled={saving}
                onClick={() => void save()}
                className="rounded-md bg-accent px-2 py-0.5 font-medium text-white disabled:opacity-60"
              >
                Save to PT4
              </button>
              <button
                type="button"
                onClick={() => {
                  setDraft(null);
                  setConflict(undefined);
                }}
                className="text-neutral-400 hover:text-neutral-100"
              >
                Cancel
              </button>
              <span className="text-neutral-500">Ctrl+Enter · Esc</span>
            </>
          )}
          {note?.rich && <span className="text-neutral-500">PT4 formatting is dropped on save.</span>}
          {error && <span className="text-red-400">{error}</span>}
        </div>
      )}
      {conflict !== undefined && (
        <div className="mt-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 font-sans text-xs">
          <p className="font-medium text-amber-300">Changed in PokerTracker since you started editing.</p>
          {conflict ? (
            <pre className="mt-1 max-h-24 overflow-y-auto whitespace-pre-wrap font-mono text-neutral-300">
              {conflict.text || "(empty)"}
            </pre>
          ) : (
            <p className="mt-1 text-neutral-400">PT4 has no note on this player any more.</p>
          )}
          <div className="mt-1.5 flex gap-3">
            <button type="button" onClick={() => void save(conflict?.date ?? "")} className="font-medium text-amber-300">
              Keep mine
            </button>
            <button
              type="button"
              onClick={() => {
                if (conflict) onSaved(conflict);
                setDraft(null);
                setConflict(undefined);
              }}
              className="text-neutral-400 hover:text-neutral-100"
            >
              Take PT4&apos;s
            </button>
          </div>
        </div>
      )}
      {autos.length > 0 && <AutoNotes notes={autos} />}
    </div>
  );
}

function ColorChip({ value, active, onClick }: { value: number; active: boolean; onClick: () => void }) {
  const c = noteColor(value);
  return (
    <button
      type="button"
      onClick={onClick}
      title={c ? c.name : "No colour"}
      aria-label={c ? c.name : "No colour"}
      aria-pressed={active}
      style={c ? { backgroundColor: c.hex } : undefined}
      className={[
        "flex h-5 w-5 items-center justify-center rounded-full text-[11px] leading-none",
        c ? "" : "border border-neutral-600 text-neutral-400",
        active ? "ring-2 ring-white ring-offset-1 ring-offset-neutral-950" : "opacity-70 hover:opacity-100",
      ].join(" ")}
    >
      {c ? null : "–"}
    </button>
  );
}
