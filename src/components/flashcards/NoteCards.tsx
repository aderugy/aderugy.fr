"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useAction } from "@/components/jobs/controls";
import { bulkNotes, updateCard } from "@/server/actions/flashcards";
import { fmtWhen } from "@/lib/agenda/zoned";
import { formatDelay } from "@/lib/flashcards/scheduler";
import { RATING_LABELS, STATE_LABELS, type Card, type NoteKind, type Rating } from "@/lib/flashcards/types";

type Review = {
  id: number;
  card_id: string;
  kind: "review" | "cram";
  rating: Rating;
  review_day: string;
  duration_ms: number;
  state_before: string;
  state_after: string;
  stability_after: number;
  due_after: string;
  reviewed_at: string;
};

export function cardLabel(kind: NoteKind, ord: number): string {
  if (kind === "cloze") return `c${ord}`;
  if (kind === "reversed") return ord === 1 ? "Back → front" : "Front → back";
  return "Card";
}

/** A note's cards: state, schedule, every rating, and the per-card switches. */
export function NoteCards({
  noteId,
  kind,
  cards,
  history,
  trashed,
  timeZone,
  now,
}: {
  noteId: string;
  kind: NoteKind;
  cards: Card[];
  history: Review[];
  trashed: boolean;
  timeZone: string;
  /** Server time (ISO), so the "due in" labels render the same on both sides. */
  now: string;
}) {
  const nowMs = Date.parse(now);
  const router = useRouter();
  const [open, setOpen] = useState<string | null>(null);
  const { pending, error, run } = useAction();

  return (
    <section className="mt-10 space-y-3">
      <h2 className="text-xs font-medium tracking-wide text-muted uppercase">Cards</h2>
      {cards.length === 0 && <p className="text-sm text-muted">No card yet.</p>}
      {cards.map((c) => {
        const mine = history.filter((h) => h.card_id === c.id);
        const due = Date.parse(c.due) - nowMs;
        return (
          <div key={c.id} className="rounded-lg border border-line bg-surface p-3 text-sm">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="font-medium">{cardLabel(kind, c.ord)}</span>
              <span className="text-xs text-muted">
                {STATE_LABELS[c.state]}
                {c.state !== "new" && ` · due ${due <= 0 ? "now" : `in ${formatDelay(due)}`}`}
                {c.reps > 0 && ` · ${c.reps} rating${c.reps > 1 ? "s" : ""} · ${c.lapses} lapse${c.lapses === 1 ? "" : "s"}`}
                {c.state !== "new" && ` · stability ${c.stability.toFixed(1)} d · difficulty ${c.difficulty.toFixed(1)}`}
              </span>
              <div className="ml-auto flex gap-2 text-xs">
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => run(() => updateCard(c.id, { suspended: !c.suspended }), () => router.refresh())}
                  className={`rounded border px-2 py-1 ${c.suspended ? "border-amber-500/60 text-amber-700 dark:text-amber-400" : "border-line text-muted hover:text-foreground"}`}
                >
                  {c.suspended ? "Suspended" : "Suspend"}
                </button>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => run(() => updateCard(c.id, { flagged: !c.flagged }), () => router.refresh())}
                  className={`rounded border px-2 py-1 ${c.flagged ? "border-accent text-accent" : "border-line text-muted hover:text-foreground"}`}
                >
                  {c.flagged ? "⚑ Flagged" : "Flag"}
                </button>
              </div>
            </div>
            {mine.length > 0 && (
              <button type="button" onClick={() => setOpen(open === c.id ? null : c.id)} className="mt-2 text-xs text-muted hover:text-foreground">
                {open === c.id ? "Hide history" : `History (${mine.length})`}
              </button>
            )}
            {open === c.id && (
              <table className="mt-2 w-full text-xs">
                <thead className="text-muted">
                  <tr className="text-left">
                    <th className="py-1 pr-2 font-normal">When</th>
                    <th className="py-1 pr-2 font-normal">Rating</th>
                    <th className="py-1 pr-2 font-normal">From → to</th>
                    <th className="py-1 pr-2 text-right font-normal">Next</th>
                    <th className="py-1 text-right font-normal">Time</th>
                  </tr>
                </thead>
                <tbody>
                  {mine.map((h) => (
                    <tr key={h.id} className="border-t border-line">
                      <td className="py-1 pr-2 whitespace-nowrap">{fmtWhen(h.reviewed_at, timeZone)}</td>
                      <td className="py-1 pr-2">
                        {RATING_LABELS[h.rating]}
                        {h.kind === "cram" && <span className="text-muted"> (cram)</span>}
                      </td>
                      <td className="py-1 pr-2 text-muted">
                        {h.state_before} → {h.state_after}
                      </td>
                      <td className="py-1 pr-2 text-right tabular-nums">{h.kind === "cram" ? "—" : formatDelay(Date.parse(h.due_after) - Date.parse(h.reviewed_at))}</td>
                      <td className="py-1 text-right tabular-nums">{(h.duration_ms / 1000).toFixed(0)} s</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        );
      })}

      <div className="flex flex-wrap gap-3 pt-4">
        {trashed ? (
          <>
            <button type="button" disabled={pending} onClick={() => run(() => bulkNotes([noteId], { op: "restore" }), () => router.refresh())} className="rounded-md border border-line px-3 py-1.5 text-xs hover:border-accent">
              Restore
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => {
                if (window.confirm("Delete this note, its cards and their history for good?")) {
                  run(() => bulkNotes([noteId], { op: "destroy" }), () => router.push("/flashcards/browse?trash=1"));
                }
              }}
              className="rounded-md border border-red-600/50 px-3 py-1.5 text-xs text-red-600 hover:bg-red-600/10"
            >
              Delete for good
            </button>
          </>
        ) : (
          <button type="button" disabled={pending} onClick={() => run(() => bulkNotes([noteId], { op: "trash" }), () => router.refresh())} className="rounded-md border border-line px-3 py-1.5 text-xs text-muted hover:text-red-600">
            Move to trash
          </button>
        )}
      </div>
      {error && <p className="text-xs text-red-600">{error}</p>}
    </section>
  );
}
