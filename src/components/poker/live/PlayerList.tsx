"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { INPUT, TagDots, TagToggles, fmtDay } from "./ui";
import { useAction } from "@/components/jobs/controls";
import { ErrorLine, TagChip } from "@/components/jobs/bits";
import { isBlankUnknown, type LiveTag, type PlayerSummary } from "@/lib/live/types";
import { createPlayer } from "@/server/actions/live";

/**
 * The player database: search by name or looks, filter by tag. Known players
 * and unknowns (seated without a name) are two lists, so the strangers of
 * every session never bury the people Arthur knows. Unknowns with nothing on
 * them — the default name, no tag, note or description — are hidden unless
 * asked for.
 */
export function PlayerList({ players, tags }: { players: PlayerSummary[]; tags: LiveTag[] }) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<string[]>([]);
  const [category, setCategory] = useState<"known" | "unknown">("known");
  const [showBlank, setShowBlank] = useState(false);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [tagIds, setTagIds] = useState<string[]>([]);
  const { pending, error, run } = useAction();
  const tagById = new Map(tags.map((t) => [t.id, t]));

  const known = players.filter((p) => p.known);
  const unknowns = players.filter((p) => !p.known);
  const blank = unknowns.filter(isBlankUnknown).length;

  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return players
      .filter((p) => (category === "known" ? p.known : !p.known && (showBlank || !isBlankUnknown(p))))
      .filter((p) => !needle || p.name.toLowerCase().includes(needle) || (p.description ?? "").toLowerCase().includes(needle))
      .filter((p) => filter.every((t) => p.tag_ids.includes(t)))
      .sort((a, b) => (b.last_seen_at ?? "").localeCompare(a.last_seen_at ?? "") || a.name.localeCompare(b.name));
  }, [players, q, filter, category, showBlank]);

  return (
    <main className="mx-auto h-full w-full max-w-2xl overflow-y-auto px-4 py-5 sm:px-6 sm:py-8">
      <div className="flex items-center gap-2">
        <h1 className="flex-1 text-lg font-semibold tracking-tight">Players</h1>
        <button type="button" onClick={() => setAdding((x) => !x)} className="rounded-lg border border-accent px-3 py-1.5 text-sm text-accent">
          {adding ? "Close" : "+ New"}
        </button>
      </div>

      {adding && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            run(async () => {
              const r = await createPlayer({ name, description: description || null, tag_ids: tagIds });
              if (r.ok) router.push(`/poker/live/players/${r.id}`);
              return r;
            });
          }}
          className="mt-3 space-y-2 rounded-xl border border-line bg-surface p-3"
        >
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Name or nickname" className={INPUT} />
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} placeholder="How to recognise them" className={INPUT} />
          <TagToggles tags={tags} active={tagIds} onToggle={(id, on) => setTagIds((t) => (on ? [...t, id] : t.filter((x) => x !== id)))} />
          <ErrorLine error={error} />
          <button type="submit" disabled={pending || !name.trim()} className="w-full rounded-lg bg-accent py-2.5 text-sm font-medium text-white disabled:opacity-50">
            Add
          </button>
        </form>
      )}

      <div className="mt-4 flex items-center gap-1 text-xs">
        {(["known", "unknown"] as const).map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => setCategory(c)}
            aria-pressed={category === c}
            className={`rounded-full border px-3 py-1 ${category === c ? "border-accent bg-accent text-white" : "border-line text-muted"}`}
          >
            {c === "known" ? `Known · ${known.length}` : `Unknown · ${unknowns.length - blank}`}
          </button>
        ))}
        {category === "unknown" && blank > 0 && (
          <button type="button" onClick={() => setShowBlank((x) => !x)} className="ml-auto text-muted underline">
            {showBlank ? "Hide" : "Show"} {blank} blank
          </button>
        )}
      </div>
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name or description" className={`${INPUT} mt-2`} />
      {tags.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {tags.map((t) => (
            <TagChip
              key={t.id}
              tag={t}
              active={filter.includes(t.id)}
              onClick={() => setFilter((f) => (f.includes(t.id) ? f.filter((x) => x !== t.id) : [...f, t.id]))}
            />
          ))}
        </div>
      )}

      <ul className="mt-3 divide-y divide-line rounded-xl border border-line bg-surface">
        {list.map((p) => (
          <li key={p.id}>
            <Link href={`/poker/live/players/${p.id}`} className="flex items-center gap-3 px-3 py-2.5">
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className={`truncate text-sm font-medium ${p.known ? "" : "italic"}`}>{p.name}</span>
                  <TagDots tags={p.tag_ids.map((id) => tagById.get(id)).filter((t): t is LiveTag => Boolean(t))} />
                </span>
                {p.description && <span className="block truncate text-xs text-muted">{p.description}</span>}
              </span>
              <span className="shrink-0 text-right text-[11px] text-muted">
                {p.last_seen_at ? (
                  <>
                    {fmtDay(p.last_seen_at)}
                    {p.last_seen_venue && <span className="block">{p.last_seen_venue}</span>}
                  </>
                ) : (
                  "not seen yet"
                )}
                {p.note_count > 0 && <span className="block">{p.note_count} note{p.note_count > 1 ? "s" : ""}</span>}
              </span>
            </Link>
          </li>
        ))}
        {list.length === 0 && (
          <li className="px-3 py-8 text-center text-xs text-muted">
            {category === "unknown"
              ? unknowns.length
                ? "No unknown matches. Tag, describe or note an unknown at the table and it shows here."
                : "No unknown players yet. Every new session seats one per empty seat."
              : players.length
                ? "Nobody matches."
                : "No players yet. They are added from the table, or with + New."}
          </li>
        )}
      </ul>
    </main>
  );
}
