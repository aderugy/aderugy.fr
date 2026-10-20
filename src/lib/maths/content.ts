import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { parse } from "yaml";
import { CONTENT_DIR } from "@/lib/maths/graph/load";
import type { GraphNode } from "@/lib/maths/graph/types";

export type Course = {
  body: string;
  data: Record<string, unknown>;
};

export type ExerciseFile = {
  id: string;
  kind: "calcul" | "preuve" | "simulation" | "contre-exemple" | "qcm";
  difficulty: 1 | 2 | 3 | 4 | 5;
  /** Id de la capsule après laquelle l'exercice devient faisable (D25). */
  after: string | null;
  statement: string;
  hints: string[];
  solution: string;
};

export type RubriqueId = (typeof RUBRIQUE)[number]["id"];

/**
 * Une capsule : une notion du cours, lisible en une séance de 5 à 10 minutes
 * (décision D25). Fichier `modules/NN-<id>.mdx` : le numéro fixe l'ordre, l'id
 * — le nom sans numéro — est la clé stable en base et dans les `ref` des
 * cartes, pour qu'on puisse réordonner les capsules sans rien perdre.
 */
export type Capsule = {
  id: string;
  numero: number;
  title: string;
  minutes: number;
  /** Sections de la rubrique du §6 que la capsule couvre. */
  rubrique: RubriqueId[];
  body: string;
};

/** Dossier du contenu d'un concept : content/maths/<domain>/<topic>/<concept>/. */
export function conceptDir(node: GraphNode): string {
  const [domain, topic] = node.ancestors;
  return path.join(CONTENT_DIR, domain, topic, node.id);
}

/**
 * Le fichier course.mdx tel qu'il est écrit. Pour un nœud découpé en
 * capsules, il ne porte que le statut et les sections propres au nœud entier
 * (liens, références).
 */
export function loadCourseShell(node: GraphNode): Course | null {
  const file = path.join(conceptDir(node), "course.mdx");
  if (!fs.existsSync(file)) return null;
  const { content, data } = matter(fs.readFileSync(file, "utf8"));
  return { body: content, data };
}

/**
 * Le cours complet, d'un seul tenant : les capsules dans l'ordre, chacune sous
 * un titre de niveau 2 ancré sur son id, puis la coquille. C'est ce que lisent
 * la recherche, l'export /corpus et le connecteur — le corpus reste relisible
 * seul, comme un manuel (§12), quel que soit le découpage.
 */
export function loadCourse(node: GraphNode): Course | null {
  return composerCours(loadCourseShell(node), loadModules(node));
}

export function composerCours(
  coquille: Course | null,
  capsules: Capsule[],
): Course | null {
  if (!coquille) return null;
  if (capsules.length === 0) return coquille;
  const corps = capsules
    .map((c) => `## ${c.title} {#${c.id}}\n\n${c.body.trim()}\n`)
    .join("\n");
  return { data: coquille.data, body: `${corps}\n${coquille.body.trim()}\n` };
}

const NOM_CAPSULE = /^(\d{2})-([a-z0-9]+(?:-[a-z0-9]+)*)\.mdx$/;

/** `03-definition-convergence.mdx` → numéro 3, id `definition-convergence`. */
export function lireNomCapsule(
  fichier: string,
): { numero: number; id: string } | null {
  const m = NOM_CAPSULE.exec(fichier);
  return m ? { numero: Number(m[1]), id: m[2] } : null;
}

/**
 * Capsules d'un concept, dans l'ordre. Vide pour un nœud encore rédigé d'un
 * bloc dans course.mdx : les deux formats cohabitent le temps de convertir.
 */
