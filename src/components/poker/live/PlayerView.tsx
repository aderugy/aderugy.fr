"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { PlayerNotes } from "./PlayerNotes";
import { PlayerPicker } from "./PlayerPicker";
import { INPUT, NetText, TagToggles, fmtDay, fmtShortDay } from "./ui";
import { InlineText, useAction } from "@/components/jobs/controls";
import { ErrorLine } from "@/components/jobs/bits";
import { BoardCards, PlayingCard } from "@/components/poker/trainer/Cards";
import { positions } from "@/lib/live/hand";
import { splitCards, type LiveHand, type LivePlayer, type LiveTag, type PlayerNote, type PlayerSummary } from "@/lib/live/types";
import { deletePlayer, mergePlayers, promotePlayer, setTags, updatePlayer } from "@/server/actions/live";

export type PlayerDetail = {
  player: LivePlayer;
  tagIds: string[];
  tags: LiveTag[];
  notes: PlayerNote[];
  sessions: { id: string; venue: string; started_at: string; seat: number }[];
  hands: (LiveHand & { venue: string | null; currency: string })[];
  /** For an unknown player: the known ones they may turn out to be. */
  knownPlayers: PlayerSummary[];
};

/** One player: who they are, how to spot them, the notes, where you met, the hands. */
export function PlayerView({ detail }: { detail: PlayerDetail }) {
  const { player, tagIds, tags, notes, sessions, hands, knownPlayers } = detail;
  const router = useRouter();
  const { pending, error, run } = useAction();
  const sessionLabels = Object.fromEntries(sessions.map((s) => [s.id, `${s.venue}, ${fmtDay(s.started_at)}`]));

  return (
    <main className={`mx-auto h-full w-full max-w-2xl overflow-y-auto px-4 py-5 sm:px-6 sm:py-8 ${pending ? "opacity-80" : ""}`}>
      <Link href="/poker/live/players" className="text-xs text-muted hover:text-foreground">
        ← Players
      </Link>
      {!player.known && <Upgrade player={player} tags={tags} knownPlayers={knownPlayers} venue={sessions[0]?.venue ?? ""} />}
      <h1 className={`mt-2 text-xl font-semibold tracking-tight ${player.known ? "" : "italic"}`}>
        <InlineText value={player.name} onSave={(v) => run(() => updatePlayer(player.id, { name: v }))} className="w-full" />
      </h1>
      <div className="mt-1 text-sm">
        <InlineText
          value={player.description ?? ""}
          placeholder="+ How to recognise them"
          onSave={(v) => run(() => updatePlayer(player.id, { description: v || null }))}
          className="w-full"
        />
      </div>
      <div className="mt-3">
        <TagToggles
          tags={tags}
          active={tagIds}
          disabled={pending}
          onToggle={(id, on) => run(() => setTags(player.id, on ? [...tagIds, id] : tagIds.filter((x) => x !== id)))}
        />
      </div>
      <ErrorLine error={error} />

      <section className="mt-6">
        <h2 className="mb-1 text-xs font-medium tracking-wide text-muted uppercase">Notes</h2>
        <PlayerNotes playerId={player.id} notes={notes} sessionLabels={sessionLabels} />
      </section>

      <section className="mt-6">
        <h2 className="mb-1 text-xs font-medium tracking-wide text-muted uppercase">Sessions together · {sessions.length}</h2>
        {sessions.length === 0 ? (
          <p className="text-xs text-muted">Not seated in any session yet.</p>
        ) : (
          <ul className="space-y-0.5 text-sm">
            {sessions.map((s) => (
              <li key={s.id}>
                <Link href={`/poker/live/${s.id}`} className="hover:underline">
                  {fmtDay(s.started_at)} · {s.venue} <span className="text-xs text-muted">· seat {s.seat}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mt-6">
        <h2 className="mb-1 text-xs font-medium tracking-wide text-muted uppercase">Hands with them · {hands.length}</h2>
        {hands.length === 0 ? (
          <p className="text-xs text-muted">None entered.</p>
        ) : (
          <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
            {hands.map((h) => {
              const theirSeat = h.seats.find((s) => s.player_id === player.id)?.seat;
              const pos = positions(h.seats.map((s) => s.seat), h.button_seat);
              const shown = theirSeat ? splitCards(h.shown[String(theirSeat)]) : null;
              return (
                <li key={h.id}>
                  <Link href={`/poker/live/${h.session_id}/hands/${h.id}`} className="flex items-center gap-2 px-3 py-2 text-xs">
                    <span className="w-20 shrink-0 truncate text-muted">{fmtShortDay(h.played_at)}</span>
                    <span className="w-14 shrink-0">{theirSeat ? `${pos.get(theirSeat) ?? ""}` : ""}</span>
                    <span className="flex w-10 shrink-0 gap-0.5">
                      {shown && (
                        <>
                          <PlayingCard card={shown[0]} size="xs" />
                          <PlayingCard card={shown[1]} size="xs" />
                        </>
                      )}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{h.board.length > 0 && <BoardCards cards={h.board} size="xs" />}</span>
                    {h.starred && <span className="text-amber-500">★</span>}
                    <NetText value={h.hero_net} currency={h.currency} />
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <button
        type="button"
        onClick={() =>
          confirm(`Delete ${player.name} and their notes? Hands and sessions keep the seat, without the name.`) &&
          run(() => deletePlayer(player.id), () => router.push("/poker/live/players"))
        }
        className="mt-8 text-xs text-muted underline hover:text-red-500"
      >
        Delete this player
      </button>
    </main>
  );
}

/**
 * An unknown player becomes a real one: give them a name (they join the known
 * players as they are), or say who they are (everything on them moves to that
 * player, and this page goes).
 */
function Upgrade({
  player,
  tags,
  knownPlayers,
  venue,
}: {
  player: LivePlayer;
  tags: LiveTag[];
  knownPlayers: PlayerSummary[];
  venue: string;
}) {
  const router = useRouter();
  const { pending, error, run } = useAction();
  const [mode, setMode] = useState<null | "name" | "merge">(null);
  const [name, setName] = useState("");
  return (
    <div className="mt-3 rounded-xl border border-dashed border-line bg-surface p-3 text-sm">
      <p className="text-xs text-muted">Unknown player — not in your known players until named.</p>
      {mode === null && (
        <div className="mt-2 grid grid-cols-2 gap-2">
          <button type="button" onClick={() => setMode("name")} className="rounded-lg border border-accent py-2 text-sm font-medium text-accent">
            Name them
          </button>
          <button type="button" onClick={() => setMode("merge")} className="rounded-lg border border-line py-2 text-sm">
            It’s someone I know
          </button>
        </div>
      )}
      {mode === "name" && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            run(() => promotePlayer(player.id, name), () => setMode(null));
          }}
          className="mt-2 flex gap-2"
        >
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Name or nickname" className={INPUT} />
          <button type="submit" disabled={pending || !name.trim()} className="shrink-0 rounded-lg bg-accent px-3 text-sm font-medium text-white disabled:opacity-50">
            Save
          </button>
        </form>
      )}
      {mode === "merge" && (
        <div className="mt-2">
          <p className="mb-2 text-xs text-muted">Their tags, notes, description, seats and hands move to the player you pick.</p>
          <PlayerPicker
            players={knownPlayers}
            tags={tags}
            exclude={new Map()}
            venue={venue}
            pending={pending}
            knownOnly
            onPick={(id) => run(() => mergePlayers(player.id, id, false), () => router.replace(`/poker/live/players/${id}`))}
          />
        </div>
      )}
      <ErrorLine error={error} />
      {mode !== null && (
        <button type="button" onClick={() => setMode(null)} className="mt-2 text-xs text-muted underline">
          Cancel
        </button>
      )}
    </div>
  );
}
