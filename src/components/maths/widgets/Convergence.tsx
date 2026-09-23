"use client";

import { useMemo, useState } from "react";

/**
 * Convergence de la moyenne empirique — le premier widget interactif du §7.
 *
 * Il sert trois nœuds à la fois : `suites-reelles`, où il montre qu'une suite
 * convergente peut l'être très lentement ; `loi-grands-nombres-intuitive`, dont
 * il est l'illustration directe ; et `loi-cauchy-lois-lourdes`, parce que la
 * loi de Cauchy est le contre-exemple — sans espérance, la moyenne empirique ne
 * converge pas, et le widget le rend visible en une seconde.
 *
 * Le générateur est déterministe et sa graine est un paramètre : la même page
 * donne toujours la même figure, ce qui est la moindre des choses pour un
 * support de cours dont on peut discuter les valeurs.
 */

type Loi = "uniforme" | "bernoulli" | "cauchy";

const LOIS: Record<
  Loi,
  { libelle: string; moyenne: number | null; ecartType: number | null }
> = {
  uniforme: { libelle: "uniforme sur [0,1]", moyenne: 0.5, ecartType: Math.sqrt(1 / 12) },
  bernoulli: { libelle: "Bernoulli(0,3)", moyenne: 0.3, ecartType: Math.sqrt(0.3 * 0.7) },
  cauchy: { libelle: "Cauchy standard", moyenne: null, ecartType: null },
};

