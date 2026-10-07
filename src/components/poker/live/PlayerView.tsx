"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { PlayerNotes } from "./PlayerNotes";
import { NetText, TagToggles, fmtDay, fmtShortDay } from "./ui";
import { InlineText, useAction } from "@/components/jobs/controls";
import { ErrorLine } from "@/components/jobs/bits";
import { BoardCards, PlayingCard } from "@/components/poker/trainer/Cards";
import { positions } from "@/lib/live/hand";
import { splitCards, type LiveHand, type LivePlayer, type LiveTag, type PlayerNote } from "@/lib/live/types";
import { deletePlayer, setTags, updatePlayer } from "@/server/actions/live";

export type PlayerDetail = {
  player: LivePlayer;
  tagIds: string[];
  tags: LiveTag[];
  notes: PlayerNote[];
  sessions: { id: string; venue: string; started_at: string; seat: number }[];
  hands: (LiveHand & { venue: string | null; currency: string })[];
};

/** One player: who they are, how to spot them, the notes, where you met, the hands. */
export function PlayerView({ detail }: { detail: PlayerDetail }) {
  const { player, tagIds, tags, notes, sessions, hands } = detail;
  const router = useRouter();
  const { pending, error, run } = useAction();
  const sessionLabels = Object.fromEntries(sessions.map((s) => [s.id, `${s.venue}, ${fmtDay(s.started_at)}`]));

  return (
    <main className={`mx-auto h-full w-full max-w-2xl overflow-y-auto px-4 py-5 sm:px-6 sm:py-8 ${pending ? "opacity-80" : ""}`}>
      <Link href="/poker/live/players" className="text-xs text-muted hover:text-foreground">
        ← Players
      </Link>
      <h1 className="mt-2 text-xl font-semibold tracking-tight">
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