export function loadModules(node: GraphNode): Capsule[] {
  const dir = path.join(conceptDir(node), "modules");
  if (!fs.existsSync(dir)) return [];
  const capsules: Capsule[] = [];
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".mdx"))) {
    const nom = lireNomCapsule(f);
    if (!nom) throw new Error(`${node.id} : capsule mal nommée ${f} (attendu NN-id.mdx)`);
    const { content, data } = matter(fs.readFileSync(path.join(dir, f), "utf8"));
    capsules.push({
      ...nom,
      title: String(data.title ?? nom.id),
      minutes: Number(data.minutes ?? 0),
      rubrique: (Array.isArray(data.rubrique) ? data.rubrique : []) as RubriqueId[],
      body: content.trim(),
    });
  }
  capsules.sort((a, b) => a.numero - b.numero);
  const vus = new Set<string>();
  for (const c of capsules) {
    if (vus.has(c.id)) throw new Error(`${node.id} : capsule en double ${c.id}`);
    vus.add(c.id);
  }
  return capsules;
}

/**
 * Où relire la source d'une carte, ou d'un résultat de recherche : la capsule
 * elle-même si l'ancre en est une, sinon la section de la page du nœud.
 */
export function lienSource(
  nodeId: string,
  ancre: string,
  capsules: Pick<Capsule, "id">[],
): string {
  if (ancre && capsules.some((c) => c.id === ancre))
    return `/maths/n/${nodeId}/m/${ancre}`;
  return `/maths/n/${nodeId}${ancre ? `#${ancre}` : ""}`;
}

/**
 * Exercices d'un concept. Un fichier par exercice, la correction et les
 * indices étant dans son frontmatter ou séparés par les marqueurs
 * `<!-- indice -->` et `<!-- solution -->`.
 */
export function loadExercises(node: GraphNode): ExerciseFile[] {
  const dir = path.join(conceptDir(node), "exercises");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".mdx"))
    .sort()
    .map((f) => {
      const { content, data } = matter(
        fs.readFileSync(path.join(dir, f), "utf8"),
      );
      const [statement, ...rest] = content.split("<!-- solution -->");
      const [enonce, ...indices] = statement.split("<!-- indice -->");
      return {
        id: f.replace(/\.mdx$/, ""),
        kind: (data.kind ?? "calcul") as ExerciseFile["kind"],
        difficulty: (data.difficulty ?? 1) as ExerciseFile["difficulty"],
        after: typeof data.after === "string" ? data.after : null,
        statement: enonce.trim(),
        hints: indices.map((h) => h.trim()).filter(Boolean),
        solution: rest.join("").trim(),
      };
    });
}

export type Card = {
  id: string;
  /**
   * D'où vient la carte : l'id d'une capsule, ou l'ancre d'une section du
   * cours pour un nœud qui n'est pas découpé (décisions D1 et D25).
   */
  ref: string;
  front: string;
  back: string;
};

/**
 * Cartes de révision d'un concept. Le fichier ne porte que le contenu ;
 * l'état de l'ordonnanceur est en base.
 */
export function loadCards(node: GraphNode): Card[] {
  const file = path.join(conceptDir(node), "cards.yaml");
  if (!fs.existsSync(file)) return [];
  const doc = parse(fs.readFileSync(file, "utf8")) as { cards?: Card[] };
  return (doc?.cards ?? []).map((c) => ({
    id: c.id,
    ref: c.ref ?? "",
    front: c.front ?? "",
    back: c.back ?? "",
  }));
}

/** Clé stable d'un exercice et d'une carte, pour la base. */
export const exerciseKey = (nodeId: string, exerciseId: string) =>
  `${nodeId}/${exerciseId}`;

export const cardKey = (nodeId: string, cardId: string) =>
  `${nodeId}:${cardId}`;

/** Les neuf sections imposées par le §6. L'ordre ne change jamais. */
export const RUBRIQUE = [
  { id: "position", label: "position" },
  { id: "probleme", label: "problème" },
  { id: "construction", label: "construction" },
  { id: "intuition", label: "intuition" },
  { id: "demonstrations", label: "démonstrations" },
  { id: "pieges", label: "pièges" },
  { id: "simulation", label: "simulation" },
  { id: "liens", label: "liens" },
  { id: "references", label: "références" },
] as const;
