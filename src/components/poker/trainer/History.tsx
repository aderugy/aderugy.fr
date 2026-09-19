"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { byHandClass, byNode, confusions, mixDiscipline, type Tally } from "@/lib/trainer/history";
import type { Trainer, TrainerAnswer, TrainerSession } from "@/lib/trainer/types";
import type { TrainerNodeView } from "@/server/trainers";

const pct = (x: number) => `${Math.round(x)}%`;

function when(iso: string) {
  return new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

export function History({
  trainer,
  nodes,
  sessions,
  answers,
}: {
  trainer: Trainer;
  nodes: TrainerNodeView[];
  sessions: TrainerSession[];
  answers: TrainerAnswer[];
}) {
  const played = sessions.filter((s) => s.hands > 0);
  const totals = played.reduce(
    (a, s) => ({ hands: a.hands + s.hands, correct: a.correct + s.correct, blunders: a.blunders + s.blunders }),
    { hands: 0, correct: 0, blunders: 0 },
  );

  const nodeLabel = useMemo(() => {
    const m = new Map(nodes.map((n) => [n.node_id, `${n.spotName}${n.label ? ` · ${n.label}` : ""}${n.board.length ? ` · ${n.board.join("")}` : ""}`]));
    return (id: string) => m.get(id) ?? "Removed node";
  }, [nodes]);
  const worstNodes = useMemo(() => byNode(answers, nodeLabel).slice(0, 5), [answers, nodeLabel]);
  const worstClasses = useMemo(() => byHandClass(answers).slice(0, 5), [answers]);
  const swaps = useMemo(() => confusions(answers), [answers]);
  const mix = useMemo(() => mixDiscipline(answers), [answers]);

  if (played.length === 0) {
    return (
      <p className="rounded-lg border border-line bg-surface p-4 text-sm text-muted">
        No session yet. Results show up here as soon as you answer a hand.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Sessions" value={String(played.length)} />
        <Stat label="Hands" value={String(totals.hands)} />
        <Stat label="Correct" value={pct((totals.correct / totals.hands) * 100)} />
        <Stat label="Blunder rate" value={pct((totals.blunders / totals.hands) * 100)} />
      </div>

      {played.length >= 2 && (
        <section className="rounded-lg border border-line bg-surface p-3">
          <h2 className="text-sm font-medium">% correct per session</h2>
          <ScoreChart sessions={played} />
        </section>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <Leaks title="Weakest nodes" rows={worstNodes} empty="Needs 5+ hands on a node." />
        <Leaks title="Weakest hand classes" rows={worstClasses} empty="Needs 5+ hands in a class." />
        <section className="rounded-lg border border-line bg-surface p-3">
          <h2 className="text-sm font-medium">Most common errors</h2>
          {swaps.length === 0 ? (
            <p className="mt-2 text-xs text-muted">None yet.</p>
          ) : (
            <ul className="mt-2 space-y-1 text-xs">
              {swaps.map((s) => (
                <li key={s.label} className="flex justify-between gap-2">
                  <span>{s.label}</span>
                  <span className="tabular-nums text-muted">×{s.count}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="rounded-lg border border-line bg-surface p-3">
          <h2 className="text-sm font-medium">Mix discipline</h2>
          <p className="text-[11px] text-muted">On mixed combos: how often you chose each action vs the solver.</p>
          {mix.length === 0 ? (
            <p className="mt-2 text-xs text-muted">No mixed combo dealt yet.</p>
          ) : (
            <table className="mt-2 w-full text-xs">
              <thead className="text-muted">
                <tr>
                  <th className="text-left font-normal">Action</th>
                  <th className="text-right font-normal">Solver</th>
                  <th className="text-right font-normal">You</th>
                </tr>
              </thead>
              <tbody>
                {mix.map((m) => (
                  <tr key={m.label}>
                    <td>{m.label}</td>
                    <td className="text-right tabular-nums">{pct(m.solver)}</td>
                    <td className="text-right tabular-nums">{pct(m.chosen)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>

      <section className="rounded-lg border border-line bg-surface p-3">
        <h2 className="text-sm font-medium">Sessions</h2>
        <table className="mt-2 w-full text-xs">
          <thead className="text-muted">
            <tr>
              <th className="text-left font-normal">Started</th>
              <th className="text-right font-normal">Hands</th>
              <th className="text-right font-normal">Correct</th>
              <th className="text-right font-normal">Blunders</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {[...played].reverse().map((s) => (
              <tr key={s.id} className="border-t border-line">
                <td className="py-1">
                  {when(s.started_at)}
                  {!s.ended_at && <span className="ml-1 text-amber-600">open</span>}
                </td>
                <td className="py-1 text-right tabular-nums">{s.hands}</td>
                <td className="py-1 text-right tabular-nums">{pct((s.correct / s.hands) * 100)}</td>
                <td className="py-1 text-right tabular-nums">{s.blunders}</td>
                <td className="py-1 text-right">
                  <Link href={`/poker/trainers/${trainer.id}/sessions/${s.id}`} className="text-accent hover:underline">
                    Review
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-line bg-surface px-3 py-2">
      <div className="text-[11px] text-muted">{label}</div>
      <div className="text-xl font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function Leaks({ title, rows, empty }: { title: string; rows: Tally[]; empty: string }) {
  return (
    <section className="rounded-lg border border-line bg-surface p-3">
      <h2 className="text-sm font-medium">{title}</h2>
      {rows.length === 0 ? (
        <p className="mt-2 text-xs text-muted">{empty}</p>
      ) : (
        <ul className="mt-2 space-y-1.5 text-xs">
          {rows.map((r) => (
            <li key={r.key}>
              <div className="flex justify-between gap-2">
                <span className="truncate">{r.label}</span>
                <span className="shrink-0 tabular-nums">
                  {pct((r.correct / r.hands) * 100)} <span className="text-muted">/ {r.hands}</span>
                </span>
              </div>
              <div className="mt-0.5 h-1 overflow-hidden rounded bg-line">
                <div className="h-full rounded bg-accent" style={{ width: `${(r.correct / r.hands) * 100}%` }} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** One series: % correct per session, oldest → newest, hover for the details. */
function ScoreChart({ sessions }: { sessions: TrainerSession[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 600;
  const H = 160;
  const pad = { l: 30, r: 10, t: 10, b: 18 };
  const pts = sessions.map((s, i) => ({
    x: pad.l + (sessions.length === 1 ? 0 : (i / (sessions.length - 1)) * (W - pad.l - pad.r)),
    y: pad.t + (1 - s.correct / s.hands) * (H - pad.t - pad.b),
    s,
  }));
  const d = pts.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  const h = hover !== null ? pts[hover] : null;

  return (
    <div className="relative mt-2">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Percent correct per session">
        {[0, 50, 100].map((v) => {
          const y = pad.t + (1 - v / 100) * (H - pad.t - pad.b);
          return (
            <g key={v}>
              <line x1={pad.l} x2={W - pad.r} y1={y} y2={y} className="stroke-line" strokeWidth={1} />
              <text x={pad.l - 6} y={y + 3} textAnchor="end" className="fill-muted text-[10px]">
                {v}%
              </text>
            </g>
          );
        })}
        <path d={d} fill="none" className="stroke-accent" strokeWidth={2} strokeLinejoin="round" />
        {h && <line x1={h.x} x2={h.x} y1={pad.t} y2={H - pad.b} className="stroke-muted" strokeDasharray="3 3" />}
        {pts.map((p, i) => (
          <g key={p.s.id} onPointerEnter={() => setHover(i)} onPointerLeave={() => setHover(null)}>
            <circle cx={p.x} cy={p.y} r={14} fill="transparent" />
            <circle cx={p.x} cy={p.y} r={4} className="fill-accent stroke-surface" strokeWidth={2} />
          </g>
        ))}
      </svg>
      {h && (
        <div
          className="pointer-events-none absolute -translate-x-1/2 -translate-y-full rounded border border-line bg-surface px-2 py-1 text-[11px] shadow"
          style={{ left: `${(h.x / W) * 100}%`, top: `${(h.y / H) * 100}%` }}
        >
          <div className="font-medium">{pct((h.s.correct / h.s.hands) * 100)} correct</div>
          <div className="text-muted">
            {when(h.s.started_at)} · {h.s.hands} hands
          </div>
        </div>
      )}
    </div>
  );
}
