import Link from "next/link";
import { loadGraph } from "@/lib/maths/graph/load";
import { loadCourse, loadExercises } from "@/lib/maths/content";
import { Mdx } from "@/lib/maths/mdx";

/**
 * Le corpus rédigé, d'un bloc, dans l'ordre topologique du DAG — donc dans un
 * ordre où aucun nœud n'arrive avant ses prérequis.
 *
 * C'est l'export PDF du §7 : il n'y a pas de générateur de PDF, il y a une
 * feuille de style d'impression. « Imprimer vers un PDF » depuis le navigateur
 * produit le fichier, avec la même typographie et le même rendu KaTeX que
 * l'écran. Une chaîne de génération séparée serait un deuxième moteur de rendu
 * à maintenir, et le premier écart entre les deux serait invisible.
 */
export default function CorpusPage() {
  const graph = loadGraph();
  const noeuds = graph.order
    .map((id) => graph.byId.get(id)!)
    .filter((n) => n.contentStatus !== "empty");

  return (
    <main className="px-4 py-6 sm:px-8 lg:px-10 lg:py-8">
      <header className="max-w-[70ch] print:hidden">
        <h1 className="text-2xl font-semibold tracking-tight">Corpus</h1>
        <p className="chrome text-muted mt-1">
          {noeuds.length} nœud{noeuds.length > 1 ? "s" : ""} rédigé
          {noeuds.length > 1 ? "s" : ""}, dans l&apos;ordre topologique du
          graphe. Pour un PDF : imprimer cette page et choisir « Enregistrer au
          format PDF ». Les rails, les boutons et les formulaires sont retirés à
          l&apos;impression.
        </p>
      </header>

      {noeuds.length === 0 && (
        <p className="chrome text-muted mt-4">
          aucun cours rédigé pour l&apos;instant
        </p>
      )}

      {noeuds.map((node) => {
        const course = loadCourse(node);
        const exercices = loadExercises(node);
        if (!course) return null;
        const [domaine, topic] = node.ancestors.map((a) => graph.byId.get(a)!);
        return (
          <article key={node.id} className="noeud-imprime mt-16">
            <div className="prose-cours">
              <p className="chrome text-muted">
                {domaine.title} · {topic.title}
              </p>
              <h1 className="mt-1 text-2xl font-semibold tracking-tight">
                {node.title}
              </h1>
              <p className="chrome text-muted">
                <Link href={`/maths/n/${node.id}`} className="underline print:no-underline">
                  {node.id}
                </Link>
              </p>
            </div>

            <div className="prose-cours mt-8">
              <Mdx source={course.body} />
            </div>

            {exercices.length > 0 && (
              <section className="prose-cours mt-10">
                <h2 className="border-line border-b pb-1 text-lg font-semibold tracking-tight">
                  Exercices
                </h2>
                {exercices.map((e, i) => (
                  <div key={e.id} className="eviter-coupure mt-6">
                    <p className="chrome text-muted">
                      {i + 1} · {e.kind} · difficulté {e.difficulty}
                    </p>
                    <Mdx source={e.statement} />
                    {e.hints.map((h, k) => (
                      <div key={k} className="border-line mt-2 border-l pl-4">
                        <p className="chrome text-muted">indice {k + 1}</p>
                        <Mdx source={h} />
                      </div>
                    ))}
                    <div className="border-line mt-3 border-t pt-2">
                      <p className="chrome text-muted">correction</p>
                      <Mdx source={e.solution} />
                    </div>
                  </div>
                ))}
              </section>
            )}
          </article>
        );
      })}
    </main>
  );
}
