import Link from "next/link";
import { loadGraph } from "@/lib/maths/graph/load";
import { chargerDonnees, revisionsParJour } from "@/server/maths/data";
import { bilan } from "@/server/maths/jeu";
import { BAREME, JOKERS_PAR_SEMAINE, type Evenement } from "@/lib/maths/jeu";
import { dateCourte } from "@/lib/maths/etat";

/**
 * Rythme (décision D26) : XP, niveau, série, objectif du jour, badges.
 *
 * Même parti pris visuel que le tableau de bord (D21) : une seule encre, des
 * filets, chaque graphique doublé de ses chiffres. La couleur de maîtrise
 * n'apparaît pas ici — l'XP mesure l'effort, pas la maîtrise, et la page le
 * dit.
 */
export default async function RythmePage() {
  const graph = loadGraph();
  const [donnees, revisions] = await Promise.all([chargerDonnees(), revisionsParJour()]);
  const b = bilan(graph, donnees, revisions, new Date());
  const titre = (nodeId: string) => graph.byId.get(nodeId)?.title ?? nodeId;
  const maxJour = Math.max(1, ...b.recents.map((r) => r.xp));
  const obtenus = b.badges.filter((x) => x.obtenu).length;

  return (
    <main className="mx-auto w-full max-w-4xl px-4 py-6 sm:px-8 sm:py-8">
      <h1 className="text-2xl font-semibold tracking-tight">Rythme</h1>
      <p className="chrome text-muted mt-1 max-w-[70ch]">
        L&apos;XP compte l&apos;effort — capsules, exercices, révisions — et ne
        décide de rien : l&apos;état des nœuds reste calculé sur les preuves
        (cours lu, exercices, stabilité des cartes).
      </p>

      {/* Niveau et série, côte à côte : les deux chiffres qu'on vient voir. */}
      <section className="border-line mt-6 grid gap-6 border-y py-5 sm:grid-cols-2">
        <div>
          <div className="chrome text-muted">niveau</div>
          <div className="mt-0.5 flex items-baseline gap-3">
            <span className="text-3xl font-semibold tabular-nums">{b.niveau.niveau}</span>
            <span className="chrome text-muted tabular-nums">
              {b.xp} XP · encore {b.niveau.jusqua - b.xp} pour le niveau {b.niveau.niveau + 1}
            </span>
          </div>
          <svg
            viewBox="0 0 100 6"
            preserveAspectRatio="none"
            className="mt-2 block h-2.5 w-full max-w-sm"
            role="img"
            aria-label={`${Math.round(b.niveau.part * 100)} % du niveau ${b.niveau.niveau}`}
          >
            <rect x="0.25" y="0.25" width="99.5" height="5.5" fill="none" stroke="var(--accent)" strokeWidth="0.5" vectorEffect="non-scaling-stroke" />
            <rect x="0" y="0" width={b.niveau.part * 100} height="6" fill="var(--accent)" />
          </svg>
        </div>

        <div>
          <div className="chrome text-muted">série</div>
          <div className="mt-0.5 flex items-baseline gap-3">
            <span className="text-3xl font-semibold tabular-nums">{b.serie.longueur}</span>
            <span className="chrome text-muted">
              jour{b.serie.longueur > 1 ? "s" : ""} · record {b.serie.record}
            </span>
          </div>
          <ul className="chrome mt-2">
            <li>
              {b.serie.aujourdhui
                ? "✓ aujourd'hui compte déjà"
                : b.serie.longueur > 0
                  ? "aujourd'hui reste à faire, avant minuit"
                  : "une capsule, un exercice ou une carte suffit à la lancer"}
            </li>
            <li className="text-muted">
              joker : {b.serie.jokerDisponible ? "disponible cette semaine" : "utilisé cette semaine"}
              {b.serie.jokers.length > 0 &&
                ` · a couvert ${b.serie.jokers.map((j) => dateCourte(`${j}T12:00:00Z`)).join(", ")}`}
            </li>
          </ul>
        </div>
      </section>

      <Panneau titre="Objectif du jour">
        <ul className="chrome-15">
          {b.objectif.map((o) => (
            <li key={o.libelle} className="border-line flex flex-wrap items-baseline gap-x-3 border-b py-2">
              <span aria-hidden className="w-4">{o.fait ? "☑" : "☐"}</span>
              <span className={o.fait ? "text-muted" : undefined}>{o.libelle}</span>
              <span className="chrome text-muted">{o.detail}</span>
            </li>
          ))}
        </ul>
        <p className="chrome text-muted mt-2">
          {b.objectif.every((o) => o.fait)
            ? "Fait pour aujourd'hui."
            : b.objectif[0].fait
              ? <>Reste la <Link href="/maths/revision" className="underline hover:text-foreground">file de révision</Link>.</>
              : <>Le plus court : la prochaine capsule, depuis le <Link href="/maths" className="underline hover:text-foreground">parcours</Link>.</>}
        </p>
      </Panneau>

      <Panneau titre="Quatorze derniers jours">
        {b.recents.every((r) => r.xp === 0) ? (
          <p className="chrome text-muted">aucun gain sur la période</p>
        ) : (
          <>
            <svg
              viewBox={`0 0 ${b.recents.length * 10} 40`}
              className="block h-24 w-full max-w-xl"
              role="img"
              aria-label="XP par jour sur quatorze jours"
            >
              {b.recents.map((r, i) => {
                const h = (r.xp / maxJour) * 36;
                return (
                  <rect key={r.jour} x={i * 10 + 1.5} y={38 - h} width="7" height={Math.max(h, r.xp > 0 ? 0.8 : 0)} fill="var(--accent)" />
                );
              })}
              <line x1="0" y1="38.25" x2={b.recents.length * 10} y2="38.25" stroke="var(--border)" strokeWidth="0.5" />
            </svg>
            <table className="chrome mt-2 w-full max-w-xl">
              <tbody>
                <tr className="text-muted">
                  {b.recents.map((r) => (
                    <td key={r.jour} className="text-center tabular-nums">{Number(r.jour.slice(8))}</td>
                  ))}
                </tr>
                <tr>
                  {b.recents.map((r) => (
                    <td key={r.jour} className="text-center tabular-nums">{r.xp || "·"}</td>
                  ))}
                </tr>
              </tbody>
            </table>
          </>
        )}
      </Panneau>

      <Panneau titre={`Badges · ${obtenus} / ${b.badges.length}`}>
        <ul className="grid gap-x-8 sm:grid-cols-2">
          {b.badges.map((x) => (
            <li key={x.id} className="border-line flex items-baseline gap-3 border-b py-2">
              <span aria-hidden className="font-mono text-[12px]">{x.obtenu ? "▮" : "▯"}</span>
              <div className="min-w-0">
                <div className={x.obtenu ? "font-medium" : "text-muted"}>{x.nom}</div>
                <div className="chrome text-muted">
                  {x.description}
                  {x.obtenu && x.jour && ` · ${dateCourte(`${x.jour}T12:00:00Z`)}`}
                  {!x.obtenu && x.progres && ` · ${x.progres.fait} / ${x.progres.but}`}
                </div>
              </div>
            </li>
          ))}
        </ul>
      </Panneau>

      <Panneau titre="Derniers gains">
        {b.journal.length === 0 ? (
          <p className="chrome text-muted">rien encore — la première capsule rapporte {BAREME.capsule} XP</p>
        ) : (
          <table className="chrome w-full">
            <tbody>
              {b.journal.map((e, i) => (
                <tr key={i} className="border-line border-b">
                  <td className="text-muted w-24 py-1 pr-3 whitespace-nowrap">{dateCourte(`${e.jour}T12:00:00Z`)}</td>
                  <td className="py-1 pr-3">{libelle(e, titre)}</td>
                  <td className="py-1 text-right tabular-nums whitespace-nowrap">+{e.xp}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panneau>

      <Panneau titre="Barème">
        <table className="chrome w-full max-w-[60ch]">
          <tbody>
            {[
              ["capsule terminée", `${BAREME.capsule}`],
              ["checkpoint réussi du premier coup", `+${BAREME.premierEssai}`],
              ["exercice résolu seul", `${BAREME.exercice["resolu-seul"]} × difficulté`],
              ["exercice résolu avec indice", `${BAREME.exercice["resolu-avec-indice"]} × difficulté`],
              ["exercice tenté (échec)", `${BAREME.exercice.echec} × difficulté`],
              ["exercice abandonné", `${BAREME.exercice.abandonne} × difficulté`],
              ["test de sortie réussi (première fois sur un nœud)", `+${BAREME.testDeSortie}`],
              ["carte révisée (une fois par jour)", `${BAREME.revision}`],
            ].map(([k, v]) => (
              <tr key={k} className="border-line border-b">
                <td className="py-1 pr-3">{k}</td>
                <td className="py-1 text-right tabular-nums">{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="chrome text-muted mt-2 max-w-[70ch]">
          Un exercice ne rapporte que ses progrès : le refaire après l&apos;avoir
          réussi ne rapporte rien, et déclarer un échec ne retire jamais rien.
          Niveau n à 100·n(n−1)/2 XP. Série : un jour compte dès une capsule, un
          exercice, une carte ou une séance au journal ; {JOKERS_PAR_SEMAINE} joker par
          semaine couvre un jour manqué isolé.
        </p>
      </Panneau>
    </main>
  );
}

function libelle(e: Evenement, titre: (id: string) => string): string {
  switch (e.type) {
    case "capsule":
      return `capsule ${e.detail} · ${titre(e.nodeId)}`;
    case "premier-essai":
      return `checkpoint du premier coup · ${e.detail}`;
    case "exercice":
      return `exercice ${e.detail.split("/")[1] ?? e.detail} · ${titre(e.nodeId)}`;
    case "test-de-sortie":
      return `test de sortie réussi · ${titre(e.nodeId)}`;
    case "revision":
      return `${e.detail} carte${Number(e.detail) > 1 ? "s" : ""} révisée${Number(e.detail) > 1 ? "s" : ""} · ${titre(e.nodeId)}`;
  }
}

function Panneau({ titre, children }: { titre: string; children: React.ReactNode }) {
  return (
    <section className="mt-8">
      <h2 className="border-line mb-3 border-b pb-1 text-lg font-semibold tracking-tight">{titre}</h2>
      {children}
    </section>
  );
}
