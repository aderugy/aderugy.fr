import Link from "next/link";
import { loadGraph } from "@/lib/maths/graph/load";
import { chargerDonnees, minutesByNode } from "@/server/maths/data";
import { evidenceParNoeud } from "@/lib/maths/progression/evidence";
import { computeStates } from "@/lib/maths/progression/rules";
import {
  chargeAVenir,
  courbeOubli,
  heuresParDomaine,
  noeudsFragiles,
  reussiteParTag,
  type EtatCarteBrut,
} from "@/lib/maths/stats";
import {
  BarresHeures,
  BarresReussite,
  CourbeRetention,
  HistogrammeCharge,
} from "@/components/maths/graphiques";
import { ETAT, marqueur, minutes as fmtMinutes } from "@/lib/maths/etat";

export default async function TableauDeBord() {
  const maintenant = new Date();
  const graph = loadGraph();
  const donnees = await chargerDonnees();
  const preuves = evidenceParNoeud(graph, donnees);
  const etats = computeStates(graph, preuves);

  const cartes: EtatCarteBrut[] = [...donnees.reviewStates.values()].map((r) => ({
    nodeId: r.nodeId,
    stability: r.stability,
    due: r.due,
    lastReview: r.lastReview,
    lapses: r.lapses,
  }));
  const tentatives = donnees.attempts;

  const domaines = heuresParDomaine(graph, etats, minutesByNode(donnees));
  const tags = reussiteParTag(
    graph,
    tentatives.map((t) => ({
      nodeId: t.nodeId,
      difficulty: t.difficulty,
      outcome: t.outcome,
      minutesSpent: t.minutesSpent,
    })),
  );
  const oubli = courbeOubli(cartes, maintenant, 60);
  const charge = chargeAVenir(cartes, maintenant, 30);
  const fragiles = noeudsFragiles(graph, etats, preuves, cartes);

  const minutesTotales = [...minutesByNode(donnees).values()].reduce((a, b) => a + b, 0);
  const revisees = cartes.filter((c) => c.lastReview !== null).length;

  return (
    <main className="mx-auto w-full max-w-4xl px-4 py-6 sm:px-8 sm:py-8">
      <h1 className="text-2xl font-semibold tracking-tight">Tableau de bord</h1>
      <p className="chrome text-muted mt-1 max-w-[70ch]">
        Ce que les données permettent de dire, et rien de plus. Chaque panneau
        indique ce qui lui manque quand il n&apos;a pas de quoi répondre.
      </p>

      <Panneau
        titre="Heures par niveau"
        note={`${fmtMinutes(minutesTotales)} réellement passées, tous nœuds confondus`}
      >
        <BarresHeures lignes={domaines} />
        <Tableau
          entetes={["niveau", "concepts acquis", "heures acquises", "estimé", "temps réel"]}
          lignes={domaines.map((d) => [
            d.titre,
            `${d.conceptsAcquis} / ${d.concepts}`,
            `${d.heuresAcquises} h`,
            `${d.heuresEstimees} h`,
            d.minutesReelles ? fmtMinutes(d.minutesReelles) : "—",
          ])}
        />
        <p className="chrome text-muted mt-2 max-w-[70ch]">
          L&apos;écart entre le temps estimé et le temps réel est la seule façon
          de savoir si les estimations du graphe valent quelque chose. Il faudra
          plusieurs nœuds terminés pour qu&apos;il veuille dire quelque chose.
        </p>
      </Panneau>

      <Panneau
        titre="Charge de révision, 30 jours"
        note={`${cartes.length} carte${cartes.length > 1 ? "s" : ""} dans l'ordonnanceur`}
      >
        {cartes.length === 0 ? (
          <Vide>
            aucune carte en base — réviser une première fois depuis la{" "}
            <Link href="/maths/revision" className="text-accent hover:underline">
              file de révision
            </Link>
          </Vide>
        ) : (
          <>
            <HistogrammeCharge points={charge} />
            <p className="chrome text-muted mt-2">
              La première colonne cumule le retard et les cartes du jour.
            </p>
          </>
        )}
      </Panneau>

      <Panneau
        titre="Courbe d'oubli"
        note={`prévision sur ${revisees} carte${revisees > 1 ? "s" : ""} déjà révisée${revisees > 1 ? "s" : ""}`}
      >
        {revisees === 0 ? (
          <Vide>
            aucune carte révisée — la courbe est calculée à partir des
            stabilités, qui n&apos;existent qu&apos;après une première révision
          </Vide>
        ) : (
          <>
            <CourbeRetention points={oubli} />
            <p className="chrome text-muted mt-2 max-w-[70ch]">
              Rétention moyenne <em>prévue</em> par l&apos;ordonnanceur, pas
              mesurée : c&apos;est la formule FSRS appliquée aux stabilités
              actuelles. La courbe empirique — taux de rappel réel en fonction
              du délai — demandera plusieurs centaines de lignes dans{" "}
              <code>review_log</code>, qui les enregistre déjà.
            </p>
          </>
        )}
      </Panneau>

      <Panneau
        titre="Réussite par tag"
        note={`${tentatives.length} tentative${tentatives.length > 1 ? "s" : ""} enregistrée${tentatives.length > 1 ? "s" : ""}`}
      >
        {tags.length === 0 ? (
          <Vide>
            aucune tentative enregistrée — le formulaire est sous la correction
            de chaque exercice
          </Vide>
        ) : (
          <>
            <BarresReussite lignes={tags} />
            <p className="chrome text-muted mt-2 max-w-[70ch]">
              Encre pleine : réussi seul. Hachuré : réussi avec indice. Contour
              seul : échec ou abandon. Un exercice compte pour tous les tags de
              son nœud, les lignes ne s&apos;additionnent donc pas — la question
              est « sur quel type de contenu est-ce que je bloque ».
            </p>
          </>
        )}
      </Panneau>

      <Panneau
        titre="Nœuds fragiles"
        note={`${fragiles.length} signalé${fragiles.length > 1 ? "s" : ""}`}
      >
        {fragiles.length === 0 ? (
          <Vide>
            rien à signaler — un nœud devient fragile quand plus de la moitié de
            ses exercices sont réussis avec indice, qu&apos;une carte a rechuté
            deux fois, ou qu&apos;une carte d&apos;un nœud acquis retombe sous
            le seuil de stabilité
          </Vide>
        ) : (
          <ul className="chrome max-w-[70ch]">
            {fragiles.map((f) => (
              <li
                key={f.nodeId}
                className="border-line flex items-baseline gap-3 border-b py-2"
              >
                <span style={{ color: ETAT[f.etat].border }}>
                  {marqueur(f.etat)}
                </span>
                <Link href={`/maths/n/${f.nodeId}`} className="hover:text-accent">
                  {f.titre}
                </Link>
                <div className="grow" />
                <span className="text-muted">
                  {f.raisons.join(" · ")}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panneau>
    </main>
  );
}

function Panneau({
  titre,
  note,
  children,
}: {
  titre: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-6 rounded-lg border border-line bg-surface p-4 sm:p-5">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-line pb-2">
        <h2 className="text-base font-semibold tracking-tight">{titre}</h2>
        <div className="grow" />
        {note && <span className="chrome text-muted">{note}</span>}
      </div>
      <div className="mt-3">{children}</div>
    </section>
  );
}

function Vide({ children }: { children: React.ReactNode }) {
  return <p className="chrome text-muted max-w-[70ch]">{children}</p>;
}

/** Doublure tabulaire : un graphique sans table n'est pas relisible. */
function Tableau({
  entetes,
  lignes,
}: {
  entetes: string[];
  lignes: (string | number)[][];
}) {
  return (
    <div className="mt-4 overflow-x-auto"><table className="chrome w-full max-w-[70ch]">
      <thead>
        <tr className="text-muted border-line border-b">
          {entetes.map((e, i) => (
            <th key={e} className={`py-1 font-medium ${i === 0 ? "text-left" : "text-right"}`}>
              {e}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {lignes.map((l, i) => (
          <tr key={i} className="border-line border-b">
            {l.map((c, j) => (
              <td
                key={j}
                className={`py-1 tabular-nums ${j === 0 ? "text-left" : "text-right"}`}
              >
                {c}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table></div>
  );
}
