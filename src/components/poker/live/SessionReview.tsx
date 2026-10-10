"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { HandRow, Timeline } from "./SessionParts";
import { Field, INPUT, NetText, fmtClock, fmtDay, fromLocalInput, toLocalInput } from "./ui";
import { useAction } from "@/components/jobs/controls";
import { ErrorLine } from "@/components/jobs/bits";
import { NotesEditor } from "@/components/ui/NotesEditor";
import { fmtDuration, summarize } from "@/lib/live/session";
import { fmtChips, fmtMoney, fmtStakes } from "@/lib/live/types";
import type { SessionBundle } from "@/server/live/data";
import { deleteSession, reopenSession, updateMoney, updateSession } from "@/server/actions/live";

/** A finished session: the result, who was there, the hands, the log. */
export function SessionReview({ data }: { data: SessionBundle }) {
  const { session, events, seatEvents, hands, players } = data;
  const router = useRouter();
  const { pending, error, run } = useAction();
  const [editing, setEditing] = useState(false);
  const sum = summarize(session, events);
  const playerById = useMemo(() => new Map(players.map((p) => [p.id, p])), [players]);

  // Everyone who sat at this table, in order of arrival.
  // Known players first, then the unknowns — still worth naming afterwards.
  const met: { id: string; name: string; seat: number; at: string; known: boolean }[] = [];
  for (const e of seatEvents) {
    if (e.kind === "sit" && e.player_id && !met.some((m) => m.id === e.player_id)) {
      const p = playerById.get(e.player_id);
      met.push({ id: e.player_id, name: p?.name ?? "?", seat: e.seat, at: e.at, known: p?.known ?? true });
    }
  }
  met.sort((a, b) => Number(b.known) - Number(a.known));
  const unknown = seatEvents.filter((e) => e.kind === "sit" && !e.player_id).length;
  const starred = hands.filter((h) => h.starred).length;

  return (
    <main className={`mx-auto h-full w-full max-w-2xl overflow-y-auto px-4 py-5 sm:px-6 sm:py-8 ${pending ? "opacity-80" : ""}`}>
      <Link href="/poker/live" className="text-xs text-muted hover:text-foreground">
        ← Sessions
      </Link>
      <div className="mt-2 flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-lg font-semibold tracking-tight">{session.venue}</h1>
          <p className="text-xs text-muted">
            {fmtDay(session.started_at)} · {fmtClock(session.started_at)}–{session.ended_at ? fmtClock(session.ended_at) : ""} · {fmtStakes(session)}{" "}
            {session.game} · {session.seats}-max
          </p>
        </div>
        <span className="text-2xl font-semibold">
          <NetText value={sum.net} currency={session.currency} />
        </span>
      </div>

      <div className="mt-4 grid grid-cols-3 gap-2 rounded-xl border border-line bg-surface p-3 text-center text-sm sm:grid-cols-5">
        <Stat label="Played" value={fmtDuration(sum.playedMs)} />
        <Stat label="In" value={fmtMoney(sum.invested, session.currency)} sub={sum.rebuys ? `${sum.rebuys} rebuy${sum.rebuys > 1 ? "s" : ""}` : undefined} />
        <Stat label="Out" value={fmtMoney(session.cash_out ?? 0, session.currency)} />
        <Stat label="Per hour" value={<NetText value={sum.hourly} currency={session.currency} whole />} />
        <Stat label="bb/h" value={sum.bbPerHour === null ? "—" : String(Math.round(sum.bbPerHour * 10) / 10)} />
      </div>

      <div className="mt-3 flex flex-wrap gap-3 text-xs">
        <button type="button" onClick={() => setEditing((x) => !x)} className="text-muted underline">
          {editing ? "Close" : "Edit"}
        </button>
        <button type="button" onClick={() => run(() => reopenSession(session.id))} className="text-muted underline">
          Back to the table (undo the end)
        </button>
        <button
          type="button"
          onClick={() => confirm("Delete this session, its hands and its log? Players and their notes stay.") && run(() => deleteSession(session.id), () => router.push("/poker/live"))}
          className="text-muted underline hover:text-red-500"
        >
          Delete
        </button>
      </div>
      <ErrorLine error={error} />

      {editing && <EditForm data={data} pending={pending} run={run} onDone={() => setEditing(false)} />}

      <section className="mt-6">
        <h2 className="mb-1 text-xs font-medium tracking-wide text-muted uppercase">
          Hands {hands.length ? `· ${hands.length}` : ""}
          {starred ? ` · ${starred} ★` : ""}
        </h2>
        {hands.length === 0 ? (
          <p className="text-xs text-muted">No hands entered.</p>
        ) : (
          <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
            {hands.map((h) => (
              <HandRow key={h.id} hand={h} sessionId={session.id} currency={session.currency} />
            ))}
          </ul>
        )}
      </section>

      <section className="mt-6">
        <h2 className="mb-1 text-xs font-medium tracking-wide text-muted uppercase">Players</h2>
        {met.length === 0 && !unknown ? (
          <p className="text-xs text-muted">Nobody was recorded at the table.</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {met.map((m) => (
              <Link
                key={m.id}
                href={`/poker/live/players/${m.id}`}
                className={`rounded-full border px-2.5 py-1 text-xs ${m.known ? "border-line bg-surface" : "border-dashed border-line italic text-muted"}`}
              >
                <span className="not-italic tabular-nums text-muted">{m.seat}</span> {m.name}
              </Link>
            ))}
            {unknown > 0 && <span className="px-1 py-1 text-xs text-muted">+ {unknown} not identified</span>}
          </div>
        )}
      </section>

      <section className="mt-6">
        <h2 className="mb-1 text-xs font-medium tracking-wide text-muted uppercase">Session notes</h2>
        <NotesEditor
          value={session.notes}
          onSave={(v) => run(() => updateSession(session.id, { notes: v }))}
          placeholder="How it went, the table, the mental game…"
          addLabel="Add notes"
          startClosed
        />
      </section>

      <div className="mt-6">
        <Timeline
          session={session}
          events={events}
          seatEvents={seatEvents}
          hands={hands}
          nameOf={(id) => (id ? (playerById.get(id)?.name ?? null) : null)}
        />
      </div>
    </main>
  );
}

