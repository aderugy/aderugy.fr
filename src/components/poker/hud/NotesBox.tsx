"use client";

import { useState } from "react";
import { NoteConflictError, pt4 } from "@/lib/hud/client";
import type { Pt4AutoNote, Pt4Note } from "@/lib/hud/types";
import { AutoNotes } from "./AutoNotes";
import { PioBridgeError } from "@/lib/solver/pioBridge";

/** PT4's colour labels offered here (0 = none). Their names live in PT4's settings. */
const COLORS = [1, 2, 3, 4, 5, 6, 7, 8];

type Draft = { text: string; color: number; base: string };

/**
 * The PokerTracker 4 note of one player, editable, sized for the HUD row:
 * collapsed it fills its slot; hovering or typing expands it over the page.
 * Saving writes it to PT4 (Ctrl/⌘+Enter). If PT4 changed the note since it was loaded, the save is
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

  // Collapsed: fills its slot next to the HUD panels (colour + text in small).
  // Hover or focus: grows over the page below with the chips and buttons.
  const open = "group-hover:flex group-focus-within:flex";
  return (
    <div
      className={[
        "group absolute left-0 top-0 flex h-full w-full flex-col overflow-hidden rounded-lg bg-neutral-950 p-2 font-mono text-neutral-100",
        "hover:z-30 hover:h-auto hover:min-h-full hover:w-[30rem] hover:shadow-xl",
        "focus-within:z-30 focus-within:h-auto focus-within:min-h-full focus-within:w-[30rem] focus-within:shadow-xl",
        conflict !== undefined ? "ring-1 ring-amber-500" : "",
      ].join(" ")}
    >
      <div className="mb-1 flex items-center gap-1 text-[11px] text-neutral-400">
        <span
          className={`group-hover:hidden group-focus-within:hidden ${color > 0 ? "rounded bg-neutral-800 px-1 text-neutral-200" : ""}`}
        >
          {color > 0 ? color : "note"}
        </span>
        <span className={`hidden flex-wrap gap-1 ${open}`}>
          <ColorChip value={0} active={color === 0} onClick={() => edit({ color: 0 })} />
          {COLORS.map((c) => (
            <ColorChip key={c} value={c} active={color === c} onClick={() => edit({ color: c })} />
          ))}
        </span>
        <span className={`ml-auto ${dirty ? "text-amber-400" : ""}`}>
          {saving ? "saving…" : dirty ? "not saved" : ""}
        </span>
        {autos.length > 0 && (
          <span title={`${autos.length} PT4 auto-notes: hover to see them`} className="text-sky-400/80">
            auto ×{autos.length}
          </span>
        )}
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
        placeholder="No note · hover to write"
        spellCheck={false}
        className={[
          "min-h-0 w-full flex-1 resize-none bg-transparent text-xs leading-5 text-neutral-100 outline-none placeholder:text-neutral-600",
          "group-hover:min-h-24 group-focus-within:min-h-24",
        ].join(" ")}
      />
      <div className={`mt-1 hidden flex-wrap items-center gap-2 font-sans text-xs ${open}`}>
        {dirty ? (
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
        ) : (
          note && <span className="text-neutral-500">saved {note.date.replace("T", " ").slice(0, 16)}</span>
        )}
        {note?.rich && <span className="text-neutral-500">PT4 formatting is dropped on save.</span>}
        {error && <span className="text-red-400">{error}</span>}
      </div>
      {autos.length > 0 && (
        <div className={`hidden ${open} flex-col`}>
          <AutoNotes notes={autos} />
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
        "h-5 min-w-5 rounded border px-1 font-mono text-[11px] tabular-nums",
        active ? "border-accent bg-accent text-white" : "border-neutral-700 text-neutral-400 hover:text-neutral-100",
      ].join(" ")}
    >
      {value === 0 ? "–" : value}
    </button>
  );
}
