"use client";

import Link from "next/link";
import { useState } from "react";
import { Sheet } from "@/components/ui/Sheet";
import { useAction } from "@/components/jobs/controls";
import { createDeck, deleteDeck, updateDeck } from "@/server/actions/flashcards";
import type { DeckCounts, DeckWithCounts } from "@/server/flashcards/data";

/**
 * The deck tree with today's counts — new, in steps, due — rolled up over
 * each subtree and capped by the daily limits, as a session would show them.
 * The limits are soft: what they hold back is shown apart, and a session
 * offers it once its own cards are done.
 */
export function DeckList({
  decks,
  total,
  beyond,
  doneToday,
  inbox,
}: {
  decks: DeckWithCounts[];
  total: DeckCounts;
  beyond: { newCards: number; reviewDue: number };
  doneToday: { reviews: number; fresh: number };
  inbox: number;
}) {
  const [creating, setCreating] = useState<{ parentId: string | null } | null>(null);
  const [editing, setEditing] = useState<DeckWithCounts | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const past = beyond.newCards + beyond.reviewDue;
  const anything = total.newCards + total.learningDue + total.reviewDue > 0;
  const studiable = anything || past > 0;

  const hidden = (d: DeckWithCounts): boolean => {
    let p = d.parent_id;
    while (p) {
      if (collapsed.has(p)) return true;
      p = decks.find((x) => x.id === p)?.parent_id ?? null;
    }
    return false;
  };
  const hasChildren = (id: string) => decks.some((d) => d.parent_id === id);

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6 sm:py-10">
      {inbox > 0 && (
        <Link
          href="/flashcards/inbox"
          className="mb-5 flex items-center justify-between rounded-lg border border-accent/40 bg-accent/5 px-4 py-3 text-sm hover:border-accent"
        >
          <span>
            <span className="font-medium">{inbox}</span> note{inbox > 1 ? "s" : ""} from Claude waiting for review
          </span>
          <span className="text-accent">Open inbox →</span>
        </Link>
      )}

      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-semibold tracking-tight">Today</h1>
          <p className="mt-1 text-sm text-muted">
            {anything ? (
              <>
                <Counts fresh={total.newCards} learning={total.learningDue} due={total.reviewDue} /> to study
              </>
            ) : past > 0 ? (
              "Today’s limits are reached"
            ) : decks.length ? (
              "Nothing due. Come back tomorrow, or cram a deck."
            ) : (
              "Create a deck, then add notes to it."
            )}
            {doneToday.reviews + doneToday.fresh > 0 && (
              <span> · {doneToday.reviews + doneToday.fresh} done today</span>
            )}
            {past > 0 && (
              <span title="The daily limits are soft: a session offers these once its own cards are done.">
                {" "}· {[beyond.reviewDue ? `${beyond.reviewDue} due` : "", beyond.newCards ? `${beyond.newCards} new` : ""].filter(Boolean).join(" and ")} past the limits
              </span>
            )}
          </p>
        </div>
        {studiable && (
          <Link
            href="/flashcards/review"
            className={
              anything
                ? "rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90"
                : "rounded-md border border-line bg-surface px-4 py-2 text-sm hover:border-accent"
            }
          >
            {anything ? "Study all" : "Study past the limits"}
          </Link>
        )}
        <Link
          href="/flashcards/notes/new"
          className="rounded-md border border-line bg-surface px-3 py-2 text-sm hover:border-accent"
        >
          + Note
        </Link>
      </div>

      <div className="mt-8 overflow-hidden rounded-lg border border-line bg-surface">
        <div className="flex items-center border-b border-line px-3 py-2 text-xs text-muted">
          <span className="flex-1">Deck</span>
          <span className="w-10 text-right text-sky-600 dark:text-sky-400" title="New">New</span>
          <span className="w-10 text-right text-amber-600 dark:text-amber-400" title="Learning, due now">Learn</span>
          <span className="w-10 text-right text-emerald-600 dark:text-emerald-400" title="Reviews due today">Due</span>
          <span className="w-8" />
        </div>
        {decks.length === 0 && <p className="px-3 py-6 text-center text-sm text-muted">No deck yet.</p>}
        <ul>
          {decks.filter((d) => !hidden(d)).map((d) => {
            const c = d.counts;
            const busy = c.newCards + c.learningDue + c.reviewDue + d.beyond > 0;
            return (
              <li key={d.id} className="flex items-center border-b border-line px-3 last:border-b-0 hover:bg-background/60">
                <div className="flex min-w-0 flex-1 items-center py-2.5" style={{ paddingLeft: `${d.depth * 1.1}rem` }}>
                  {hasChildren(d.id) ? (
                    <button
                      type="button"
                      onClick={() =>
                        setCollapsed((s) => {
                          const n = new Set(s);
                          if (n.has(d.id)) n.delete(d.id);
                          else n.add(d.id);
                          return n;
                        })
                      }
                      className="mr-1 w-4 shrink-0 text-xs text-muted hover:text-foreground"
                      aria-label={collapsed.has(d.id) ? "Expand" : "Collapse"}
                    >
                      {collapsed.has(d.id) ? "▸" : "▾"}
                    </button>
                  ) : (
                    <span className="mr-1 w-4 shrink-0" />
                  )}
                  <Link
                    href={busy ? `/flashcards/review?deck=${d.id}` : `/flashcards/browse?deck=${d.id}`}
                    className="min-w-0 truncate text-sm hover:text-accent"
                    title={busy ? "Study this deck" : "Browse this deck"}
                  >
                    {d.name}
                  </Link>
                  <span className="ml-2 shrink-0 text-xs text-muted">{c.cards ? c.cards : ""}</span>
                  {d.beyond > 0 && (
                    <span className="ml-2 shrink-0 text-xs text-muted" title="New and due cards past today’s limits">
                      +{d.beyond}
                    </span>
                  )}
                </div>
                <Num value={c.newCards} className="text-sky-600 dark:text-sky-400" />
                <Num value={c.learningDue} className="text-amber-600 dark:text-amber-400" />
                <Num value={c.reviewDue} className="text-emerald-600 dark:text-emerald-400" />
                <button
                  type="button"
                  onClick={() => setEditing(d)}
                  className="ml-2 flex h-8 w-6 shrink-0 items-center justify-center text-muted hover:text-foreground"
                  aria-label={`Options for ${d.name}`}
                >
                  ⋯
                </button>
              </li>
            );
          })}
        </ul>
        <button
          type="button"
          onClick={() => setCreating({ parentId: null })}
          className="w-full border-t border-line px-3 py-2.5 text-left text-sm text-muted hover:text-foreground"
        >
          + New deck
        </button>
      </div>

      {creating && <NewDeckSheet decks={decks} parentId={creating.parentId} onClose={() => setCreating(null)} />}
      {editing && (
        <DeckSheet
          deck={editing}
          decks={decks}
          onClose={() => setEditing(null)}
          onNewChild={() => {
            setCreating({ parentId: editing.id });
            setEditing(null);
          }}
        />
      )}
    </main>
  );
}

