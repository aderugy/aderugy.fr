"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { bulkNotes, searchNotes } from "@/server/actions/flashcards";
import { plainText } from "@/lib/flashcards/notes";
import { formatDelay } from "@/lib/flashcards/scheduler";
import { KIND_LABELS, NOTE_KINDS, STATE_LABELS, type Card } from "@/lib/flashcards/types";
import type { NoteRow, SearchFilters } from "@/server/flashcards/data";
import { DeckSelect } from "./DeckList";

const STATE_FILTERS = [
  ["new", "New"],
  ["learning", "Learning"],
  ["review", "Review"],
  ["relearning", "Relearning"],
  ["suspended", "Suspended"],
  ["flagged", "Flagged"],
  ["leech", "Leeches"],
] as const;

function summary(cards: Card[], now: number): string {
  if (cards.length === 0) return "no card";
  const live = cards.filter((c) => !c.suspended);
  const parts: string[] = [];
  if (live.length < cards.length) parts.push(`${cards.length - live.length} suspended`);
  const next = live.filter((c) => c.state !== "new").sort((a, b) => Date.parse(a.due) - Date.parse(b.due))[0];
  const fresh = live.filter((c) => c.state === "new").length;
  if (next) {
    const ms = Date.parse(next.due) - now;
    parts.unshift(`${STATE_LABELS[next.state]} · ${ms <= 0 ? "due" : `in ${formatDelay(ms)}`}`);
  }
  if (fresh) parts.push(`${fresh} new`);
  if (cards.some((c) => c.flagged)) parts.push("⚑");
  return parts.join(" · ");
}

/**
 * Notes, searched and filtered, with actions on a selection: move, tag,
 * trash (or restore and delete for good, in the trash).
 */
