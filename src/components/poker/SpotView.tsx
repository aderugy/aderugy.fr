"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { colorForKind, recolorActions } from "@/lib/solver/colors";
import { globalFrequencies } from "@/lib/solver/strategy";
import {
  createNode,
  deleteNode as deleteNodeAction,
  saveStrategy,
  updateNode,
  updateSpotSetup,
} from "@/server/actions/solver";
import { CsvImportError, parseStrategyCsv } from "@/lib/solver/csvImport";
import {
  asAction,
  asFlop,
  asPio,
  asStrategy,
  asStreet,
  emptyWeights,
  NODE_LABELS,
  setupProblem,
  type NodeData,
  type NodeMeta,
  type NodeType,
  type PokerNode,
  type SpotSetup,
  type StrategyAction,
  type StrategyStats,
  type StrategyWeights,
} from "@/lib/solver/types";
import {
  childTypes as childTypesFor,
  defaultOptions,
  effectiveStack,
  fmtBb,
  initialState,
  oop,
  totalPot,
  walkPath,
  walkTree,
  type HandState,
  type NodeState,
} from "@/lib/solver/gameState";
import {
  isCardToken,
  matchPioAction,
  pioActions,
  pioSnapshot,
  pioStats,
  pioWeights,
  seatsFromPath,
  setupFromTree,
  streetStartId,
  toStrategyActions,
  type PioNode,
  type PioPlayer,
  type PioTree,
} from "@/lib/solver/pio";
import { asRunoutReport, runoutReport } from "@/lib/solver/runouts";
import { pioBridge, PioBridgeError } from "@/lib/solver/pioBridge";
import type { Seat } from "@/lib/solver/seats";
import { RootInspector, ROOT_ID } from "@/components/poker/SpotRoot";
import { NodeInspector, type ImportResult } from "@/components/poker/NodeInspector";
import { StrategyEditor } from "@/components/poker/StrategyEditor";
import { SpotStudy, type StudyEditing } from "@/components/poker/SpotStudy";
import { PioFilePicker, RunoutPicker } from "@/components/poker/PioDialogs";
import { resolveStop, studyTree } from "@/lib/solver/studyNav";

const NODE_SELECT = "id, spot_id, parent_id, type, position, data, created_at, updated_at";

type Drawer = { kind: "node"; id: string } | { kind: "setup" } | null;
type Dialog =
  | { kind: "flop" }
  | { kind: "link"; nodeId: string }
  | { kind: "runouts"; leafId: string; file: string; splitId: string; street: "turn" | "river"; available: string[]; existing: string[] }
  | null;
type Notice = { tone: "busy" | "ok" | "warn" | "error"; text: string; detail?: string[] } | null;

/**
 * A spot, one node at a time (the study layout) — where it is also edited:
 * notes inline, the node's tools in a drawer, strategies imported from
 * PioSOLVER through PioBridge (or pasted as CSV). Holds the whole tree in
 * memory and every mutation; SpotStudy draws it.
 */
