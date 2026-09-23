/**
 * Primitives de graphique du tableau de bord.
 *
 * Règle de couleur, héritée du §9 : la couleur encode l'état de maîtrise et
 * rien d'autre. Concrètement, **les graphiques sont tracés d'une seule
 * encre** — l'accent du site sur le fond, comme un enregistrement
 * d'instrument — et la rampe de
 * maîtrise n'apparaît que là où la grandeur mesurée *est* la maîtrise, c'est-à-
 * dire les heures acquises. Aucune palette catégorielle : là où il faudrait
 * distinguer des catégories, on emploie la texture (hachure) et l'étiquetage
 * direct, jamais une seconde teinte.
 *
 * La rampe est une échelle séquentielle valide — luminosité OKLab strictement
 * décroissante, 0,809 → 0,609 → 0,459 → 0,311 — mais son premier échelon n'a
 * qu'un contraste de 1,61:1 sur la plaque. Tout aplat clair porte donc une
 * étiquette lisible, et chaque graphique est doublé d'un tableau.
 */

export const HACHURE_ID = "hachure-45";

/** Motif de hachure, seule distinction non colorée admise. */
export function DefsHachure() {
  return (
    <defs>
      <pattern
        id={HACHURE_ID}
        width="6"
        height="6"
        patternUnits="userSpaceOnUse"
        patternTransform="rotate(45)"
      >
        <line
          x1="0"
          y1="0"
          x2="0"
          y2="6"
          stroke="var(--accent)"
          strokeWidth="2.5"
        />
      </pattern>
    </defs>
  );
}

// ── Barres de progression : la seule chose colorée du tableau de bord ───────

