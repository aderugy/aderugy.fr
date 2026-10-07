"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { HandEditor, type SeatName } from "./HandEditor";
import { FeltCenter, LiveTable, type SeatView } from "./LiveTable";
import { PlayerNotes } from "./PlayerNotes";
import { PlayerPicker } from "./PlayerPicker";
import { BarButton, INPUT, NetText, Sheet, TagToggles, fmtClock, fromLocalInput, toLocalInput, useNow } from "./ui";
import { HandRow, Timeline } from "./SessionParts";
import { useAction } from "@/components/jobs/controls";
import { ErrorLine } from "@/components/jobs/bits";
import { DEFAULT_COLOR } from "@/lib/categories";
import { dealtIn, emptySeats, nextButton, tableAt, type Table } from "@/lib/live/table";
import { fmtDuration, summarize } from "@/lib/live/session";
import { fmtChips, fmtMoney, fmtStakes, type HandInput } from "@/lib/live/types";
import type { SessionBundle } from "@/server/live/data";
import {
  addMoney,
  createHand,
  endSession,
  identifyAsNewPlayer,
  identifySeat,
  moveSeat,
  seatEvent,
  seatNewPlayer,
  setTags,
  toggleBreak,
  updatePlayer,
} from "@/server/actions/live";

type Panel = null | { kind: "seat"; seat: number } | { kind: "rebuy" } | { kind: "end" } | { kind: "hand" };

/**
 * The running session, built for a phone held at the table: the table on
 * top, a bar of big buttons at the bottom, and everything else one tap away
 * in a sheet. The hands, the table's log and the session notes scroll below.
 */
export function SessionScreen({ data }: { data: SessionBundle }) {
  const { session, events, seatEvents, hands, players, tags } = data;
  const router = useRouter();
  const now = useNow();
  const [panel, setPanel] = useState<Panel>(null);
  const { pending, error, run, setError } = useAction();

  const table = useMemo(() => tableAt(seatEvents), [seatEvents]);
  const summary = summarize(session, events, now);
  const playerById = useMemo(() => new Map(players.map((p) => [p.id, p])), [players]);
  const tagById = useMemo(() => new Map(tags.map((t) => [t.id, t])), [tags]);
  const colorsOf = (playerId: string | null) =>
    playerId ? (playerById.get(playerId)?.tag_ids ?? []).map((id) => tagById.get(id)?.color ?? DEFAULT_COLOR) : [];

  const seated = new Map<string, number>();
  for (const o of table.values()) if (o.player_id) seated.set(o.player_id, o.seat);

  const views: SeatView[] = [];
  for (let n = 1; n <= session.seats; n++) {
    if (n === session.hero_seat) {
      views.push({ seat: n, kind: "hero" });
      continue;
    }
    const o = table.get(n);
    if (!o) continue;
    const p = o.player_id ? playerById.get(o.player_id) : null;
    views.push({
      seat: n,
      kind: p ? "player" : "unknown",
      name: p?.name,
      colors: colorsOf(o.player_id),
      sittingOut: o.sittingOut,
      sub: o.sittingOut ? `out ${fmtClock(o.statusSince)}` : undefined,
    });
  }

  const nextHandButton = nextButton(session.button_seat, dealtIn(table, session.hero_seat));

  const close = () => {
    setPanel(null);
    setError(null);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* What and how long */}
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-3 pt-2 text-xs text-muted sm:px-5">
          <span className="text-sm font-semibold text-foreground">{session.venue}</span>
          <span>
            {fmtStakes(session)} {session.game}
          </span>
          <span className="tabular-nums">{fmtDuration(summary.playedMs)} played</span>
          <span className="tabular-nums">in {fmtMoney(summary.invested, session.currency)}</span>
          <span className="tabular-nums">
            {hands.length} hand{hands.length === 1 ? "" : "s"}
          </span>
        </div>
        {summary.onBreakSince && (
          <div className="mx-3 mt-2 rounded-lg bg-amber-500/15 px-3 py-2 text-sm sm:mx-5">
            On a break since {fmtClock(summary.onBreakSince)} — the clock is stopped.
          </div>
        )}

        <div className="px-1 pt-1">
          <LiveTable
            size={session.seats}
            seats={views}
            button={session.button_seat}
            onSeat={(seat) => setPanel({ kind: "seat", seat })}
            center={<FeltCenter board={[]} note="Tap a seat" />}
          />
        </div>
        <ErrorLine error={panel === null ? error : null} />

        <div className="mx-auto max-w-2xl space-y-4 px-3 pb-6 pt-2 sm:px-5">
          <section>
            <h2 className="mb-1 text-xs font-medium tracking-wide text-muted uppercase">Hands</h2>
            {hands.length === 0 ? (
              <p className="text-xs text-muted">None yet. “+ Hand” at the bottom enters one.</p>
            ) : (
              <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
                {[...hands].reverse().map((h) => (
                  <HandRow key={h.id} hand={h} sessionId={session.id} currency={session.currency} />
                ))}
              </ul>
            )}
          </section>
          <Timeline
            session={session}
            events={events}
            seatEvents={seatEvents}
            hands={hands}
            nameOf={(id) => (id ? (playerById.get(id)?.name ?? null) : null)}
            editable
          />
        </div>
      </div>

      {/* The bar */}
      <div className="grid shrink-0 grid-cols-4 gap-2 border-t border-line bg-background px-3 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
        <BarButton tone="accent" onClick={() => setPanel({ kind: "hand" })}>
          + Hand
        </BarButton>
        <BarButton onClick={() => setPanel({ kind: "rebuy" })}>Rebuy</BarButton>
        <BarButton onClick={() => run(() => toggleBreak(session.id))} disabled={pending}>
          {summary.onBreakSince ? "Resume" : "Break"}
        </BarButton>
        <BarButton tone="danger" onClick={() => setPanel({ kind: "end" })}>
          End
        </BarButton>
      </div>

      {panel?.kind === "seat" && (
        <SeatSheet
          key={panel.seat}
          seat={panel.seat}
          data={data}
          table={table}
          seated={seated}
          onClose={close}
        />
      )}

      <Sheet open={panel?.kind === "rebuy"} onClose={close} title="Rebuy">
        <MoneyForm
          defaultAmount={events.find((e) => e.kind === "buy_in")?.amount ?? null}
          currency={session.currency}
          pending={pending}
          error={error}
          label="Add"
          onSubmit={(amount) => run(() => addMoney(session.id, { kind: "rebuy", amount }), close)}
        />
      </Sheet>

      <Sheet open={panel?.kind === "end"} onClose={close} title="End the session">
        <EndForm
          currency={session.currency}
          invested={summary.invested}
          pending={pending}
          error={error}
          onSubmit={(cash_out, ended_at) => run(() => endSession(session.id, { cash_out, ended_at }), () => {
            close();
            router.refresh();
          })}
        />
      </Sheet>

      {panel?.kind === "hand" && (
        <HandEditor
          title={`Hand #${hands.length + 1}`}
          size={session.seats}
          currency={session.currency}
          heroSeat={session.hero_seat}
          names={namesFromTable(table, (id) => playerById.get(id)?.name ?? null, colorsOf)}
          initial={newHand(session, table, nextHandButton)}
          onSave={(input) => createHand(session.id, input)}
          onClose={close}
        />
      )}
    </div>
  );
}

