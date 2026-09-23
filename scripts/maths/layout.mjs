#!/usr/bin/env node
// Calcule une fois pour toutes les dispositions du DAG et les écrit dans
// content/maths/graph.layout.json, versionné avec le reste.
//
// Principe 3 du plan de design : le graphe est une carte, pas une
// illustration. Un nœud doit se retrouver au même endroit d'une session à
// l'autre — un layout recalculé à chaque chargement détruirait la mémoire
// spatiale. À relancer seulement après une modification de graph.yaml.
//
// Une disposition par domaine, plus une globale. Une vue de domaine contient
// ses concepts et, en fantômes, leurs prérequis extérieurs — la direction
// amont, celle qui dit ce qui manque encore. Les dépendants extérieurs ne sont
// pas repris : ils encombraient la vue sans rien apprendre (le niveau 0 en
// avait 39 pour 22 concepts), et la page de nœud les liste déjà sous
// « débloque ».

import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import dagre from "@dagrejs/dagre";

const root = process.cwd();
const src = path.join(root, "content", "maths", "graph.yaml");
const out = path.join(root, "content", "maths", "graph.layout.json");

const NODE_W = 168;
const NODE_H = 22;

const { nodes } = parse(fs.readFileSync(src, "utf8"));
const byId = new Map(nodes.map((n) => [n.id, n]));
const concepts = nodes.filter((n) => n.kind === "concept");
const domains = nodes.filter((n) => n.kind === "domain");

const domainOf = (id) => {
  const topic = byId.get(byId.get(id).parentId);
  return topic.parentId;
};

/** Arêtes du DAG, restreintes aux concepts existants. */
const edges = [];
for (const c of concepts)
  for (const r of c.requires) if (byId.has(r)) edges.push([r, c.id]);

function layout(ids, keep) {
  const set = new Set(ids);
  const g = new dagre.graphlib.Graph({ directed: true });
  g.setGraph({
    rankdir: "TB",
    nodesep: 24,
    ranksep: 60,
    edgesep: 12,
    marginx: 40,
    marginy: 40,
  });
  g.setDefaultEdgeLabel(() => ({}));

  // Ordre d'insertion = ordre du fichier : stable d'une exécution à l'autre.
  for (const c of concepts)
    if (set.has(c.id)) g.setNode(c.id, { width: NODE_W, height: NODE_H });
  const used = edges.filter(([a, b]) => set.has(a) && set.has(b) && keep(a, b));
  for (const [a, b] of used) g.setEdge(a, b);

  dagre.layout(g);

  const positions = {};
  for (const id of g.nodes()) {
    const { x, y } = g.node(id);
    positions[id] = { x: Math.round(x), y: Math.round(y) };
  }
  return {
    width: Math.ceil(g.graph().width),
    height: Math.ceil(g.graph().height),
    nodes: Object.fromEntries(
      Object.entries(positions).sort(([a], [b]) => a.localeCompare(b)),
    ),
    edges: used
      .map(([a, b]) => ({
        from: a,
        to: b,
        points: g.edge(a, b).points.map((p) => [
          Math.round(p.x),
          Math.round(p.y),
        ]),
      }))
      .sort((x, y) =>
        x.from === y.from
          ? x.to.localeCompare(y.to)
          : x.from.localeCompare(y.from),
      ),
  };
}

const views = {};

views.global = {
  ...layout(
    concepts.map((c) => c.id),
    () => true,
  ),
  ghosts: [],
};

for (const d of domains) {
  const own = concepts.filter((c) => domainOf(c.id) === d.id).map((c) => c.id);
  const ownSet = new Set(own);
  const ghosts = new Set();
  for (const [a, b] of edges) if (ownSet.has(b) && !ownSet.has(a)) ghosts.add(a);
  views[d.id] = {
    ...layout([...own, ...ghosts], (a, b) => ownSet.has(a) || ownSet.has(b)),
    ghosts: [...ghosts].sort(),
  };
}

fs.writeFileSync(
  out,
  JSON.stringify(
    { generatedFrom: "content/graph.yaml", nodeWidth: NODE_W, nodeHeight: NODE_H, views },
    null,
    1,
  ) + "\n",
);

for (const [name, v] of Object.entries(views))
  console.log(
    `${name.padEnd(12)} ${String(Object.keys(v.nodes).length).padStart(3)} nœuds ` +
      `(${String(v.ghosts.length).padStart(2)} fantômes)  ` +
      `${String(v.edges.length).padStart(3)} arêtes  ${v.width} × ${v.height} px`,
  );