export function BarresHeures({
  lignes,
}: {
  lignes: {
    id: string;
    titre: string;
    heuresEstimees: number;
    heuresAcquises: number;
  }[];
}) {
  const max = Math.max(1, ...lignes.map((l) => l.heuresEstimees));
  return (
    <table className="chrome w-full max-w-[70ch]">
      <tbody>
        {lignes.map((l) => {
          const part = l.heuresAcquises / max;
          const total = l.heuresEstimees / max;
          return (
            <tr key={l.id}>
              <td className="w-28 py-1 pr-3 align-middle">{l.titre}</td>
              <td className="py-1 align-middle">
                <svg
                  viewBox="0 0 100 8"
                  preserveAspectRatio="none"
                  className="block h-3 w-full"
                  role="img"
                  aria-label={`${l.heuresAcquises} heures acquises sur ${l.heuresEstimees}`}
                >
                  <rect
                    x="0"
                    y="0.5"
                    width={total * 100}
                    height="7"
                    fill="none"
                    stroke="var(--border)"
                    strokeWidth="1"
                    vectorEffect="non-scaling-stroke"
                  />
                  {part > 0 && (
                    <rect
                      x="0"
                      y="0.5"
                      width={part * 100}
                      height="7"
                      fill="var(--maitrise-70)"
                    />
                  )}
                </svg>
              </td>
              <td className="text-muted w-32 py-1 pl-3 text-right tabular-nums">
                {l.heuresAcquises} / {l.heuresEstimees} h
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// ── Barres de réussite : encre pleine, hachurée, ou vide ────────────────────

export function BarresReussite({
  lignes,
}: {
  lignes: {
    tag: string;
    essais: number;
    reussis: number;
    sansIndice: number;
    taux: number;
  }[];
}) {
  const max = Math.max(1, ...lignes.map((l) => l.essais));
  return (
    <table className="chrome w-full max-w-[70ch]">
      <tbody>
        {lignes.map((l) => {
          const seul = (l.sansIndice / max) * 100;
          const indice = ((l.reussis - l.sansIndice) / max) * 100;
          const rate = ((l.essais - l.reussis) / max) * 100;
          return (
            <tr key={l.tag}>
              <td className="w-28 py-1 pr-3 align-middle">{l.tag}</td>
              <td className="py-1 align-middle">
                <svg
                  viewBox="0 0 100 8"
                  preserveAspectRatio="none"
                  className="block h-3 w-full"
                  role="img"
                  aria-label={`${l.reussis} réussis sur ${l.essais}, dont ${l.sansIndice} sans indice`}
                >
                  <DefsHachure />
                  {/* 2 px de fond entre les segments : ils ne se touchent pas. */}
                  <rect x="0" y="0.5" width={seul} height="7" fill="var(--accent)" />
                  <rect
                    x={seul}
                    y="0.5"
                    width={Math.max(0, indice)}
                    height="7"
                    fill={`url(#${HACHURE_ID})`}
                    opacity="0.55"
                  />
                  <rect
                    x={seul + indice}
                    y="0.5"
                    width={Math.max(0, rate)}
                    height="7"
                    fill="none"
                    stroke="var(--border)"
                    strokeWidth="1"
                    vectorEffect="non-scaling-stroke"
                  />
                </svg>
              </td>
              <td className="text-muted w-40 py-1 pl-3 text-right tabular-nums">
                {Math.round(l.taux * 100)} % · {l.sansIndice} seul ·{" "}
                {l.essais} essais
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// ── Courbe de rétention ─────────────────────────────────────────────────────

export function CourbeRetention({
  points,
  reperes = [7, 30, 60],
}: {
  points: { jour: number; retention: number }[];
  reperes?: number[];
}) {
  const W = 640;
  const H = 180;
  const M = { g: 4, d: 44, h: 12, b: 22 };
  const jMax = Math.max(1, ...points.map((p) => p.jour));
  const x = (j: number) => M.g + (j / jMax) * (W - M.g - M.d);
  const y = (r: number) => M.h + (1 - r) * (H - M.h - M.b);

  const d = points
    .map((p, i) => `${i === 0 ? "M" : "L"}${x(p.jour).toFixed(1)},${y(p.retention).toFixed(1)}`)
    .join(" ");

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="block h-auto w-full max-w-[70ch]"
      role="img"
      aria-label="Rétention moyenne prévue sur les prochains jours"
    >
      {/* Grille : le seuil de 90 % est la définition même de la stabilité. */}
      {[
        { v: 0.9, l: "90 %" },
        { v: 0.5, l: "50 %" },
      ].map((g) => (
        <g key={g.v}>
          <line
            x1={M.g}
            x2={W - M.d}
            y1={y(g.v)}
            y2={y(g.v)}
            stroke="var(--border)"
            strokeWidth="1"
            strokeDasharray={g.v === 0.9 ? undefined : "3 3"}
          />
          <text
            x={W - M.d + 6}
            y={y(g.v) + 4}
            fontFamily="inherit"
            fontSize="11"
            fill="var(--muted)"
          >
            {g.l}
          </text>
        </g>
      ))}

      <path d={d} fill="none" stroke="var(--accent)" strokeWidth="2" />

      {reperes
        .filter((j) => j <= jMax)
        .map((j) => {
          const p = points.find((q) => q.jour === j);
          if (!p) return null;
          return (
            <g key={j}>
              <circle cx={x(j)} cy={y(p.retention)} r="4" fill="var(--accent)" />
              <text
                x={x(j)}
                y={y(p.retention) - 9}
                textAnchor="middle"
                fontFamily="inherit"
                fontSize="11"
                fill="var(--foreground)"
              >
                {Math.round(p.retention * 100)} %
              </text>
            </g>
          );
        })}

      <line
        x1={M.g}
        x2={W - M.d}
        y1={H - M.b}
        y2={H - M.b}
        stroke="var(--border)"
      />
      {[0, ...reperes].filter((j) => j <= jMax).map((j) => (
        <text
          key={j}
          x={x(j)}
          y={H - M.b + 14}
          // La première étiquette est longue : l'ancrer à gauche, sinon elle
          // déborde du cadre et se fait rogner.
          textAnchor={j === 0 ? "start" : "middle"}
          fontFamily="inherit"
          fontSize="11"
          fill="var(--muted)"
        >
          {j === 0 ? "aujourd'hui" : `J+${j}`}
        </text>
      ))}
    </svg>
  );
}

// ── Charge de révision ──────────────────────────────────────────────────────

export function HistogrammeCharge({
  points,
}: {
  points: { date: string; jour: number; cartes: number }[];
}) {
  const W = 640;
  const H = 120;
  const b = 20;
  const max = Math.max(1, ...points.map((p) => p.cartes));
  const pas = (W - 4) / points.length;

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="block h-auto w-full max-w-[70ch]"
      role="img"
      aria-label="Nombre de cartes échues par jour sur les trente prochains jours"
    >
      {points.map((p) => {
        const h = (p.cartes / max) * (H - b - 14);
        return (
          <g key={p.jour}>
            <title>{`${p.jour === 0 ? "en retard et aujourd'hui" : p.date} — ${p.cartes} carte${p.cartes > 1 ? "s" : ""}`}</title>
            <rect
              x={2 + p.jour * pas + 1}
              y={H - b - h}
              width={Math.max(1, pas - 2)}
              height={h}
              fill="var(--accent)"
            />
            {p.cartes > 0 && (
              <text
                x={2 + p.jour * pas + pas / 2}
                y={H - b - h - 4}
                textAnchor="middle"
                fontFamily="inherit"
                fontSize="10"
                fill="var(--muted)"
              >
                {p.cartes}
              </text>
            )}
          </g>
        );
      })}
      <line
        x1="2"
        x2={W - 2}
        y1={H - b}
        y2={H - b}
        stroke="var(--border)"
      />
      {[0, 7, 14, 21, 28].map((j) => (
        <text
          key={j}
          x={2 + j * pas + pas / 2}
          y={H - b + 14}
          textAnchor="middle"
          fontFamily="inherit"
          fontSize="11"
          fill="var(--muted)"
        >
          {j === 0 ? "auj." : `J+${j}`}
        </text>
      ))}
    </svg>
  );
}
