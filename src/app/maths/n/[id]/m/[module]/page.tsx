import Link from "next/link";
import { notFound } from "next/navigation";
import { loadGraph } from "@/lib/maths/graph/load";
import {
  loadCards,
  loadExercises,
  loadModules,
  RUBRIQUE,
} from "@/lib/maths/content";
import {
  attemptsOfNode,
  capsulesTermineesDe,
  chargerDonnees,
} from "@/server/maths/data";
import {
  avancementCapsules,
  exercicesParCapsule,
  voisine,
} from "@/lib/maths/progression/capsules";
import { Mdx } from "@/lib/maths/mdx";
import { rouvrirCapsule, terminerCapsule } from "@/server/actions/maths";
import ListeExercices from "@/components/maths/ListeExercices";
import { jauge } from "@/components/maths/Parcours";

const LIBELLE_RUBRIQUE = new Map<string, string>(
  RUBRIQUE.map((r) => [r.id, r.label]),
);

/**
 * Lecteur de capsule (décision D25) : une notion, un écran, une action.
 *
 * Pas de rails ici, contrairement à la page de nœud : la capsule se lit d'une
 * traite, en 5 à 10 minutes, y compris sur téléphone. Le relevé d'état reste
 * sur la page du nœud, à un clic. Comme le cours (D20), c'est la page qui
 * défile, pas un conteneur.
 */
export default async function CapsulePage({
  params,
}: PageProps<"/maths/n/[id]/m/[module]">) {
  const { id, module } = await params;
  const graph = loadGraph();
  const node = graph.byId.get(id);
  if (!node || node.kind !== "concept") notFound();
  const capsules = loadModules(node);
  const capsule = capsules.find((c) => c.id === module);
  if (!capsule) notFound();

  const donnees = await chargerDonnees();
  const terminees = capsulesTermineesDe(donnees, id);
  const avancement = avancementCapsules(capsules, terminees);
  const lue = terminees.has(capsule.id);

  const exercices = loadExercises(node);
  const numeros = new Map(exercices.map((e, i) => [e.id, i + 1]));
  const apres = exercicesParCapsule(capsules, exercices).get(capsule.id) ?? [];
  const cartes = loadCards(node).filter((c) => c.ref === capsule.id).length;

  const precedente = capsules.find((c) => c.id === voisine(capsules, capsule.id, -1));
  const suivante = capsules.find((c) => c.id === voisine(capsules, capsule.id, 1));
  const derniereALire =
    !lue && avancement.total - avancement.terminees === 1;

  return (
    <main>
      {/* Règle sous l'en-tête, comme sur la page de nœud. */}
      <div className="chrome sticky top-12 z-20 flex h-9 items-center gap-3 overflow-hidden border-b border-line bg-background px-4 whitespace-nowrap">
        <Link href={`/maths/n/${node.id}`} className="min-w-0 truncate text-muted hover:text-foreground">
          ← {node.title}
        </Link>
        <div className="grow" />
        <span className="hidden font-mono text-[12px] sm:inline" aria-hidden>
          {jauge(avancement.terminees, avancement.total)}
        </span>
        <span className="tabular-nums">
          {capsule.numero} / {capsules.length}
        </span>
      </div>

      <div className="mx-auto w-full max-w-[76ch] px-4 py-8 sm:px-8 lg:py-12">
        <div className="chrome text-muted flex flex-wrap gap-x-3">
          <span>capsule {capsule.numero}</span>
          <span>{capsule.minutes} min</span>
          <span>
            {capsule.rubrique.map((r) => LIBELLE_RUBRIQUE.get(r) ?? r).join(", ")}
          </span>
          {lue && <span>✓ lue</span>}
        </div>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">
          {capsule.title}
        </h1>

        <div className="prose-cours mt-8">
          <Mdx source={capsule.body} />
        </div>

        {apres.length > 0 && (
          <section className="mt-12">
            <h2 className="border-line border-b pb-1 text-lg font-semibold tracking-tight">
              {apres.length === 1
                ? "Un exercice est faisable à ce stade"
                : `${apres.length} exercices sont faisables à ce stade`}
            </h2>
            <div className="mt-3">
              <ListeExercices
                nodeId={node.id}
                exercices={apres}
                numeros={numeros}
                tentatives={attemptsOfNode(donnees, id)}
              />
            </div>
          </section>
        )}

        {cartes > 0 && (
          <p className="chrome text-muted mt-8">
            {cartes === 1
              ? "Une carte de révision vient de cette capsule ; elle entre dans la "
              : `${cartes} cartes de révision viennent de cette capsule ; elles entrent dans la `}
            <Link href="/maths/revision" className="underline hover:text-foreground">
              file de révision
            </Link>{" "}
            avec les autres.
          </p>
        )}

        {/* Une seule action principale : terminer, ce qui enchaîne sur la
            suite. Les liens de navigation restent discrets. */}
        <div className="chrome border-line mt-12 flex flex-wrap items-center gap-3 border-t pt-4">
          {precedente ? (
            <Link
              href={`/maths/n/${node.id}/m/${precedente.id}`}
              className="text-muted hover:text-foreground"
            >
              ← {precedente.numero}. {precedente.title.split(/ — |, /)[0]}
            </Link>
          ) : (
            <Link href={`/maths/n/${node.id}`} className="text-muted hover:text-foreground">
              ← parcours du nœud
            </Link>
          )}
          <div className="grow" />
          {lue ? (
            <>
              <form action={rouvrirCapsule.bind(null, node.id, capsule.id)}>
                <button type="submit" className="text-muted underline hover:text-foreground">
                  marquer non lue
                </button>
              </form>
              <Link
                href={
                  suivante
                    ? `/maths/n/${node.id}/m/${suivante.id}`
                    : `/maths/n/${node.id}`
                }
                className="rounded border border-line bg-surface px-3 py-1 hover:border-accent"
              >
                {suivante
                  ? `capsule suivante : ${suivante.numero}. ${suivante.title.split(/ — |, /)[0]}`
                  : "retour au parcours"}
              </Link>
            </>
          ) : (
            <form action={terminerCapsule.bind(null, node.id, capsule.id)}>
              <button type="submit" className="rounded bg-accent px-3 py-1 text-white">
                {derniereALire
                  ? "terminer la capsule et le cours"
                  : suivante
                    ? "terminer et passer à la suivante"
                    : "terminer la capsule"}
              </button>
            </form>
          )}
        </div>
      </div>
    </main>
  );
}
