import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import matter from "gray-matter";
import type { ContentStatus, Graph, GraphNode, RawNode } from "./types";

/** Racine du contenu du parcours, versionnée avec le code. */
export const CONTENT_DIR = path.join(process.cwd(), "content", "maths");
const GRAPH_FILE = path.join(CONTENT_DIR, "graph.yaml");

let cache: Graph | null = null;

/**
 * Charge content/maths/graph.yaml et calcule les champs dérivés.
 *
 * `contentStatus` n'est pas stocké dans le YAML (décision D2) : il vient du
 * système de fichiers — pas de course.mdx donne `empty`, sinon la valeur du
 * frontmatter `status`.
 */
export function loadGraph(): Graph {
  if (cache && process.env.NODE_ENV === "production") return cache;

  const raw = parse(fs.readFileSync(GRAPH_FILE, "utf8")) as { nodes: RawNode[] };
  const byId = new Map<string, GraphNode>();

  for (const n of raw.nodes) {
    if (byId.has(n.id)) throw new Error(`graph.yaml : id dupliqué ${n.id}`);
    byId.set(n.id, {
      ...n,
      requires: n.requires ?? [],
      tags: n.tags ?? [],
      unlocks: [],
      hours: n.estimatedHours,
      contentStatus: "empty",
      coursePath: null,
      ancestors: [],
    });
  }

  // Ascendants de lecture, et vérification de la hiérarchie.
  for (const node of byId.values()) {
    const chain: string[] = [];
    let cur = node.parentId;
    while (cur) {
      const parent = byId.get(cur);
      if (!parent) throw new Error(`graph.yaml : parentId inconnu ${cur}`);
      chain.unshift(parent.id);
      cur = parent.parentId;
    }
    node.ancestors = chain;
  }

  // unlocks = inverse de requires.
  for (const node of byId.values()) {
    for (const req of node.requires) {
      const target = byId.get(req);
      if (!target) throw new Error(`${node.id} : requires inconnu ${req}`);
      if (target.kind !== "concept")
        throw new Error(`${node.id} : requires ${req} qui n'est pas un concept`);
      target.unlocks.push(node.id);
    }
  }

  // Statut du contenu et chemin du cours.
  for (const node of byId.values()) {
    if (node.kind !== "concept") continue;
    const [domain, topic] = node.ancestors;
    const rel = path.join(domain, topic, node.id, "course.mdx");
    const abs = path.join(CONTENT_DIR, rel);
    node.coursePath = rel;
    node.contentStatus = readStatus(abs);
  }

  // Heures dérivées sur les conteneurs.
  const children = new Map<string, GraphNode[]>();
  for (const node of byId.values()) {
    if (!node.parentId) continue;
    const list = children.get(node.parentId) ?? [];
    list.push(node);
    children.set(node.parentId, list);
  }
  const sumHours = (node: GraphNode): number => {
    if (node.kind === "concept") return node.estimatedHours;
    const kids = children.get(node.id) ?? [];
    return kids.reduce((acc, k) => acc + sumHours(k), 0);
  };
  for (const node of byId.values()) node.hours = sumHours(node);

  const nodes = [...byId.values()];
  const concepts = nodes.filter((n) => n.kind === "concept");

  cache = {
    nodes,
    byId,
    domains: nodes.filter((n) => n.kind === "domain"),
    concepts,
    order: topoSort(concepts),
  };
  return cache;
}

function readStatus(abs: string): ContentStatus {
  if (!fs.existsSync(abs)) return "empty";
  const { data } = matter(fs.readFileSync(abs, "utf8"));
  const status = data.status;
  return status === "draft" || status === "published" ? status : "empty";
}

/** Tri topologique de Kahn. Lève si le graphe contient un cycle. */
function topoSort(concepts: GraphNode[]): string[] {
  const indeg = new Map(concepts.map((c) => [c.id, c.requires.length]));
  const queue = concepts.filter((c) => c.requires.length === 0).map((c) => c.id);
  const dependents = new Map<string, string[]>();
  for (const c of concepts)
    for (const r of c.requires)
      dependents.set(r, [...(dependents.get(r) ?? []), c.id]);

  const order: string[] = [];
  queue.sort();
  while (queue.length > 0) {
    const cur = queue.shift()!;
    order.push(cur);
    for (const d of dependents.get(cur) ?? []) {
      const next = indeg.get(d)! - 1;
      indeg.set(d, next);
      if (next === 0) queue.push(d);
    }
  }
  if (order.length !== concepts.length)
    throw new Error("graph.yaml : cycle détecté dans les prérequis");
  return order;
}

/** Enfants directs d'un nœud, dans l'ordre du fichier. */
export function childrenOf(graph: Graph, id: string): GraphNode[] {
  return graph.nodes.filter((n) => n.parentId === id);
}
