import "server-only";
import { z } from "zod";
import type { McpServer, CallToolResult } from "@modelcontextprotocol/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cardKey, exerciseKey, loadCards, loadCourse, loadExercises, RUBRIQUE } from "@/lib/maths/content";
import { childrenOf, loadGraph } from "@/lib/maths/graph/load";
import type { Graph, GraphNode, ProgressState } from "@/lib/maths/graph/types";
import { evidenceParNoeud } from "@/lib/maths/progression/evidence";
import { computeStates, EMPTY_EVIDENCE, SEUILS, stateOfContainer } from "@/lib/maths/progression/rules";
import { fileDeRevision, NOUVELLES_MAX } from "@/lib/maths/revision/queue";
import { chercher, type TypeDoc } from "@/lib/maths/search";
import { retrievabilite } from "@/lib/maths/fsrs";
import { chargeAVenir, courbeOubli, heuresParDomaine, noeudsFragiles, reussiteParTag, type EtatCarteBrut } from "@/lib/maths/stats";
import { localDate } from "@/lib/agenda/zoned";
import {
  addAttemptAvec,
  addSessionAvec,
  chargerDonneesDe,
  deleteEntryAvec,
  minutesByNode,
  reviewLogAvec,
  setCourseReadAvec,
  setManualAvec,
  updateAttemptAvec,
  updateSessionAvec,
  type AttemptRow,
  type DonneesMaths,
  type Outcome,
  type SessionLogRow,
} from "@/server/maths/data";
import { callerOf } from "./auth";

/**
 * /maths as MCP tools, on the same connector as the backlog (migration 0028).
 *
 * The content — graph, courses, exercises, cards — is read from content/maths/
 * on disk, exactly as the pages read it (next.config.ts traces it into the
 * /api/mcp function). The state is read and written with the caller's own
 * token, so RLS and the connector rules apply: Claude reads everything,
 * records progress, sessions and attempts, and edits or deletes only the
 * sessions and attempts it recorded. Rating cards stays Arthur's.
 */

export const MATHS_INSTRUCTIONS = `Arthur's probability & statistics parcours (aderugy.fr/maths): a graph of concepts, from prerequisites (niveau 0) to expert level, each with a course, exercises and review cards. You may read all of it and record what Arthur tells you he did; you cannot rate cards — reviewing is his, in the app.

How the data works:
- The graph has domains (levels, e.g. "niveau-0"), topics and concepts, all with stable slug ids. Only concepts carry content and progress. "requires" edges are real prerequisites; "unlocks" is their inverse.
- Content lives in the site's repository, not in the database: it is read-only here. A concept's content is empty (not written yet), draft or published. The course has nine sections in a fixed order (position, probleme, construction, intuition, demonstrations, pieges, simulation, liens, references), in French, Markdown with KaTeX.
- State per concept, computed from evidence, never stored: locked (a prerequisite is not learned yet), available, in-progress, learned, mastered. learned = course read + ≥70% of difficulty ≤3 exercises solved, half of those without a hint (or Arthur marked it learned). mastered = learned + a difficulty 4–5 exercise solved + every card's FSRS stability > 21 days (or marked mastered). Mastery is lost by itself when cards decay.
- Evidence you may record: the manual status (none, in-progress, learned, mastered — for a node he tested out of, or to override), whether the course was read, study sessions (minutes + note), and exercise attempts (outcome + minutes + note). Outcomes: resolu-seul (solved alone), resolu-avec-indice (solved with a hint), echec (failed), abandonne (gave up). The best attempt per exercise counts. The note of an attempt — what blocked him — is the most valuable field: write it precisely.
- Entries you record are marked as yours; you can edit or delete only those.
- Review cards follow FSRS, interleaved across the whole graph; the queue caps new cards at ${NOUVELLES_MAX}. You can read the queue and the review history to quiz him or spot weak points, but ratings must go through the app.

Working with him: record only what he said he did — never infer an outcome. When you show an exercise, give the statement first; reveal hints, then the solution, only when he asks. Write to him in French when discussing the content.`;

/* ----------------------------------------------------------------- helpers */