export function namesFromTable(
  table: Table,
  nameOf: (id: string) => string | null,
  colorsOf: (id: string | null) => string[],
): Map<number, SeatName> {
  const out = new Map<number, SeatName>();
  for (const o of table.values()) {
    out.set(o.seat, { playerId: o.player_id, name: o.player_id ? nameOf(o.player_id) : null, colors: colorsOf(o.player_id) });
  }
  return out;
}

function newHand(session: SessionBundle["session"], table: Table, button: number): HandInput {
  const dealt = dealtIn(table, session.hero_seat);
  return {
    button_seat: button,
    hero_seat: session.hero_seat,
    small_blind: session.small_blind,
    big_blind: session.big_blind,
    straddle: null,
    seats: dealt.map((seat) => ({ seat, player_id: table.get(seat)?.player_id ?? null, stack: null })),
    actions: [],
    hero_cards: null,
    board: [],
    shown: {},
    winners: [],
    hero_net: null,
    starred: false,
    notes: null,
  };
}

/* -------------------------------------------------------------- the seat */

function SeatSheet({
  seat,
  data,
  table,
  seated,
  onClose,
}: {
  seat: number;
  data: SessionBundle;
  table: Table;
  seated: Map<string, number>;
  onClose: () => void;
}) {
  const { session, players, tags, notes } = data;
  const { pending, error, run } = useAction();
  const [mode, setMode] = useState<"main" | "identify" | "move">("main");
  const occupant = table.get(seat);
  const player = occupant?.player_id ? players.find((p) => p.id === occupant.player_id) : null;
  const empties = emptySeats(table, session.seats, session.hero_seat);

  // Arthur's own seat: he can move.
  if (seat === session.hero_seat) {
    return (
      <Sheet open onClose={onClose} title={`You · seat ${seat}`}>
        <p className="mb-2 text-sm text-muted">Changing seat? Pick the new one.</p>
        <SeatButtons seats={empties} pending={pending} onPick={(to) => run(() => seatEvent(session.id, { kind: "hero_move", seat: to }), onClose)} />
        <ErrorLine error={error} />
      </Sheet>
    );
  }

  // Nobody there: someone sits down.
  if (!occupant) {
    return (
      <Sheet open onClose={onClose} title={`Seat ${seat} · someone sits`}>
        <PlayerPicker
          players={players}
          tags={tags}
          exclude={seated}
          venue={session.venue}
          pending={pending}
          onPick={(id) => run(() => seatEvent(session.id, { kind: "sit", seat, player_id: id }), onClose)}
          onCreate={(input) => run(() => seatNewPlayer(session.id, seat, input), onClose)}
          onUnknown={() => run(() => seatEvent(session.id, { kind: "sit", seat, player_id: null }), onClose)}
        />
        <ErrorLine error={error} />
      </Sheet>
    );
  }

  const title = (
    <span className="flex items-center gap-2">
      <span className="tabular-nums text-muted">{seat}</span>
      {player ? (
        <Link href={`/poker/live/players/${player.id}`} className="truncate underline-offset-2 hover:underline">
          {player.name}
        </Link>
      ) : (
        <span>Not identified</span>
      )}
      {occupant.sittingOut && <span className="rounded bg-amber-500/15 px-1.5 text-[11px] font-normal">sitting out</span>}
    </span>
  );

  if (mode === "identify" || !player) {
    return (
      <Sheet open onClose={onClose} title={title}>
        <p className="mb-2 text-xs text-muted">
          {player ? "Wrong person? Pick who it really is." : "Who is it? Pick them, or add them."} Their whole stay in this seat is updated.
        </p>
        <PlayerPicker
          players={players}
          tags={tags}
          exclude={seated}
          venue={session.venue}
          pending={pending}
          onPick={(id) => run(() => identifySeat(session.id, seat, id), onClose)}
          onCreate={(input) => run(() => identifyAsNewPlayer(session.id, seat, input), onClose)}
        />
        <ErrorLine error={error} />
        {!player && (
          <SeatActions
            occupant={occupant}
            pending={pending}
            onOut={() => run(() => seatEvent(session.id, { kind: occupant.sittingOut ? "back" : "sit_out", seat }), onClose)}
            onLeave={() => run(() => seatEvent(session.id, { kind: "leave", seat }), onClose)}
            onMove={() => setMode("move")}
          />
        )}
        {mode === "identify" && (
          <button type="button" onClick={() => setMode("main")} className="mt-3 text-xs text-muted underline">
            Back
          </button>
        )}
      </Sheet>
    );
  }

  if (mode === "move") {
    return (
      <Sheet open onClose={onClose} title={title}>
        <p className="mb-2 text-sm text-muted">Moves to…</p>
        <SeatButtons seats={empties} pending={pending} onPick={(to) => run(() => moveSeat(session.id, seat, to), onClose)} />
        <ErrorLine error={error} />
        <button type="button" onClick={() => setMode("main")} className="mt-3 text-xs text-muted underline">
          Back
        </button>
      </Sheet>
    );
  }

  const theirNotes = notes.filter((n) => n.player_id === player.id);
  return (
    <Sheet open onClose={onClose} title={title}>
      <div className={`space-y-4 ${pending ? "opacity-70" : ""}`}>
        <Description
          key={player.id}
          value={player.description}
          onSave={(v) => run(() => updatePlayer(player.id, { description: v }))}
        />
        <TagToggles
          tags={tags}
          active={player.tag_ids}
          disabled={pending}
          onToggle={(id, on) => run(() => setTags(player.id, on ? [...player.tag_ids, id] : player.tag_ids.filter((x) => x !== id)))}
        />
        <section>
          <h3 className="mb-1 text-xs font-medium tracking-wide text-muted uppercase">Notes</h3>
          <PlayerNotes playerId={player.id} notes={theirNotes} sessionId={session.id} limit={5} />
        </section>
        <ErrorLine error={error} />
        <SeatActions
          occupant={occupant}
          pending={pending}
          onOut={() => run(() => seatEvent(session.id, { kind: occupant.sittingOut ? "back" : "sit_out", seat }), onClose)}
          onLeave={() => run(() => seatEvent(session.id, { kind: "leave", seat }), onClose)}
          onMove={() => setMode("move")}
          onIdentify={() => setMode("identify")}
        />
      </div>
    </Sheet>
  );
}

