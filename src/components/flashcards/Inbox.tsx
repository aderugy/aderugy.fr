"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { bulkNotes } from "@/server/actions/flashcards";
import { cardOrds, sidesOf } from "@/lib/flashcards/notes";
import { KIND_LABELS, type Note } from "@/lib/flashcards/types";
import { Rich } from "./Rich";

/**
 * Notes Claude wrote, waiting for a decision. Nothing here is reviewed until
 * accepted: accepting generates the cards; rejecting deletes the note.
 */
export function Inbox({ notes }: { notes: (Note & { deck_path: string })[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const act = (ids: string[], op: "accept" | "reject") =>
    start(async () => {
      setError(null);
      setBusy(new Set(ids));
      const r = await bulkNotes(ids, { op });
      setBusy(new Set());
      if (!r.ok) setError(r.error);
      router.refresh();
    });

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6 sm:py-10">
      <div className="flex flex-wrap items-baseline gap-3">
        <h1 className="text-lg font-semibold tracking-tight">Inbox</h1>
        <p className="text-sm text-muted">
          {notes.length ? `${notes.length} note${notes.length > 1 ? "s" : ""} from Claude` : "Empty"}
        </p>
        {notes.length > 1 && (
          <div className="ml-auto flex gap-2">
            <button
              type="button"
              disabled={pending}
              onClick={() => window.confirm(`Reject all ${notes.length} notes?`) && act(notes.map((n) => n.id), "reject")}
              className="rounded-md border border-line px-3 py-1.5 text-sm text-muted hover:text-red-600"
            >
              Reject all
            </button>
            <button type="button" disabled={pending} onClick={() => act(notes.map((n) => n.id), "accept")} className="rounded-md bg-accent px-3 py-1.5 text-sm text-white">
              Accept all
            </button>
          </div>
        )}
      </div>
      {notes.length === 0 && (
        <p className="mt-6 text-sm text-muted">
          When Claude writes cards through the connector, they wait here until you accept them. Ask it, for instance, to turn a chapter of{" "}
          <Link href="/maths" className="text-accent hover:underline">/maths</Link> or an interview prep into cards.
        </p>
      )}
      {error && <p className="mt-3 text-xs text-red-600">{error}</p>}

      <ul className="mt-6 space-y-4">
        {notes.map((n) => {
          const ords = cardOrds(n);
          const first = sidesOf(n, ords[0] ?? 0);
          return (
            <li key={n.id} className={`rounded-lg border border-line bg-surface p-4 ${busy.has(n.id) ? "opacity-50" : ""}`}>
              <p className="mb-3 text-xs text-muted">
                {n.deck_path} · {KIND_LABELS[n.kind]} · {ords.length} card{ords.length === 1 ? "" : "s"}
                {n.tags.length ? ` · ${n.tags.map((t) => `#${t}`).join(" ")}` : ""}
              </p>
              <Rich source={first.question} className="text-sm" />
              <hr className="my-3 border-line" />
              <Rich source={first.answer} className="text-sm" />
              {n.extra && <Rich source={n.extra} className="mt-3 text-xs text-muted" />}
              {n.source && (
                <a href={n.source} target="_blank" rel="noreferrer noopener" className="mt-2 inline-block text-xs text-accent hover:underline">
                  Source ↗
                </a>
              )}
              <div className="mt-4 flex gap-2">
                <button type="button" disabled={pending} onClick={() => act([n.id], "accept")} className="rounded-md bg-accent px-3 py-1.5 text-sm text-white">
                  Accept
                </button>
                <Link href={`/flashcards/notes/${n.id}`} className="rounded-md border border-line px-3 py-1.5 text-sm hover:border-accent">
                  Edit
                </Link>
                <button type="button" disabled={pending} onClick={() => act([n.id], "reject")} className="ml-auto rounded-md border border-line px-3 py-1.5 text-sm text-muted hover:text-red-600">
                  Reject
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </main>
  );
}