function failure(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

function ok(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

const TZ = "Europe/Paris";
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const pct = (x: number) => `${Math.round(x * 100)} %`;
const fmtMin = (m: number) => (m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")}`);
const when = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : new Intl.DateTimeFormat("en-GB", { timeZone: TZ, dateStyle: "medium", timeStyle: "short" }).format(d);
};

const MANUALS = ["none", "in-progress", "learned", "mastered"] as const;
const OUTCOMES = ["resolu-seul", "resolu-avec-indice", "echec", "abandonne"] as const;
const OUTCOME_LABELS: Record<Outcome, string> = {
  "resolu-seul": "solved alone",
  "resolu-avec-indice": "solved with a hint",
  echec: "failed",
  abandonne: "gave up",
};
const STATES = ["locked", "available", "in-progress", "learned", "mastered"] as const;
const MARK: Record<ProgressState, string> = {
  locked: "▯",
  available: "▨",
  "in-progress": "▤",
  learned: "▥",
  mastered: "▮",
};

const nodeRef = z.string().min(1).max(120).describe('A node id (slug, e.g. "suites-reelles"), from list_maths_nodes or search_maths.');
const conceptRef = z.string().min(1).max(120).describe('A concept id (slug, e.g. "suites-reelles"), from list_maths_nodes or search_maths.');

/** Everything a tool needs to reason like the pages do. */
type Snapshot = {
  graph: Graph;
  donnees: DonneesMaths;
  states: Map<string, ProgressState>;
  evidence: ReturnType<typeof evidenceParNoeud>;
};

async function snapshot(db: SupabaseClient, userId: string): Promise<Snapshot> {
  const graph = loadGraph();
  const donnees = await chargerDonneesDe(db, userId, { auteur: true });
  const evidence = evidenceParNoeud(graph, donnees);
  return { graph, donnees, evidence, states: computeStates(graph, evidence) };
}

function stateOf(s: Snapshot, node: GraphNode): ProgressState {
  return node.kind === "concept" ? s.states.get(node.id) ?? "locked" : stateOfContainer(s.graph, node.id, s.states);
}

type Found = { ok: true; node: GraphNode } | { ok: false; error: string };

function findNode(graph: Graph, ref: string): Found {
  const id = ref.trim().toLowerCase().replace(/^\/?maths\/n\//, "");
  const node = graph.byId.get(id);
  if (node) return { ok: true, node };
  const close = graph.nodes.filter((n) => n.id.includes(id) || n.title.toLowerCase().includes(id)).slice(0, 5);
  return {
    ok: false,
    error: `No node "${ref}".${close.length ? ` Did you mean ${close.map((n) => `${n.id} (${n.title})`).join(", ")}?` : " Call list_maths_nodes or search_maths."}`,
  };
}

function findConcept(graph: Graph, ref: string): Found {
  const r = findNode(graph, ref);
  if (r.ok && r.node.kind !== "concept")
    return { ok: false, error: `"${r.node.id}" is a ${r.node.kind}, not a concept: only concepts carry content and progress.` };
  return r;
}

function cardStateRow(s: Snapshot, nodeId: string, cardId: string, now: Date): string {
  const row = s.donnees.reviewStates.get(cardKey(nodeId, cardId));
  if (!row || !row.lastReview) return "new";
  const t = Math.max(0, (now.getTime() - new Date(row.lastReview).getTime()) / 86_400_000);
  return [
    `stability ${row.stability.toFixed(1)} d`,
    `difficulty ${row.difficulty.toFixed(1)}`,
    `recall now ${pct(retrievabilite(t, row.stability))}`,
    `due ${row.due}`,
    `${row.reps} reviews, ${row.lapses} lapses`,
  ].join(", ");
}

function attemptLine(a: AttemptRow): string {
  return `- ${when(a.createdAt)} · ${a.exerciseKey.split("/")[1]} (difficulty ${a.difficulty}) · ${OUTCOME_LABELS[a.outcome]}${a.minutesSpent ? ` · ${fmtMin(a.minutesSpent)}` : ""}${a.createdBy === "claude" ? " · recorded by Claude" : ""}${a.note ? ` — ${clip(a.note, 300)}` : ""} (attempt ${a.id})`;
}

function sessionLine(x: SessionLogRow, title?: string): string {
  return `- ${when(x.createdAt)} · ${title ?? x.nodeId} · ${fmtMin(x.minutes)}${x.createdBy === "claude" ? " · recorded by Claude" : ""}${x.note ? ` — ${clip(x.note, 300)}` : ""} (session ${x.id})`;
}

/** The course split into its ## sections, with their anchors. */
function sections(body: string): { anchor: string; title: string; text: string }[] {
  return body
    .split(/\n(?=## )/)
    .map((bloc) => {
      const head = /^##\s+(.*?)\s*(?:\{#([\w-]+)\})?\s*$/m.exec(bloc.split("\n")[0]);
      return { anchor: head?.[2] ?? "", title: head?.[1] ?? "Introduction", text: bloc.trim() };
    })
    .filter((x) => x.text);
}

/* ------------------------------------------------------------------- tools */

export function registerMathsTools(server: McpServer) {
  /* --------------------------------------------------------- overview */

  server.registerTool(
    "get_maths_dashboard",
    {
      title: "Maths parcours dashboard",
      description:
        "Where Arthur stands in the maths parcours: concepts per state, hours per level (estimated, earned, actually spent), cards due today and over the next week, predicted retention, success rate per tag, fragile nodes, recent activity, and the concepts he can start next.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (_input, ctx) => {
      const { db, userId } = callerOf(ctx.http?.authInfo);
      const s = await snapshot(db, userId);
      const now = new Date();
      const { graph, donnees, states } = s;

      const counts = Object.fromEntries(STATES.map((st) => [st, 0])) as Record<ProgressState, number>;
      for (const c of graph.concepts) counts[states.get(c.id) ?? "locked"]++;

      const minutes = minutesByNode(donnees);
      const domains = heuresParDomaine(graph, states, minutes);

      const cartes: EtatCarteBrut[] = [...donnees.reviewStates.values()].map((r) => ({
        nodeId: r.nodeId,
        stability: r.stability,
        due: r.due,
        lastReview: r.lastReview,
        lapses: r.lapses,
      }));
      const queue = fileDeRevision(graph, donnees, now);
      const load = chargeAVenir(cartes, now, 7);
      const retention = courbeOubli(cartes, now, 30);
      const tags = reussiteParTag(
        graph,
        donnees.attempts.map((a) => ({ nodeId: a.nodeId, difficulty: a.difficulty, outcome: a.outcome, minutesSpent: a.minutesSpent })),
      );
      const fragile = noeudsFragiles(graph, states, s.evidence, cartes);

      const weekAgo = now.getTime() - 7 * 86_400_000;
      const recentMinutes =
        donnees.sessions.filter((x) => Date.parse(x.createdAt) >= weekAgo).reduce((a, x) => a + x.minutes, 0) +
        donnees.attempts.filter((x) => Date.parse(x.createdAt) >= weekAgo).reduce((a, x) => a + x.minutesSpent, 0);
      const recentAttempts = donnees.attempts.filter((x) => Date.parse(x.createdAt) >= weekAgo).length;

      const next = graph.order
        .map((id) => graph.byId.get(id)!)
        .filter((c) => (states.get(c.id) ?? "locked") === "available")
        .slice(0, 8);
      const inProgress = graph.concepts.filter((c) => states.get(c.id) === "in-progress");

      const out = [
        `# Maths parcours — ${localDate(now, TZ)}`,
        `${graph.concepts.length} concepts: ${STATES.map((st) => `${counts[st]} ${st}`).join(", ")}. ${plural(graph.concepts.filter((c) => c.contentStatus !== "empty").length, "concept")} with content written.`,
        `Last 7 days: ${fmtMin(recentMinutes)} logged, ${plural(recentAttempts, "exercise attempt")}.`,
        "",
        "## Levels",
        ...domains.map(
          (d) =>
            `- ${d.titre} (${d.id}): ${d.conceptsAcquis}/${d.concepts} concepts learned · ${d.heuresAcquises} h earned of ${d.heuresEstimees} h estimated · ${d.minutesReelles ? fmtMin(d.minutesReelles) : "no time"} spent`,
        ),
        "",
        "## Reviews",
        `Due today: ${queue.length} cards (${queue.filter((c) => c.nouvelle).length} new). Next 7 days: ${load.slice(1).map((p) => `${p.date.slice(5)} ${p.cartes}`).join(", ")}.`,
        retention[0].cartes
          ? `Predicted mean recall over ${plural(retention[0].cartes, "reviewed card")}: today ${pct(retention[0].retention)}, in 7 days ${pct(retention[7].retention)}, in 30 days ${pct(retention[30].retention)} (if nothing is reviewed).`
          : "No card reviewed yet.",
        "",
        "## Success by tag (best attempt per exercise)",
        tags.length ? tags.map((t) => `- ${t.tag}: ${t.reussis}/${t.essais} solved (${pct(t.taux)}), ${t.sansIndice} without a hint`).join("\n") : "No attempt yet.",
        "",
        "## Fragile nodes",
        fragile.length ? fragile.map((f) => `- ${f.titre} (${f.nodeId}, ${f.etat}): ${f.raisons.join("; ")}`).join("\n") : "None.",
        "",
        "## In progress",
        inProgress.length ? inProgress.map((c) => `- ${c.title} (${c.id})`).join("\n") : "Nothing.",
        "",
        "## Can start next (prerequisites learned, in learning order)",
        next.length ? next.map((c) => `- ${c.title} (${c.id}) · ${c.estimatedHours} h · content ${c.contentStatus}`).join("\n") : "Nothing available.",
      ];
      return ok(out.join("\n"));
    },
  );

  server.registerTool(
    "list_maths_nodes",
    {
      title: "List the maths graph",
      description:
        "The parcours as a tree (levels > topics > concepts) with each node's state, content status and estimated hours, and each concept's prerequisites. Filter by a subtree, a state, a tag, or concepts that have content.",
      inputSchema: z.object({
        under: nodeRef.optional().describe("Only this domain or topic and what is below it."),
        state: z.enum(STATES).optional().describe("Only concepts in this state."),
        tag: z.string().max(40).optional().describe("Only concepts with this tag (analyse, algebre, combinatoire, calculatoire, mesure, asymptotique, inference, bayesien, processus, ml, causal, simulation, donnees, preuve)."),
        with_content: z.boolean().optional().describe("Only concepts whose course is written (draft or published)."),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ under, state, tag, with_content }, ctx) => {
      const { db, userId } = callerOf(ctx.http?.authInfo);
      const s = await snapshot(db, userId);
      const { graph } = s;

      let roots = graph.domains;
      if (under) {
        const r = findNode(graph, under);
        if (!r.ok) return failure(r.error);
        roots = [r.node];
      }
      const filtering = Boolean(state || tag || with_content);
      const keep = (c: GraphNode) =>
        (!state || stateOf(s, c) === state) &&
        (!tag || c.tags.includes(tag)) &&
        (!with_content || c.contentStatus !== "empty");

      const lines: string[] = [];
      const walk = (n: GraphNode, depth: number): boolean => {
        if (n.kind === "concept") {
          if (!keep(n)) return false;
          const st = stateOf(s, n);
          lines.push(
            `${"  ".repeat(depth)}${MARK[st]} ${n.title} (${n.id}) · ${st} · ${n.estimatedHours} h · content ${n.contentStatus}${n.requires.length ? ` · requires ${n.requires.join(", ")}` : ""}`,
          );
          return true;
        }
        const at = lines.length;
        lines.push(`${"  ".repeat(depth)}${n.kind === "domain" ? "#" : "##"} ${n.title} (${n.id}) · ${stateOf(s, n)} · ${n.hours} h`);
        const any = childrenOf(graph, n.id).map((k) => walk(k, depth + 1)).some(Boolean);
        if (filtering && !any) lines.splice(at);
        return any;
      };
      roots.forEach((r) => walk(r, 0));

      if (lines.length === 0) return ok("No concept matches.");
      return ok(`Legend: ▯ locked ▨ available ▤ in progress ▥ learned ▮ mastered\n${lines.join("\n")}`);
    },
  );

  server.registerTool(
    "get_maths_node",
    {
      title: "Get a maths node",
      description:
        "Everything about one node. For a concept: state and why (course read, manual status, exercises, cards against the thresholds), prerequisites and what it unlocks with their states, the course's sections, every exercise with its best outcome, every card with its FSRS state, and the logged sessions and attempts. For a domain or topic: its children.",
      inputSchema: z.object({ node: nodeRef }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ node: ref }, ctx) => {
      const { db, userId } = callerOf(ctx.http?.authInfo);
      const s = await snapshot(db, userId);
      const r = findNode(s.graph, ref);
      if (!r.ok) return failure(r.error);
      const node = r.node;
      const path = node.ancestors.map((a) => s.graph.byId.get(a)!.title).join(" > ");
      const head = `# ${node.title} (${node.id})\n${node.kind}${path ? ` in ${path}` : ""} · ${stateOf(s, node)} · ${node.hours} h estimated${node.tags.length ? ` · tags ${node.tags.join(", ")}` : ""}\nPage: /maths/n/${node.id}`;

      if (node.kind !== "concept") {
        const kids = childrenOf(s.graph, node.id).map(
          (k) => `- ${MARK[stateOf(s, k)]} ${k.title} (${k.id}) · ${k.kind} · ${stateOf(s, k)} · ${k.hours} h${k.kind === "concept" ? ` · content ${k.contentStatus}` : ""}`,
        );
        return ok(`${head}\n\n## Children\n${kids.join("\n")}`);
      }

      const now = new Date();
      const ev = s.evidence.get(node.id) ?? EMPTY_EVIDENCE;
      const prog = s.donnees.progress.get(node.id);
      const attempts = s.donnees.attempts.filter((a) => a.nodeId === node.id);
      const sessions = s.donnees.sessions.filter((x) => x.nodeId === node.id);
      const minutes = sessions.reduce((a, x) => a + x.minutes, 0) + attempts.reduce((a, x) => a + x.minutesSpent, 0);

      const easy = ev.exercises.filter((e) => e.difficulty <= 3);
      const easySolved = easy.filter((e) => e.outcome === "resolu-seul" || e.outcome === "resolu-avec-indice");
      const alone = easySolved.filter((e) => e.outcome === "resolu-seul");
      const hardSolved = ev.exercises.some((e) => e.difficulty >= SEUILS.difficulteHaute && (e.outcome === "resolu-seul" || e.outcome === "resolu-avec-indice"));
      const strong = ev.cardStabilities.filter((x) => x > SEUILS.stabiliteJours).length;

      const rel = (ids: string[]) =>
        ids.length ? ids.map((id) => `${s.graph.byId.get(id)?.title ?? id} (${id}, ${s.states.get(id) ?? "locked"})`).join("; ") : "none";

      const course = loadCourse(node);
      const exercises = loadExercises(node);
      const cards = loadCards(node);
      const best = new Map<string, AttemptRow>();
      const rank = (o: Outcome) => OUTCOMES.length - OUTCOMES.indexOf(o);
      for (const a of attempts) {
        const cur = best.get(a.exerciseKey);
        if (!cur || rank(a.outcome) > rank(cur.outcome)) best.set(a.exerciseKey, a);
      }

      const out = [
        head,
        "",
        "## Evidence",
        `- Manual status: ${prog?.manual ?? "none"}${prog?.masteredAt ? ` (first mastered ${when(prog.masteredAt)})` : ""}`,
        `- Course read: ${prog?.courseRead ? "yes" : "no"}`,
        `- Exercises difficulty ≤ 3: ${easySolved.length}/${easy.length} attempted ones solved (learned needs ≥ ${pct(SEUILS.reussiteFaible)} of them, half without a hint: ${alone.length} alone)`,
        `- Hard exercise (difficulty ≥ ${SEUILS.difficulteHaute}) solved: ${hardSolved ? "yes" : "no"}`,
        `- Cards above ${SEUILS.stabiliteJours} d stability: ${strong}/${ev.cardStabilities.length || cards.length}`,
        `- Time spent: ${fmtMin(minutes)}`,
        "",
        `Requires: ${rel(node.requires)}`,
        `Unlocks: ${rel(node.unlocks)}`,
        "",
        `## Course — ${node.contentStatus}`,
        course
          ? sections(course.body).map((x) => `- ${x.title}${x.anchor ? ` (#${x.anchor})` : ""}`).join("\n")
          : "Not written yet.",
        "",
        `## Exercises (${exercises.length})`,
        exercises.length
          ? exercises
              .map((e) => {
                const b = best.get(exerciseKey(node.id, e.id));
                return `- ${e.id} · ${e.kind} · difficulty ${e.difficulty} · ${plural(e.hints.length, "hint")} · ${b ? `best: ${OUTCOME_LABELS[b.outcome]}` : "not attempted"}`;
              })
              .join("\n")
          : "None.",
        "",
        `## Cards (${cards.length})`,
        cards.length ? cards.map((c) => `- ${c.id} (from #${c.ref}): ${clip(c.front, 140)} — ${cardStateRow(s, node.id, c.id, now)}`).join("\n") : "None.",
        "",
        `## Attempts (${attempts.length})`,
        attempts.length ? attempts.slice(0, 30).map(attemptLine).join("\n") : "None.",
        "",
        `## Sessions (${sessions.length})`,
        sessions.length ? sessions.slice(0, 30).map((x) => sessionLine(x)).join("\n") : "None.",
      ];
      return ok(out.join("\n"));
    },
  );

  /* ---------------------------------------------------------- content */

  server.registerTool(
    "read_maths_course",
    {
      title: "Read a maths course",
      description:
        `The course of a concept, as written (French Markdown with KaTeX and code). Pass a section to get only that part: its anchor (${RUBRIQUE.map((r) => r.id).join(", ")}) or its number (1–9). Without one, the whole course.`,
      inputSchema: z.object({
        concept: conceptRef,
        section: z.string().max(40).optional().describe("Section anchor or number."),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ concept, section }) => {
      const graph = loadGraph();
      const r = findConcept(graph, concept);
      if (!r.ok) return failure(r.error);
      const course = loadCourse(r.node);
      if (!course) return ok(`"${r.node.title}" has no course yet (content ${r.node.contentStatus}).`);
      const all = sections(course.body);
      if (!section) return ok(`# ${r.node.title} — ${r.node.contentStatus}\n\n${course.body.trim()}`);
      const want = section.trim().toLowerCase().replace(/^#/, "");
      const hit =
        all.find((x) => x.anchor === want) ??
        all.find((x) => x.title.startsWith(`${want}.`)) ??
        all.find((x) => x.title.toLowerCase().includes(want));
      if (!hit) return failure(`No section "${section}". Sections: ${all.map((x) => x.anchor || x.title).join(", ")}.`);
      return ok(`# ${r.node.title}\n\n${hit.text}`);
    },
  );

  server.registerTool(
    "get_maths_exercise",
    {
      title: "Get a maths exercise",
      description:
        'One exercise of a concept: its statement, kind and difficulty, and Arthur\'s attempts on it. Hints and the solution are returned only when asked (reveal "hints" or "solution", which includes the hints): do not reveal them before he wants them.',
      inputSchema: z.object({
        concept: conceptRef,
        exercise: z.string().min(1).max(120).describe('Exercise id, the file name without .mdx ("05-trois-adherences"), from get_maths_node. A leading number alone ("05") works.'),
        reveal: z.enum(["statement", "hints", "solution"]).optional().describe('Default "statement".'),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ concept, exercise, reveal }, ctx) => {
      const { db, userId } = callerOf(ctx.http?.authInfo);
      const graph = loadGraph();
      const r = findConcept(graph, concept);
      if (!r.ok) return failure(r.error);
      const all = loadExercises(r.node);
      const e = all.find((x) => x.id === exercise) ?? all.find((x) => x.id.startsWith(`${exercise}-`));
      if (!e) return failure(`No exercise "${exercise}" in ${r.node.id}. Exercises: ${all.map((x) => x.id).join(", ") || "none"}.`);

      const donnees = await chargerDonneesDe(db, userId, { auteur: true });
      const tries = donnees.attempts.filter((a) => a.exerciseKey === exerciseKey(r.node.id, e.id));
      const level = reveal ?? "statement";

      const out = [
        `# ${r.node.title} — exercise ${e.id}`,
        `${e.kind} · difficulty ${e.difficulty} · ${plural(e.hints.length, "hint")}`,
        "",
        "## Statement",
        e.statement,
      ];
      if (level !== "statement") {
        out.push("", "## Hints", e.hints.length ? e.hints.map((h, i) => `${i + 1}. ${h}`).join("\n\n") : "None.");
      }
      if (level === "solution") out.push("", "## Solution", e.solution || "Not written.");
      out.push("", `## Attempts (${tries.length})`, tries.length ? tries.map(attemptLine).join("\n") : "None.");
      return ok(out.join("\n"));
    },
  );

  server.registerTool(
    "search_maths",
    {
      title: "Search the maths parcours",
      description:
        "Full-text search across concept titles, course sections, exercises and cards (accents and case ignored, all words must appear). Returns where each hit is, with an excerpt.",
      inputSchema: z.object({
        query: z.string().min(1).max(200),
        type: z.enum(["concept", "course", "exercise", "card"]).optional().describe("Only this kind of result."),
        limit: z.number().int().min(1).max(40).optional().describe("Default 15."),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query, type, limit }) => {
      const map: Record<string, TypeDoc> = { concept: "noeud", course: "cours", exercise: "exercice", card: "carte" };
      const back: Record<TypeDoc, string> = { noeud: "concept", cours: "course", exercice: "exercise", carte: "card" };
      let hits = chercher(query, 200);
      if (type) hits = hits.filter((h) => h.type === map[type]);
      hits = hits.slice(0, limit ?? 15);
      if (hits.length === 0) return ok("No match.");
      return ok(
        hits
          .map((h) => `- [${back[h.type]}] ${h.nodeTitle} (${h.nodeId}) · ${h.titre}${h.ancre ? ` #${h.ancre}` : ""}\n  ${h.extrait}`)
          .join("\n"),
      );
    },
  );

  /* ---------------------------------------------------------- reviews */

  server.registerTool(
    "get_maths_review_queue",
    {
      title: "Maths cards due",
      description:
        `The review queue as the app builds it today: due and new cards (new ones capped at ${NOUVELLES_MAX}), interleaved across concepts. Each with its question, answer, source section and FSRS state. Use it to quiz Arthur; the rating itself happens in the app (/maths/revision).`,
      inputSchema: z.object({
        concept: conceptRef.optional().describe("Only cards of this concept."),
        include_answers: z.boolean().optional().describe("Include the back of each card. Default false."),
        limit: z.number().int().min(1).max(100).optional().describe("Default 30."),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ concept, include_answers, limit }, ctx) => {
      const { db, userId } = callerOf(ctx.http?.authInfo);
      const graph = loadGraph();
      let only: string | null = null;
      if (concept) {
        const r = findConcept(graph, concept);
        if (!r.ok) return failure(r.error);
        only = r.node.id;
      }
      const donnees = await chargerDonneesDe(db, userId);
      let queue = fileDeRevision(graph, donnees, new Date());
      const total = queue.length;
      if (only) queue = queue.filter((c) => c.nodeId === only);
      const shown = queue.slice(0, limit ?? 30);
      if (shown.length === 0) return ok(only ? "No card of this concept is due." : "Nothing due today.");
      const body = shown.map((c, i) =>
        [
          `${i + 1}. ${c.nodeTitle} · card ${c.cardId}${c.nouvelle ? " · new" : ` · due ${c.etat.due} · stability ${c.etat.stability.toFixed(1)} d · ${c.etat.lapses} lapses`} · from #${c.ref}`,
          `   Q: ${c.front}`,
          include_answers ? `   A: ${c.back.trim().replace(/\n/g, "\n      ")}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      );
      return ok(`${total} cards due today (${queue.filter((c) => c.nouvelle).length} new in this list)${queue.length > shown.length ? `, showing ${shown.length}` : ""}.\n\n${body.join("\n")}`);
    },
  );

  /* --------------------------------------------------------- activity */

  server.registerTool(
    "list_maths_activity",
    {
      title: "Maths activity log",
      description:
        "What Arthur did, most recent first: study sessions, exercise attempts (with what blocked him) and card reviews. Filter by concept and by how many days back. Entry ids here are what update_maths_entry and delete_maths_entry take.",
      inputSchema: z.object({
        concept: conceptRef.optional(),
        days: z.number().int().min(1).max(3650).optional().describe("How far back. Default 30."),
        include: z.array(z.enum(["sessions", "attempts", "reviews"])).min(1).optional().describe("Default all three."),
        limit: z.number().int().min(1).max(200).optional().describe("Per kind. Default 50."),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ concept, days, include, limit }, ctx) => {
      const { db, userId } = callerOf(ctx.http?.authInfo);
      const graph = loadGraph();
      let only: string | undefined;
      if (concept) {
        const r = findConcept(graph, concept);
        if (!r.ok) return failure(r.error);
        only = r.node.id;
      }
      const kinds = new Set(include ?? ["sessions", "attempts", "reviews"]);
      const n = limit ?? 50;
      const since = new Date(Date.now() - (days ?? 30) * 86_400_000).toISOString();
      const title = (id: string) => graph.byId.get(id)?.title ?? id;
      const inScope = (x: { nodeId: string; createdAt: string }) => (!only || x.nodeId === only) && x.createdAt >= since;

      const donnees = await chargerDonneesDe(db, userId, { auteur: true });
      const out: string[] = [`Since ${since.slice(0, 10)}${only ? ` · ${title(only)}` : ""}`];

      if (kinds.has("sessions")) {
        const xs = donnees.sessions.filter(inScope);
        out.push("", `## Sessions (${xs.length}, ${fmtMin(xs.reduce((a, x) => a + x.minutes, 0))})`, xs.length ? xs.slice(0, n).map((x) => sessionLine(x, title(x.nodeId))).join("\n") : "None.");
      }
      if (kinds.has("attempts")) {
        const xs = donnees.attempts.filter(inScope);
        out.push("", `## Attempts (${xs.length})`, xs.length ? xs.slice(0, n).map((a) => attemptLine(a).replace("- ", `- ${title(a.nodeId)} · `)).join("\n") : "None.");
      }
      if (kinds.has("reviews")) {
        const xs = await reviewLogAvec(db, userId, { nodeId: only, since, limit: n });
        const labels = ["", "again", "hard", "good", "easy"];
        out.push(
          "",
          `## Reviews (${xs.length}${xs.length === n ? "+" : ""})`,
          xs.length
            ? xs.map((x) => `- ${when(x.reviewedAt)} · ${title(x.nodeId)} · card ${x.cardKey.split(":")[1]} · ${labels[x.rating]} · stability ${x.stabilityBefore.toFixed(1)} → ${x.stabilityAfter.toFixed(1)} d after ${x.elapsedDays.toFixed(1)} d`).join("\n")
            : "None.",
        );
      }
      return ok(out.join("\n"));
    },
  );

  /* ----------------------------------------------------------- writes */

  server.registerTool(
    "set_maths_node_status",
    {
      title: "Set a concept's manual status",
      description:
        'Mark a concept by hand: "learned" or "mastered" when Arthur passed it without going through the exercises (or says he knows it), "in-progress" when he started it, "none" to clear the mark. Evidence still counts: a concept that earns a higher state keeps it.',
      inputSchema: z.object({ concept: conceptRef, status: z.enum(MANUALS) }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ concept, status }, ctx) => {
      const { db, userId } = callerOf(ctx.http?.authInfo);
      const graph = loadGraph();
      const r = findConcept(graph, concept);
      if (!r.ok) return failure(r.error);
      await setManualAvec(db, r.node.id, status);
      const s = await snapshot(db, userId);
      return ok(`${r.node.title}: manual status ${status}; state now ${s.states.get(r.node.id) ?? "locked"}.`);
    },
  );

  server.registerTool(
    "set_maths_course_read",
    {
      title: "Mark a course read",
      description: "Record that Arthur has read a concept's course (or unmark it). Reading the course is one of the conditions for learned.",
      inputSchema: z.object({ concept: conceptRef, read: z.boolean().optional().describe("Default true.") }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ concept, read }, ctx) => {
      const { db, userId } = callerOf(ctx.http?.authInfo);
      const graph = loadGraph();
      const r = findConcept(graph, concept);
      if (!r.ok) return failure(r.error);
      await setCourseReadAvec(db, userId, r.node.id, read ?? true);
      const s = await snapshot(db, userId);
      return ok(`${r.node.title}: course ${read === false ? "unmarked" : "marked read"}; state now ${s.states.get(r.node.id) ?? "locked"}.`);
    },
  );

  server.registerTool(
    "log_maths_session",
    {
      title: "Log a study session",
      description: "Add a study session on a concept to the journal: how long, and a note (what he covered, where he stopped). Exercise time goes on the attempt instead.",
      inputSchema: z.object({
        concept: conceptRef,
        minutes: z.number().int().min(1).max(1440),
        note: z.string().max(4000).optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ concept, minutes, note }, ctx) => {
      const { db, userId } = callerOf(ctx.http?.authInfo);
      const r = findConcept(loadGraph(), concept);
      if (!r.ok) return failure(r.error);
      const id = await addSessionAvec(db, userId, r.node.id, minutes, note?.trim() ?? "");
      return ok(`Logged ${fmtMin(minutes)} on ${r.node.title} (session ${id}).`);
    },
  );

  server.registerTool(
    "log_maths_attempt",
    {
      title: "Log an exercise attempt",
      description:
        "Record Arthur's attempt at an exercise: the outcome he reports, the time spent, and a note on what blocked him or what worked. The difficulty is taken from the exercise. Record only what he told you.",
      inputSchema: z.object({
        concept: conceptRef,
        exercise: z.string().min(1).max(120).describe('Exercise id ("05-trois-adherences") or its number ("05").'),
        outcome: z.enum(OUTCOMES).describe("resolu-seul: solved alone · resolu-avec-indice: solved with a hint · echec: failed · abandonne: gave up."),
        minutes: z.number().int().min(0).max(1440).optional(),
        note: z.string().max(4000).optional().describe("What blocked him, precisely; or the key idea he found."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ concept, exercise, outcome, minutes, note }, ctx) => {
      const { db, userId } = callerOf(ctx.http?.authInfo);
      const graph = loadGraph();
      const r = findConcept(graph, concept);
      if (!r.ok) return failure(r.error);
      const all = loadExercises(r.node);
      const e = all.find((x) => x.id === exercise) ?? all.find((x) => x.id.startsWith(`${exercise}-`));
      if (!e) return failure(`No exercise "${exercise}" in ${r.node.id}. Exercises: ${all.map((x) => x.id).join(", ") || "none"}.`);
      const id = await addAttemptAvec(db, userId, {
        exerciseKey: exerciseKey(r.node.id, e.id),
        nodeId: r.node.id,
        difficulty: e.difficulty,
        outcome,
        minutesSpent: minutes ?? 0,
        note: note?.trim() ?? "",
      });
      const s = await snapshot(db, userId);
      return ok(`Logged ${e.id} (difficulty ${e.difficulty}): ${OUTCOME_LABELS[outcome]} (attempt ${id}). ${r.node.title} is now ${s.states.get(r.node.id) ?? "locked"}.`);
    },
  );

  server.registerTool(
    "update_maths_entry",
    {
      title: "Edit a logged session or attempt",
      description: "Correct a session or an attempt you recorded (ids from list_maths_activity or get_maths_node). Entries Arthur recorded himself are his: they cannot be changed from here.",
      inputSchema: z.object({
        kind: z.enum(["session", "attempt"]),
        id: z.number().int().positive(),
        outcome: z.enum(OUTCOMES).optional().describe("Attempts only."),
        minutes: z.number().int().min(0).max(1440).optional(),
        note: z.string().max(4000).optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ kind, id, outcome, minutes, note }, ctx) => {
      const { db, userId } = callerOf(ctx.http?.authInfo);
      if (outcome === undefined && minutes === undefined && note === undefined) return failure("Nothing to change.");
      if (kind === "session" && outcome !== undefined) return failure("A session has no outcome.");
      if (kind === "session" && minutes === 0) return failure("A session lasts at least a minute.");
      const done =
        kind === "attempt"
          ? await updateAttemptAvec(db, userId, id, { outcome, minutesSpent: minutes, note: note?.trim() })
          : await updateSessionAvec(db, userId, id, { minutes, note: note?.trim() });
      return done
        ? ok(`${kind === "attempt" ? "Attempt" : "Session"} ${id} updated.`)
        : failure(`No ${kind} ${id} that you recorded. Arthur's own entries cannot be changed from here.`);
    },
  );

  server.registerTool(
    "delete_maths_entry",
    {
      title: "Delete a logged session or attempt",
      description: "Delete a session or an attempt you recorded, e.g. one logged by mistake. Entries Arthur recorded himself cannot be deleted from here.",
      inputSchema: z.object({ kind: z.enum(["session", "attempt"]), id: z.number().int().positive() }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ kind, id }, ctx) => {
      const { db, userId } = callerOf(ctx.http?.authInfo);
      const done = await deleteEntryAvec(db, userId, kind === "attempt" ? "maths_attempt" : "maths_session_log", id);
      return done
        ? ok(`${kind === "attempt" ? "Attempt" : "Session"} ${id} deleted.`)
        : failure(`No ${kind} ${id} that you recorded. Arthur's own entries cannot be deleted from here.`);
    },
  );
}
