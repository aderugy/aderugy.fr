"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { SEATS, type Seat } from "@/lib/solver/seats";
import { STREET_LABELS, type Trainer } from "@/lib/trainer/types";
import { deleteTrainer, removeNodeFromTrainer, updateTrainer } from "@/server/actions/trainers";
import type { TrainerPage } from "@/server/trainers";
import { Segmented } from "@/components/poker/ui";
import { BoardCards } from "@/components/poker/trainer/Cards";
import { History } from "@/components/poker/trainer/History";
import { Practice } from "@/components/poker/trainer/Practice";

type Tab = "practice" | "nodes" | "history" | "settings";

const fmt = (x: number) => (Number.isInteger(x) ? String(x) : String(Math.round(x * 100) / 100));

export function TrainerView({ trainer, nodes, sessions, answers }: TrainerPage) {
  const [tab, setTab] = useState<Tab>("practice");
  const usable = nodes.filter(
    (n) => !n.missing && n.hero_seat === trainer.hero_seat && n.villain_seat === trainer.villain_seat,
  );

  return (
    <div className="mt-2 space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="min-w-0">
          <h1 className="truncate text-lg font-semibold tracking-tight">{trainer.name}</h1>
          <p className="text-xs text-muted">
            {trainer.hero_seat} vs {trainer.villain_seat}
            {trainer.street ? ` · ${STREET_LABELS[trainer.street]}` : ""} · pot {fmt(Number(trainer.pot_bb))} bb ·{" "}
            {fmt(Number(trainer.stack_bb))} bb behind
          </p>
        </div>
        <Segmented
          size="sm"
          value={tab}
          onChange={setTab}
          options={[
            { id: "practice", label: "Practice" },
            { id: "nodes", label: `Nodes (${nodes.length})` },
            { id: "history", label: "History" },
            { id: "settings", label: "Settings" },
          ]}
        />
      </div>

      {tab === "practice" && <Practice trainer={trainer} nodeCount={usable.length} />}
      {tab === "nodes" && <NodeList trainer={trainer} nodes={nodes} />}
      {tab === "history" && <History trainer={trainer} nodes={nodes} sessions={sessions} answers={answers} />}
      {tab === "settings" && <Settings trainer={trainer} />}
    </div>
  );
}

function NodeList({ trainer, nodes }: { trainer: Trainer; nodes: TrainerPage["nodes"] }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  if (nodes.length === 0) {
    return (
      <div className="rounded-lg border border-line bg-surface p-4 text-sm text-muted">
        No node yet. In{" "}
        <Link href="/poker/spots" className="text-accent hover:underline">
          Solver notes
        </Link>
        , select a strategy node set to {trainer.hero_seat} vs {trainer.villain_seat} and use “Add to trainer…”. The
        board and the line are read from the tree above it.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {error && <p className="text-sm text-red-500">{error}</p>}
      <ul className="space-y-2">
        {nodes.map((n) => {
          const misfit =
            n.missing
              ? "node deleted"
              : n.hero_seat !== trainer.hero_seat || n.villain_seat !== trainer.villain_seat
                ? `node is ${n.hero_seat} vs ${n.villain_seat} — skipped`
                : null;
          return (
            <li key={n.node_id} className="flex items-center gap-3 rounded-lg border border-line bg-surface px-3 py-2">
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-medium">{n.spotName}</span>
                  {n.label && <span className="text-muted">· {n.label}</span>}
                  {n.board.length > 0 && <BoardCards cards={n.board} size="xs" />}
                </div>
                <p className="text-xs text-muted">
                  {STREET_LABELS[n.street]} ·{" "}
                  {n.line.length > 0 ? n.line.map((a) => `${a.seat} ${a.label.toLowerCase()}`).join(" · ") : "first to act"}
                </p>
                {misfit && <p className="text-xs text-amber-600">{misfit}</p>}
              </div>
              {!n.missing && (
                <Link
                  href={`/poker/spots/${n.spot_id}?node=${n.node_id}`}
                  className="shrink-0 text-xs text-muted hover:text-foreground"
                >
                  Open
                </Link>
              )}
              <button
                type="button"
                disabled={pending}
                onClick={() =>
                  startTransition(async () => {
                    const r = await removeNodeFromTrainer({ trainerId: trainer.id, nodeId: n.node_id });
                    if (!r.ok) setError(r.error);
                  })
                }
                className="shrink-0 text-xs text-muted hover:text-red-500"
              >
                Remove
              </button>
            </li>
          );
        })}
      </ul>
      <p className="text-[11px] text-muted">
        Boards and lines are re-read from the trees at the start of each session.
      </p>
    </div>
  );
}

function Settings({ trainer }: { trainer: Trainer }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [name, setName] = useState(trainer.name);
  const [hero, setHero] = useState<Seat>(trainer.hero_seat);
  const [villain, setVillain] = useState<Seat>(trainer.villain_seat);
  const [pot, setPot] = useState(String(trainer.pot_bb));
  const [stack, setStack] = useState(String(trainer.stack_bb));
  const seatsChanged = hero !== trainer.hero_seat || villain !== trainer.villain_seat;

  const input =
    "mt-0.5 w-full rounded border border-line bg-background px-2 py-1 text-sm text-foreground outline-none focus:border-accent";

  return (
    <form
      className="max-w-md space-y-3 rounded-lg border border-line bg-surface p-4"
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        setSaved(false);
        startTransition(async () => {
          const r = await updateTrainer({
            id: trainer.id,
            name,
            heroSeat: hero,
            villainSeat: villain,
            potBb: Number(pot),
            stackBb: Number(stack),
          });
          if (!r.ok) setError(r.error);
          else setSaved(true);
        });
      }}
    >
      <label className="block text-xs text-muted">
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} className={input} />
      </label>
      <div className="grid grid-cols-2 gap-2">
        <label className="block text-xs text-muted">
          Hero
          <select value={hero} onChange={(e) => setHero(e.target.value as Seat)} className={input}>
            {SEATS.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </label>
        <label className="block text-xs text-muted">
          Villain
          <select value={villain} onChange={(e) => setVillain(e.target.value as Seat)} className={input}>
            {SEATS.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </label>
        <label className="block text-xs text-muted">
          Pot at street start (bb)
          <input type="number" step="0.1" min="0.1" value={pot} onChange={(e) => setPot(e.target.value)} className={input} />
        </label>
        <label className="block text-xs text-muted">
          Stack behind (bb)
          <input type="number" step="0.1" min="0.1" value={stack} onChange={(e) => setStack(e.target.value)} className={input} />
        </label>
      </div>
      {seatsChanged && (
        <p className="text-[11px] text-amber-600">
          Nodes that are not {hero} vs {villain} will be skipped until removed.
        </p>
      )}
      {error && <p className="text-xs text-red-500">{error}</p>}
      {saved && <p className="text-xs text-emerald-600">Saved.</p>}
      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={pending || hero === villain}
          className="rounded bg-accent px-3 py-1.5 text-sm text-white disabled:opacity-50"
        >
          Save
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => {
            if (!confirm("Delete this trainer and all its sessions?")) return;
            startTransition(async () => {
              const r = await deleteTrainer(trainer.id);
              if (!r.ok) setError(r.error);
              else router.push("/poker/trainers");
            });
          }}
          className="ml-auto text-xs text-muted hover:text-red-500"
        >
          Delete trainer
        </button>
      </div>
    </form>
  );
}
