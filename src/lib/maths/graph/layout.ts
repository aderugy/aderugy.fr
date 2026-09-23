import fs from "node:fs";
import path from "node:path";
import { CONTENT_DIR } from "./load";

export type LayoutView = {
  width: number;
  height: number;
  nodes: Record<string, { x: number; y: number }>;
  edges: { from: string; to: string; points: [number, number][] }[];
  ghosts: string[];
};

export type LayoutFile = {
  nodeWidth: number;
  nodeHeight: number;
  views: Record<string, LayoutView>;
};

const FILE = path.join(CONTENT_DIR, "graph.layout.json");

let cache: LayoutFile | null = null;

/**
 * Dispositions précalculées par `npm run maths:layout`. Elles sont versionnées :
 * un nœud garde sa place d'une session à l'autre (principe 3 du design).
 */
export function loadLayout(): LayoutFile {
  if (cache && process.env.NODE_ENV === "production") return cache;
  if (!fs.existsSync(FILE))
    throw new Error(
      "content/maths/graph.layout.json manquant — lancer `npm run maths:layout`.",
    );
  cache = JSON.parse(fs.readFileSync(FILE, "utf8")) as LayoutFile;
  return cache;
}
