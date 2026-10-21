"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Sheet } from "@/components/ui/Sheet";
import { Rich } from "./Rich";
import { NoteEditor, type EditableNote } from "./NoteEditor";
import { dueTomorrow, rateCard, undoReview, updateCard } from "@/server/actions/flashcards";
import { diffAnswer } from "@/lib/flashcards/text";
import { sameAnswer, sidesOf } from "@/lib/flashcards/notes";
import { nextCard } from "@/lib/flashcards/queue";
import { formatDelay, preview } from "@/lib/flashcards/scheduler";
import { RATING_LABELS, RATINGS, memoryOf, type Rating, type Settings } from "@/lib/flashcards/types";
import type { QueueItem } from "@/server/flashcards/data";

/**
 * A review session. The server built the queue; this consumes it: shows a
 * card, reveals it, takes a rating, and moves on at once while the rating is
 * saved in the background, one save after another. Cards still in their
 * steps come back into the queue here, with the due time the server
 * confirms. Undo waits for the saves in flight, then restores the last card.
 *
 * The daily limits are soft: what they held back comes with the session, and
 * once its own cards are done it offers them, with a word on what it costs.
 *
 * Keys: Space/Enter reveal · 1–4 rate · E edit · Z undo.
 * Touch: tap reveals · hold opens the card menu · swipe left Again, right Good.
 */

type From = "learning" | "review" | "fresh";
type Lists = Record<From, QueueItem[]>;
type Done = { rating: Rating; item: QueueItem; from: From; reviewId: number | null; token: number; ms: number };

const RATING_STYLES: Record<Rating, string> = {
  1: "border-red-500/40 text-red-700 dark:text-red-400",
  2: "border-amber-500/40 text-amber-700 dark:text-amber-400",
  3: "border-emerald-500/40 text-emerald-700 dark:text-emerald-400",
  4: "border-sky-500/40 text-sky-700 dark:text-sky-400",
};

function pick(lists: Lists, now: Date): { item: QueueItem; from: From } | null {
  const adapt = (l: QueueItem[]) => l.map((item) => ({ due: item.card.due, item }));
  const p = nextCard({ learning: adapt(lists.learning), review: adapt(lists.review), fresh: adapt(lists.fresh) }, now);
  return p ? { item: p.card.item, from: p.from } : null;
}

function without(lists: Lists, cardId: string): Lists {
  return {
    learning: lists.learning.filter((i) => i.card.id !== cardId),
    review: lists.review.filter((i) => i.card.id !== cardId),
    fresh: lists.fresh.filter((i) => i.card.id !== cardId),
  };
}