export function SpotView({
  spotId,
  spotName,
  initialSetup,
  initialFocus,
}: {
  spotId: string;
  spotName: string;
  initialSetup: SpotSetup;
  /** A node to open on (links from a trainer). */
  initialFocus?: string | null;
}) {
  const supabase = useMemo(() => createClient(), []);
  const [, startTransition] = useTransition();

  const [nodesById, setNodesById] = useState<Record<string, PokerNode>>({});
  const [allLoaded, setAllLoaded] = useState(false);
  const [setup, setSetup] = useState<SpotSetup>(initialSetup);
  const [focus, setFocus] = useState<string | null>(initialFocus ?? null);

  // Where you are in the tree lives in the URL (?node=<id>): reload or share
  // the link to come back here, and the browser's back / forward buttons
  // move through the tree.
  useEffect(() => {
    if (!focus) return;
    const url = new URL(window.location.href);
    if (url.searchParams.get("node") === focus) return;
    url.searchParams.set("node", focus);
    window.history.pushState(null, "", url.pathname + url.search + url.hash);
  }, [focus]);
  useEffect(() => {
    const onPop = () => setFocus(new URL(window.location.href).searchParams.get("node"));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const [drawer, setDrawer] = useState<Drawer>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [strategyWeights, setStrategyWeights] = useState<Record<string, StrategyWeights>>({});
  const [statsById, setStatsById] = useState<Record<string, StrategyStats | null>>({});
  const [gridEditor, setGridEditor] = useState<{ nodeId: string; weights: StrategyWeights } | null>(null);

  // Latest values for async flows (an import creates nodes and reads them back
  // before React re-renders).
  const nodesRef = useRef(nodesById);
  const setupRef = useRef(setup);
  useEffect(() => {
    nodesRef.current = nodesById;
  }, [nodesById]);
  useEffect(() => {
    setupRef.current = setup;
  }, [setup]);

  const fail = useCallback((e: unknown) => {
    const text = e instanceof PioBridgeError || e instanceof Error ? e.message : String(e);
    setNotice({ tone: "error", text });
  }, []);

  /* ------------------------------------------------------------- loading */

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const all: PokerNode[] = [];
      const PAGE = 1000;
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await supabase
          .from("poker_nodes")
          .select(NODE_SELECT)
          .eq("spot_id", spotId)
          .order("position")
          .order("id")
          .range(from, from + PAGE - 1);
        if (cancelled) return;
        if (error) {
          setNotice({ tone: "error", text: error.message });
          return;
        }
        all.push(...((data ?? []) as PokerNode[]));
        if (!data || data.length < PAGE) break;
      }
      const map = Object.fromEntries(all.map((n) => [n.id, n]));
      nodesRef.current = map;
      setNodesById(map);
      setAllLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [supabase, spotId]);

  const childrenOf = useMemo(() => {
    const map = new Map<string | null, PokerNode[]>();
    for (const n of Object.values(nodesById)) {
      const list = map.get(n.parent_id);
      if (list) list.push(n);
      else map.set(n.parent_id, [n]);
    }
    for (const list of map.values()) list.sort((a, b) => a.position - b.position || a.created_at.localeCompare(b.created_at));
    return map;
  }, [nodesById]);

  /* ---------------------------------------------------------- hand state */

  const setupReady = setupProblem(setup) === null;
  const rootState: HandState | null = useMemo(
    () => (setupReady ? initialState(setup as SpotSetup & { players: [Seat, Seat] }) : null),
    [setup, setupReady],
  );
  const nodeStates: Map<string, NodeState> = useMemo(() => {
    if (!setupReady) return new Map();
    return walkTree(setup as SpotSetup & { players: [Seat, Seat] }, (id) => childrenOf.get(id) ?? []);
  }, [setup, setupReady, childrenOf]);

  /** Root → node, from the latest nodes. */
  function pathNodes(id: string): PokerNode[] {
    const out: PokerNode[] = [];
    let cur: PokerNode | undefined = nodesRef.current[id];
    while (cur && out.length < 10_000) {
      out.push(cur);
      cur = cur.parent_id ? nodesRef.current[cur.parent_id] : undefined;
    }
    return out.reverse();
  }

  /** The hand at a node from the latest nodes and setup (for async flows). */
  function stateAt(id: string): NodeState | null {
    const s = setupRef.current;
    if (setupProblem(s)) return null;
    return walkPath(s as SpotSetup & { players: [Seat, Seat] }, pathNodes(id)).at(-1) ?? null;
  }

  function kidsOf(id: string | null): PokerNode[] {
    return Object.values(nodesRef.current)
      .filter((n) => n.parent_id === id)
      .sort((a, b) => a.position - b.position);
  }

  /** Seats from the latest setup (async flows); render uses `seatsOf(setup)`. */
  function seats(): { OOP: Seat; IP: Seat } | null {
    return seatsOf(setupRef.current);
  }

  /* ------------------------------------------------------------- grids */

  const weightsRef = useRef(strategyWeights);
  useEffect(() => {
    weightsRef.current = strategyWeights;
  }, [strategyWeights]);
  const weightsInflight = useRef<Set<string>>(new Set());
  const requestWeights = useCallback(
    (ids: string[]) => {
      const need = ids.filter((id) => weightsRef.current[id] === undefined && !weightsInflight.current.has(id));
      if (need.length === 0) return;
      for (const id of need) weightsInflight.current.add(id);
      void (async () => {
        const { data, error } = await supabase.from("poker_strategies").select("node_id, weights").in("node_id", need);
        for (const id of need) weightsInflight.current.delete(id);
        if (error) {
          setNotice({ tone: "error", text: error.message });
          return;
        }
        setStrategyWeights((prev) => {
          const next = { ...prev };
          for (const id of need) if (next[id] === undefined) next[id] = emptyWeights();
          for (const row of data ?? []) {
            const id = row.node_id as string;
            if (prev[id] === undefined) next[id] = normalizeWeights(row.weights);
          }
          return next;
        });
      })();
    },
    [supabase],
  );

  // Solver stats (equity, EV) are heavy: only the decision in focus asks.
  const statsRef = useRef(statsById);
  useEffect(() => {
    statsRef.current = statsById;
  }, [statsById]);
  const statsInflight = useRef<Set<string>>(new Set());
  const requestStats = useCallback(
    (id: string) => {
      if (statsRef.current[id] !== undefined || statsInflight.current.has(id)) return;
      statsInflight.current.add(id);
      void (async () => {
        const { data, error } = await supabase.from("poker_strategies").select("stats").eq("node_id", id).maybeSingle();
        statsInflight.current.delete(id);
        // Before migration 0014 there is no column: no stats, no error shown.
        const stats = error ? null : (((data as { stats?: unknown } | null)?.stats ?? null) as StrategyStats | null);
        setStatsById((prev) => (prev[id] === undefined ? { ...prev, [id]: stats } : prev));
      })();
    },
    [supabase],
  );

  const deadCardsFor = useCallback((nodeId: string) => deadCardsIn(nodesById, nodeId), [nodesById]);
  const allNodes = useMemo(() => Object.values(nodesById), [nodesById]);

  /* ---------------------------------------------------------- mutations */

  function saveSetup(next: SpotSetup) {
    setupRef.current = next;
    setSetup(next);
    startTransition(async () => {
      const r = await updateSpotSetup({ id: spotId, setup: next });
      if (!r.ok) fail(r.error);
    });
  }

  /** Merge a patch into a node's data and save it. */
  function persistData(id: string, patch: NodeData) {
    const current = nodesRef.current[id];
    const data = { ...((current?.data ?? {}) as object), ...(patch as object) } as NodeData;
    if (current) nodesRef.current = { ...nodesRef.current, [id]: { ...current, data } };
    setNodesById((prev) => (prev[id] ? { ...prev, [id]: { ...prev[id], data } } : prev));
    startTransition(async () => {
      const r = await updateNode({ id, data });
      if (!r.ok) fail(r.error);
    });
  }

  /** Create a node (with the usual starting data for its type unless given). */
  async function addChild(parentId: string | null, type: NodeType, opts: { optionId?: string; data?: NodeData } = {}): Promise<PokerNode | null> {
    const parent = parentId ? nodesRef.current[parentId] ?? null : null;
    const before = parent ? (stateAt(parent.id)?.state ?? null) : rootStateOf(setupRef.current);
    const data = opts.data ?? defaultData(type, parent, before, opts.optionId ?? firstUndeveloped(parent));
    const r = await createNode({ spotId, parentId, type, data });
    if (!r.ok) {
      fail(r.error);
      return null;
    }
    const now = new Date().toISOString();
    const node: PokerNode = {
      id: r.id,
      spot_id: spotId,
      parent_id: parentId,
      type,
      position: kidsOf(parentId).length,
      data,
      created_at: now,
      updated_at: now,
    };
    nodesRef.current = { ...nodesRef.current, [node.id]: node };
    setNodesById((prev) => ({ ...prev, [node.id]: node }));
    return node;
  }

  function descendantsOf(id: string): Set<string> {
    const doomed = new Set<string>([id]);
    const stack = [id];
    while (stack.length) {
      const cur = stack.pop()!;
      for (const child of kidsOf(cur)) {
        doomed.add(child.id);
        stack.push(child.id);
      }
    }
    return doomed;
  }

  function dropLocal(doomed: Set<string>) {
    const next = { ...nodesRef.current };
    for (const d of doomed) delete next[d];
    nodesRef.current = next;
    setNodesById((prev) => {
      const out = { ...prev };
      for (const d of doomed) delete out[d];
      return out;
    });
  }

  /**
   * Delete a node and everything under it. Deleting the branch of an option
   * keeps the option (and its grid column): it just goes back to undeveloped.
   */
  function removeNode(id: string) {
    const node = nodesRef.current[id];
    const doomed = descendantsOf(id);
    const parent = node?.parent_id ? nodesRef.current[node.parent_id] : null;
    dropLocal(doomed);
    setDrawer(null);
    setFocus(parent?.id ?? ROOT_ID);
    startTransition(async () => {
      const r = await deleteNodeAction(id);
      if (!r.ok) fail(r.error);
    });
  }

  /** Ask, naming the node and how much goes with it, then delete. */
  function confirmDelete(id: string) {
    const node = nodesRef.current[id];
    if (!node) return;
    const below = descendantsOf(id).size - 1;
    const actor = stateAt(id)?.actor;
    const name =
      node.type === "strategy"
        ? `the ${actor ? `${actor} ` : ""}decision`
        : node.type === "action"
          ? `“${asAction(node).label}”`
          : node.type === "flop"
            ? `the flop ${asFlop(node).cards.join(" ")}`
            : `the ${node.type} ${asStreet(node).card ?? ""}`.trim();
    const rest = below > 0 ? ` and the ${below} node${below === 1 ? "" : "s"} under it` : "";
    if (confirm(`Delete ${name}${rest}?`)) removeNode(id);
  }

  /** Keep a decision's linked action children in step with its options. */
  function syncLinkedChildren(strategyId: string, actions: StrategyAction[], skip: Set<string> = new Set()) {
    const byId = new Map(actions.map((a) => [a.id, a]));
    for (const kid of kidsOf(strategyId)) {
      if (kid.type !== "action" || skip.has(kid.id)) continue;
      const d = asAction(kid);
      if (!d.strategyActionId) continue;
      const a = byId.get(d.strategyActionId);
      if (!a) {
        const doomed = descendantsOf(kid.id);
        dropLocal(doomed);
        startTransition(async () => {
          const r = await deleteNodeAction(kid.id);
          if (!r.ok) fail(r.error);
        });
        continue;
      }
      if (actionChanged(d, a)) {
        persistData(kid.id, { ...d, kind: a.kind, sizePct: a.sizePct ?? null, sizeUnit: a.sizeUnit ?? null, label: a.label, color: a.color });
      }
    }
  }

  function firstUndeveloped(parent: PokerNode | null): string | undefined {
    if (!parent || parent.type !== "strategy") return undefined;
    const linked = linkedActionIds(parent.id);
    return asStrategy(parent).actions.find((a) => !linked.has(a.id))?.id;
  }

  function linkedActionIds(strategyId: string): Set<string> {
    const out = new Set<string>();
    for (const kid of kidsOf(strategyId)) {
      if (kid.type !== "action") continue;
      const id = asAction(kid).strategyActionId;
      if (id) out.add(id);
    }
    return out;
  }

  /* ------------------------------------------------------ grid editing */

  async function openGridEditor(node: PokerNode) {
    const { data, error } = await supabase.from("poker_strategies").select("weights").eq("node_id", node.id).maybeSingle();
    if (error) return fail(error.message);
    setGridEditor({ nodeId: node.id, weights: normalizeWeights(data?.weights) });
  }

  function saveGridWeights(weights: StrategyWeights) {
    if (!gridEditor) return;
    const nodeId = gridEditor.nodeId;
    setGridEditor((prev) => (prev ? { ...prev, weights } : prev));
    setStrategyWeights((prev) => ({ ...prev, [nodeId]: weights }));
    startTransition(async () => {
      const r = await saveStrategy({ nodeId, weights });
      if (!r.ok) fail(r.error);
    });
  }

  /* ------------------------------------------------------------ imports */

  /**
   * Put an imported strategy on a decision: its options, its grid, its
   * solver stats (null for CSV), and one action node per option actually
   * played that has none yet. Existing action nodes stay linked to their
   * option (same id) and are relabelled.
   */
  async function applyImportedStrategy(
    node: PokerNode,
    imp: {
      actions: StrategyAction[];
      weights: StrategyWeights;
      stats: StrategyStats | null;
      rows?: number;
      warnings?: string[];
      /** Extra data for the decision (the Pio link). */
      extra?: NodeData;
      /** Extra data for each option's action node (its Pio link). */
      childExtra?: (a: StrategyAction) => NodeData;
      confirm?: string | null;
      source: string;
    },
  ): Promise<ImportResult> {
    if (imp.confirm) {
      const { data: existing, error } = await supabase.from("poker_strategies").select("weights").eq("node_id", node.id).maybeSingle();
      if (error) return { ok: false, error: error.message };
      const prev = normalizeWeights(existing?.weights);
      if ((Object.keys(prev.hands).length > 0 || Object.keys(prev.combos).length > 0) && !confirm(imp.confirm)) {
        return { ok: false, error: "Import cancelled" };
      }
    }

    const current = asStrategy(nodesRef.current[node.id] ?? node);
    persistData(node.id, { ...current, actions: imp.actions, ...(imp.extra as object) } as NodeData);
    setStrategyWeights((prev) => ({ ...prev, [node.id]: imp.weights }));
    setStatsById((prev) => ({ ...prev, [node.id]: imp.stats }));
    const saved = await saveStrategy({ nodeId: node.id, weights: imp.weights, stats: imp.stats });
    if (!saved.ok) return { ok: false, error: saved.error };
    const warnings = [...(imp.warnings ?? [])];
    if (saved.warning) warnings.push(saved.warning);

    const kids = kidsOf(node.id);
    const byId = new Map(imp.actions.map((a) => [a.id, a]));
    const linked = new Set<string>();
    let orphaned = 0;
    for (const kid of kids) {
      if (kid.type !== "action") continue;
      const d = asAction(kid);
      const a = d.strategyActionId ? byId.get(d.strategyActionId) : undefined;
      if (!a) {
        if (d.strategyActionId) orphaned++;
        continue;
      }
      linked.add(a.id);
      const extra = imp.childExtra?.(a);
      if (actionChanged(d, a) || extra) {
        persistData(kid.id, { ...d, kind: a.kind, sizePct: a.sizePct ?? null, sizeUnit: a.sizeUnit ?? null, label: a.label, color: a.color, ...(extra as object) } as NodeData);
      }
    }

    // One action node per played option without one, in order (a 0% option
    // needs none). Sequential so positions follow the options.
    const freqs = globalFrequencies(imp.weights, imp.actions.length, deadCardsIn(nodesRef.current, node.id));
    let created = 0;
    let unused = 0;
    for (const [i, a] of imp.actions.entries()) {
      if (linked.has(a.id)) continue;
      if (!freqs || freqs[i] <= 0.0001) {
        unused++;
        continue;
      }
      const data = {
        strategyActionId: a.id,
        kind: a.kind,
        sizePct: a.sizePct ?? null,
        sizeUnit: a.sizeUnit ?? null,
        label: a.label,
        color: a.color,
        ...(imp.childExtra?.(a) as object),
      } as NodeData;
      if (!(await addChild(node.id, "action", { data }))) return { ok: false, error: "Could not create the action nodes" };
      created++;
    }

    const parts = [
      imp.source,
      ...(imp.rows != null ? [`${imp.rows} row${imp.rows === 1 ? "" : "s"}`] : []),
      `${imp.actions.length} options`,
      `${created} action node${created === 1 ? "" : "s"} created`,
    ];
    if (unused > 0) parts.push(`${unused} never played`);
    if (orphaned > 0) parts.push(`${orphaned} older action node${orphaned === 1 ? "" : "s"} no longer match an option`);
    return { ok: true, message: `Imported ${parts.join(" · ")}`, warnings };
  }

  async function importStrategyCsv(node: PokerNode, text: string): Promise<ImportResult> {
    let parsed;
    try {
      parsed = parseStrategyCsv(text, asStrategy(node).actions);
    } catch (e) {
      return { ok: false, error: e instanceof CsvImportError ? e.message : "Could not read the file" };
    }
    return applyImportedStrategy(node, {
      actions: parsed.actions,
      weights: parsed.weights,
      stats: null,
      rows: parsed.rows,
      warnings: parsed.warnings,
      confirm: "Replace this decision's options and grid with the CSV?",
      source: "CSV",
    });
  }

  /* ---------------------------------------------------------------- Pio */

  const pioNodes = useRef(new Map<string, Promise<{ node: PioNode; children: PioNode[] }>>());
  const pioTrees = useRef(new Map<string, Promise<PioTree>>());
  function pioNode(file: string, id: string) {
    const key = `${file}|${id}`;
    let p = pioNodes.current.get(key);
    if (!p) {
      p = pioBridge.node(file, id);
      p.catch(() => pioNodes.current.delete(key));
      pioNodes.current.set(key, p);
    }
    return p;
  }
  function pioTree(file: string) {
    let p = pioTrees.current.get(file);
    if (!p) {
      p = pioBridge.tree(file);
      p.catch(() => pioTrees.current.delete(file));
      pioTrees.current.set(file, p);
    }
    return p;
  }

  /** The save linked above (or on) a node, if any. */
  function pioFileAbove(id: string): string | null {
    for (const n of pathNodes(id).reverse()) {
      const p = asPio(n);
      if (p) return p.file;
    }
    return null;
  }

  /**
   * The solver node an app node stands for: from the deepest node on its line
   * that stores one, then step by step — a decision is the node reached, an
   * action the option of the solver that matches it, a card that card.
   */
  async function resolvePio(id: string): Promise<{ file: string; pioId: string }> {
    const path = pathNodes(id);
    let i = path.length - 1;
    while (i >= 0 && !asPio(path[i])) i--;
    if (i < 0) throw new Error("No PioSOLVER save above this node. Add the flop from a save, or link its flop to one (✎ on the flop).");
    const link = asPio(path[i])!;
    const file = link.file;
    let cur = link.id;
    for (const n of path.slice(i + 1)) {
      const p = asPio(n);
      if (p && p.file === file) {
        cur = p.id;
        continue;
      }
      if (n.type === "strategy") {
        cur = cur === "r" ? "r:0" : cur;
      } else if (n.type === "action") {
        const { node: dn, children } = await pioNode(file, cur);
        if (!dn.player) throw new Error(`The solver has no decision at ${cur}.`);
        const ss = streetStartId(cur);
        const start = ss === cur ? dn.pot : (await pioNode(file, ss)).node.pot;
        const tree = await pioTree(file);
        const opts = pioActions(dn, children, start, tree.effectiveStack);
        const a = asAction(n);
        const m = matchPioAction(a, opts);
        if (!m) throw new Error(`“${a.label}” isn't one of the solver's options here (${opts.map((o) => o.label).join(", ")}).`);
        cur = m.childId;
      } else if (n.type === "turn" || n.type === "river") {
        const c = asStreet(n).card;
        if (!c) throw new Error(`Pick the ${n.type} card first.`);
        cur = `${cur}:${c}`;
      } else {
        throw new Error("Link this flop to a save first (✎ on the flop).");
      }
    }
    return { file, pioId: cur };
  }

  /** Import the solver's decision onto a decision node. */
  async function importDecision(node: PokerNode, opts: { at?: { file: string; pioId: string }; confirm: boolean }): Promise<ImportResult> {
    try {
      const ns = stateAt(node.id);
      if (!ns) return { ok: false, error: "Set who plays first (Start → Setup)." };
      if (ns.error) return { ok: false, error: `Fix the line first: ${ns.error}` };
      const { file, pioId } = opts.at ?? (await resolvePio(node.id));
      const [d, handOrder, tree] = await Promise.all([pioBridge.decision(file, pioId), pioBridge.handOrder(), pioTree(file)]);
      const ss = streetStartId(pioId);
      const start = ss === pioId ? d.node.pot : (await pioNode(file, ss)).node.pot;
      const st = seats();
      if (st && ns.actor && st[d.player as PioPlayer] !== ns.actor) {
        return { ok: false, error: `The solver has ${st[d.player]} to act here, the tree has ${ns.actor}: the line doesn't match.` };
      }
      const pa = pioActions(d.node, d.children, start, tree.effectiveStack);
      const actions = toStrategyActions(pa, asStrategy(nodesRef.current[node.id] ?? node).actions);
      const childPio = new Map(actions.map((a, i) => [a.id, pa[i].childId]));
      const importedAt = new Date().toISOString();
      const weights = pioWeights(d, handOrder, d.node.board);
      const stats = pioStats(d, handOrder, { seats: st, importedAt });
      const snap = pioSnapshot(d.node, tree.effectiveStack);
      const warnings = [...(stats?.notes ?? [])];
      const engPot = totalPot(ns.state);
      const engStack = effectiveStack(ns.state);
      if (Math.abs(engPot - snap.potBb) > 0.06 || Math.abs(engStack - snap.stackBb) > 0.06) {
        warnings.push(
          `The tree has pot ${fmtBb(engPot)} · ${fmtBb(engStack)} behind here, the solver ${fmtBb(snap.potBb)} · ${fmtBb(snap.stackBb)}.`,
        );
      }
      const r = await applyImportedStrategy(node, {
        actions,
        weights,
        stats,
        warnings,
        extra: { pio: { file, id: pioId, ...snap, importedAt } },
        childExtra: (a) => ({ pio: { file, id: childPio.get(a.id)! } }),
        confirm: opts.confirm ? "Replace this decision's strategy with the solver's?" : null,
        source: "from Pio",
      });
      return r.ok ? { ...r, message: `${r.message} · ${d.ms} ms` } : r;
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  function show(r: ImportResult) {
    if (r.ok) setNotice({ tone: r.warnings.length ? "warn" : "ok", text: r.message, detail: r.warnings });
    else setNotice({ tone: "error", text: r.error });
  }

  async function importFocusDecision(id: string) {
    const node = nodesRef.current[id];
    if (!node) return;
    setNotice({ tone: "busy", text: "Importing from Pio…" });
    show(await importDecision(node, { confirm: true }));
  }

  /**
   * Below a node where the tree stops: the solver's next decision (created
   * and imported), or the cards it deals next (a picker), or the end.
   */
  async function continueFromPio(leafId: string) {
    const leaf = nodesRef.current[leafId];
    if (!leaf) return;
    try {
      setNotice({ tone: "busy", text: "Asking the solver…" });
      const { file, pioId } = await resolvePio(leafId);
      if (leaf.type === "action" && asPio(leaf)?.id !== pioId) persistData(leafId, { pio: { file, id: pioId } });
      const target = pioId === "r" ? "r:0" : pioId;
      const { node: pn, children } = await pioNode(file, target);
      if (pn.player) {
        if (!pn.solved) return setNotice({ tone: "warn", text: "This node isn't in the save (a river of a no-rivers save)." });
        const dec = await addChild(leafId, "strategy", { data: { actions: [], pio: { file, id: target } } as NodeData });
        if (!dec) return;
        setFocus(dec.id);
        setNotice({ tone: "busy", text: "Importing from Pio…" });
        show(await importDecision(dec, { at: { file, pioId: target }, confirm: false }));
        return;
      }
      if (pn.type.startsWith("SPLIT")) {
        const cards = children.map((c) => c.last ?? "").filter(isCardToken);
        if (cards.length === 0 || children.every((c) => !c.solved)) {
          return setNotice({ tone: "warn", text: "The next street isn't in this save (no_rivers save)." });
        }
        const ns = stateAt(leafId);
        const street = ns?.state.nextStreet === "river" ? "river" : "turn";
        const existing = kidsOf(leafId)
          .filter((k) => k.type === street)
          .map((k) => asStreet(k).card)
          .filter((c): c is string => !!c);
        setNotice(null);
        setDialog({ kind: "runouts", leafId, file, splitId: target, street, available: cards, existing });
        return;
      }
      setNotice({ tone: "ok", text: "The hand ends here in the solver." });
    } catch (e) {
      fail(e);
    }
  }

  async function importRunouts(leafId: string, file: string, splitId: string, street: "turn" | "river", cards: string[]) {
    setDialog(null);
    const warnings: string[] = [];
    let done = 0;
    for (const card of cards) {
      setNotice({ tone: "busy", text: `Importing ${street} ${card} (${done + 1}/${cards.length})…` });
      const id = `${splitId}:${card}`;
      const cardNode = await addChild(leafId, street, { data: { card, pio: { file, id } } as NodeData });
      if (!cardNode) return;
      const dec = await addChild(cardNode.id, "strategy", { data: { actions: [], pio: { file, id } } as NodeData });
      if (!dec) return;
      const r = await importDecision(dec, { at: { file, pioId: id }, confirm: false });
      if (!r.ok) warnings.push(`${card}: ${r.error}`);
      else warnings.push(...r.warnings.map((w) => `${card}: ${w}`));
      done++;
    }
    setFocus(leafId);
    setNotice({ tone: warnings.length ? "warn" : "ok", text: `Imported ${done} ${street} card${done === 1 ? "" : "s"} from Pio`, detail: warnings.slice(0, 6) });
  }

  /** The report on every card dealt below a node (turn or river), saved on the node. */
  async function loadRunouts(id: string) {
    const leaf = nodesRef.current[id];
    if (!leaf) return;
    try {
      setNotice({ tone: "busy", text: "Reading every runout from Pio (the whole save is loaded once: a few seconds)…" });
      const { file, pioId } = await resolvePio(id);
      if (leaf.type === "action" && asPio(leaf)?.id !== pioId) persistData(id, { pio: { file, id: pioId } });
      const [r, tree] = await Promise.all([pioBridge.runouts(file, pioId), pioTree(file)]);
      const report = runoutReport(r, tree.effectiveStack, new Date().toISOString());
      persistData(id, { runouts: report });
      setNotice({
        tone: report.missing.length ? "warn" : "ok",
        text: `${report.rows.length} runouts read from Pio · ${(r.ms / 1000).toFixed(1)} s`,
        detail: report.missing.length ? [`Not in the save: ${report.missing.join(" ")}`] : [],
      });
    } catch (e) {
      fail(e);
    }
  }

  /** One card of the report into the tree (card + its decision from Pio), then go there. */
  async function importRunoutCard(id: string, card: string) {
    const report = asRunoutReport((nodesRef.current[id]?.data as NodeMeta | undefined)?.runouts);
    const ns = stateAt(id);
    if (!report || !ns) return;
    const street = ns.state.nextStreet === "river" ? "river" : "turn";
    await importRunouts(id, report.file, report.pioId, street, [card]);
    const cardNode = kidsOf(id).find((k) => k.type === street && asStreet(k).card === card);
    const dec = cardNode ? kidsOf(cardNode.id).find((k) => k.type === "strategy") : undefined;
    if (dec) setFocus(dec.id);
  }

  /** Develop an option of a decision; on a solver line, import what follows. */
  async function develop(decisionId: string, optionId: string) {
    const dec = nodesRef.current[decisionId];
    const a = dec ? asStrategy(dec).actions.find((x) => x.id === optionId) : undefined;
    if (!dec || !a) return;
    const node = await addChild(decisionId, "action", {
      data: { strategyActionId: a.id, kind: a.kind, sizePct: a.sizePct ?? null, sizeUnit: a.sizeUnit ?? null, label: a.label, color: a.color },
    });
    if (!node) return;
    setFocus(node.id);
    if (pioFileAbove(decisionId)) await continueFromPio(node.id);
  }

  /** A flop from a save: the spot's start from the save, the flop, its first decision. */
  async function addFlopFromPio(file: string) {
    setDialog(null);
    try {
      setNotice({ tone: "busy", text: "Opening the save…" });
      const tree = await pioTree(file);
      const cur = setupRef.current;
      const players = cur.players ?? seatsFromPath(file);
      if (!players) {
        setDrawer({ kind: "setup" });
        return setNotice({ tone: "warn", text: "Set who plays this spot first (two seats), then add the flop again." });
      }
      const fromSave = setupFromTree(tree);
      const same = cur.players && cur.street === "flop" && cur.potBb === fromSave.potBb && cur.stackBb === fromSave.stackBb;
      if (!same) {
        const hasTree = kidsOf(null).length > 0;
        const text = `Start the spot like the save: ${players[0]} vs ${players[1]}, flop, pot ${fmtBb(fromSave.potBb)} bb, ${fmtBb(fromSave.stackBb)} bb behind?`;
        if (!hasTree || confirm(text)) saveSetup({ ...cur, players, street: "flop", ...fromSave });
      }
      const sameBoard = (n: PokerNode) => {
        const cards = asFlop(n).cards;
        return cards.length === 3 && tree.board.every((c) => cards.includes(c));
      };
      let flop = kidsOf(null).find((n) => n.type === "flop" && sameBoard(n)) ?? null;
      if (flop) persistData(flop.id, { pio: { file, id: "r" } } as NodeData);
      else flop = await addChild(null, "flop", { data: { cards: tree.board, pio: { file, id: "r" } } as NodeData });
      if (!flop) return;
      let dec: PokerNode | null = kidsOf(flop.id).find((k) => k.type === "strategy") ?? null;
      const hadGrid = !!dec;
      if (!dec) dec = await addChild(flop.id, "strategy", { data: { actions: [], pio: { file, id: "r:0" } } as NodeData });
      if (!dec) return;
      setFocus(dec.id);
      setNotice({ tone: "busy", text: "Importing the flop decision…" });
      show(await importDecision(dec, { at: { file, pioId: "r:0" }, confirm: hadGrid }));
    } catch (e) {
      fail(e);
    }
  }

  async function linkFlop(flopId: string, file: string) {
    setDialog(null);
    try {
      const tree = await pioTree(file);
      const flop = nodesRef.current[flopId];
      const cards = flop ? asFlop(flop).cards : [];
      if (cards.length === 3 && !tree.board.every((c) => cards.includes(c))) {
        return setNotice({ tone: "error", text: `That save's flop is ${tree.board.join(" ")}, not ${cards.join(" ")}.` });
      }
      persistData(flopId, { ...(cards.length === 3 ? {} : { cards: tree.board }), pio: { file, id: "r" } } as NodeData);
      setNotice({ tone: "ok", text: `Linked to ${file}` });
    } catch (e) {
      fail(e);
    }
  }

  // Ctrl+V on a decision in focus imports the clipboard as CSV (the old way).
  const focusStop = useMemo(() => (allLoaded ? resolveStop(studyTree(allNodes, ROOT_ID), focus) : null), [allLoaded, allNodes, focus]);
  useEffect(() => {
    if (drawer || !focusStop || nodesById[focusStop]?.type !== "strategy") return;
    function onPaste(e: ClipboardEvent) {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      const text = e.clipboardData?.getData("text/plain") ?? "";
      if (!text.trim() || !/[,;\t]/.test(text)) return;
      e.preventDefault();
      const node = nodesRef.current[focusStop!];
      if (node) void importStrategyCsv(node, text).then(show);
    }
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawer, focusStop, nodesById]);

  /* ---------------------------------------------------------------- view */

  function childTypesAt(id: string): NodeType[] {
    if (!rootState) return [];
    const node = id === ROOT_ID ? null : (nodesById[id] ?? null);
    return childTypesFor(node, node ? (nodeStates.get(node.id) ?? null) : null, rootState);
  }

  function childLabelAt(id: string, type: NodeType): string {
    if (type !== "strategy") return NODE_LABELS[type];
    const st = id === ROOT_ID ? rootState : nodeStates.get(id)?.state;
    return st?.toAct ? `Decision (${st.toAct})` : NODE_LABELS[type];
  }

  function linkedIdsNow(strategyId: string): Set<string> {
    const out = new Set<string>();
    for (const kid of childrenOf.get(strategyId) ?? []) {
      const aid = kid.type === "action" ? asAction(kid).strategyActionId : null;
      if (aid) out.add(aid);
    }
    return out;
  }

  const editing: StudyEditing = {
    editNode: (id) => setDrawer(id === ROOT_ID ? { kind: "setup" } : { kind: "node", id }),
    saveNotes: (id, patch) => {
      if (id === ROOT_ID) {
        const s = setupRef.current;
        saveSetup({ ...s, ...(patch.summary !== undefined ? { summary: patch.summary } : {}), ...(patch.notes !== undefined ? { notes: patch.notes } : {}) });
      } else persistData(id, patch);
    },
    saveCategories: (id, categories) => persistData(id, { categories }),
    runouts: {
      load: (id) => void loadRunouts(id),
      importCard: (id, card) => void importRunoutCard(id, card),
      saveGroups: (id, runoutGroups) => persistData(id, { runoutGroups }),
    },
    develop: (decisionId, optionId) => void develop(decisionId, optionId),
    deleteNode: confirmDelete,
    addChild: async (parentId, type) => {
      const node = await addChild(parentId === ROOT_ID ? null : parentId, type);
      if (!node) return;
      setFocus(node.id);
      // Cards and options are chosen in the drawer.
      if (type !== "action") setDrawer({ kind: "node", id: node.id });
    },
    childTypes: childTypesAt,
    childLabel: childLabelAt,
    pasteCsv: async (id) => {
      const node = nodesRef.current[id];
      if (!node) return;
      let text: string;
      try {
        text = await navigator.clipboard.readText();
      } catch {
        return setNotice({ tone: "warn", text: "Clipboard access blocked — press Ctrl+V instead." });
      }
      show(await importStrategyCsv(node, text));
    },
    pio: {
      linkedAbove: (id) => id !== ROOT_ID && !!pioFileAbove(id),
      importDecision: (id) => void importFocusDecision(id),
      continueFrom: (id) => void continueFromPio(id),
      addFlop: () => setDialog({ kind: "flop" }),
      busy: notice?.tone === "busy",
    },
    stats: statsById,
    requestStats,
    seats: seatsOf(setup),
  };

  const drawerNode = drawer?.kind === "node" ? (nodesById[drawer.id] ?? null) : null;
  const drawerParent = drawerNode?.parent_id ? (nodesById[drawerNode.parent_id] ?? null) : null;
  const lastFile = useMemo(() => {
    for (const n of Object.values(nodesById)) {
      const p = asPio(n);
      if (p) return p.file;
    }
    return null;
  }, [nodesById]);

  return (
    <div className="relative h-full w-full overflow-hidden bg-background">
      <SpotStudy
        header={
          <span className="flex min-w-0 items-center gap-2">
            <Link href="/poker/spots" className="shrink-0 text-xs text-muted hover:text-foreground" title="All spots">
              ← Spots
            </Link>
            <span className="truncate text-sm font-medium">{spotName}</span>
          </span>
        }
        setup={setup}
        nodes={allNodes}
        loading={!allLoaded}
        nodeStates={nodeStates}
        rootState={rootState}
        weights={strategyWeights}
        requestWeights={requestWeights}
        deadCards={deadCardsFor}
        focusId={focus}
        onFocus={setFocus}
        editing={editing}
      />

      {notice && <NoticeBar notice={notice} onClose={() => setNotice(null)} />}

      {drawer?.kind === "setup" && (
        <RootInspector
          setup={setup}
          childTypes={childTypesAt(ROOT_ID)}
          childLabel={(t) => childLabelAt(ROOT_ID, t)}
          onChange={saveSetup}
          onAddChild={(type) => void editing.addChild(ROOT_ID, type)}
          onAddFromPio={() => setDialog({ kind: "flop" })}
          onClose={() => setDrawer(null)}
          withNotes={false}
        />
      )}

      {drawerNode && (
        <NodeInspector
          key={drawerNode.id}
          node={drawerNode}
          parent={drawerParent}
          dead={deadCardsFor(drawerNode.id)}
          ns={setupReady ? (nodeStates.get(drawerNode.id) ?? null) : null}
          before={setupReady ? (drawerParent ? (nodeStates.get(drawerParent.id)?.state ?? null) : rootState) : null}
          setup={setup}
          childTypes={childTypesAt(drawerNode.id)}
          childLabel={(t) => childLabelAt(drawerNode.id, t)}
          withNotes={drawerNode.id !== focusStop}
          pio={
            drawerNode.type === "flop"
              ? { link: asPio(drawerNode), onLink: () => setDialog({ kind: "link", nodeId: drawerNode.id }) }
              : undefined
          }
          onPatch={(data) => persistData(drawerNode.id, data)}
          onAddChild={(type) => void editing.addChild(drawerNode.id, type)}
          onDelete={() => confirmDelete(drawerNode.id)}
          onOpenStrategy={() => void openGridEditor(drawerNode)}
          onImportCsv={(text) => importStrategyCsv(drawerNode, text)}
          onClose={() => setDrawer(null)}
        />
      )}

      {gridEditor && nodesById[gridEditor.nodeId] && (
        <StrategyEditor
          key={gridEditor.nodeId}
          title="Decision — grid"
          initialActions={asStrategy(nodesById[gridEditor.nodeId]).actions}
          initialWeights={gridEditor.weights}
          dead={deadCardsFor(gridEditor.nodeId)}
          linkedActionIds={linkedIdsNow(gridEditor.nodeId)}
          onActionsChange={(actions) => {
            persistData(gridEditor.nodeId, { ...asStrategy(nodesById[gridEditor.nodeId]), actions });
            syncLinkedChildren(gridEditor.nodeId, actions);
          }}
          onWeightsChange={saveGridWeights}
          onClose={() => setGridEditor(null)}
        />
      )}

      {dialog?.kind === "flop" && (
        <PioFilePicker
          title="Add a flop from a PioSOLVER save"
          near={lastFile}
          onPick={(file) => void addFlopFromPio(file)}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "link" && (
        <PioFilePicker
          title="Link this flop to a PioSOLVER save"
          near={lastFile}
          onPick={(file) => void linkFlop(dialog.nodeId, file)}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "runouts" && (
        <RunoutPicker
          street={dialog.street}
          available={dialog.available}
          existing={dialog.existing}
          onPick={(cards) => void importRunouts(dialog.leafId, dialog.file, dialog.splitId, dialog.street, cards)}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}

/* -------------------------------------------------------------- notices */

function NoticeBar({ notice, onClose }: { notice: NonNullable<Notice>; onClose: () => void }) {
  const tone = {
    busy: "border-line bg-surface text-foreground",
    ok: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
    warn: "border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-300",
    error: "border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400",
  }[notice.tone];
  // Success fades on its own; the rest stays until read.
  useEffect(() => {
    if (notice.tone !== "ok") return;
    const t = window.setTimeout(onClose, 4000);
    return () => window.clearTimeout(t);
  }, [notice, onClose]);
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-3 z-40 flex justify-center px-3">
      <div role="status" className={`pointer-events-auto max-w-xl rounded-lg border px-3 py-2 text-xs shadow-lg backdrop-blur ${tone}`}>
        <div className="flex items-start gap-3">
          {notice.tone === "busy" && <span className="mt-0.5 size-3 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent" />}
          <span className="min-w-0 flex-1">{notice.text}</span>
          {notice.tone !== "busy" && (
            <button type="button" onClick={onClose} className="shrink-0 opacity-70 hover:opacity-100" aria-label="Dismiss">
              ✕
            </button>
          )}
        </div>
        {notice.detail && notice.detail.length > 0 && (
          <ul className="mt-1 list-disc space-y-0.5 pl-4 opacity-90">
            {notice.detail.map((d) => (
              <li key={d}>{d}</li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- helpers */

function seatsOf(s: SpotSetup): { OOP: Seat; IP: Seat } | null {
  if (!s.players) return null;
  const o = oop(s.players);
  return { OOP: o, IP: s.players[0] === o ? s.players[1] : s.players[0] };
}

function rootStateOf(setup: SpotSetup): HandState | null {
  return setupProblem(setup) ? null : initialState(setup as SpotSetup & { players: [Seat, Seat] });
}

function actionChanged(d: ReturnType<typeof asAction>, a: StrategyAction): boolean {
  return (
    d.label !== a.label ||
    d.color !== a.color ||
    d.kind !== a.kind ||
    (d.sizePct ?? null) !== (a.sizePct ?? null) ||
    (d.sizeUnit ?? null) !== (a.sizeUnit ?? null)
  );
}

/** Board cards dealt above a node (its flop / turn / river ancestors). */
export function deadCardsIn(nodesById: Record<string, PokerNode>, nodeId: string): Set<string> {
  const dead = new Set<string>();
  let cur = nodesById[nodeId]?.parent_id ?? null;
  while (cur) {
    const n = nodesById[cur];
    if (!n) break;
    if (n.type === "flop") for (const c of asFlop(n).cards) dead.add(c);
    if (n.type === "turn" || n.type === "river") {
      const c = asStreet(n).card;
      if (c) dead.add(c);
    }
    cur = n.parent_id;
  }
  return dead;
}

function normalizeWeights(raw: unknown): StrategyWeights {
  const w = (raw ?? {}) as Partial<StrategyWeights>;
  return { hands: w.hands ?? {}, combos: w.combos ?? {} };
}

function defaultData(type: NodeType, parent: PokerNode | null, before: HandState | null, optionId: string | undefined): NodeData {
  switch (type) {
    case "flop":
      return { cards: [] };
    case "turn":
    case "river":
      return { card: null };
    case "strategy": {
      // The options a player usually has here; an import replaces them.
      const options = before ? defaultOptions(before) : [];
      return {
        actions: recolorActions(
          options.map((o) => ({ id: crypto.randomUUID(), kind: o.kind, sizePct: o.sizePct, sizeUnit: o.sizeUnit ?? null, label: o.label, color: "" })),
        ),
      };
    }
    case "action": {
      if (parent && parent.type === "strategy") {
        const actions = asStrategy(parent).actions;
        const a = actions.find((x) => x.id === optionId) ?? actions[0];
        if (a) {
          return { strategyActionId: a.id, kind: a.kind, sizePct: a.sizePct ?? null, sizeUnit: a.sizeUnit ?? null, label: a.label, color: a.color };
        }
      }
      return { kind: "check", label: "Check", color: colorForKind("check") };
    }
    default:
      return {};
  }
}
