"use client";

import Link from "next/link";
import { useState } from "react";
import { INPUT, fmtClock } from "./ui";
import { useAction } from "@/components/jobs/controls";
import { ErrorLine } from "@/components/jobs/bits";
import type { PlayerNote } from "@/lib/live/types";
import { addNote, deleteNote, updateNote } from "@/server/actions/live";

/**
 * Timestamped notes on a player, newest first, with a box to add one. A note
 * taken during a session remembers which (and which hand, if any); Claude's
 * notes are marked as such.
 */
export function PlayerNotes({
  playerId,
  notes,
  sessionId = null,
  handId = null,
  limit,
  sessionLabels = {},
}: {
  playerId: string;
  notes: PlayerNote[];
  /** The session (and hand) a new note is taken in. */
  sessionId?: string | null;
  handId?: string | null;
  /** Show only the latest few, with a link to the rest. */
  limit?: number;
  sessionLabels?: Record<string, string>;
}) {
  const { pending, error, run } = useAction();
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const shown = limit ? notes.slice(0, limit) : notes;

  return (
    <div className={pending ? "opacity-70" : ""}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          run(() => addNote({ player_id: playerId, body: draft, session_id: sessionId, hand_id: handId }), () => setDraft(""));
        }}
        className="flex gap-2"
      >
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={2}
          placeholder="3-bets light from the blinds, tilts after losing…"
          className={`${INPUT} min-w-0 flex-1`}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) e.currentTarget.form?.requestSubmit();
          }}
        />
        <button type="submit" disabled={!draft.trim() || pending} className="shrink-0 self-stretch rounded-lg bg-accent px-3 text-sm font-medium text-white disabled:opacity-40">
          Add
        </button>
      </form>
      <ErrorLine error={error} />

      <ul className="mt-2 space-y-2">
        {shown.map((n) => (
          <li key={n.id} className="rounded-lg border border-line bg-surface px-3 py-2 text-sm">
            {editing === n.id ? (
              <div className="space-y-2">
                <textarea value={editDraft} onChange={(e) => setEditDraft(e.target.value)} rows={3} className={INPUT} />
                <div className="flex justify-end gap-3 text-xs">
                  <button type="button" onClick={() => setEditing(null)} className="text-muted">
                    Cancel
                  </button>
                  <button type="button" onClick={() => run(() => updateNote(n.id, editDraft), () => setEditing(null))} className="font-medium text-accent">
                    Save
                  </button>
                </div>
              </div>
            ) : (
              <>
                <p className="whitespace-pre-wrap">{n.body}</p>
                <p className="mt-1 flex flex-wrap items-center gap-x-2 text-[11px] text-muted">
                  <span>{fmtClock(n.created_at, true)}</span>
                  {n.source === "claude" && <span className="rounded bg-accent/10 px-1 text-accent">Claude</span>}
                  {n.session_id && (
                    <Link href={`/poker/live/${n.session_id}${n.hand_id ? `/hands/${n.hand_id}` : ""}`} className="underline">
                      {sessionLabels[n.session_id] ?? "session"}
                      {n.hand_id ? " · hand" : ""}
                    </Link>
                  )}
                  <span className="ml-auto flex gap-3">
                    <button
                      type="button"
                      onClick={() => {
                        setEditing(n.id);
                        setEditDraft(n.body);
                      }}
                    >
                      Edit
                    </button>
                    <button type="button" onClick={() => confirm("Delete this note?") && run(() => deleteNote(n.id))} className="hover:text-red-500">
                      Delete
                    </button>
                  </span>
                </p>
              </>
            )}
          </li>
        ))}
        {notes.length === 0 && <li className="text-xs text-muted">No notes yet.</li>}
      </ul>
      {limit && notes.length > limit && (
        <Link href={`/poker/live/players/${playerId}`} className="mt-2 block text-xs text-muted underline">
          All {notes.length} notes →
        </Link>
      )}
    </div>
  );
}
