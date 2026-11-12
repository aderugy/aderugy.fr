"use client";

import { useMemo, useState } from "react";
import { HandRow } from "./SessionParts";
import { INPUT, NetText, fmtShortDay } from "./ui";
import { allInLuck } from "@/lib/live/allin";
import { positions } from "@/lib/live/hand";
import { fmtMoney, splitCards } from "@/lib/live/types";
import type { HandListItem } from "@/server/live/data";

type Filter = "all" | "starred" | "allin" | "notes";

const RANKS = "23456789TJQKA";

/** "AsKd" → "AKo", "8c8s" → "88", "7c8c" → "87s". */
function handClass(cards: string | null): string | null {
  const c = splitCards(cards);
  if (!c) return null;
  const [a, b] = [c[0], c[1]].sort(
    (x, y) => RANKS.indexOf(y[0]) - RANKS.indexOf(x[0]),
  );
  if (a[0] === b[0]) return a[0] + b[0];
  return a[0] + b[0] + (a[1] === b[1] ? "s" : "o");
}

/**
 * Every hand, across sessions, newest first, grouped by session. Filters:
 * starred, all-ins, hands with notes; a position; hole cards ("AK", "AKs",
 * "88").
 */
export function HandsList({ hands }: { hands: HandListItem[] }) {
  const [filter, setFilter] = useState<Filter>("all");
  const [pos, setPos] = useState("");
  const [q, setQ] = useState("");

  const withPos = useMemo(
    () =>
      hands.map((h) => ({
        h,
        pos: h.hero_seat
          ? (positions(
              h.seats.map((s) => s.seat),
              h.button_seat,
            ).get(h.hero_seat) ?? null)
          : null,
        cls: handClass(h.hero_cards),
      })),
    [hands],
  );
  const posOptions = useMemo(
    () =>
      [
        ...new Set(withPos.map((x) => x.pos).filter((p): p is string => !!p)),
      ].sort(),
    [withPos],
  );

  const needle = q.trim().toUpperCase().replace(/\s+/g, "");
  const shown = withPos.filter(({ h, pos: p, cls }) => {
    if (filter === "starred" && !h.starred) return false;
    if (filter === "allin" && !h.allin) return false;
    if (filter === "notes" && !h.notes) return false;
    if (pos && p !== pos) return false;
    if (needle) {
      if (!cls) return false;
      const want = needle.replace(/[SO]$/, (m) => m.toLowerCase());
      if (!(cls === want || (want.length === 2 && cls.slice(0, 2) === want)))
        return false;
    }
    return true;
  });

  // Group by session, keeping the newest-first order.
  const groups: { id: string; items: typeof shown }[] = [];
  for (const x of shown) {
    const last = groups[groups.length - 1];
    if (last && last.id === x.h.session_id) last.items.push(x);
    else groups.push({ id: x.h.session_id, items: [x] });
  }

  const currency = hands[0]?.currency ?? "€";
  const net =
    Math.round(shown.reduce((t, x) => t + (x.h.hero_net ?? 0), 0) * 100) / 100;
  const luck = allInLuck(shown.map((x) => x.h));

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-2xl px-3 py-4 sm:px-5">
        <div className="flex flex-wrap gap-1.5 text-xs">
          {(
            [
              ["all", "All"],
              ["starred", "★ Starred"],
              ["allin", "All-ins"],
              ["notes", "With notes"],
            ] as [Filter, string][]
          ).map(([v, label]) => (
            <button
              key={v}
              type="button"
              aria-pressed={filter === v}
              onClick={() => setFilter(v)}
              className={`rounded-full border px-2.5 py-0.5 ${filter === v ? "border-foreground bg-foreground text-background" : "border-line text-muted hover:text-foreground"}`}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="mt-2 flex gap-2">
          <div className="min-w-0 flex-1">
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Cards: AK, AKs, 88…"
              className={INPUT}
            />
          </div>
          <div className="w-32 shrink-0">
            <select
              value={pos}
              onChange={(e) => setPos(e.target.value)}
              className={INPUT}
              aria-label="Position"
            >
              <option value="">Position</option>
              {posOptions.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </div>
        </div>

        <p className="mt-3 text-xs text-muted">
          {shown.length} hand{shown.length === 1 ? "" : "s"} ·{" "}
          <NetText value={net} currency={currency} />
          {luck.hands > 0 && (
            <>
              {" "}
              · {luck.hands} all-in{luck.hands > 1 ? "s" : ""}, luck{" "}
              {fmtMoney(luck.luck, currency, true)}
            </>
          )}
        </p>

        {groups.length === 0 ? (
          <p className="mt-6 text-center text-sm text-muted">
            No hand matches.
          </p>
        ) : (
          groups.map((g) => {
            const first = g.items[0].h;
            const sum =
              Math.round(
                g.items.reduce((t, x) => t + (x.h.hero_net ?? 0), 0) * 100,
              ) / 100;
            return (
              <section key={g.id} className="mt-4">
                <h2 className="mb-1 flex items-baseline gap-2 text-xs text-muted">
                  <span className="font-medium text-foreground">
                    {fmtShortDay(first.session_started_at)}
                  </span>
                  <span className="truncate">{first.venue}</span>
                  <span className="ml-auto shrink-0 tabular-nums">
                    {g.items.length} ·{" "}
                    <NetText value={sum} currency={first.currency} />
                  </span>
                </h2>
                <ul className="divide-y divide-line rounded-xl border border-line bg-surface">
                  {g.items.map(({ h }) => (
                    <HandRow
                      key={h.id}
                      hand={h}
                      sessionId={h.session_id}
                      currency={h.currency}
                    />
                  ))}
                </ul>
              </section>
            );
          })
        )}
      </div>
    </div>
  );
}
