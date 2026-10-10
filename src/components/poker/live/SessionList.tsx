"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Field, INPUT, NetText, fmtClock, fmtDay, fromLocalInput, toLocalInput, useNow } from "./ui";
import { ErrorLine } from "@/components/jobs/bits";
import { fmtDuration, summarize, totals } from "@/lib/live/session";
import { fmtChips, fmtMoney, fmtStakes, TABLE_SIZES } from "@/lib/live/types";
import type { SessionRow } from "@/server/live/data";
import { startSession } from "@/server/actions/live";

export function SessionList({ sessions, venues }: { sessions: SessionRow[]; venues: string[] }) {
  const now = useNow();
  const running = sessions.find((s) => !s.ended_at);
  const done = sessions.filter((s) => s.ended_at);
  const sums = done.map((s) => summarize(s, s.events, now));
  const t = totals(sums);
  const currency = done[0]?.currency ?? "€";
  const [open, setOpen] = useState(!running && sessions.length === 0);

  return (
    <main className="mx-auto h-full w-full max-w-2xl overflow-y-auto px-4 py-5 sm:px-6 sm:py-8">
      {running ? (
        <RunningCard session={running} now={now} />
      ) : open ? (
        <StartForm last={sessions[0] ?? null} venues={venues} onCancel={sessions.length ? () => setOpen(false) : undefined} />
      ) : (
        <button type="button" onClick={() => setOpen(true)} className="w-full rounded-xl bg-accent py-4 text-base font-semibold text-white">
          Start a session
        </button>
      )}

      {done.length > 0 && (
        <section className="mt-6">
          <div className="grid grid-cols-4 gap-2 rounded-xl border border-line bg-surface p-3 text-center">
            <Stat label="Sessions" value={String(t.sessions)} />
            <Stat label="Result" value={<NetText value={t.net} currency={currency} />} />
            <Stat label="Played" value={fmtDuration(t.playedMs)} />
            <Stat label="Per hour" value={<NetText value={t.hourly} currency={currency} whole />} />
          </div>
          <ul className="mt-3 divide-y divide-line rounded-xl border border-line bg-surface">
            {done.map((s, i) => {
              const sum = sums[i];
              return (
                <li key={s.id}>
                  <Link href={`/poker/live/${s.id}`} className="flex items-center gap-3 px-3 py-2.5">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{s.venue}</span>
                      <span className="block text-xs text-muted">
                        {fmtDay(s.started_at)} · {fmtStakes(s)} · {fmtDuration(sum.playedMs)}
                        {s.hand_count ? ` · ${s.hand_count} hands` : ""}
                      </span>
                    </span>
                    <span className="shrink-0 text-right text-sm">
                      <NetText value={sum.net} currency={s.currency} />
                      {sum.bbPerHour !== null && <span className="block text-[11px] text-muted tabular-nums">{Math.round(sum.bbPerHour * 10) / 10} bb/h</span>}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </main>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] tracking-wide text-muted uppercase">{label}</div>
      <div className="mt-0.5 text-sm font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function RunningCard({ session, now }: { session: SessionRow; now: number }) {
  const sum = summarize(session, session.events, now);
  return (
    <Link href={`/poker/live/${session.id}`} className="block rounded-xl border-2 border-accent bg-surface p-4">
      <span className="text-[11px] font-semibold tracking-wide text-accent uppercase">
        {sum.onBreakSince ? "On a break" : "Running"} · since {fmtClock(session.started_at)}
      </span>
      <span className="mt-1 block text-lg font-semibold">{session.venue}</span>
      <span className="block text-sm text-muted">
        {fmtStakes(session)} {session.game} · {fmtDuration(sum.playedMs)} played · in {fmtMoney(sum.invested, session.currency)}
      </span>
      <span className="mt-3 block rounded-lg bg-accent py-2.5 text-center text-sm font-semibold text-white">Back to the table →</span>
    </Link>
  );
}

function StartForm({ last, venues, onCancel }: { last: SessionRow | null; venues: string[]; onCancel?: () => void }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [venue, setVenue] = useState(last?.venue ?? "");
  const [game, setGame] = useState(last?.game ?? "NLHE");
  const [sb, setSb] = useState(last ? fmtChips(last.small_blind) : "1");
  const [bb, setBb] = useState(last ? fmtChips(last.big_blind) : "2");
  const [currency, setCurrency] = useState(last?.currency ?? "€");
  const [seats, setSeats] = useState<number>(last?.seats ?? 9);
  const [hero, setHero] = useState<number | null>(null);
  const firstBuyIn = last?.events.find((e) => e.kind === "buy_in")?.amount;
  const [buyIn, setBuyIn] = useState(firstBuyIn ? fmtChips(firstBuyIn) : "");
  const [startedAt, setStartedAt] = useState(() => toLocalInput(null));
  const [moreOpen, setMoreOpen] = useState(false);
  const [fill, setFill] = useState(true);

  const submit = () => {
    setError(null);
    if (hero === null) return setError("Tap your seat.");
    start(async () => {
      const r = await startSession({
        venue,
        game,
        small_blind: sb,
        big_blind: bb,
        currency,
        seats,
        hero_seat: hero,
        buy_in: buyIn,
        started_at: fromLocalInput(startedAt),
        fill_unknowns: fill,
      });
      if (!r.ok) setError(r.error);
      else router.push(`/poker/live/${r.id}`);
    });
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className="space-y-4 rounded-xl border border-line bg-surface p-4"
    >
      <h1 className="text-lg font-semibold tracking-tight">New session</h1>
      <Field label="Where">
        <input list="live-venues" value={venue} onChange={(e) => setVenue(e.target.value)} placeholder="Club, casino…" className={INPUT} />
        <datalist id="live-venues">
          {venues.map((v) => (
            <option key={v} value={v} />
          ))}
        </datalist>
      </Field>
      <div className="grid grid-cols-3 gap-2">
        <Field label="SB">
          <input inputMode="decimal" onFocus={(e) => e.currentTarget.select()} value={sb} onChange={(e) => setSb(e.target.value)} className={INPUT} />
        </Field>
        <Field label="BB">
          <input inputMode="decimal" onFocus={(e) => e.currentTarget.select()} value={bb} onChange={(e) => setBb(e.target.value)} className={INPUT} />
        </Field>
        <Field label="Buy-in">
          <input inputMode="decimal" onFocus={(e) => e.currentTarget.select()} value={buyIn} onChange={(e) => setBuyIn(e.target.value)} placeholder={currency} className={INPUT} />
        </Field>
      </div>
      <Field label="Table">
        <div className="flex gap-2">
          {TABLE_SIZES.map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => {
                setSeats(n);
                if (hero && hero > n) setHero(null);
              }}
              className={`flex-1 rounded-lg border py-2 text-sm ${seats === n ? "border-accent bg-accent text-white" : "border-line"}`}
            >
              {n} seats
            </button>
          ))}
        </div>
      </Field>
      <Field label="Your seat">
        <div className="grid grid-cols-5 gap-2">
          {Array.from({ length: seats }, (_, i) => i + 1).map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => setHero(n)}
              className={`h-11 rounded-lg border text-sm font-semibold tabular-nums ${hero === n ? "border-accent bg-accent text-white" : "border-line"}`}
            >
              {n}
            </button>
          ))}
        </div>
      </Field>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" checked={fill} onChange={(e) => setFill(e.target.checked)} className="mt-0.5 size-4 accent-[var(--accent)]" />
        <span>
          Fill the other seats with unknown players
          <span className="block text-xs text-muted">Tag and note them right away; name them when you know who they are.</span>
        </span>
      </label>
      <button type="button" onClick={() => setMoreOpen((x) => !x)} className="text-xs text-muted">
        {moreOpen ? "▾" : "▸"} Game, currency, start time
      </button>
      {moreOpen && (
        <div className="grid grid-cols-2 gap-2">
          <Field label="Game">
            <input value={game} onChange={(e) => setGame(e.target.value)} className={INPUT} />
          </Field>
          <Field label="Currency">
            <input value={currency} onChange={(e) => setCurrency(e.target.value)} className={INPUT} />
          </Field>
          <div className="col-span-2">
            <Field label="Started at">
              <input type="datetime-local" value={startedAt} onChange={(e) => setStartedAt(e.target.value)} className={INPUT} />
            </Field>
          </div>
        </div>
      )}
      <ErrorLine error={error} />
      <div className="flex gap-2">
        {onCancel && (
          <button type="button" onClick={onCancel} className="rounded-lg border border-line px-4 py-3 text-sm">
            Cancel
          </button>
        )}
        <button type="submit" disabled={pending} className="flex-1 rounded-lg bg-accent py-3 text-sm font-semibold text-white disabled:opacity-50">
          {pending ? "Starting…" : "Sit down"}
        </button>
      </div>
    </form>
  );
}
