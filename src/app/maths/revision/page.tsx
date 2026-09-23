import { loadGraph } from "@/lib/maths/graph/load";
import { fileDeRevision } from "@/lib/maths/revision/queue";
import { Mdx } from "@/lib/maths/mdx";
import Reviseur, { type CarteVue } from "@/components/maths/Reviseur";
import { chargerDonnees } from "@/server/maths/data";

/**
 * Seule surface où l'ordonnanceur décide (décision D1). La file est entrelacée
 * sur tout le corpus ; la page de nœud, elle, n'affiche qu'un relevé.
 */
export default async function RevisionPage() {
  const graph = loadGraph();
  const file = fileDeRevision(graph, await chargerDonnees(), new Date());

  const cartes: CarteVue[] = file.map((c) => ({
    cardKey: c.cardKey,
    nodeId: c.nodeId,
    cardId: c.cardId,
    nodeTitle: c.nodeTitle,
    ref: c.ref,
    nouvelle: c.nouvelle,
    stability: c.etat.stability,
    reps: c.etat.reps,
    lapses: c.etat.lapses,
  }));

  // Le MDX est compilé côté serveur, puis passé au composant client : KaTeX
  // n'a rien à faire dans le navigateur.
  const faces = file.map((c) => ({
    front: <Mdx source={c.front} />,
    back: <Mdx source={c.back} />,
  }));

  return (
    <main className="flex h-[calc(100dvh-3rem)] flex-col">
      <Reviseur cartes={cartes} faces={faces} />
    </main>
  );
}
