"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { STREET_LABELS } from "@/lib/trainer/types";
import { createTrainer, updateTrainer } from "@/server/actions/trainers";
import type { TrainerListItem } from "@/server/trainers";
import { NewTrainerForm } from "@/components/poker/trainer/AddToTrainer";

export function TrainerList({ trainers }: { trainers: TrainerListItem[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [creating, setCreating] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const visible = trainers.filter((t) => showArchived || !t.archived);
  const archivedCount = trainers.filter((t) => t.archived).length;

  return (
    <div className="space-y-4">
      {creating ? (
        <div className="rounded-lg border border-line bg-surface p-4">
          <NewTrainerForm
            seat={null}
            vsSeat={null}
            pending={pending}
            compact={false}
            onCancel={() => setCreating(false)}
            onSubmit={(v) => {
              setError(null);
              startTransition(async () => {
                const r = await createTrainer(v);
                if (!r.ok) {
                  setError(r.error);
                  return;
                }
                router.push(`/poker/trainers/${r.id}`);
              });
            }}
          />
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="rounded bg-accent px-3 py-2 text-sm text-white"
        >
          New trainer
        </button>
      )}
      {error && <p className="text-sm text-red-500">{error}</p>}

      {visible.length === 0 ? (
        <p className="rounded border border-line bg-surface p-4 text-sm text-muted">
          No trainer yet. Create one here, or straight from a strategy node in{" "}
          <Link href="/poker/spots" className="text-accent hover:underline">
            Solver notes
          </Link>
          .
        </p>
      ) : (
        <ul className="space-y-2">
          {visible.map((t) => (
            <li
              key={t.id}
              className="flex items-center gap-3 rounded-lg border border-line bg-surface px-3 py-2.5"
            >
              <Link href={`/poker/trainers/${t.id}`} className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">
                  {t.name}
                  {t.archived && <span className="ml-2 text-xs font-normal text-muted">archived</span>}
                </span>
                <span className="block text-xs text-muted">
                  {t.hero_seat} vs {t.villain_seat}
                  {t.street ? ` · ${STREET_LABELS[t.street]}` : ""} · {t.nodeCount} node
                  {t.nodeCount === 1 ? "" : "s"} · {t.sessions} session{t.sessions === 1 ? "" : "s"}
                </span>
              </Link>
              <span className="shrink-0 text-right">
                <span className="block text-sm font-semibold tabular-nums">
                  {t.lastScore === null ? "—" : `${Math.round(t.lastScore)}%`}
                </span>
                <span className="block text-[10px] text-muted">last score</span>
              </span>
              <button
                type="button"
                disabled={pending}
                onClick={() =>
                  startTransition(async () => {
                    const r = await updateTrainer({ id: t.id, archived: !t.archived });
                    if (!r.ok) setError(r.error);
                  })
                }
                className="shrink-0 text-xs text-muted hover:text-foreground"
              >
                {t.archived ? "Unarchive" : "Archive"}
              </button>
            </li>
          ))}
        </ul>
      )}
      {archivedCount > 0 && (
        <button
          type="button"
          onClick={() => setShowArchived((v) => !v)}
          className="text-xs text-muted hover:text-foreground"
        >
          {showArchived ? "Hide archived" : `Show archived (${archivedCount})`}
        </button>
      )}
    </div>
  );
}
