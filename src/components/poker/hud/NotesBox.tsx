"use client";

import { useRef, useState } from "react";
import { NoteConflictError, pt4 } from "@/lib/hud/client";
import type { Pt4AutoNote, Pt4Note } from "@/lib/hud/types";
import { AutoNotes } from "./AutoNotes";
import { CardText } from "./CardText";
import { NOTE_COLORS, noteColor } from "@/lib/hud/noteColors";
import { PioBridgeError } from "@/lib/solver/pioBridge";


type Draft = { text: string; color: number; base: string };

/** Shared by the textarea and the highlighted layer behind it. */
const FIELD =
  "rounded-md border px-2 py-1.5 font-mono text-xs leading-5 whitespace-pre-wrap break-words [overflow-wrap:anywhere] [scrollbar-gutter:stable]";

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
  const backdrop = useRef<HTMLDivElement>(null);

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
        "flex flex-col rounded-lg border border-line bg-inset p-2.5 font-mono text-foreground",
        conflict !== undefined ? "ring-1 ring-amber-500" : "",
      ].join(" ")}
    >
      <div className="mb-1.5 flex flex-wrap items-center gap-1 text-[11px] text-muted">
        <ColorChip value={0} active={color === 0} onClick={() => edit({ color: 0 })} />
        {NOTE_COLORS.map((c) => (
          <ColorChip key={c.id} value={c.id} active={color === c.id} onClick={() => edit({ color: c.id })} />
        ))}
        <span className={`ml-auto ${dirty ? "font-medium text-amber-600 dark:text-amber-400" : ""}`}>
          {saving ? "saving…" : dirty ? "not saved" : note ? `saved ${note.date.replace("T", " ").slice(0, 16)}` : ""}
        </span>
      </div>
      {/* The text is drawn by the layer behind (cards bold in their suit's
          colour); the textarea on top is transparent but for the caret.
          Same font, padding, border and wrapping, so the two line up. */}
      <div className="relative rounded-md bg-surface">
        <div
          ref={backdrop}
          aria-hidden
          className={`${FIELD} pointer-events-none absolute inset-0 overflow-hidden border-transparent text-foreground`}
        >
          <CardText text={text} />
          {"\n"}
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
          onScroll={(e) => {
            if (backdrop.current) backdrop.current.scrollTop = e.currentTarget.scrollTop;
          }}
          className={`${FIELD} relative block w-full resize-y border-line bg-transparent text-transparent caret-foreground outline-none placeholder:text-muted focus:border-accent`}
        />
      </div>
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
                className="text-muted hover:text-foreground"
              >
                Cancel
              </button>
              <span className="text-muted">Ctrl+Enter · Esc</span>
            </>
          )}
          {note?.rich && <span className="text-muted">PT4 formatting is dropped on save.</span>}
          {error && <span className="text-red-600 dark:text-red-400">{error}</span>}
        </div>
      )}
      {conflict !== undefined && (
        <div className="mt-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 font-sans text-xs">
          <p className="font-medium text-amber-700 dark:text-amber-300">Changed in PokerTracker since you started editing.</p>
          {conflict ? (
            <pre className="mt-1 max-h-24 overflow-y-auto whitespace-pre-wrap font-mono text-foreground">
              {conflict.text || "(empty)"}
            </pre>
          ) : (
            <p className="mt-1 text-muted">PT4 has no note on this player any more.</p>
          )}
          <div className="mt-1.5 flex gap-3">
            <button type="button" onClick={() => void save(conflict?.date ?? "")} className="font-medium text-amber-700 dark:text-amber-300">
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
        c ? "" : "border border-line text-muted",
        active ? "ring-2 ring-foreground ring-offset-1 ring-offset-inset" : "opacity-60 hover:opacity-100",
      ].join(" ")}
    >
      {c ? null : "–"}
    </button>
  );
}