/** mulberry32 — court, correct, et reproductible d'un navigateur à l'autre. */
function generateur(graine: number) {
  let a = graine >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function tirage(loi: Loi, u: number): number {
  if (loi === "uniforme") return u;
  if (loi === "bernoulli") return u < 0.3 ? 1 : 0;
  return Math.tan(Math.PI * (u - 0.5)); // Cauchy par inversion
}

export default function Convergence({
  loiInitiale = "uniforme",
  nMax = 10000,
  trajectoires = 12,
  graine = 1,
}: {
  loiInitiale?: Loi;
  nMax?: number;
  trajectoires?: number;
  graine?: number;
}) {
  const [loi, setLoi] = useState<Loi>(loiInitiale);
  const [R, setR] = useState(trajectoires);
  const [g, setG] = useState(graine);

  const { chemins, min, max } = useMemo(() => {
    const rnd = generateur(g);
    const chemins: [number, number][][] = [];
    let min = Infinity;
    let max = -Infinity;
    for (let r = 0; r < R; r++) {
      const points: [number, number][] = [];
      let somme = 0;
      for (let n = 1; n <= nMax; n++) {
        somme += tirage(loi, rnd());
        // Un point par pas logarithmique : 10 000 segments par trajectoire ne
        // se verraient pas et coûteraient cher à tracer.
        if (n <= 10 || n % Math.max(1, Math.floor(n / 40)) === 0 || n === nMax) {
          const m = somme / n;
          points.push([n, m]);
          if (Number.isFinite(m)) {
            min = Math.min(min, m);
            max = Math.max(max, m);
          }
        }
      }
      chemins.push(points);
    }
    return { chemins, min, max };
  }, [loi, R, g, nMax]);

  const info = LOIS[loi];
  // Cadrage : autour de la moyenne théorique quand elle existe, sinon sur ce
  // que les trajectoires ont réellement fait — c'est tout le sujet.
  const [y0, y1] =
    info.moyenne !== null
      ? [info.moyenne - 0.55, info.moyenne + 0.55]
      : [Math.max(min, -8), Math.min(max, 8)];

  const W = 640;
  const H = 240;
  const M = { g: 8, d: 8, h: 12, b: 24 };
  const x = (n: number) =>
    M.g + (Math.log10(n) / Math.log10(nMax)) * (W - M.g - M.d);
  const y = (v: number) =>
    M.h + (1 - (v - y0) / (y1 - y0)) * (H - M.h - M.b);

  const chemin = (pts: [number, number][]) =>
    pts
      .map(([n, v], i) => `${i === 0 ? "M" : "L"}${x(n).toFixed(1)},${y(v).toFixed(1)}`)
      .join(" ");

  const decades = [1, 10, 100, 1000, 10000].filter((d) => d <= nMax);

  return (
    <figure className="my-6 overflow-hidden rounded-lg border border-line bg-surface">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="block h-auto w-full"
        role="img"
        aria-label={`Moyennes empiriques de ${R} trajectoires, loi ${info.libelle}`}
      >
        {decades.map((d) => (
          <line
            key={d}
            x1={x(d)}
            x2={x(d)}
            y1={M.h}
            y2={H - M.b}
            stroke="var(--border)"
            strokeDasharray="2 3"
          />
        ))}

        {/* Enveloppe théorique en 1,96 σ/√n : la vitesse, pas la limite. */}
        {info.moyenne !== null && info.ecartType !== null && (
          <path
            d={
              decadesFines(nMax)
                .map((n, i) => {
                  const e = 1.96 * (info.ecartType! / Math.sqrt(n));
                  return `${i === 0 ? "M" : "L"}${x(n).toFixed(1)},${y(info.moyenne! + e).toFixed(1)}`;
                })
                .join(" ") +
              " " +
              decadesFines(nMax)
                .reverse()
                .map((n) => {
                  const e = 1.96 * (info.ecartType! / Math.sqrt(n));
                  return `L${x(n).toFixed(1)},${y(info.moyenne! - e).toFixed(1)}`;
                })
                .join(" ") +
              " Z"
            }
            fill="var(--border)"
            opacity="0.35"
          />
        )}

        {info.moyenne !== null && (
          <line
            x1={M.g}
            x2={W - M.d}
            y1={y(info.moyenne)}
            y2={y(info.moyenne)}
            stroke="var(--foreground)"
            strokeWidth="1"
          />
        )}

        {chemins.map((c, i) => (
          <path
            key={i}
            d={chemin(c)}
            fill="none"
            stroke="var(--foreground)"
            strokeWidth="1"
            opacity={0.45}
          />
        ))}

        <line
          x1={M.g}
          x2={W - M.d}
          y1={H - M.b}
          y2={H - M.b}
          stroke="var(--border)"
        />
        {decades.map((d, i) => (
          <text
            key={d}
            x={x(d)}
            y={H - M.b + 15}
            // Première et dernière décade ancrées vers l'intérieur, sinon
            // elles débordent du cadre.
            textAnchor={
              i === 0 ? "start" : i === decades.length - 1 ? "end" : "middle"
            }
            fontFamily="inherit"
            fontSize="11"
            fill="var(--muted)"
          >
            {d.toLocaleString("fr-FR")}
          </text>
        ))}
      </svg>

      <div className="chrome border-line flex flex-wrap items-center gap-4 border-t px-3 py-2">
        <label className="flex items-center gap-2">
          <span className="text-muted">loi</span>
          <select
            value={loi}
            onChange={(e) => setLoi(e.target.value as Loi)}
            className="rounded border border-line bg-surface px-2 py-0.5 focus:border-accent focus:outline-none"
          >
            {(Object.keys(LOIS) as Loi[]).map((k) => (
              <option key={k} value={k}>
                {LOIS[k].libelle}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2">
          <span className="text-muted">trajectoires</span>
          <input
            type="range"
            min={1}
            max={40}
            value={R}
            onChange={(e) => setR(Number(e.target.value))}
            className="w-28"
          />
          <span className="tabular-nums">{R}</span>
        </label>
        <button
          onClick={() => setG((v) => v + 1)}
          className="rounded border border-line bg-surface hover:border-accent px-2 py-0.5"
        >
          retirer
          <span className="text-muted ml-2 tabular-nums">graine {g}</span>
        </button>
      </div>

      <figcaption className="chrome text-muted border-line border-t px-3 py-2">
        Moyennes empiriques en fonction de <em>n</em>, échelle logarithmique.
        {info.moyenne !== null ? (
          <>
            {" "}
            La bande grise est l&apos;intervalle théorique à 1,96 σ/√<em>n</em> :
            les trajectoires y restent, et il faut multiplier <em>n</em> par cent
            pour la resserrer d&apos;un facteur dix.
          </>
        ) : (
          <>
            {" "}
            La loi de Cauchy n&apos;a pas d&apos;espérance : la moyenne
            empirique ne converge pas, et des sauts apparaissent à toute
            échelle. Augmenter <em>n</em> n&apos;y change rien — c&apos;est le
            contre-exemple qui montre que la loi des grands nombres a bien une
            hypothèse.
          </>
        )}
      </figcaption>
    </figure>
  );
}

/** Abscisses régulières en échelle log, pour tracer l'enveloppe. */
function decadesFines(nMax: number): number[] {
  const out: number[] = [];
  for (let i = 0; i <= 60; i++) {
    out.push(Math.max(1, Math.round(Math.pow(nMax, i / 60))));
  }
  return out;
}