function Num({ value, className }: { value: number; className: string }) {
  return <span className={`w-10 text-right text-sm tabular-nums ${value ? className : "text-muted/50"}`}>{value}</span>;
}

export function Counts({ fresh, learning, due }: { fresh: number; learning: number; due: number }) {
  return (
    <>
      <span className="text-sky-600 dark:text-sky-400">{fresh} new</span>
      {" · "}
      <span className="text-amber-600 dark:text-amber-400">{learning} learning</span>
      {" · "}
      <span className="text-emerald-600 dark:text-emerald-400">{due} due</span>
    </>
  );
}

function NewDeckSheet({ decks, parentId, onClose }: { decks: DeckWithCounts[]; parentId: string | null; onClose: () => void }) {
  const [name, setName] = useState("");
  const [parent, setParent] = useState(parentId ?? "");
  const { pending, error, run } = useAction();
  const submit = () => run(async () => createDeck(name, parent || null), onClose);
  return (
    <Sheet
      title="New deck"
      onClose={onClose}
      footer={
        <div className="flex items-center gap-3">
          {error && <p className="flex-1 text-xs text-red-600">{error}</p>}
          <button
            type="button"
            disabled={pending || !name.trim()}
            onClick={submit}
            className="ml-auto rounded-md bg-accent px-4 py-2 text-sm text-white disabled:opacity-50"
          >
            Create
          </button>
        </div>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className="space-y-3 text-sm"
      >
        <label className="block">
          <span className="text-xs text-muted">Name</span>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={80}
            className="mt-1 w-full rounded-md border border-line bg-surface px-3 py-2 outline-none focus:border-accent"
          />
        </label>
        <label className="block">
          <span className="text-xs text-muted">Inside</span>
          <DeckSelect decks={decks} value={parent} onChange={setParent} allowNone="Top level" />
        </label>
      </form>
    </Sheet>
  );
}

export function DeckSelect({
  decks,
  value,
  onChange,
  allowNone,
  exclude,
  className = "",
}: {
  decks: { id: string; path: string; depth: number }[];
  value: string;
  onChange: (id: string) => void;
  allowNone?: string;
  exclude?: Set<string>;
  className?: string;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={`mt-1 w-full rounded-md border border-line bg-surface px-2 py-2 outline-none focus:border-accent ${className}`}
    >
      {allowNone !== undefined && <option value="">{allowNone}</option>}
      {decks
        .filter((d) => !exclude?.has(d.id))
        .map((d) => (
          <option key={d.id} value={d.id}>
            {d.path}
          </option>
        ))}
    </select>
  );
}

function DeckSheet({
  deck,
  decks,
  onClose,
  onNewChild,
}: {
  deck: DeckWithCounts;
  decks: DeckWithCounts[];
  onClose: () => void;
  onNewChild: () => void;
}) {
  const [name, setName] = useState(deck.name);
  const [parent, setParent] = useState(deck.parent_id ?? "");
  const [moveTo, setMoveTo] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const { pending, error, run } = useAction();

  // A deck cannot move under itself or its descendants.
  const below = new Set<string>([deck.id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const d of decks) {
      if (d.parent_id && below.has(d.parent_id) && !below.has(d.id)) {
        below.add(d.id);
        grew = true;
      }
    }
  }
  const changed = name.trim() !== deck.name || (parent || null) !== deck.parent_id;

  return (
    <Sheet title={deck.path} onClose={onClose}>
      <div className="space-y-5 text-sm">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          <Link href={`/flashcards/review?deck=${deck.id}`} className="rounded-md border border-line bg-surface px-3 py-2 text-center hover:border-accent">
            Study
          </Link>
          <Link href={`/flashcards/review?deck=${deck.id}&cram=1`} className="rounded-md border border-line bg-surface px-3 py-2 text-center hover:border-accent">
            Cram
          </Link>
          <Link href={`/flashcards/notes/new?deck=${deck.id}`} className="rounded-md border border-line bg-surface px-3 py-2 text-center hover:border-accent">
            Add note
          </Link>
          <Link href={`/flashcards/browse?deck=${deck.id}`} className="rounded-md border border-line bg-surface px-3 py-2 text-center hover:border-accent">
            Browse
          </Link>
          <Link href={`/flashcards/stats?deck=${deck.id}`} className="rounded-md border border-line bg-surface px-3 py-2 text-center hover:border-accent">
            Stats
          </Link>
          <a href={`/flashcards/export?deck=${deck.id}`} className="rounded-md border border-line bg-surface px-3 py-2 text-center hover:border-accent">
            Export CSV
          </a>
        </div>

        <div className="space-y-3 border-t border-line pt-4">
          <label className="block">
            <span className="text-xs text-muted">Name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={80}
              className="mt-1 w-full rounded-md border border-line bg-surface px-3 py-2 outline-none focus:border-accent"
            />
          </label>
          <label className="block">
            <span className="text-xs text-muted">Inside</span>
            <DeckSelect decks={decks} value={parent} onChange={setParent} allowNone="Top level" exclude={below} />
          </label>
          <div className="flex items-center gap-3">
            <button type="button" onClick={onNewChild} className="text-xs text-muted hover:text-foreground">
              + Sub-deck
            </button>
            <button
              type="button"
              disabled={pending || !changed || !name.trim()}
              onClick={() => run(() => updateDeck(deck.id, { name, parentId: parent || null }), onClose)}
              className="ml-auto rounded-md bg-accent px-4 py-2 text-white disabled:opacity-50"
            >
              Save
            </button>
          </div>
        </div>

        <div className="border-t border-line pt-4">
          {!confirmDelete ? (
            <button type="button" onClick={() => setConfirmDelete(true)} className="text-xs text-red-600 hover:underline">
              Delete deck…
            </button>
          ) : (
            <div className="space-y-2">
              <p className="text-xs text-muted">
                Sub-decks move up one level.{" "}
                {deck.counts.cards > 0 || decks.some((d) => d.parent_id === deck.id)
                  ? "Its notes (trash included) go to the deck you pick."
                  : "It has no notes."}
              </p>
              <DeckSelect decks={decks} value={moveTo} onChange={setMoveTo} allowNone="Move notes to…" exclude={new Set([deck.id])} />
              <button
                type="button"
                disabled={pending}
                onClick={() => run(() => deleteDeck(deck.id, moveTo || null), onClose)}
                className="rounded-md border border-red-600/50 px-3 py-1.5 text-xs text-red-600 hover:bg-red-600/10 disabled:opacity-50"
              >
                Delete “{deck.name}”
              </button>
            </div>
          )}
        </div>
        {error && <p className="text-xs text-red-600">{error}</p>}
      </div>
    </Sheet>
  );
}