export function Reviewer({
  initial,
  settings,
  cram,
  deckId,
  deckName,
  heldBack,
  extra: extraInitial,
  decks,
  startedAt,
}: {
  initial: Lists;
  settings: Settings;
  cram: boolean;
  deckId: string | null;
  deckName: string | null;
  heldBack: { review: number; fresh: number };
  /** Cards past today's limits, in queue order. */
  extra: { review: QueueItem[]; fresh: QueueItem[] };
  decks: { id: string; path: string; depth: number }[];
  /** Server time when the queue was built: the first card is picked at it, on both sides. */
  startedAt: string;
}) {
  const [boot] = useState(() => {
    const p = pick(initial, new Date(startedAt));
    return { lists: p ? without(initial, p.item.card.id) : initial, current: p };
  });
  const [lists, setLists] = useState<Lists>(boot.lists);
  const [current, setCurrent] = useState<{ item: QueueItem; from: From } | null>(boot.current);
  const [revealed, setRevealed] = useState(false);
  const [typed, setTyped] = useState("");
  const [history, setHistory] = useState<Done[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  const [editing, setEditing] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [tomorrow, setTomorrow] = useState<number | null>(null);
  const [clock, setClock] = useState(() => Date.now());
  const [extra, setExtra] = useState(extraInitial);

  const shownAt = useRef(0);
  const chain = useRef<Promise<void>>(Promise.resolve());
  const tokens = useRef(0);
  const listsRef = useRef(lists);
  useEffect(() => {
    listsRef.current = lists;
  }, [lists]);

  const advance = useCallback((from: Lists) => {
    const p = pick(from, new Date());
    if (p) {
      setLists(without(from, p.item.card.id));
      setCurrent(p);
    } else {
      setLists(from);
      setCurrent(null);
    }
    setRevealed(false);
    setTyped("");
    setMenu(false);
    shownAt.current = Date.now();
  }, []);

  useEffect(() => {
    shownAt.current = Date.now();
  }, []);

  /** Go past the daily limits: bring `n` held cards of one kind into the session. */
  const goPast = useCallback(
    (kind: "review" | "fresh", n: number) => {
      const taken = extra[kind].slice(0, n);
      if (!taken.length) return;
      setExtra((e) => ({ ...e, [kind]: e[kind].slice(taken.length) }));
      setTomorrow(null);
      advance({ ...lists, [kind]: [...lists[kind], ...taken] });
    },
    [extra, lists, advance],
  );

  // While waiting for a card still in its steps, tick so it appears when due.
  const waitingFor = !current ? lists.learning.map((i) => Date.parse(i.card.due)).sort((a, b) => a - b)[0] : undefined;
  useEffect(() => {
    if (waitingFor === undefined) return;
    const id = window.setInterval(() => {
      setClock(Date.now());
      if (Date.now() >= waitingFor) advance(listsRef.current);
    }, 15_000);
    return () => window.clearInterval(id);
  }, [waitingFor, advance]);

  const finished = !current && lists.learning.length === 0;
  useEffect(() => {
    if (finished && tomorrow === null && !cram) {
      void dueTomorrow(deckId).then((n) => setTomorrow(n ?? -1));
    }
  }, [finished, tomorrow, cram, deckId]);

  const sides = useMemo(() => (current ? sidesOf(current.item.note, current.item.card.ord) : null), [current]);
  const outcomes = useMemo(
    () => (current && revealed && !cram ? preview(memoryOf(current.item.card), new Date(), settings) : null),
    [current, revealed, cram, settings],
  );

  const reveal = useCallback(() => {
    if (current && !revealed) setRevealed(true);
  }, [current, revealed]);

  const rate = useCallback(
    (rating: Rating) => {
      if (!current || !revealed) return;
      const { item, from } = current;
      const duration = Date.now() - shownAt.current;
      const token = ++tokens.current;
      let next = lists;

      if (cram) {
        if (rating === 1) next = { ...next, review: [...next.review, item] };
      } else {
        const local = preview(memoryOf(item.card), new Date(), settings)[rating];
        const m = local.memory;
        if ((m.state === "learning" || m.state === "relearning") && !local.leech) {
          const moved: QueueItem = {
            ...item,
            card: { ...item.card, state: m.state, step: m.step, stability: m.stability, difficulty: m.difficulty, due: m.due, last_review: m.lastReview, reps: m.reps, lapses: m.lapses },
          };
          next = { ...next, learning: [...next.learning, moved] };
        }
      }

      const ms = Math.min(duration, 60_000);
      setHistory((h) => [...h, { rating, item, from, reviewId: null, token, ms }]);
      setElapsedMs((t) => t + ms);
      advance(next);

      chain.current = chain.current.then(async () => {
        const res = await rateCard(item.card.id, rating, duration, cram);
        if (res.ok) {
          setHistory((h) => h.map((d) => (d.token === token ? { ...d, reviewId: res.reviewId } : d)));
          if (!cram) {
            setLists((l) => ({
              ...l,
              learning: l.learning.map((i) => (i.card.id === res.card.id ? { ...i, card: res.card } : i)),
            }));
            if (res.card.suspended && !item.card.suspended) setNotice("Leech: this card keeps slipping, so it was suspended and tagged “leech”. Rewrite it from Browse.");
          }
        } else if ("stale" in res && res.stale) {
          setHistory((h) => h.filter((d) => d.token !== token));
          setLists((l) => without(l, item.card.id));
          setNotice("That card was already reviewed on another device; it left the queue.");
        } else {
          setHistory((h) => h.filter((d) => d.token !== token));
          setLists((l) => ({ ...without(l, item.card.id), review: [item, ...l.review.filter((i) => i.card.id !== item.card.id)] }));
          setNotice(`Not saved: ${"error" in res ? res.error : "unknown error"}. The card is back in the queue.`);
        }
      });
    },
    [current, revealed, lists, cram, settings, advance],
  );

  const undo = useCallback(async () => {
    await chain.current;
    const last = history.at(-1);
    if (!last || last.reviewId === null) return;
    const res = await undoReview(last.reviewId);
    if (!res.ok) {
      setNotice(res.error);
      return;
    }
    setHistory((h) => h.slice(0, -1));
    setElapsedMs((t) => Math.max(0, t - last.ms));
    const back = { item: res.value, from: last.from };
    setLists((l) => {
      let n = without(l, last.item.card.id);
      // The card on screen goes back where it came from, at the front.
      if (current) n = { ...n, [current.from]: [current.item, ...n[current.from]] };
      return n;
    });
    setCurrent(back);
    setRevealed(false);
    setTyped("");
    shownAt.current = Date.now();
  }, [history, current]);

  const skipCurrent = useCallback(
    (patch: { suspended?: boolean; bury?: boolean }, message: string) => {
      if (!current) return;
      const id = current.item.card.id;
      setMenu(false);
      advance(lists);
      void updateCard(id, patch).then((r) => setNotice(r.ok ? message : r.error));
    },
    [current, lists, advance],
  );

  const toggleFlag = useCallback(() => {
    if (!current) return;
    const flagged = !current.item.card.flagged;
    setCurrent({ ...current, item: { ...current.item, card: { ...current.item.card, flagged } } });
    setMenu(false);
    void updateCard(current.item.card.id, { flagged }).then((r) => !r.ok && setNotice(r.error));
  }, [current]);

  // Keyboard.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (editing || e.metaKey || e.ctrlKey || e.altKey) return;
      const inField = (e.target as HTMLElement)?.closest?.("input, textarea, select");
      if (e.key === "Escape" && menu) {
        setMenu(false);
        return;
      }
      if (!revealed && (e.key === "Enter" || (e.key === " " && !inField))) {
        e.preventDefault();
        reveal();
        return;
      }
      if (inField) return;
      if (revealed && ["1", "2", "3", "4"].includes(e.key)) {
        e.preventDefault();
        rate(Number(e.key) as Rating);
      } else if (revealed && e.key === " ") {
        e.preventDefault();
        rate(3);
      } else if (e.key.toLowerCase() === "e" && current) {
        e.preventDefault();
        setEditing(true);
      } else if (e.key.toLowerCase() === "z") {
        e.preventDefault();
        void undo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [revealed, reveal, rate, undo, editing, menu, current]);

  // Touch: tap, hold, swipe.
  const touch = useRef<{ x: number; y: number; t: number; moved: boolean; timer: number | null } | null>(null);
  const [dx, setDx] = useState(0);
  const [holding, setHolding] = useState(false);
  const onPointerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest("a, button, input, textarea, select")) return;
    // A hold opens the menu on touch only: with a mouse it would fight text selection.
    const timer = e.pointerType === "mouse" ? null : window.setTimeout(() => {
      if (touch.current && !touch.current.moved) {
        setHolding(false);
        setMenu(true);
        touch.current = null;
      }
    }, 500);
    touch.current = { x: e.clientX, y: e.clientY, t: Date.now(), moved: false, timer };
    setHolding(true);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const s = touch.current;
    if (!s) return;
    const mx = e.clientX - s.x;
    const my = e.clientY - s.y;
    if (!s.moved && (Math.abs(mx) > 10 || Math.abs(my) > 10)) {
      s.moved = true;
      if (s.timer) window.clearTimeout(s.timer);
      setHolding(false);
    }
    if (revealed && settings.swipeGestures && e.pointerType !== "mouse" && Math.abs(mx) > Math.abs(my)) setDx(mx);
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const s = touch.current;
    touch.current = null;
    setHolding(false);
    setDx(0);
    if (!s) return;
    if (s.timer) window.clearTimeout(s.timer);
    const mx = e.clientX - s.x;
    const my = e.clientY - s.y;
    if (!s.moved) {
      if (!revealed) reveal();
      return;
    }
    if (revealed && settings.swipeGestures && e.pointerType !== "mouse" && Math.abs(mx) > 90 && Math.abs(my) < 60) {
      rate(mx < 0 ? 1 : 3);
    }
  };

  const remaining = {
    fresh: lists.fresh.length + (current?.from === "fresh" ? 1 : 0),
    learning: lists.learning.length + (current?.from === "learning" ? 1 : 0),
    review: lists.review.length + (current?.from === "review" ? 1 : 0),
  };
  const canUndo = history.length > 0;

  /* --------------------------------------------------------------- views */

  if (finished) {
    const by = (r: Rating) => history.filter((d) => d.rating === r).length;
    const minutes = Math.round(elapsedMs / 60_000);
    return (
      <main className="mx-auto w-full max-w-lg px-5 py-14 text-sm">
        <h1 className="text-xl font-semibold tracking-tight">{history.length ? "Session done" : extra.review.length + extra.fresh.length > 0 && !cram ? "Today’s limits are reached" : "Nothing to study"}</h1>
        {history.length > 0 ? (
          <>
            <p className="mt-2 text-muted">
              {history.length} card{history.length > 1 ? "s" : ""} in {minutes < 1 ? "under a minute" : `${minutes} min`}
              {deckName ? ` · ${deckName}` : ""}
              {cram ? " · cram, nothing rescheduled" : ""}
            </p>
            <div className="mt-6 grid grid-cols-4 gap-2">
              {RATINGS.map((r) => (
                <div key={r} className={`rounded-lg border px-2 py-3 text-center ${RATING_STYLES[r]}`}>
                  <div className="text-lg font-semibold tabular-nums">{by(r)}</div>
                  <div className="text-xs">{RATING_LABELS[r]}</div>
                </div>
              ))}
            </div>
          </>
        ) : extra.review.length + extra.fresh.length > 0 && !cram ? null : (
          <p className="mt-2 text-muted">
            {cram ? "This selection has no cards to cram." : "No card is due in this deck right now."}
          </p>
        )}
        {!cram && tomorrow !== null && tomorrow >= 0 && (
          <p className="mt-6 text-muted">
            Tomorrow: <span className="text-foreground">{tomorrow}</span> card{tomorrow === 1 ? "" : "s"} due.
          </p>
        )}
        {!cram && extra.review.length + extra.fresh.length > 0 && (
          <div className="mt-6 rounded-lg border border-amber-500/40 bg-amber-500/5 px-4 py-3">
            <p className="font-medium text-amber-700 dark:text-amber-400">Today’s limits are reached</p>
            <p className="mt-1 text-muted">
              {[extra.review.length ? `${extra.review.length} due` : "", extra.fresh.length ? `${extra.fresh.length} new` : ""]
                .filter(Boolean)
                .join(" and ")}{" "}
              card{extra.review.length + extra.fresh.length > 1 ? "s are" : " is"} still waiting. You can keep going:
              {extra.review.length > 0 && " overdue reviews are fine to catch up on,"}
              {extra.fresh.length > 0 && " but every new card adds reviews to the coming days."}
              {extra.fresh.length === 0 && " nothing is lost by stopping here either."}
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              {extra.review.length > 0 && (
                <button
                  type="button"
                  onClick={() => goPast("review", extra.review.length)}
                  className="rounded-md border border-line bg-surface px-3 py-1.5 hover:border-accent"
                >
                  Review {extra.review.length} more due
                </button>
              )}
              {extra.fresh.length > 0 && (
                <button
                  type="button"
                  onClick={() => goPast("fresh", 10)}
                  className="rounded-md border border-line bg-surface px-3 py-1.5 hover:border-accent"
                >
                  Learn {Math.min(10, extra.fresh.length)} more new
                </button>
              )}
              {extra.fresh.length > 10 && (
                <button
                  type="button"
                  onClick={() => {
                    if (window.confirm(`Add all ${extra.fresh.length} new cards to this session? They will all come back for review in the next days.`)) {
                      goPast("fresh", extra.fresh.length);
                    }
                  }}
                  className="rounded-md border border-line bg-surface px-3 py-1.5 hover:border-accent"
                >
                  All {extra.fresh.length} new
                </button>
              )}
            </div>
          </div>
        )}
        {!cram && extra.review.length + extra.fresh.length === 0 && heldBack.fresh + heldBack.review > 0 && (
          <p className="mt-2 text-muted">You went past today’s limits.</p>
        )}
        {notice && <p className="mt-4 text-xs text-muted">{notice}</p>}
        <div className="mt-8 flex flex-wrap gap-3">
          <Link href="/flashcards" className="rounded-md bg-accent px-4 py-2 text-white">
            Back to decks
          </Link>
          {canUndo && (
            <button type="button" onClick={() => void undo()} className="rounded-md border border-line px-4 py-2 hover:border-accent">
              Undo last
            </button>
          )}
          <Link href={`/flashcards/stats${deckId ? `?deck=${deckId}` : ""}`} className="rounded-md border border-line px-4 py-2 hover:border-accent">
            Stats
          </Link>
        </div>
      </main>
    );
  }

  if (!current) {
    const inMin = waitingFor ? Math.max(1, Math.round((waitingFor - clock) / 60_000)) : 0;
    return (
      <main className="mx-auto w-full max-w-lg px-5 py-14 text-sm">
        <h1 className="text-lg font-semibold tracking-tight">Next card in {inMin} min</h1>
        <p className="mt-2 text-muted">
          {lists.learning.length} card{lists.learning.length > 1 ? "s are" : " is"} still in learning steps. Stay here and it
          shows when due, or come back later: progress is saved.
        </p>
        <div className="mt-6 flex gap-3">
          <button
            type="button"
            onClick={() => {
              const [first, ...rest] = [...lists.learning].sort((a, b) => Date.parse(a.card.due) - Date.parse(b.card.due));
              setLists({ ...lists, learning: rest });
              setCurrent({ item: first, from: "learning" });
              setRevealed(false);
              shownAt.current = Date.now();
            }}
            className="rounded-md bg-accent px-4 py-2 text-white"
          >
            Study it now
          </button>
          <Link href="/flashcards" className="rounded-md border border-line px-4 py-2 hover:border-accent">
            Done for now
          </Link>
        </div>
      </main>
    );
  }

  const { item } = current;
  const card = item.card;
  const isCloze = item.note.kind === "cloze";
  const expected = sides?.expected ?? null;

  return (
    <main className="flex h-[calc(100dvh-3rem)] flex-col">
      {/* Where we are, and the session's controls. */}
      <div className="flex h-10 shrink-0 items-center gap-3 border-b border-line px-3 text-xs text-muted sm:px-5">
        <span className="tabular-nums">
          <span className={current.from === "fresh" ? "font-semibold text-sky-600 underline underline-offset-4 dark:text-sky-400" : "text-sky-600 dark:text-sky-400"}>{remaining.fresh}</span>
          {" · "}
          <span className={current.from === "learning" ? "font-semibold text-amber-600 underline underline-offset-4 dark:text-amber-400" : "text-amber-600 dark:text-amber-400"}>{remaining.learning}</span>
          {" · "}
          <span className={current.from === "review" ? "font-semibold text-emerald-600 underline underline-offset-4 dark:text-emerald-400" : "text-emerald-600 dark:text-emerald-400"}>{remaining.review}</span>
        </span>
        <span className="min-w-0 truncate">
          {cram ? "Cram · " : ""}
          {item.deckPath}
        </span>
        {card.flagged && <span title="Flagged">⚑</span>}
        <div className="ml-auto flex items-center gap-1">
          <button type="button" disabled={!canUndo} onClick={() => void undo()} className="rounded px-2 py-1 hover:text-foreground disabled:opacity-40" title="Undo (Z)">
            Undo
          </button>
          <button type="button" onClick={() => setMenu((m) => !m)} className="rounded px-2 py-1 text-base leading-none hover:text-foreground" aria-label="Card menu">
            ⋯
          </button>
          <Link href="/flashcards" className="rounded px-2 py-1 hover:text-foreground">
            Quit
          </Link>
        </div>
      </div>

      {notice && (
        <button type="button" onClick={() => setNotice(null)} className="shrink-0 border-b border-line bg-amber-500/10 px-4 py-2 text-left text-xs">
          {notice} <span className="text-muted">(dismiss)</span>
        </button>
      )}

      <div
        className={`fc-card min-h-0 flex-1 touch-pan-y overflow-y-auto px-4 py-6 sm:px-10 sm:py-10 ${holding ? "fc-holding" : ""}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          if (touch.current?.timer) window.clearTimeout(touch.current.timer);
          touch.current = null;
          setHolding(false);
          setDx(0);
        }}
        style={dx ? { transform: `translateX(${dx * 0.35}px)`, transition: "none" } : { transition: "transform 150ms" }}
      >
        <div className="mx-auto max-w-2xl">
          {dx !== 0 && (
            <p className={`mb-3 text-center text-xs ${dx < 0 ? "text-red-600" : "text-emerald-600"}`}>
              {Math.abs(dx) > 90 ? (dx < 0 ? "Release: Again" : "Release: Good") : dx < 0 ? "← Again" : "Good →"}
            </p>
          )}

          {!(revealed && isCloze) && <Rich source={sides!.question} className="text-lg leading-relaxed" />}

          {expected !== null && !revealed && (
            <input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder="Type the answer, then Enter"
              autoFocus
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              className="mt-6 w-full rounded-md border border-line bg-surface px-3 py-2 text-base outline-none focus:border-accent"
            />
          )}

          {revealed && (
            <>
              {!isCloze && <hr className="my-6 border-line" />}
              {expected !== null && (
                <p className="mb-4 rounded-md border border-line bg-surface px-3 py-2 font-mono text-sm">
                  {typed.trim() === "" ? (
                    <span className="text-muted">(nothing typed)</span>
                  ) : sameAnswer(typed, expected) ? (
                    <span className="text-emerald-600 dark:text-emerald-400">✓ {typed}</span>
                  ) : (
                    diffAnswer(expected, typed.trim()).map((p, i) => (
                      <span
                        key={i}
                        className={
                          p.kind === "same"
                            ? "text-emerald-600 dark:text-emerald-400"
                            : p.kind === "missing"
                              ? "bg-amber-500/20 text-amber-700 dark:text-amber-300"
                              : "text-red-600 line-through"
                        }
                      >
                        {p.text}
                      </span>
                    ))
                  )}
                </p>
              )}
              <Rich source={sides!.answer} className="text-lg leading-relaxed" />
              {item.note.extra && (
                <div className="mt-6 border-t border-line pt-4 text-muted">
                  <Rich source={item.note.extra} className="text-sm" />
                </div>
              )}
              {(item.note.source || item.note.tags.length > 0) && (
                <p className="mt-6 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted">
                  {item.note.source && (
                    <a href={item.note.source} target={item.note.source.startsWith("/") ? undefined : "_blank"} rel="noreferrer noopener" className="text-accent hover:underline">
                      Source ↗
                    </a>
                  )}
                  {item.note.tags.map((t) => (
                    <span key={t}>#{t}</span>
                  ))}
                </p>
              )}
            </>
          )}
        </div>
      </div>

      {/* The only actions: reveal, then rate. Thumb-reachable on a phone. */}
      <div className="shrink-0 border-t border-line px-3 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] sm:px-5">
        {!revealed ? (
          <button type="button" onClick={reveal} className="mx-auto block w-full max-w-2xl rounded-lg bg-accent py-3 text-sm font-medium text-white">
            Show answer <span className="ml-2 hidden text-white/70 sm:inline">space</span>
          </button>
        ) : (
          <div className="mx-auto grid max-w-2xl grid-cols-4 gap-2">
            {RATINGS.map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => rate(r)}
                className={`rounded-lg border bg-surface py-2 text-sm hover:bg-background ${RATING_STYLES[r]}`}
              >
                <span className="block font-medium">{RATING_LABELS[r]}</span>
                <span className="block text-xs opacity-80">
                  {outcomes ? formatDelay(outcomes[r].inMs) : cram ? (r === 1 ? "again" : "ok") : ""}
                  <span className="ml-1 hidden opacity-60 sm:inline">{r}</span>
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {menu && (
        <Sheet title="This card" onClose={() => setMenu(false)}>
          <div className="grid gap-2 text-sm">
            <button type="button" onClick={() => { setMenu(false); setEditing(true); }} className="rounded-md border border-line bg-surface px-3 py-2.5 text-left hover:border-accent">
              Edit note <span className="float-right text-xs text-muted">E</span>
            </button>
            <button type="button" onClick={toggleFlag} className="rounded-md border border-line bg-surface px-3 py-2.5 text-left hover:border-accent">
              {card.flagged ? "Remove flag" : "Flag"}
            </button>
            <button type="button" onClick={() => skipCurrent({ bury: true }, "Buried until tomorrow.")} className="rounded-md border border-line bg-surface px-3 py-2.5 text-left hover:border-accent">
              Bury until tomorrow
            </button>
            <button type="button" onClick={() => skipCurrent({ suspended: true }, "Suspended. Unsuspend it from Browse.")} className="rounded-md border border-line bg-surface px-3 py-2.5 text-left hover:border-accent">
              Suspend
            </button>
            {item.note.source && (
              <a href={item.note.source} target="_blank" rel="noreferrer noopener" className="rounded-md border border-line bg-surface px-3 py-2.5 hover:border-accent">
                Open source ↗
              </a>
            )}
            <Link href={`/flashcards/notes/${item.note.id}`} className="rounded-md border border-line bg-surface px-3 py-2.5 hover:border-accent">
              Note page, card history
            </Link>
            <p className="pt-2 text-xs text-muted">
              {card.state === "new"
                ? "New card."
                : `${card.reps} rating${card.reps > 1 ? "s" : ""} · ${card.lapses} lapse${card.lapses === 1 ? "" : "s"} · stability ${card.stability.toFixed(1)} d · difficulty ${card.difficulty.toFixed(1)}`}
            </p>
          </div>
        </Sheet>
      )}

      {editing && (
        <Sheet title="Edit note" onClose={() => setEditing(false)} wide>
          <NoteEditor
            decks={decks}
            note={{ ...item.note } as EditableNote}
            compact
            onSaved={(n) => {
              setEditing(false);
              const patchNote = (i: QueueItem): QueueItem => (i.note.id === n.id ? { ...i, note: { ...i.note, ...n } } : i);
              setCurrent((c) => (c ? { ...c, item: patchNote(c.item) } : c));
              setLists((l) => ({ learning: l.learning.map(patchNote), review: l.review.map(patchNote), fresh: l.fresh.map(patchNote) }));
            }}
          />
        </Sheet>
      )}
    </main>
  );
}
