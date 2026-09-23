import Link from "next/link";
import { loadGraph } from "@/lib/maths/graph/load";
import { loadLayout } from "@/lib/maths/graph/layout";
import { evidenceParNoeud } from "@/lib/maths/progression/evidence";
import { computeStates, stateOfContainer } from "@/lib/maths/progression/rules";
import GraphCanvas, { type ViewData } from "@/components/maths/GraphCanvas";
import TreeView from "@/components/maths/TreeView";
import { ETAT, marqueur } from "@/lib/maths/etat";
import { chargerDonnees } from "@/server/maths/data";

export default async function MathsHome({ searchParams }: PageProps<"/maths">) {
  const params = await searchParams;
  const v = typeof params.v === "string" ? params.v : undefined;
  const mode = typeof params.mode === "string" ? params.mode : undefined;
  const graph = loadGraph();
  const layout = loadLayout();
  const states = computeStates(graph, evidenceParNoeud(graph, await chargerDonnees()));

  // Nœud courant : le premier commencé, sinon le premier disponible dans
  // l'ordre topologique. C'est lui qui décide de la vue ouverte par défaut.
  const focusId =
    graph.order.find((id) => states.get(id) === "in-progress") ??
    graph.order.find((id) => states.get(id) === "available") ??
    null;
  const focusDomain = focusId
    ? graph.byId.get(focusId)!.ancestors[0]
    : graph.domains[0].id;

  const view = v && layout.views[v] ? v : focusDomain;
  const data = layout.views[view];
  const ghosts = new Set(data.ghosts);

  const viewData: ViewData = {
    width: data.width,
    height: data.height,
    nodeWidth: layout.nodeWidth,
    nodeHeight: layout.nodeHeight,
    positions: data.nodes,
    edges: data.edges,
    nodes: Object.keys(data.nodes).map((id) => {
      const n = graph.byId.get(id)!;
      return {
        id,
        title: n.title,
        state: states.get(id) ?? "locked",
        hours: n.estimatedHours,
        unlocks: n.unlocks.length,
        ghost: ghosts.has(id),
        domainLabel: graph.byId.get(n.ancestors[0])!.title,
      };
    }),
  };

  const totalHeures = graph.concepts.reduce((a, c) => a + c.estimatedHours, 0);
  const acquis = graph.concepts.filter((c) =>
    ["learned", "mastered"].includes(states.get(c.id) ?? ""),
  );
  const heuresAcquises = acquis.reduce((a, c) => a + c.estimatedHours, 0);

  const arbre = mode === "arbre" ? "&mode=arbre" : "";
  const lien = (vue: string) =>
    [
      "flex shrink-0 items-baseline gap-2 rounded-md px-2.5 py-1.5",
      vue === view ? "bg-accent/10 font-medium text-accent" : "text-foreground hover:bg-surface",
    ].join(" ");

  return (
    <main className="flex h-[calc(100dvh-3rem)] flex-col md:flex-row">
      {/* Rail : filtre par domaine. Ne raconte rien d'autre. Sur téléphone il
          devient une bande horizontale au-dessus de la carte. */}
      <nav className="chrome shrink-0 border-b border-line md:w-48 md:overflow-y-auto md:border-r md:border-b-0">
        <ul className="flex gap-1 overflow-x-auto p-2 md:block md:space-y-0.5 md:overflow-visible [scrollbar-width:none]">
          {graph.domains.map((d) => {
            const s = stateOfContainer(graph, d.id, states);
            return (
              <li key={d.id} className="shrink-0">
                <Link href={`/maths?v=${d.id}${arbre}`} className={lien(d.id)}>
                  <span style={{ color: ETAT[s].border }}>{marqueur(s)}</span>
                  <span className="truncate">{d.title.split(" — ")[0]}</span>
                </Link>
              </li>
            );
          })}
          <li className="shrink-0">
            <Link href={`/maths?v=global${arbre}`} className={lien("global")}>
              <span className="md:pl-5">tout le graphe</span>
            </Link>
          </li>
          <li className="shrink-0 md:hidden">
            <Link
              href={`/maths?v=${view}${mode === "arbre" ? "" : "&mode=arbre"}`}
              className="flex px-2.5 py-1.5 text-accent"
            >
              {mode === "arbre" ? "vue graphe" : "vue arborescente"}
            </Link>
          </li>
        </ul>

        <div className="hidden border-t border-line px-4 py-3 md:block">
          <Link
            href={`/maths?v=${view}${mode === "arbre" ? "" : "&mode=arbre"}`}
            className="text-accent hover:underline"
          >
            {mode === "arbre" ? "vue graphe" : "vue arborescente"}
          </Link>
        </div>

        <div className="hidden border-t border-line px-4 py-3 text-muted md:block">
          <div>
            <span className="text-foreground">{heuresAcquises}</span> / {totalHeures} h
          </div>
          <div>
            <span className="text-foreground">{acquis.length}</span> / {graph.concepts.length} concepts
          </div>
        </div>
      </nav>

      {mode === "arbre" ? (
        <TreeView graph={graph} states={states} domainId={view} />
      ) : (
        <GraphCanvas data={viewData} focusId={focusId} />
      )}
    </main>
  );
}
