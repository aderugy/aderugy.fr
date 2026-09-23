"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { ProgressState } from "@/lib/maths/graph/types";
import { ETAT } from "@/lib/maths/etat";

export type ViewNode = {
  id: string;
  title: string;
  state: ProgressState;
  hours: number;
  unlocks: number;
  ghost: boolean;
  domainLabel: string;
};

export type ViewData = {
  width: number;
  height: number;
  nodeWidth: number;
  nodeHeight: number;
  positions: Record<string, { x: number; y: number }>;
  edges: { from: string; to: string; points: [number, number][] }[];
  nodes: ViewNode[];
};

const ZOOM = { min: 0.15, max: 2 };

export default function GraphCanvas({
  data,
  focusId,
}: {
  data: ViewData;
  focusId: string | null;
}) {
  const router = useRouter();
  const box = useRef<HTMLDivElement>(null);
  const [t, setT] = useState({ x: 0, y: 0, k: 1 });
  const [hover, setHover] = useState<ViewNode | null>(null);
  const drag = useRef<{ x: number; y: number; tx: number; ty: number } | null>(
    null,
  );

  // Ouverture sur le nœud courant, à l'échelle 1 : on lit la carte à sa taille
  // réelle, on ne la regarde pas de loin. Le nœud est placé au tiers supérieur
  // — ce qui reste à faire est en dessous, et il n'y a pas de bande vide.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const { width: w, height: h } = el.getBoundingClientRect();
    const p = focusId ? data.positions[focusId] : null;
    const cx = p ? p.x : data.width / 2;
    const cy = p ? p.y : data.height / 2;
    // Si le niveau entier tient à une échelle encore lisible, on l'ouvre en
    // entier : on voit d'un coup ce qui est ouvert et ce qui suit. Sinon on
    // ouvre à l'échelle 1 sur le nœud courant.
    const ajuste = Math.min((w - 32) / data.width, (h - 32) / data.height, 1);
    if (ajuste >= 0.85) {
      const k = ajuste;
      setT({
        x: (w - data.width * k) / 2,
        y: (h - data.height * k) / 2,
        k,
      });
      return;
    }
    setT({ x: w / 2 - cx, y: h / 3 - cy, k: 1 });
  }, [data, focusId]);

  const onWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const el = box.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const mx = e.clientX - r.left;
    const my = e.clientY - r.top;
    setT((prev) => {
      const k = Math.min(
        ZOOM.max,
        Math.max(ZOOM.min, prev.k * Math.exp(-e.deltaY / 500)),
      );
      const ratio = k / prev.k;
      return { k, x: mx - (mx - prev.x) * ratio, y: my - (my - prev.y) * ratio };
    });
  }, []);

  const path = (points: [number, number][]) =>
    points
      .map(([x, y], i) => (i === 0 ? `M${x},${y}` : `L${x},${y}`))
      .join(" ");

  return (
    <div className="relative flex min-h-0 grow flex-col">
      <div
        ref={box}
        className="relative min-h-0 grow cursor-grab touch-none overflow-hidden active:cursor-grabbing"
        onWheel={onWheel}
        onPointerDown={(e) => {
          if ((e.target as Element).closest("a")) return;
          drag.current = { x: e.clientX, y: e.clientY, tx: t.x, ty: t.y };
          (e.currentTarget as Element).setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          setT((prev) => ({
            ...prev,
            x: d.tx + (e.clientX - d.x),
            y: d.ty + (e.clientY - d.y),
          }));
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
      >
        <svg
          className="absolute inset-0 h-full w-full"
          role="img"
          aria-label="Graphe des prérequis"
        >
          <g transform={`translate(${t.x} ${t.y}) scale(${t.k})`}>
            <g
              fill="none"
              stroke="var(--border)"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            >
              {data.edges.map((e) => (
                <path
                  key={`${e.from}->${e.to}`}
                  d={path(e.points)}
                  stroke={
                    hover && (hover.id === e.from || hover.id === e.to)
                      ? "var(--accent)"
                      : "var(--border)"
                  }
                />
              ))}
            </g>
            {data.nodes.map((n) => {
              const p = data.positions[n.id];
              if (!p) return null;
              const s = ETAT[n.state];
              const x = p.x - data.nodeWidth / 2;
              const y = p.y - data.nodeHeight / 2;
              return (
                <a
                  key={n.id}
                  href={`/maths/n/${n.id}`}
                  onClick={(e) => {
                    e.preventDefault();
                    router.push(`/maths/n/${n.id}`);
                  }}
                  onMouseEnter={() => setHover(n)}
                  onFocus={() => setHover(n)}
                  onMouseLeave={() => setHover(null)}
                >
                  <rect
                    x={x}
                    y={y}
                    width={data.nodeWidth}
                    height={data.nodeHeight}
                    rx={4}
                    fill={n.ghost ? "transparent" : s.fill}
                    stroke={
                      hover?.id === n.id || n.id === focusId
                        ? "var(--accent)"
                        : s.border
                    }
                    strokeWidth={hover?.id === n.id || n.id === focusId ? 2 : 1}
                    strokeDasharray={n.ghost ? "3 2" : undefined}
                  />
                  <text
                    x={p.x}
                    y={p.y + 4}
                    textAnchor="middle"
                    fontFamily="inherit"
                    fontSize={11}
                    fill={n.ghost ? "var(--foreground)" : s.text}
                    opacity={n.ghost ? 0.55 : 1}
                    style={{ pointerEvents: "none" }}
                  >
                    {n.id.length > 26 ? n.id.slice(0, 25) + "…" : n.id}
                  </text>
                </a>
              );
            })}
          </g>
        </svg>

        <div className="chrome absolute top-2 right-2 flex gap-2">
          <button
            className="rounded border border-line bg-surface hover:border-accent px-2 py-0.5"
            onClick={() => setT((p) => ({ ...p, k: Math.max(ZOOM.min, p.k / 1.3) }))}
            aria-label="Dézoomer"
          >
            −
          </button>
          <button
            className="rounded border border-line bg-surface hover:border-accent px-2 py-0.5"
            onClick={() => setT((p) => ({ ...p, k: Math.min(ZOOM.max, p.k * 1.3) }))}
            aria-label="Zoomer"
          >
            +
          </button>
          <span className="text-muted self-center tabular-nums">
            {Math.round(t.k * 100)} %
          </span>
        </div>
      </div>

      {/* Règle basse : le nœud pointé. Rien d'autre. */}
      <div className="chrome flex h-9 shrink-0 items-center gap-3 overflow-hidden border-t border-line px-4 whitespace-nowrap">
        {hover ? (
          <>
            <span className="font-medium">{hover.id}</span>
            <span className="text-muted">·</span>
            <span>{ETAT[hover.state].label}</span>
            <span className="text-muted">·</span>
            <span>{hover.hours} h</span>
            <span className="text-muted">·</span>
            <span>
              débloque {hover.unlocks} nœud{hover.unlocks > 1 ? "s" : ""}
            </span>
            {hover.ghost && (
              <>
                <span className="text-muted">·</span>
                <span className="text-muted">
                  hors vue — {hover.domainLabel}
                </span>
              </>
            )}
            <div className="grow" />
            <span className="max-w-[40ch] truncate">{hover.title}</span>
          </>
        ) : (
          <span className="text-muted">
            survoler un nœud · molette pour zoomer · glisser pour déplacer
          </span>
        )}
      </div>
    </div>
  );
}
