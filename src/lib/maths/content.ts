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
  statement: string;
  hints: string[];
  solution: string;
};

/** Dossier du contenu d'un concept : content/maths/<domain>/<topic>/<concept>/. */
export function conceptDir(node: GraphNode): string {
  const [domain, topic] = node.ancestors;
  return path.join(CONTENT_DIR, domain, topic, node.id);
}

export function loadCourse(node: GraphNode): Course | null {
  const file = path.join(conceptDir(node), "course.mdx");
  if (!fs.existsSync(file)) return null;
  const { content, data } = matter(fs.readFileSync(file, "utf8"));
  return { body: content, data };
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
        statement: enonce.trim(),
        hints: indices.map((h) => h.trim()).filter(Boolean),
        solution: rest.join("").trim(),
      };
    });
}

export type Card = {
  id: string;
  /** Ancre de la section du cours dont la carte provient (décision D1). */
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