function SeatActions({
  occupant,
  pending,
  onOut,
  onLeave,
  onMove,
  onIdentify,
}: {
  occupant: { sittingOut: boolean };
  pending: boolean;
  onOut: () => void;
  onLeave: () => void;
  onMove: () => void;
  onIdentify?: () => void;
}) {
  return (
    <div className="mt-3 grid grid-cols-2 gap-2">
      <BarButton onClick={onOut} disabled={pending}>
        {occupant.sittingOut ? "Back in" : "Sits out"}
      </BarButton>
      <BarButton onClick={onMove} disabled={pending}>
        Changes seat
      </BarButton>
      <BarButton tone="danger" onClick={onLeave} disabled={pending}>
        Leaves
      </BarButton>
      {onIdentify && (
        <BarButton onClick={onIdentify} disabled={pending}>
          Not them?
        </BarButton>
      )}
    </div>
  );
}

function SeatButtons({ seats, pending, onPick }: { seats: number[]; pending: boolean; onPick: (seat: number) => void }) {
  if (!seats.length) return <p className="text-sm text-muted">No empty seat.</p>;
  return (
    <div className="grid grid-cols-5 gap-2">
      {seats.map((s) => (
        <button key={s} type="button" disabled={pending} onClick={() => onPick(s)} className="h-11 rounded-lg border border-line text-sm font-semibold tabular-nums">
          {s}
        </button>
      ))}
    </div>
  );
}

