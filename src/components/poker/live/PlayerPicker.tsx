"use client";

import { useMemo, useState } from "react";
import { INPUT, TagDots, TagToggles, fmtShortDay } from "./ui";
import { isBlankUnknown, type LiveTag, type PlayerSummary } from "@/lib/live/types";

type Category = "known" | "unknown";

/**
 * Find someone in the player database, or add them. Known players come first;
 * the unknowns (people seated before without a name, with whatever tags and
 * notes they got) are one tab away, so they never crowd the known ones.
 * Players last seen at this venue come first when nothing is typed; typing
 * matches the name and the description ("bald", "cap", "Russian").
 */
export function PlayerPicker({
  players,
  tags,
  exclude,
  venue,
  pending,
  onPick,
  onCreate,
  onUnknown,
  unknownLabel = "Unknown player",
  knownOnly = false,
}: {
  players: PlayerSummary[];
  tags: LiveTag[];
  /** Already at the table: shown, but not pickable. */
  exclude: Map<string, number>;
  venue: string;
  pending: boolean;
  onPick: (playerId: string) => void;
  onCreate?: (input: { name: string; description: string | null; tag_ids: string[] }) => void;
  /** Seat a fresh unknown instead. */
  onUnknown?: () => void;
  unknownLabel?: string;
  /** Only the known players (picking who an unknown really is). */
  knownOnly?: boolean;
}) {
  const [q, setQ] = useState("");
  const [category, setCategory] = useState<Category>("known");
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [tagIds, setTagIds] = useState<string[]>([]);
  const tagById = new Map(tags.map((t) => [t.id, t]));

  // Blank unknowns (a default name, nothing on them) are of no use to pick.
  const unknowns = useMemo(() => players.filter((p) => !p.known && !isBlankUnknown(p)), [players]);
  const pool = category === "known" || knownOnly ? players.filter((p) => p.known) : unknowns;

  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const scored = pool
      .filter((p) => !needle || p.name.toLowerCase().includes(needle) || (p.description ?? "").toLowerCase().includes(needle))
      .map((p) => {
        const here = p.last_seen_venue?.toLowerCase() === venue.toLowerCase();
        const starts = needle && p.name.toLowerCase().startsWith(needle);
        return { p, score: (starts ? 4 : 0) + (here ? 2 : 0), seen: p.last_seen_at ?? "" };
      });
    scored.sort((a, b) => b.score - a.score || b.seen.localeCompare(a.seen) || a.p.name.localeCompare(b.p.name));
    return scored.slice(0, 30).map((x) => x.p);
  }, [pool, q, venue]);

  if (creating && onCreate) {
    return (
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onCreate({ name, description: description.trim() || null, tag_ids: tagIds });
        }}
        className="space-y-3"
      >
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Name or nickname" className={INPUT} />
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
          placeholder="How to recognise them: looks, age, accent…"
          className={INPUT}
        />
        <TagToggles tags={tags} active={tagIds} onToggle={(id, on) => setTagIds((t) => (on ? [...t, id] : t.filter((x) => x !== id)))} />
        <div className="flex gap-2">
          <button type="button" onClick={() => setCreating(false)} className="flex-1 rounded-lg border border-line py-2.5 text-sm">
            Back
          </button>
          <button type="submit" disabled={!name.trim() || pending} className="flex-1 rounded-lg bg-accent py-2.5 text-sm font-medium text-white disabled:opacity-50">
            Add
          </button>
        </div>
      </form>
    );
  }

  return (
    <div className="space-y-2">
      {(onCreate || onUnknown) && (
        <div className="flex gap-2">
          {onUnknown && (
            <button
              type="button"
              onClick={onUnknown}
              disabled={pending}
              className="flex-1 rounded-lg bg-accent py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              {unknownLabel}
            </button>
          )}
          {onCreate && (
            <button
              type="button"
              onClick={() => {
                setName(q.trim());
                setCreating(true);
              }}
              className="flex-1 rounded-lg border border-accent py-2 text-sm font-medium text-accent"
            >
              + New player{q.trim() ? ` “${q.trim()}”` : ""}
            </button>
          )}
        </div>
      )}
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name or looks" className={INPUT} />
      {!knownOnly && (
        <div className="flex gap-1 text-xs">
          {(["known", "unknown"] as const).map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setCategory(c)}
              aria-pressed={category === c}
              className={`rounded-full border px-2.5 py-1 ${category === c ? "border-accent bg-accent text-white" : "border-line text-muted"}`}
            >
              {c === "known" ? "Known" : `Unknown · ${unknowns.length}`}
            </button>
          ))}
        </div>
      )}
      <ul className="divide-y divide-line rounded-lg border border-line">
        {list.map((p) => {
          const seat = exclude.get(p.id);
          return (
            <li key={p.id}>
              <button
                type="button"
                disabled={seat !== undefined || pending}
                onClick={() => onPick(p.id)}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm disabled:opacity-40"
              >
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className={`truncate font-medium ${p.known ? "" : "italic"}`}>{p.name}</span>
                    <TagDots tags={p.tag_ids.map((id) => tagById.get(id)).filter((t): t is LiveTag => Boolean(t))} />
                  </span>
                  {p.description && <span className="block truncate text-xs text-muted">{p.description}</span>}
                </span>
                <span className="shrink-0 text-right text-[11px] text-muted">
                  {seat !== undefined ? (
                    `seat ${seat}`
                  ) : (
                    <>
                      {p.last_seen_venue ?? ""}
                      {!p.known && p.last_seen_at && <span className="block">{fmtShortDay(p.last_seen_at)}</span>}
                    </>
                  )}
                </span>
              </button>
            </li>
          );
        })}
        {list.length === 0 && (
          <li className="px-3 py-4 text-center text-xs text-muted">
            {pool.length ? "Nobody matches." : category === "unknown" && !knownOnly ? "No unknown with tags, notes or a description yet." : "No players yet."}
          </li>
        )}
      </ul>
    </div>
  );
}
