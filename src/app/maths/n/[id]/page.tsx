import Link from "next/link";
import { notFound } from "next/navigation";
import { loadGraph } from "@/lib/maths/graph/load";
import {
  exerciseKey,
  loadCards,
  loadCourse,
  loadExercises,
  RUBRIQUE,
} from "@/lib/maths/content";
import {
  attemptsOfNode,
  chargerDonnees,
  progressOf,
  reviewStatesOfNode,
  sessionsOf,
} from "@/server/maths/data";
import { evidenceParNoeud } from "@/lib/maths/progression/evidence";
import {
  computeStates,
  meriteLearned,
  meriteMastered,
  SEUILS,
} from "@/lib/maths/progression/rules";
import { dateCourte, ETAT, marqueur, minutes as fmtMinutes } from "@/lib/maths/etat";
import { Mdx } from "@/lib/maths/mdx";
import { JournalSession, MarquageEtat } from "@/components/maths/NodeActions";
import Exercice from "@/components/maths/Exercice";

/**
 * Les deux rails restent en place pendant que le cours défile : ils portent la
 * navigation par section et le relevé d'état, qui n'ont aucune raison de
 * disparaître au bout de trois écrans. Hauteur fixée au reste du viewport
 * (en-tête 3rem + règle 2,25rem) pour que leurs filets verticaux soient
 * continus, et défilement interne propre quand leur contenu déborde.
 *
 * Sous `lg`, pas de place pour trois colonnes : le rail gauche disparaît (le
 * cours se lit en continu) et le rail droit passe sous le cours.
 */
const RAIL =
  "chrome shrink-0 border-line p-4 lg:sticky lg:top-[5.25rem] lg:h-[calc(100dvh-5.25rem)] lg:overflow-y-auto";