export function Browser({
  filters,
  initial,
  decks,
  tags,
  now,
}: {
  filters: SearchFilters;
  initial: { notes: NoteRow[]; more: boolean };
  decks: { id: string; path: string; depth: number }[];
  tags: { tag: string; notes: number }[];
  now: string;
}) {
  const router = useRouter();
  const nowMs = Date.parse(now);
  const [notes, setNotes] = useState(initial.notes);
  const [more, setMore] = useState(initial.more);
  const [page, setPage] = useState(0);
  // A refresh after a bulk action hands new results down: start over from them.
  const [base, setBase] = useState(initial);
  if (base !== initial) {
    setBase(initial);
    setNotes(initial.notes);
    setMore(initial.more);
    setPage(0);
  }
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [q, setQ] = useState(filters.q ?? "");
  const [moveTo, setMoveTo] = useState("");
  const [addTag, setAddTag] = useState("");
  const [removeTag, setRemoveTag] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const go = (patch: Partial<Record<keyof SearchFilters, string | boolean | undefined>>) => {
    const next: Record<string, string> = {};
    const all = { ...filters, ...patch } as Record<string, unknown>;
    const keys: Record<string, string> = { q: "q", deckId: "deck", tag: "tag", kind: "kind", state: "state", due: "due", source: "source", createdBy: "by", trash: "trash" };
    for (const [k, param] of Object.entries(keys)) {
      const v = all[k];
      if (v === true) next[param] = "1";
      else if (typeof v === "string" && v) next[param] = v;
    }
    const qs = new URLSearchParams(next).toString();
    router.push(`/flashcards/browse${qs ? `?${qs}` : ""}`);
  };

  const loadMore = () =>
    start(async () => {
      const r = await searchNotes(filters, page + 1);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setNotes((n) => [...n, ...r.value.notes]);
      setMore(r.value.more);
      setPage((p) => p + 1);
    });

  const bulk = (action: Parameters<typeof bulkNotes>[1], done: string) =>
    start(async () => {
      setError(null);
      const r = await bulkNotes([...selected], action);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setMessage(`${done}: ${r.value} note${r.value === 1 ? "" : "s"}.`);
      setSelected(new Set());
      router.refresh();
    });

  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const allSelected = notes.length > 0 && notes.every((n) => selected.has(n.id));
  const control = "rounded-md border border-line bg-surface px-2 py-1.5 text-sm outline-none focus:border-accent";

  return (
    <main className="mx-auto w-full max-w-4xl px-4 py-6 sm:px-6 sm:py-8">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          go({ q: q.trim() || undefined });
        }}
        className="flex flex-wrap gap-2"
      >
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search front, back, extra"
          className={`${control} min-w-0 flex-1 basis-56`}
          type="search"
        />
        <button type="submit" className="rounded-md bg-accent px-3 py-1.5 text-sm text-white">
          Search
        </button>
        <Link href={`/flashcards/notes/new${filters.deckId ? `?deck=${filters.deckId}` : ""}`} className="rounded-md border border-line bg-surface px-3 py-1.5 text-sm hover:border-accent">
          + Note
        </Link>
      </form>

      <div className="mt-3 flex flex-wrap gap-2 text-sm">
        <DeckSelect decks={decks} value={filters.deckId ?? ""} onChange={(v) => go({ deckId: v || undefined })} allowNone="All decks" className="!mt-0 !w-auto max-w-[14rem] !py-1.5" />
        <select value={filters.tag ?? ""} onChange={(e) => go({ tag: e.target.value || undefined })} className={`${control} max-w-[12rem]`}>
          <option value="">Any tag</option>
          {tags.map((t) => (
            <option key={t.tag} value={t.tag}>
              {t.tag} ({t.notes})
            </option>
          ))}
        </select>
        <select value={filters.state ?? ""} onChange={(e) => go({ state: e.target.value || undefined })} className={control}>
          <option value="">Any state</option>
          {STATE_FILTERS.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
        <select value={filters.due ?? ""} onChange={(e) => go({ due: e.target.value || undefined })} className={control}>
          <option value="">Any due date</option>
          <option value="today">Due today</option>
          <option value="overdue">Overdue</option>
        </select>
        <select value={filters.kind ?? ""} onChange={(e) => go({ kind: e.target.value || undefined })} className={control}>
          <option value="">Any kind</option>
          {NOTE_KINDS.map((k) => (
            <option key={k} value={k}>
              {KIND_LABELS[k]}
            </option>
          ))}
        </select>
        <select value={filters.createdBy ?? ""} onChange={(e) => go({ createdBy: e.target.value || undefined })} className={control}>
          <option value="">Anyone</option>
          <option value="claude">Written by Claude</option>
          <option value="user">Written by me</option>
        </select>
        <label className="flex items-center gap-1.5 px-1 text-muted">
          <input type="checkbox" checked={Boolean(filters.source)} onChange={(e) => go({ source: e.target.checked || undefined })} /> Has source
        </label>
        <label className="flex items-center gap-1.5 px-1 text-muted">
          <input type="checkbox" checked={Boolean(filters.trash)} onChange={(e) => go({ trash: e.target.checked || undefined })} /> Trash
        </label>
      </div>

      {(filters.deckId || filters.tag) && !filters.trash && (
        <p className="mt-3 text-xs text-muted">
          <Link
            href={`/flashcards/review?cram=1${filters.deckId ? `&deck=${filters.deckId}` : ""}${filters.tag ? `&tag=${encodeURIComponent(filters.tag)}` : ""}`}
            className="text-accent hover:underline"
          >
            Cram this {filters.tag ? "tag" : "deck"}
          </Link>{" "}
          — every card, nothing rescheduled.
        </p>
      )}

      {selected.size > 0 && (
        <div className="sticky top-12 z-20 mt-4 flex flex-wrap items-center gap-2 rounded-lg border border-accent/40 bg-background p-2 text-sm shadow-sm">
          <span className="px-1 font-medium">{selected.size} selected</span>
          {filters.trash ? (
            <>
              <button type="button" disabled={pending} onClick={() => bulk({ op: "restore" }, "Restored")} className="rounded-md border border-line px-2 py-1 hover:border-accent">
                Restore
              </button>
              <button
                type="button"
                disabled={pending}
                onClick={() => window.confirm(`Delete ${selected.size} note(s), their cards and history for good?`) && bulk({ op: "destroy" }, "Deleted")}
                className="rounded-md border border-red-600/50 px-2 py-1 text-red-600"
              >
                Delete for good
              </button>
            </>
          ) : (
            <>
              <DeckSelect decks={decks} value={moveTo} onChange={setMoveTo} allowNone="Move to…" className="!mt-0 !w-auto max-w-[12rem] !py-1" />
              <button type="button" disabled={pending || !moveTo} onClick={() => bulk({ op: "move", deckId: moveTo }, "Moved")} className="rounded-md border border-line px-2 py-1 hover:border-accent disabled:opacity-50">
                Move
              </button>
              <input value={addTag} onChange={(e) => setAddTag(e.target.value)} placeholder="+ tag" className="w-24 rounded-md border border-line bg-surface px-2 py-1" />
              <input value={removeTag} onChange={(e) => setRemoveTag(e.target.value)} placeholder="− tag" className="w-24 rounded-md border border-line bg-surface px-2 py-1" />
              <button
                type="button"
                disabled={pending || (!addTag.trim() && !removeTag.trim())}
                onClick={() => {
                  bulk({ op: "tag", add: addTag.split(/\s+/).filter(Boolean), remove: removeTag.split(/\s+/).filter(Boolean) }, "Retagged");
                  setAddTag("");
                  setRemoveTag("");
                }}
                className="rounded-md border border-line px-2 py-1 hover:border-accent disabled:opacity-50"
              >
                Tag
              </button>
              <button type="button" disabled={pending} onClick={() => bulk({ op: "trash" }, "Moved to trash")} className="rounded-md border border-line px-2 py-1 text-muted hover:text-red-600">
                Trash
              </button>
            </>
          )}
          <button type="button" onClick={() => setSelected(new Set())} className="ml-auto px-1 text-xs text-muted hover:text-foreground">
            Clear
          </button>
        </div>
      )}
      {error && <p className="mt-3 text-xs text-red-600">{error}</p>}
      {message && <p className="mt-3 text-xs text-emerald-700 dark:text-emerald-400">{message}</p>}

      <div className="mt-4 overflow-hidden rounded-lg border border-line bg-surface">
        <div className="flex items-center gap-3 border-b border-line px-3 py-2 text-xs text-muted">
          <input
            type="checkbox"
            checked={allSelected}
            onChange={() => setSelected(allSelected ? new Set() : new Set(notes.map((n) => n.id)))}
            aria-label="Select all shown"
          />
          <span>
            {notes.length}
            {more ? "+" : ""} note{notes.length === 1 ? "" : "s"}
            {filters.trash ? " in the trash (deleted for good after 30 days)" : ""}
          </span>
        </div>
        {notes.length === 0 && <p className="px-3 py-8 text-center text-sm text-muted">No note matches.</p>}
        <ul>
          {notes.map((n) => (
            <li key={n.id} className="flex items-start gap-3 border-b border-line px-3 py-2.5 last:border-b-0">
              <input type="checkbox" checked={selected.has(n.id)} onChange={() => toggle(n.id)} className="mt-1" aria-label="Select" />
              <Link href={`/flashcards/notes/${n.id}`} className="min-w-0 flex-1 hover:text-accent">
                <span className="line-clamp-2 text-sm">{plainText(n.front) || "(empty)"}</span>
                <span className="mt-0.5 block truncate text-xs text-muted">
                  {n.deck_path} · {KIND_LABELS[n.kind]} · {summary(n.cards, nowMs)}
                  {n.created_by === "claude" ? " · by Claude" : ""}
                  {n.tags.length ? ` · ${n.tags.map((t) => `#${t}`).join(" ")}` : ""}
                </span>
              </Link>
            </li>
          ))}
        </ul>
        {more && (
          <button type="button" disabled={pending} onClick={loadMore} className="w-full border-t border-line px-3 py-2.5 text-sm text-muted hover:text-foreground">
            {pending ? "Loading…" : "Load more"}
          </button>
        )}
      </div>
    </main>
  );
}
