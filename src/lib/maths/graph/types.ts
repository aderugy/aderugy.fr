export type NodeKind = "domain" | "topic" | "concept";

export type ContentStatus = "empty" | "draft" | "published";

/** Un nœud tel qu'il est écrit dans content/maths/graph.yaml. */
export type RawNode = {
  id: string;
  kind: NodeKind;
  title: string;
  parentId: string | null;
  requires: string[];
  estimatedHours: number;
  tags: string[];
};

/** Un nœud tel que l'application le manipule : champs dérivés inclus. */
export type GraphNode = RawNode & {
  /** Inverse de `requires` — dérivé, jamais stocké. */
  unlocks: string[];
  /** Somme des descendants pour domain/topic, valeur propre pour concept. */
  hours: number;
  /** Dérivé du système de fichiers (décision D2). */
  contentStatus: ContentStatus;
  /** Chemin du cours, relatif à content/maths/. Uniquement pour les concepts. */
  coursePath: string | null;
  /** Ascendants de lecture, du domaine vers le parent direct. */
  ancestors: string[];
};

export type Graph = {
  nodes: GraphNode[];
  byId: Map<string, GraphNode>;
  domains: GraphNode[];
  concepts: GraphNode[];
  /** Ordre topologique des concepts, garanti sans cycle au chargement. */
  order: string[];
};

export type ProgressState =
  | "locked"
  | "available"
  | "in-progress"
  | "learned"
  | "mastered";