export default async function NodePage({ params }: PageProps<"/maths/n/[id]">) {
  const { id } = await params;
  const graph = loadGraph();
  const node = graph.byId.get(id);
  if (!node || node.kind !== "concept") notFound();

  const donnees = await chargerDonnees();
  const evidence = evidenceParNoeud(graph, donnees);
  const states = computeStates(graph, evidence);
  const state = states.get(id) ?? "locked";
  const preuves = evidence.get(id);
  const progress = progressOf(donnees, id);
  const sessions = sessionsOf(donnees, id);
  const course = loadCourse(node);
  const exercises = loadExercises(node);
  const cards = loadCards(node);
  const etatsCartes = new Map(reviewStatesOfNode(donnees, id).map((r) => [r.cardId, r]));
  const tentatives = attemptsOfNode(donnees, id);
  const totalMinutes =
    sessions.reduce((a, s) => a + s.minutes, 0) +
    tentatives.reduce((a, t) => a + t.minutesSpent, 0);
  const [domain, topic] = node.ancestors.map((a) => graph.byId.get(a)!);

  const faciles = exercises.filter((e) => e.difficulty <= 3);
  const reussisFaciles = (preuves?.exercises ?? []).filter(
    (e) =>
      e.difficulty <= 3 &&
      ["resolu-seul", "resolu-avec-indice"].includes(e.outcome),
  ).length;

  return (
    <main>
      {/* Deuxième règle, sous l'en-tête (3rem). */}
      <div className="chrome sticky top-12 z-20 flex h-9 items-center gap-2 overflow-hidden border-b border-line bg-background px-4 whitespace-nowrap">
        <Link href={`/maths?v=${domain.id}`} className="text-muted hover:text-foreground">
          ← parcours
        </Link>
        <span className="hidden text-muted sm:inline">/</span>
        <span className="hidden truncate sm:inline">
          {domain.title.split(" — ")[1] ?? domain.title}
        </span>
        <span className="hidden text-muted sm:inline">/</span>
        <span className="hidden truncate sm:inline">{topic.title}</span>
        <div className="grow" />
        <span style={{ color: ETAT[state].border }}>{marqueur(state)}</span>
        <span>{ETAT[state].label}</span>
      </div>

      {/* `items-start` est indispensable : un enfant de flex étiré sur toute
          la hauteur n'a aucune marge pour coller. */}
      <div className="flex flex-col lg:flex-row lg:items-start">
        {/* Rail gauche : la rubrique du §6, toujours dans le même ordre. */}
        <nav className={RAIL + " hidden w-44 border-r lg:block"}>
          <ol className="flex flex-col gap-1">
            {RUBRIQUE.map((s, i) => (
              <li key={s.id}>
                <a
                  href={`#${s.id}`}
                  className={
                    course
                      ? "text-foreground hover:text-accent"
                      : "cursor-default text-muted"
                  }
                >
                  <span className="text-muted mr-2 tabular-nums">
                    {i + 1}
                  </span>
                  {s.label}
                </a>
              </li>
            ))}
          </ol>
          <div className="border-line mt-4 border-t pt-2">
            <div className="text-muted">temps passé</div>
            <div>{totalMinutes ? fmtMinutes(totalMinutes) : "—"}</div>
            <div className="text-muted mt-2">estimé</div>
            <div>{node.estimatedHours} h</div>
          </div>
        </nav>

        {/* Colonne de lecture. Pas de conteneur de défilement : c'est la page
            qui défile, ce qui préserve la barre du navigateur, la recherche
            dans la page et le clavier. */}
        <div className="min-w-0 grow px-4 py-6 sm:px-8 lg:px-10 lg:py-8">
          <div className="prose-cours">
            <h1 className="text-2xl font-semibold tracking-tight">{node.title}</h1>
            <p className="chrome text-muted mt-1">
              {node.id} · {node.tags.join(" · ") || "sans tag"}
            </p>
          </div>

          {course ? (
            <div className="prose-cours mt-8">
              <Mdx source={course.body} />
            </div>
          ) : (
            <div className="prose-cours border-line mt-8 border-t pt-6">
              <p>
                Le cours de ce nœud n&apos;est pas rédigé. Il suivra les neuf
                sections du §6, dans cet ordre, avec les ancres attendues par
                les cartes de révision :
              </p>
              <ol className="chrome-15 border-line mt-4 border-l">
                {RUBRIQUE.map((s) => (
                  <li key={s.id} className="py-0.5 pl-3">
                    <code className="font-mono">#{s.id}</code>
                    <span className="text-muted ml-2">{s.label}</span>
                  </li>
                ))}
              </ol>
              <p className="chrome text-muted mt-4">
                Fichier attendu : <code>content/maths/{node.coursePath}</code>
              </p>
            </div>
          )}

          <section className="mt-12 max-w-[92ch]">
            <h2 className="border-line border-b pb-1 text-lg font-semibold tracking-tight">
              Exercices
            </h2>
            {exercises.length === 0 ? (
              <p className="chrome text-muted mt-3">
                aucun exercice — 8 à 15 attendus, répartis sur les cinq
                difficultés
              </p>
            ) : (
              <>
                <p className="chrome text-muted mt-2">
                  {reussisFaciles} / {faciles.length} réussis en difficulté ≤ 3
                  · seuil pour « acquis » :{" "}
                  {Math.ceil(faciles.length * SEUILS.reussiteFaible)}, dont la
                  moitié sans indice
                </p>
                <ul className="mt-3 space-y-2">
                  {exercises.map((e, i) => {
                    const key = exerciseKey(node.id, e.id);
                    return (
                      <Exercice
                        key={e.id}
                        numero={i + 1}
                        nodeId={node.id}
                        exerciseId={e.id}
                        kind={e.kind}
                        difficulty={e.difficulty}
                        statement={<Mdx source={e.statement} />}
                        hints={e.hints.map((h, k) => (
                          <Mdx key={k} source={h} />
                        ))}
                        solution={<Mdx source={e.solution} />}
                        tentatives={tentatives
                          .filter((t) => t.exerciseKey === key)
                          .map((t) => ({
                            outcome: t.outcome,
                            minutesSpent: t.minutesSpent,
                            note: t.note,
                            createdAt: dateCourte(t.createdAt),
                          }))}
                      />
                    );
                  })}
                </ul>
              </>
            )}
          </section>
        </div>

        {/* Rail droit : le seul endroit où l'on affiche des chiffres d'état. */}
        <aside className={RAIL + " space-y-5 border-t lg:w-72 lg:border-t-0 lg:border-l"}>
          <Bloc titre="prérequis">
            <Liens ids={node.requires} graph={graph} states={states} />
          </Bloc>
          <Bloc titre="débloque">
            <Liens ids={node.unlocks} graph={graph} states={states} />
          </Bloc>

          <Bloc titre="progression">
            <ul className="text-muted mb-2">
              <li>cours lu : {preuves?.courseRead ? "oui" : "non"}</li>
              <li>
                critères « acquis » :{" "}
                {preuves && meriteLearned(preuves) ? "remplis" : "non remplis"}
              </li>
              <li>
                critères « maîtrisé » :{" "}
                {preuves && meriteMastered(preuves) ? "remplis" : "non remplis"}
              </li>
            </ul>
            <MarquageEtat
              nodeId={node.id}
              courant={progress?.manual ?? "none"}
              courseRead={progress?.courseRead ?? false}
            />
          </Bloc>

          <Bloc
            titre={`révision · ${cards.length} carte${cards.length > 1 ? "s" : ""}`}
          >
            {cards.length === 0 ? (
              <p className="text-muted">
                aucune carte — fichier <code>cards.yaml</code> attendu
              </p>
            ) : (
              <>
                <table className="w-full">
                  <tbody>
                    {cards.map((c) => {
                      const e = etatsCartes.get(c.id);
                      return (
                        <tr key={c.id} className="border-line border-b">
                          <td className="py-0.5 pr-2">
                            <a
                              href={`#${c.ref}`}
                              className="hover:underline"
                              title={c.id}
                            >
                              {c.id.length > 16
                                ? c.id.slice(0, 15) + "…"
                                : c.id}
                            </a>
                          </td>
                          <td className="text-muted py-0.5 text-right tabular-nums">
                            {e ? `${e.stability.toFixed(1)} j` : "—"}
                          </td>
                          <td className="text-muted py-0.5 pl-2 text-right">
                            {e ? e.due.slice(5) : "neuve"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <p className="text-muted mt-2">
                  maîtrise : {SEUILS.stabiliteJours} j sur toutes les cartes
                </p>
                <Link
                  href="/maths/revision"
                  className="mt-2 inline-block rounded border border-line bg-surface px-2 py-1 hover:border-accent"
                >
                  file de révision
                </Link>
              </>
            )}
          </Bloc>

          <Bloc titre="journal de session">
            <JournalSession nodeId={node.id} />
            {sessions.length > 0 && (
              <ul className="mt-3">
                {sessions.slice(0, 8).map((s) => (
                  <li key={s.id} className="border-line border-t py-1">
                    <div className="text-muted">
                      {dateCourte(s.createdAt)} · {fmtMinutes(s.minutes)}
                    </div>
                    {s.note && (
                      <div className="whitespace-pre-wrap">{s.note}</div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Bloc>
        </aside>
      </div>
    </main>
  );
}

function Bloc({
  titre,
  children,
}: {
  titre: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h2 className="mb-1.5 border-b border-line pb-1 text-xs font-medium tracking-wide text-muted uppercase">
        {titre}
      </h2>
      {children}
    </section>
  );
}

function Liens({
  ids,
  graph,
  states,
}: {
  ids: string[];
  graph: ReturnType<typeof loadGraph>;
  states: Map<string, string>;
}) {
  if (ids.length === 0) return <p className="text-muted">—</p>;
  return (
    <ul>
      {ids.map((r) => {
        const n = graph.byId.get(r)!;
        const s = (states.get(r) ?? "locked") as keyof typeof ETAT;
        return (
          <li key={r} className="flex items-baseline gap-2 py-0.5">
            <span style={{ color: ETAT[s].border }}>{marqueur(s)}</span>
            <Link href={`/maths/n/${r}`} className="truncate hover:text-accent">
              {n.title}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
