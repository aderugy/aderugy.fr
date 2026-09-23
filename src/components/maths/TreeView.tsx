import Link from "next/link";
import { childrenOf } from "@/lib/maths/graph/load";
import type { Graph, ProgressState } from "@/lib/maths/graph/types";
import { ETAT, marqueur } from "@/lib/maths/etat";
import { stateOfContainer } from "@/lib/maths/progression/rules";

/** Vue de lecture hiérarchique. Le DAG reste la vérité, ceci est un sommaire. */
export default function TreeView({
  graph,
  states,
  domainId,
}: {
  graph: Graph;
  states: Map<string, ProgressState>;
  domainId: string;
}) {
  const domains =
    domainId === "global"
      ? graph.domains
      : graph.domains.filter((d) => d.id === domainId);

  return (
    <div className="min-h-0 grow overflow-y-auto px-4 py-6 sm:px-8">
      <div className="max-w-[80ch]">
        {domains.map((d) => (
          <section key={d.id} className="mb-10">
            <h2 className="border-line mb-2 border-b pb-1 text-lg font-semibold tracking-tight">
              {d.title}
            </h2>
            {childrenOf(graph, d.id).map((topic) => {
              const ts = stateOfContainer(graph, topic.id, states);
              return (
                <div key={topic.id} className="mb-5">
                  <h3 className="chrome-15 mb-1 flex items-baseline gap-2 font-medium">
                    <span style={{ color: ETAT[ts].border }}>
                      {marqueur(ts)}
                    </span>
                    {topic.title}
                    <span className="text-muted">{topic.hours} h</span>
                  </h3>
                  <ul className="chrome-15 border-line ml-2 border-l">
                    {childrenOf(graph, topic.id).map((c) => {
                      const s = states.get(c.id) ?? "locked";
                      return (
                        <li key={c.id} className="flex items-baseline gap-2 py-0.5 pl-3">
                          <span style={{ color: ETAT[s].border }}>
                            {marqueur(s)}
                          </span>
                          <Link href={`/maths/n/${c.id}`} className="hover:text-accent">
                            {c.title}
                          </Link>
                          <span className="text-muted">
                            {c.estimatedHours} h
                          </span>
                          <span className="text-muted">
                            {ETAT[s].label}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              );
            })}
          </section>
        ))}
      </div>
    </div>
  );
}