function Description({ value, onSave }: { value: string | null; onSave: (v: string | null) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? "");
  if (!editing) {
    return (
      <button type="button" onClick={() => setEditing(true)} className={`block w-full text-left text-sm ${value ? "" : "text-muted"}`}>
        {value || "+ How to recognise them"}
      </button>
    );
  }
  return (
    <div className="space-y-1">
      <textarea autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} rows={2} className={INPUT} />
      <div className="flex justify-end gap-3 text-xs">
        <button type="button" onClick={() => setEditing(false)} className="text-muted">
          Cancel
        </button>
        <button
          type="button"
          onClick={() => {
            setEditing(false);
            onSave(draft.trim() || null);
          }}
          className="font-medium text-accent"
        >
          Save
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- money */

function MoneyForm({
  defaultAmount,
  currency,
  pending,
  error,
  label,
  onSubmit,
}: {
  defaultAmount: number | null;
  currency: string;
  pending: boolean;
  error: string | null;
  label: string;
  onSubmit: (amount: string) => void;
}) {
  const [amount, setAmount] = useState(defaultAmount ? fmtChips(defaultAmount) : "");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(amount);
      }}
      className="space-y-3"
    >
      <div className="flex items-center gap-2">
        <input autoFocus inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} className={INPUT} />
        <span className="text-sm text-muted">{currency}</span>
      </div>
      <ErrorLine error={error} />
      <button type="submit" disabled={pending || !amount.trim()} className="w-full rounded-lg bg-accent py-3 text-sm font-medium text-white disabled:opacity-50">
        {label}
      </button>
    </form>
  );
}

function EndForm({
  currency,
  invested,
  pending,
  error,
  onSubmit,
}: {
  currency: string;
  invested: number;
  pending: boolean;
  error: string | null;
  onSubmit: (cashOut: string, endedAt: string | null) => void;
}) {
  const [cash, setCash] = useState("");
  const [when, setWhen] = useState(() => toLocalInput(null));
  const value = Number(cash.replace(",", "."));
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(cash, fromLocalInput(when));
      }}
      className="space-y-3"
    >
      <label className="block text-xs text-muted">
        Cash-out (0 if busted)
        <div className="mt-1 flex items-center gap-2">
          <input autoFocus inputMode="decimal" value={cash} onChange={(e) => setCash(e.target.value)} className={INPUT} />
          <span className="text-sm">{currency}</span>
        </div>
      </label>
      <label className="block text-xs text-muted">
        Ended at
        <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} className={`${INPUT} mt-1`} />
      </label>
      {cash.trim() && Number.isFinite(value) && (
        <p className="text-sm">
          Result: <NetText value={Math.round((value - invested) * 100) / 100} currency={currency} />{" "}
          <span className="text-muted">({fmtMoney(invested, currency)} in)</span>
        </p>
      )}
      <ErrorLine error={error} />
      <button type="submit" disabled={pending || !cash.trim()} className="w-full rounded-lg bg-red-600 py-3 text-sm font-medium text-white disabled:opacity-50">
        End session
      </button>
    </form>
  );
}
