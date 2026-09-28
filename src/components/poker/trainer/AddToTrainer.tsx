"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, useTransition } from "react";
import { createClient } from "@/lib/supabase/client";
import { fmtBb, effectiveStack, totalPot, type NodeState } from "@/lib/solver/gameState";
import { SEATS, type Seat } from "@/lib/solver/seats";
import { STREET_LABELS, type PokerNode, type SpotSetup } from "@/lib/solver/types";
import { compatibility } from "@/lib/trainer/resolve";
import type { Feedback, Trainer } from "@/lib/trainer/types";
import { addNodeToTrainer, createTrainer, removeNodeFromTrainer } from "@/server/actions/trainers";
import { BoardCards } from "@/components/poker/trainer/Cards";

type TrainerRow = Pick<Trainer, "id" | "name" | "hero_seat" | "villain_seat">;

/**
 * "Train from here" on any node of Solver notes: hands of a trainer start at
 * this node and are played down the tree. The preview and the greyed-out
 * trainers come from the spot page's own walk; the server walks the tree again on
 * add, and its answer is the one that counts.
 */
export function TrainFromHere({ node, setup, ns }: { node: PokerNode; setup: SpotSetup; ns: NodeState }) {
  const supabase = useMemo(() => createClient(), []);
  const [open, setOpen] = useState(false);
  const [trainers, setTrainers] = useState<TrainerRow[] | null>(null);
  const [memberOf, setMemberOf] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [creating, setCreating] = useState(false);
  const players = setup.players;
  const over = ns.state.status === "over";

  function fetchAll() {
    return Promise.all([
      supabase
        .from("poker_trainers")
        .select("id, name, hero_seat, villain_seat")
        .eq("archived", false)
        .order("updated_at", { ascending: false }),
      supabase.from("poker_trainer_nodes").select("trainer_id").eq("node_id", node.id),
    ]);
  }

  function apply([t, m]: Awaited<ReturnType<typeof fetchAll>>) {
    if (t.error || m.error) {
      setError((t.error ?? m.error)!.message);
      return;
    }
    setTrainers((t.data ?? []) as TrainerRow[]);
    setMemberOf(new Set((m.data ?? []).map((r) => r.trainer_id as string)));
  }

  async function load() {
    apply(await fetchAll());
  }

  // Membership drives the "in N trainers" line, so read it as soon as the node is open.
  useEffect(() => {
    let cancelled = false;
    void fetchAll().then((res) => {
      if (!cancelled) apply(res);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node.id]);

  function run(fn: () => Promise<{ ok: boolean; error?: string }>) {
    setError(null);
    startTransition(async () => {
      const r = await fn();
      if (!r.ok) setError(r.error ?? "Something went wrong");
      await load();
    });
  }

  const inCount = memberOf.size;
  const s = ns.state;

  return (
    <div className="rounded border border-line p-2">
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={over || !players}
          onClick={() => setOpen((v) => !v)}
          className="rounded border border-line px-2 py-1 text-xs hover:border-accent disabled:opacity-50"
        >
          {open ? "Close" : "Train from here…"}
        </button>
        <span className="text-[11px] text-muted">
          {over ? "The hand is over here" : inCount === 0 ? "No hand starts here" : `Hands start here in ${inCount} trainer${inCount > 1 ? "s" : ""}`}
        </span>
      </div>

      {open && players && (
        <div className="mt-2 space-y-2">
          <div className="space-y-1 text-[11px] text-muted">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-foreground">
                {players[0]} vs {players[1]}
              </span>
              <span>{STREET_LABELS[s.street]}</span>
              {s.board.length > 0 && <BoardCards cards={s.board} size="xs" />}
              <span className="tabular-nums">
                pot {fmtBb(totalPot(s))} · {fmtBb(effectiveStack(s))} behind
              </span>
            </div>
            <p>Each hand starts here and is played down the tree until it ends or the tree stops.</p>
          </div>

          {error && <p className="text-[11px] text-red-500">{error}</p>}

          {trainers === null ? (
            <p className="text-[11px] text-muted">Loading trainers…</p>
          ) : (
            <ul className="space-y-1">
              {trainers.map((t) => {
                const member = memberOf.has(t.id);
                const fit = compatibility(players, t);
                const disabled = pending || (!member && !fit.ok);
                return (
                  <li key={t.id} className="flex items-center gap-2 text-xs">
                    <div className="min-w-0 flex-1">
                      <Link href={`/poker/trainers/${t.id}`} className="block truncate hover:text-accent">
                        {t.name}
                      </Link>
                      <span className="text-[10px] text-muted">
                        hero {t.hero_seat} vs {t.villain_seat}
                        {!member && !fit.ok ? ` · ${fit.reason}` : ""}
                      </span>
                    </div>
                    {member ? (
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() => run(() => removeNodeFromTrainer({ trainerId: t.id, nodeId: node.id }))}
                        className="shrink-0 rounded border border-line px-1.5 py-0.5 text-[11px] text-muted hover:border-red-500 hover:text-red-500 disabled:opacity-40"
                      >
                        Remove
                      </button>
                    ) : (
                      <button
                        type="button"
                        disabled={disabled}
                        onClick={() => run(() => addNodeToTrainer({ trainerId: t.id, nodeId: node.id }))}
                        className="shrink-0 rounded border border-line px-1.5 py-0.5 text-[11px] hover:border-accent disabled:opacity-40"
                      >
                        Add
                      </button>
                    )}
                  </li>
                );
              })}
              {trainers.length === 0 && <li className="text-[11px] text-muted">No trainer yet.</li>}
            </ul>
          )}

          {creating ? (
            <NewTrainerForm
              players={players}
              pending={pending}
              onCancel={() => setCreating(false)}
              onSubmit={(v) =>
                run(async () => {
                  const r = await createTrainer({ ...v, nodeId: node.id });
                  if (r.ok) setCreating(false);
                  return r;
                })
              }
            />
          ) : (
            <button type="button" onClick={() => setCreating(true)} className="text-xs text-accent hover:underline">
              ＋ New trainer…
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export type NewTrainerValues = {
  name: string;
  heroSeat: Seat;
  villainSeat: Seat;
  feedback: Feedback;
  stopAtStreetEnd: boolean;
};

/**
 * A trainer is a matchup and how hands are played. From a spot, the two
 * seats are the spot's and only hero's side is chosen.
 */
export function NewTrainerForm({
  players,
  pending,
  onCancel,
  onSubmit,
  compact = true,
}: {
  players: [Seat, Seat] | null;
  pending: boolean;
  onCancel?: () => void;
  onSubmit: (v: NewTrainerValues) => void;
  compact?: boolean;
}) {
  const [hero, setHero] = useState<Seat>(players ? players[1] : "BB");
  const [villain, setVillain] = useState<Seat>(players ? players[0] : "BTN");
  const [name, setName] = useState(players ? `${players[1]} vs ${players[0]}` : "");
  const [feedback, setFeedback] = useState<Feedback>("each");
  const [stopAtStreetEnd, setStop] = useState(false);

  const input =
    "w-full rounded border border-line bg-background px-2 py-1 text-sm text-foreground outline-none focus:border-accent";
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({ name, heroSeat: hero, villainSeat: villain, feedback, stopAtStreetEnd });
      }}
      className={compact ? "space-y-2 rounded border border-line p-2" : "space-y-3"}
    >
      <label className="block text-xs text-muted">
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} required className={`mt-0.5 ${input}`} />
      </label>
      {players ? (
        <label className="block text-xs text-muted">
          Hero plays
          <select
            value={hero}
            onChange={(e) => {
              const h = e.target.value as Seat;
              const v = h === players[0] ? players[1] : players[0];
              setHero(h);
              setVillain(v);
              setName(`${h} vs ${v}`);
            }}
            className={`mt-0.5 ${input}`}
          >
            {players.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </label>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          <label className="block text-xs text-muted">
            Hero
            <select value={hero} onChange={(e) => setHero(e.target.value as Seat)} className={`mt-0.5 ${input}`}>
              {SEATS.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </label>
          <label className="block text-xs text-muted">
            Villain
            <select value={villain} onChange={(e) => setVillain(e.target.value as Seat)} className={`mt-0.5 ${input}`}>
              {SEATS.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </label>
        </div>
      )}
      <TrainerOptions feedback={feedback} stopAtStreetEnd={stopAtStreetEnd} onFeedback={setFeedback} onStop={setStop} />
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={pending || hero === villain}
          className="rounded bg-accent px-3 py-1.5 text-xs text-white disabled:opacity-50"
        >
          Create
        </button>
        {onCancel && (
          <button type="button" onClick={onCancel} className="text-xs text-muted hover:text-foreground">
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

/** How a hand is played: feedback after each decision or at the end, stop when a street's betting is over. */
export function TrainerOptions({
  feedback,
  stopAtStreetEnd,
  onFeedback,
  onStop,
}: {
  feedback: Feedback;
  stopAtStreetEnd: boolean;
  onFeedback: (f: Feedback) => void;
  onStop: (v: boolean) => void;
}) {
  return (
    <div className="space-y-1.5">
      <label className="block text-xs text-muted">
        Feedback
        <select
          value={feedback}
          onChange={(e) => onFeedback(e.target.value as Feedback)}
          className="mt-0.5 w-full rounded border border-line bg-background px-2 py-1 text-sm text-foreground outline-none focus:border-accent"
        >
          <option value="each">After each decision</option>
          <option value="hand_end">At the end of the hand</option>
        </select>
      </label>
      <label className="flex items-center gap-2 text-xs text-muted">
        <input type="checkbox" checked={stopAtStreetEnd} onChange={(e) => onStop(e.target.checked)} />
        Stop the hand when a street&apos;s betting is over
      </label>
    </div>
  );
}
