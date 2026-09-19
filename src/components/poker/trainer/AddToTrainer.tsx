"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, useTransition } from "react";
import { createClient } from "@/lib/supabase/client";
import { SEATS, type Seat } from "@/lib/solver/seats";
import type { PokerNode } from "@/lib/solver/types";
import { compatibility, resolveNodeContext } from "@/lib/trainer/resolve";
import { STREET_LABELS, type Trainer } from "@/lib/trainer/types";
import { addNodeToTrainer, createTrainer, removeNodeFromTrainer } from "@/server/actions/trainers";
import { BoardCards } from "@/components/poker/trainer/Cards";

type TrainerRow = Pick<Trainer, "id" | "name" | "hero_seat" | "villain_seat" | "street" | "pot_bb">;

/**
 * "Add to trainer" for a strategy node in Solver notes. The tree walk runs
 * here on the loaded ancestors to preview the context and grey out trainers
 * that would refuse the node; the server walks the tree again on add, and its
 * answer is the one that counts.
 */
export function AddToTrainer({ node, path }: { node: PokerNode; path: PokerNode[] }) {
  const supabase = useMemo(() => createClient(), []);
  const resolved = useMemo(() => resolveNodeContext(path), [path]);
  const [open, setOpen] = useState(false);
  const [trainers, setTrainers] = useState<TrainerRow[] | null>(null);
  const [memberOf, setMemberOf] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [creating, setCreating] = useState(false);

  function fetchAll() {
    return Promise.all([
      supabase
        .from("poker_trainers")
        .select("id, name, hero_seat, villain_seat, street, pot_bb")
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

  return (
    <div className="rounded border border-line p-2">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="rounded border border-line px-2 py-1 text-xs hover:border-accent"
        >
          {open ? "Close" : "Add to trainer…"}
        </button>
        <span className="text-[11px] text-muted">
          {inCount === 0 ? "In no trainer" : `In ${inCount} trainer${inCount > 1 ? "s" : ""}`}
        </span>
      </div>

      {open && (
        <div className="mt-2 space-y-2">
          {!resolved.ok ? (
            <p className="rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-700 dark:text-amber-400">
              {resolved.error}
            </p>
          ) : (
            <div className="space-y-1 text-[11px] text-muted">
              <div className="flex items-center gap-2">
                <span className="font-medium text-foreground">
                  {resolved.context.seat} vs {resolved.context.vsSeat}
                </span>
                <span>{STREET_LABELS[resolved.context.street]}</span>
                {resolved.context.board.length > 0 && <BoardCards cards={resolved.context.board} size="xs" />}
              </div>
              {resolved.context.line.length > 0 && (
                <p>{resolved.context.line.map((a) => `${a.seat} ${a.label.toLowerCase()}`).join(" · ")}</p>
              )}
            </div>
          )}

          {error && <p className="text-[11px] text-red-500">{error}</p>}

          {trainers === null ? (
            <p className="text-[11px] text-muted">Loading trainers…</p>
          ) : (
            <ul className="space-y-1">
              {trainers.map((t) => {
                const member = memberOf.has(t.id);
                const fit = resolved.ok ? compatibility(resolved.context, t) : null;
                const disabled = pending || !resolved.ok || (!member && !fit?.ok);
                return (
                  <li key={t.id} className="flex items-center gap-2 text-xs">
                    <div className="min-w-0 flex-1">
                      <Link href={`/poker/trainers/${t.id}`} className="block truncate hover:text-accent">
                        {t.name}
                      </Link>
                      <span className="text-[10px] text-muted">
                        {t.hero_seat} vs {t.villain_seat}
                        {t.street ? ` · ${STREET_LABELS[t.street]}` : ""}
                        {!member && fit && !fit.ok ? ` · ${fit.reason}` : ""}
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

          {resolved.ok &&
            (creating ? (
              <NewTrainerForm
                seat={resolved.context.seat}
                vsSeat={resolved.context.vsSeat}
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
              <button
                type="button"
                onClick={() => setCreating(true)}
                className="text-xs text-accent hover:underline"
              >
                ＋ New trainer…
              </button>
            ))}
        </div>
      )}
    </div>
  );
}

export function NewTrainerForm({
  seat,
  vsSeat,
  pending,
  onCancel,
  onSubmit,
  compact = true,
}: {
  seat: Seat | null;
  vsSeat: Seat | null;
  pending: boolean;
  onCancel?: () => void;
  onSubmit: (v: { name: string; heroSeat: Seat; villainSeat: Seat; potBb: number; stackBb: number }) => void;
  compact?: boolean;
}) {
  const [name, setName] = useState(seat && vsSeat ? `${seat} vs ${vsSeat}` : "");
  const [hero, setHero] = useState<Seat>(seat ?? "BTN");
  const [villain, setVillain] = useState<Seat>(vsSeat ?? "BB");
  const [pot, setPot] = useState("6");
  const [stack, setStack] = useState("97");
  const locked = !!seat && !!vsSeat;

  const input =
    "w-full rounded border border-line bg-background px-2 py-1 text-sm text-foreground outline-none focus:border-accent";
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({ name, heroSeat: hero, villainSeat: villain, potBb: Number(pot), stackBb: Number(stack) });
      }}
      className={compact ? "space-y-2 rounded border border-line p-2" : "space-y-3"}
    >
      <label className="block text-xs text-muted">
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} required className={`mt-0.5 ${input}`} />
      </label>
      <div className="grid grid-cols-2 gap-2">
        <label className="block text-xs text-muted">
          Hero
          <select
            value={hero}
            disabled={locked}
            onChange={(e) => setHero(e.target.value as Seat)}
            className={`mt-0.5 ${input} disabled:opacity-70`}
          >
            {SEATS.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </label>
        <label className="block text-xs text-muted">
          Villain
          <select
            value={villain}
            disabled={locked}
            onChange={(e) => setVillain(e.target.value as Seat)}
            className={`mt-0.5 ${input} disabled:opacity-70`}
          >
            {SEATS.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </label>
        <label className="block text-xs text-muted">
          Pot (bb)
          <input
            type="number"
            step="0.1"
            min="0.1"
            value={pot}
            onChange={(e) => setPot(e.target.value)}
            required
            className={`mt-0.5 ${input}`}
          />
        </label>
        <label className="block text-xs text-muted">
          Stack behind (bb)
          <input
            type="number"
            step="0.1"
            min="0.1"
            value={stack}
            onChange={(e) => setStack(e.target.value)}
            required
            className={`mt-0.5 ${input}`}
          />
        </label>
      </div>
      <p className="text-[11px] text-muted">
        Pot and stack at the start of the street. Preflop, the pot includes the blinds (1.5).
      </p>
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