function Stat({ label, value, sub }: { label: string; value: React.ReactNode; sub?: string }) {
  return (
    <div>
      <div className="text-[10px] tracking-wide text-muted uppercase">{label}</div>
      <div className="mt-0.5 font-semibold tabular-nums">{value}</div>
      {sub && <div className="text-[10px] text-muted">{sub}</div>}
    </div>
  );
}

function EditForm({
  data,
  pending,
  run,
  onDone,
}: {
  data: SessionBundle;
  pending: boolean;
  run: ReturnType<typeof useAction>["run"];
  onDone: () => void;
}) {
  const { session, events } = data;
  const [venue, setVenue] = useState(session.venue);
  const [game, setGame] = useState(session.game);
  const [sb, setSb] = useState(fmtChips(session.small_blind));
  const [bb, setBb] = useState(fmtChips(session.big_blind));
  const [start, setStart] = useState(toLocalInput(session.started_at));
  const [end, setEnd] = useState(toLocalInput(session.ended_at));
  const [cash, setCash] = useState(fmtChips(session.cash_out ?? 0));
  const money = events.filter((e) => e.kind === "buy_in" || e.kind === "rebuy");
  const [amounts, setAmounts] = useState<Record<string, string>>(Object.fromEntries(money.map((e) => [e.id, fmtChips(e.amount ?? 0)])));

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        run(async () => {
          const r = await updateSession(session.id, {
            venue,
            game,
            small_blind: sb,
            big_blind: bb,
            started_at: fromLocalInput(start) ?? undefined,
            ended_at: fromLocalInput(end) ?? undefined,
            cash_out: cash,
          });
          if (!r.ok) return r;
          for (const m of money) {
            if (amounts[m.id] !== fmtChips(m.amount ?? 0)) {
              const x = await updateMoney(m.id, amounts[m.id]);
              if (!x.ok) return x;
            }
          }
          return { ok: true as const };
        }, onDone);
      }}
      className="mt-3 space-y-3 rounded-xl border border-line bg-surface p-4"
    >
      <div className="grid grid-cols-2 gap-2">
        <Field label="Where">
          <input value={venue} onChange={(e) => setVenue(e.target.value)} className={INPUT} />
        </Field>
        <Field label="Game">
          <input value={game} onChange={(e) => setGame(e.target.value)} className={INPUT} />
        </Field>
        <Field label="SB">
          <input inputMode="decimal" onFocus={(e) => e.currentTarget.select()} value={sb} onChange={(e) => setSb(e.target.value)} className={INPUT} />
        </Field>
        <Field label="BB">
          <input inputMode="decimal" onFocus={(e) => e.currentTarget.select()} value={bb} onChange={(e) => setBb(e.target.value)} className={INPUT} />
        </Field>
        <Field label="Started">
          <input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} className={INPUT} />
        </Field>
        <Field label="Ended">
          <input type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} className={INPUT} />
        </Field>
        {money.map((m, i) => (
          <Field key={m.id} label={m.kind === "buy_in" ? "Buy-in" : `Rebuy ${i}`}>
            <input
              inputMode="decimal" onFocus={(e) => e.currentTarget.select()}
              value={amounts[m.id]}
              onChange={(e) => setAmounts((a) => ({ ...a, [m.id]: e.target.value }))}
              className={INPUT}
            />
          </Field>
        ))}
        <Field label="Cash-out">
          <input inputMode="decimal" onFocus={(e) => e.currentTarget.select()} value={cash} onChange={(e) => setCash(e.target.value)} className={INPUT} />
        </Field>
      </div>
      <button type="submit" disabled={pending} className="w-full rounded-lg bg-accent py-2.5 text-sm font-medium text-white disabled:opacity-50">
        Save
      </button>
    </form>
  );
}
