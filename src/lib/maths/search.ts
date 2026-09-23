import "server-only";
import { loadCards, loadCourse, loadExercises } from "@/lib/maths/content";
import { loadGraph } from "@/lib/maths/graph/load";
import type { Graph } from "@/lib/maths/graph/types";

export type TypeDoc = "noeud" | "cours" | "exercice" | "carte";

export type Document = {
  type: TypeDoc;
  nodeId: string;
  nodeTitle: string;
  /** Titre de la section, de l'exercice ou de la carte. */
  titre: string;
  /** Ancre ou fragment vers lequel pointer, sans le `#`. */
  ancre: string;
  texte: string;
  /** Texte normalisé, pour la recherche. */
  cle: string;
  titreCle: string;
};

export type Resultat = Document & { score: number; extrait: string };

/**
 * Normalisation : minuscules, accents retirés, ponctuation ramenée à des
 * espaces. Chercher « esperance » doit trouver « espérance », et « L^2 »
 * doit trouver « L^2 » comme « l2 ».
 */
export function normaliser(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

let cache: Document[] | null = null;

function doc(
  type: TypeDoc,
  nodeId: string,
  nodeTitle: string,
  titre: string,
  ancre: string,
  texte: string,
): Document {
  return {
    type,
    nodeId,
    nodeTitle,
    titre,
    ancre,
    texte,
    cle: normaliser(texte),
    titreCle: normaliser(`${titre} ${nodeTitle}`),
  };
}

/** Index plein texte du corpus, reconstruit à chaud en développement. */
export function index(graph: Graph = loadGraph()): Document[] {
  if (cache && process.env.NODE_ENV === "production") return cache;
  const docs: Document[] = [];

  for (const node of graph.concepts) {
    docs.push(
      doc(
        "noeud",
        node.id,
        node.title,
        node.title,
        "",
        `${node.title} ${node.id} ${node.tags.join(" ")}`,
      ),
    );

    const course = loadCourse(node);
    if (course) {
      // Une entrée par section : un résultat doit renvoyer au bon endroit du
      // cours, pas au haut de la page.
      for (const bloc of course.body.split(/\n(?=## )/)) {
        const entete = /^##\s+(.*?)\s*(?:\{#([\w-]+)\})?\s*$/m.exec(
          bloc.split("\n")[0],
        );
        const titre = entete?.[1] ?? "Introduction";
        const ancre = entete?.[2] ?? "";
        docs.push(doc("cours", node.id, node.title, titre, ancre, bloc));
      }
    }

    for (const e of loadExercises(node)) {
      docs.push(
        doc(
          "exercice",
          node.id,
          node.title,
          `exercice ${e.id} · ${e.kind} · difficulté ${e.difficulty}`,
          "",
          `${e.statement}\n${e.solution}`,
        ),
      );
    }

    for (const c of loadCards(node)) {
      docs.push(
        doc(
          "carte",
          node.id,
          node.title,
          `carte ${c.id}`,
          c.ref,
          `${c.front}\n${c.back}`,
        ),
      );
    }
  }

  cache = docs;
  return docs;
}

/**
 * Recherche conjonctive : tous les termes doivent apparaître. Un terme trouvé
 * dans le titre pèse trois fois plus que dans le corps — sans quoi une longue
 * démonstration citant dix fois un mot passe devant le nœud qui porte ce nom.
 */
export function chercher(requete: string, limite = 40): Resultat[] {
  const termes = normaliser(requete).split(" ").filter(Boolean);
  if (termes.length === 0) return [];

  const out: Resultat[] = [];
  for (const d of index()) {
    let score = 0;
    let manquant = false;
    for (const t of termes) {
      const dansCorps = compter(d.cle, t);
      const dansTitre = compter(d.titreCle, t);
      if (dansCorps + dansTitre === 0) {
        manquant = true;
        break;
      }
      score += dansCorps + 3 * dansTitre;
    }
    if (manquant) continue;
    if (d.type === "noeud") score *= 2;
    out.push({ ...d, score, extrait: extrait(d.texte, termes) });
  }

  return out.sort((a, b) => b.score - a.score).slice(0, limite);
}

function compter(texte: string, terme: string): number {
  let n = 0;
  let i = texte.indexOf(terme);
  while (i !== -1) {
    n++;
    i = texte.indexOf(terme, i + terme.length);
  }
  return n;
}

/** Fenêtre de texte autour de la première occurrence, sur le texte d'origine. */
function extrait(texte: string, termes: string[], largeur = 180): string {
  const plat = texte.replace(/\s+/g, " ").trim();
  const norme = normaliser(plat);
  // Les positions se correspondent mal après normalisation ; on cherche donc
  // une ancre approximative et on élargit généreusement.
  let i = -1;
  for (const t of termes) {
    const j = norme.indexOf(t);
    if (j !== -1 && (i === -1 || j < i)) i = j;
  }
  if (i === -1) return plat.slice(0, largeur) + (plat.length > largeur ? "…" : "");
  const debut = Math.max(0, Math.min(i - 60, plat.length - largeur));
  return (
    (debut > 0 ? "…" : "") +
    plat.slice(debut, debut + largeur) +
    (debut + largeur < plat.length ? "…" : "")
  );
}
