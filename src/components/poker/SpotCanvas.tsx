"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { createClient } from "@/lib/supabase/client";
import { colorForKind, recolorActions } from "@/lib/solver/colors";
import { layoutTree, type Size } from "@/lib/solver/layout";
import { globalFrequencies, remapWeights } from "@/lib/solver/strategy";
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
  asStrategy,
  asStreet,
  emptyWeights,
  NODE_LABELS,
  setupProblem,
  type NodeData,
  type NodeType,
  type PokerNode,
  type SpotSetup,
  type StrategyAction,
  type StrategyWeights,
} from "@/lib/solver/types";
import {
  childTypes as childTypesFor,
  defaultOptions,
  initialState,
  walkTree,
  type HandState,
  type NodeState,
} from "@/lib/solver/gameState";
import type { Seat } from "@/lib/solver/seats";
import { RootCard, RootInspector, ROOT_ID } from "@/components/poker/SpotRoot";
import type { ImportResult } from "@/components/poker/NodeInspector";
import { MiniNodeCard, NodeCard, type CanvasMode } from "@/components/poker/NodeCard";
import { NodeInspector } from "@/components/poker/NodeInspector";
import { StrategyEditor } from "@/components/poker/StrategyEditor";
import { SpotStudy } from "@/components/poker/SpotStudy";
import { Segmented } from "@/components/poker/ui";

const NODE_SELECT = "id, spot_id, parent_id, type, position, data, created_at, updated_at";

export function SpotCanvas({
  spotId,
  initialSetup,
  initialNodes,
  focusPath,
}: {
  spotId: string;
  /** The root of the tree: who plays, where it starts, pot and stacks. */
  initialSetup: SpotSetup;
  initialNodes: PokerNode[];
  /** Ids root → node to open on load (links from a trainer). */
  focusPath?: string[];
}) {
  const supabase = useMemo(() => createClient(), []);
  const [, startTransition] = useTransition();

  const [nodesById, setNodesById] = useState<Record<string, PokerNode>>(() =>
    Object.fromEntries(initialNodes.map((n) => [n.id, n])),
  );
  const [loaded, setLoaded] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [withChildren, setWithChildren] = useState<Set<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [strategy, setStrategy] = useState<{ nodeId: string; weights: StrategyWeights } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<CanvasMode>("edit");
  // Cache of strategy grids, loaded on demand (study previews, action frequencies).
  const [strategyWeights, setStrategyWeights] = useState<Record<string, StrategyWeights>>({});
  const [setup, setSetup] = useState<SpotSetup>(initialSetup);
  // Study mode: the node in focus (null = where the tree starts).
  const [studyFocus, setStudyFocus] = useState<string | null>(null);
  // Study mode walks the whole tree, so it loads every node at once.
  const [allLoaded, setAllLoaded] = useState(false);
  // Canvas: a node to scroll into view once it is laid out.
  const [centerOn, setCenterOn] = useState<string | null>(null);

  function saveSetup(next: SpotSetup) {
    setSetup(next);
    startTransition(async () => {
      const r = await updateSpotSetup({ id: spotId, setup: next });
      if (!r.ok) setError(r.error);
    });
  }

  /** Switch between the canvas and study, keeping the node you are on. */
  function switchMode(next: CanvasMode) {
    if (next === mode) return;
    if (next === "revision") {
      // Study opens on the node selected on the canvas, if any.
      if (selectedId) setStudyFocus(selectedId);
      void loadAll();
      setSelectedId(null);
    } else {
      // Back on the canvas: the studied node, selected and in view.
      const id = studyFocus;
      setSelectedId(id);
      if (id) revealOnCanvas(id);
    }
    setMode(next);
    setStrategy(null);
  }

  /** Expand every ancestor of `id` and pan the canvas to it. */
  function revealOnCanvas(id: string) {
    const chain: string[] = [];
    let cur = id === ROOT_ID ? null : (nodesById[id]?.parent_id ?? null);
    while (cur) {
      chain.push(cur);
      cur = nodesById[cur]?.parent_id ?? null;
    }
    if (chain.length) setExpanded((prev) => new Set([...prev, ...chain]));
    setCenterOn(id);
  }

  const loadingAllRef = useRef(false);
  async function loadAll() {
    if (allLoaded || loadingAllRef.current) return;
    loadingAllRef.current = true;
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
      if (error) {
        setError(error.message);
        loadingAllRef.current = false;
        return;
      }
      all.push(...((data ?? []) as PokerNode[]));
      if (!data || data.length < PAGE) break;
    }
    // Local copies win: they may hold edits not saved yet.
    setNodesById((prev) => ({ ...Object.fromEntries(all.map((n) => [n.id, n])), ...prev }));
    setLoaded((prev) => new Set([...prev, ...all.map((n) => n.id)]));
    setWithChildren(
      (prev) => new Set([...prev, ...all.flatMap((n) => (n.parent_id ? [n.parent_id] : []))]),
    );
    setAllLoaded(true);
    loadingAllRef.current = false;
  }

  const loadingRef = useRef<Set<string>>(new Set());

  const childrenOf = useMemo(() => {
    const map = new Map<string | null, PokerNode[]>();
    for (const n of Object.values(nodesById)) {
      const key = n.parent_id;
      const list = map.get(key);
      if (list) list.push(n);
      else map.set(key, [n]);
    }
    return map;
  }, [nodesById]);

  /* --------------------------------------------------------- lazy loading */

  async function fetchChildren(parentId: string): Promise<PokerNode[]> {
    const { data, error } = await supabase
      .from("poker_nodes")
      .select(NODE_SELECT)
      .eq("spot_id", spotId)
      .eq("parent_id", parentId)
      .order("position");
    if (error) {
      setError(error.message);
      return [];
    }
    return (data ?? []) as PokerNode[];
  }

  async function computeHasChildren(parentIds: string[]): Promise<Set<string>> {
    if (parentIds.length === 0) return new Set();
    const { data, error } = await supabase
      .from("poker_nodes")
      .select("parent_id")
      .eq("spot_id", spotId)
      .in("parent_id", parentIds);
    if (error) {
      setError(error.message);
      return new Set();
    }
    return new Set((data ?? []).map((r) => r.parent_id as string));
  }

  async function ensureChildren(id: string) {
    if (loaded.has(id) || loadingRef.current.has(id)) return;
    loadingRef.current.add(id);
    const kids = await fetchChildren(id);
    setNodesById((prev) => ({
      ...prev,
      ...Object.fromEntries(kids.map((k) => [k.id, k])),
    }));
    setLoaded((prev) => new Set(prev).add(id));
    const wc = await computeHasChildren(kids.map((k) => k.id));
    if (wc.size > 0) setWithChildren((prev) => new Set([...prev, ...wc]));
    loadingRef.current.delete(id);
  }

  async function expand(id: string) {
    await ensureChildren(id);
    setExpanded((prev) => new Set(prev).add(id));
  }

  // How many trainers drill each node of this spot (badge on strategy cards).
  const [trainerCounts, setTrainerCounts] = useState<Record<string, number>>({});
  useEffect(() => {
    let cancelled = false;
    void supabase
      .from("poker_trainer_nodes")
      .select("node_id")
      .eq("spot_id", spotId)
      .then(({ data }) => {
        if (cancelled || !data) return;
        const counts: Record<string, number> = {};
        for (const r of data) counts[r.node_id as string] = (counts[r.node_id as string] ?? 0) + 1;
        setTrainerCounts(counts);
      });
    return () => {
      cancelled = true;
    };
  }, [supabase, spotId]);

  // Open the tree down to a linked node and select it, once.
  const focusedRef = useRef(false);
  useEffect(() => {
    if (focusedRef.current || !focusPath || focusPath.length === 0) return;
    focusedRef.current = true;
    void (async () => {
      for (const id of focusPath.slice(0, -1)) await expand(id);
      setSelectedId(focusPath[focusPath.length - 1]);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusPath]);

  function toggle(id: string) {
    if (expanded.has(id)) {
      setExpanded((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    } else {
      void expand(id);
    }
  }

  // Load and auto-expand the roots once.
  useEffect(() => {
    const roots = initialNodes.map((n) => n.id);
    (async () => {
      const wc = await computeHasChildren(roots);
      if (wc.size > 0) setWithChildren((prev) => new Set([...prev, ...wc]));
      await Promise.all(roots.filter((id) => wc.has(id)).map((id) => expand(id)));
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* -------------------------------------------------------- visible + layout */

  // Expanded nodes show their children as full cards; a collapsed node shows
  // its (loaded) children as tiny chips, which expand it when clicked.
  const { visible, minis } = useMemo(() => {
    const out: PokerNode[] = [];
    const minis = new Set<string>();
    const walk = (node: PokerNode) => {
      out.push(node);
      const kids = childrenOf.get(node.id) ?? [];
      if (expanded.has(node.id)) {
        for (const child of kids) walk(child);
      } else {
        for (const child of kids) {
          out.push(child);
          minis.add(child.id);
        }
      }
    };
    for (const root of childrenOf.get(null) ?? []) walk(root);
    return { visible: out, minis };
  }, [childrenOf, expanded]);

  // Collapsed nodes need their children loaded to show them as chips.
  useEffect(() => {
    const need = visible
      .filter((n) => !minis.has(n.id) && !expanded.has(n.id) && withChildren.has(n.id) && !loaded.has(n.id))
      .map((n) => n.id);
    if (need.length === 0) return;
    // Fetches resolve asynchronously; state is only set once data arrives.
    void Promise.all(need.map((id) => ensureChildren(id)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, minis, expanded, withChildren, loaded]);

  // Rendered node sizes, fed back into the layout so boxes of any size (a
  // revision-mode strategy bubble is far taller than the default) never
  // overlap. One observer watches every card; it reports layout sizes, which
  // the canvas zoom transform does not affect.
  const [sizes, setSizes] = useState<Record<string, Size>>({});
  const observerRef = useRef<ResizeObserver | null>(null);
  const getObserver = useCallback((): ResizeObserver => {
    if (!observerRef.current) {
      observerRef.current = new ResizeObserver((entries) => {
        setSizes((prev) => {
          let next = prev;
          for (const entry of entries) {
            const el = entry.target as HTMLElement;
            const id = el.dataset.nodeId;
            if (!id) continue;
            const w = el.offsetWidth;
            const h = el.offsetHeight;
            if (prev[id]?.w === w && prev[id]?.h === h) continue;
            if (next === prev) next = { ...prev };
            next[id] = { w, h };
          }
          return next;
        });
      });
    }
    return observerRef.current;
  }, []);
  useEffect(() => () => observerRef.current?.disconnect(), []);

  // The root card sits above the top-level nodes, which hang from it.
  const layout = useMemo(
    () =>
      layoutTree(
        [
          { id: ROOT_ID, parent_id: null, position: 0, created_at: "" },
          ...visible.map((n) => (n.parent_id ? n : { ...n, parent_id: ROOT_ID })),
        ],
        sizes,
      ),
    [visible, sizes],
  );

  // Strategy grids, fetched once each on demand. Empties are cached too, so
  // nothing is refetched.
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
        const { data, error } = await supabase
          .from("poker_strategies")
          .select("node_id, weights")
          .in("node_id", need);
        for (const id of need) weightsInflight.current.delete(id);
        if (error) {
          setError(error.message);
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

  // Action cards show their frequency from the parent decision's grid.
  useEffect(() => {
    requestWeights(visible.filter((n) => n.type === "strategy").map((n) => n.id));
  }, [visible, requestWeights]);

  // Global frequency of every action of every visible strategy, by node id.
  const frequencies = useMemo(() => {
    const out: Record<string, number[] | null> = {};
    for (const n of visible) {
      if (n.type !== "strategy" || !strategyWeights[n.id]) continue;
      out[n.id] = globalFrequencies(
        strategyWeights[n.id],
        asStrategy(n).actions.length,
        deadCardsIn(nodesById, n.id),
      );
    }
    return out;
  }, [visible, strategyWeights, nodesById]);

  /* ------------------------------------------------------------ hand state */

  // The hand at every loaded node, walked from the setup. Null while the
  // setup can't start a hand (seats or pot missing).
  const setupReady = setupProblem(setup) === null;
  const rootState: HandState | null = useMemo(
    () => (setupReady ? initialState(setup as SpotSetup & { players: [Seat, Seat] }) : null),
    [setup, setupReady],
  );
  const nodeStates: Map<string, NodeState> = useMemo(() => {
    if (!setupReady) return new Map();
    return walkTree(setup as SpotSetup & { players: [Seat, Seat] }, (id) =>
      [...(childrenOf.get(id) ?? [])].sort((a, b) => a.position - b.position),
    );
  }, [setup, setupReady, childrenOf]);

  /** What "+" offers under a node (or under the root). */
  function childTypesOf(node: PokerNode | null): NodeType[] {
    if (!rootState) return [];
    return childTypesFor(node, node ? (nodeStates.get(node.id) ?? null) : null, rootState);
  }

  function childLabel(parent: PokerNode | null) {
    return (type: NodeType) => {
      if (type !== "strategy") return NODE_LABELS[type];
      const s = parent ? nodeStates.get(parent.id)?.state : rootState;
      return s?.toAct ? `Decision (${s.toAct})` : NODE_LABELS[type];
    };
  }

  /** Decision nodes: ids of the options that already have a branch. */
  function developedOf(node: PokerNode): Set<string> {
    return linkedActionIds(node.id);
  }

  /** The global frequency of the strategy action an action node represents. */
  function actionFrequency(node: PokerNode): number | null {
    if (node.type !== "action" || !node.parent_id) return null;
    const parent = nodesById[node.parent_id];
    if (!parent || parent.type !== "strategy") return null;
    const freqs = frequencies[parent.id];
    const index = asStrategy(parent).actions.findIndex(
      (a) => a.id === asAction(node).strategyActionId,
    );
    return freqs && index >= 0 ? freqs[index] : null;
  }

  function nodeHasChildren(id: string): boolean {
    return withChildren.has(id) || (childrenOf.get(id)?.length ?? 0) > 0;
  }

  /* --------------------------------------------------------------- mutations */

  // Latest nodes, so back-to-back patches in one tick merge onto each other.
  const nodesRef = useRef(nodesById);
  useEffect(() => {
    nodesRef.current = nodesById;
  }, [nodesById]);

  /**
   * Patch a node's data. Patches are merged into the stored data, so an editor
   * that only knows its own fields (cards, actions…) never drops the others
   * (summary, notes).
   */
  function persistData(id: string, patch: NodeData) {
    const current = nodesRef.current[id];
    const data = { ...((current?.data ?? {}) as object), ...(patch as object) } as NodeData;
    if (current) nodesRef.current = { ...nodesRef.current, [id]: { ...current, data } };
    setNodesById((prev) => (prev[id] ? { ...prev, [id]: { ...prev[id], data } } : prev));
    startTransition(async () => {
      const r = await updateNode({ id, data });
      if (!r.ok) setError(r.error);
    });
  }

  async function addChild(parent: PokerNode | null, type: NodeType, optionId?: string) {
    const before = parent ? (nodeStates.get(parent.id)?.state ?? null) : rootState;
    const data = defaultData(type, parent, before, optionId ?? firstUndeveloped(parent));
    const parentId = parent?.id ?? null;
    const r = await createNode({ spotId, parentId, type, data });
    if (!r.ok) {
      setError(r.error);
      return;
    }
    const now = new Date().toISOString();
    const siblings = childrenOf.get(parentId) ?? [];
    const node: PokerNode = {
      id: r.id,
      spot_id: spotId,
      parent_id: parentId,
      type,
      position: siblings.length,
      data,
      created_at: now,
      updated_at: now,
    };
    setNodesById((prev) => ({ ...prev, [node.id]: node }));
    if (parent) {
      setWithChildren((prev) => new Set(prev).add(parent.id));
      setLoaded((prev) => new Set(prev).add(parent.id));
      setExpanded((prev) => new Set(prev).add(parent.id));
    }
    setSelectedId(node.id);
  }

  function removeNode(id: string) {
    const node = nodesById[id];
    // Gather the node and every loaded descendant.
    const doomed = new Set<string>([id]);
    const stack = [id];
    while (stack.length) {
      const cur = stack.pop()!;
      for (const child of childrenOf.get(cur) ?? []) {
        doomed.add(child.id);
        stack.push(child.id);
      }
    }
    setNodesById((prev) => {
      const next = { ...prev };
      for (const d of doomed) delete next[d];
      return next;
    });
    setSelectedId(null);
    startTransition(async () => {
      const r = await deleteNodeAction(id);
      if (!r.ok) setError(r.error);
    });

    // A linked action under a strategy *is* that strategy action: deleting the
    // node removes the action (and its column of the grid) from the strategy.
    const parent = node?.parent_id ? nodesById[node.parent_id] : null;
    const actionId = node?.type === "action" ? asAction(node).strategyActionId : null;
    if (parent?.type === "strategy" && actionId) {
      void removeStrategyAction(parent, actionId, doomed);
    }
  }

  /** Drop one action from a strategy node, its grid column, and its siblings' colours. */
  async function removeStrategyAction(parent: PokerNode, actionId: string, skip: Set<string>) {
    const data = asStrategy(parent);
    const index = data.actions.findIndex((a) => a.id === actionId);
    if (index < 0) return;
    const len = data.actions.length;
    const actions = recolorActions(data.actions.filter((a) => a.id !== actionId));
    persistData(parent.id, { ...data, actions });
    syncLinkedChildren(parent.id, actions, skip);

    let weights = strategyWeights[parent.id];
    if (!weights) {
      const { data: row, error } = await supabase
        .from("poker_strategies")
        .select("weights")
        .eq("node_id", parent.id)
        .maybeSingle();
      if (error) {
        setError(error.message);
        return;
      }
      if (!row) return; // no grid stored yet: nothing to remap
      weights = normalizeWeights(row.weights);
    }
    const next = remapWeights(weights, len, len - 1, index);
    setStrategyWeights((prev) => ({ ...prev, [parent.id]: next }));
    const r = await saveStrategy({ nodeId: parent.id, weights: next });
    if (!r.ok) setError(r.error);
  }

  /**
   * Keep a strategy's linked action children in step with its action set:
   * relabel / recolour the ones whose action changed, delete the ones whose
   * action is gone (with their subtree). `skip` holds nodes already deleted.
   */
  function syncLinkedChildren(
    strategyId: string,
    actions: StrategyAction[],
    skip: Set<string> = new Set(),
  ) {
    const byId = new Map(actions.map((a) => [a.id, a]));
    for (const kid of childrenOf.get(strategyId) ?? []) {
      if (kid.type !== "action" || skip.has(kid.id)) continue;
      const d = asAction(kid);
      if (!d.strategyActionId) continue;
      const a = byId.get(d.strategyActionId);
      if (!a) {
        removeSubtree(kid.id);
        continue;
      }
      if (
        d.label !== a.label ||
        d.color !== a.color ||
        d.kind !== a.kind ||
        (d.sizePct ?? null) !== (a.sizePct ?? null) ||
        (d.sizeUnit ?? null) !== (a.sizeUnit ?? null)
      ) {
        persistData(kid.id, {
          ...d,
          kind: a.kind,
          sizePct: a.sizePct ?? null,
          sizeUnit: a.sizeUnit ?? null,
          label: a.label,
          color: a.color,
        });
      }
    }
  }

  /** Delete a node and its loaded descendants, without touching its parent. */
  function removeSubtree(id: string) {
    const doomed = new Set<string>([id]);
    const stack = [id];
    while (stack.length) {
      const cur = stack.pop()!;
      for (const child of childrenOf.get(cur) ?? []) {
        doomed.add(child.id);
        stack.push(child.id);
      }
    }
    setNodesById((prev) => {
      const next = { ...prev };
      for (const d of doomed) delete next[d];
      return next;
    });
    if (selectedId && doomed.has(selectedId)) setSelectedId(null);
    startTransition(async () => {
      const r = await deleteNodeAction(id);
      if (!r.ok) setError(r.error);
    });
  }

  /** The first option of a decision that has no branch yet. */
  function firstUndeveloped(parent: PokerNode | null): string | undefined {
    if (!parent || parent.type !== "strategy") return undefined;
    const linked = linkedActionIds(parent.id);
    return asStrategy(parent).actions.find((a) => !linked.has(a.id))?.id;
  }

  /** Strategy action ids that have a linked action node under `strategyId`. */
  function linkedActionIds(strategyId: string): Set<string> {
    const out = new Set<string>();
    for (const kid of childrenOf.get(strategyId) ?? []) {
      if (kid.type !== "action") continue;
      const id = asAction(kid).strategyActionId;
      if (id) out.add(id);
    }
    return out;
  }

  /* --------------------------------------------------------------- strategy */

  async function openStrategy(node: PokerNode) {
    // Linked action children must be known to keep them in sync with edits.
    void ensureChildren(node.id);
    const { data, error } = await supabase
      .from("poker_strategies")
      .select("weights")
      .eq("node_id", node.id)
      .maybeSingle();
    if (error) {
      setError(error.message);
      return;
    }
    const weights = (data?.weights as StrategyWeights) ?? emptyWeights();
    setStrategy({
      nodeId: node.id,
      weights: { hands: weights.hands ?? {}, combos: weights.combos ?? {} },
    });
  }

  function saveStrategyWeights(weights: StrategyWeights) {
    if (!strategy) return;
    setStrategy((prev) => (prev ? { ...prev, weights } : prev));
    const nodeId = strategy.nodeId;
    // Keep the revision-mode cache in step with edits.
    setStrategyWeights((prev) => ({ ...prev, [nodeId]: weights }));
    startTransition(async () => {
      const r = await saveStrategy({ nodeId, weights });
      if (!r.ok) setError(r.error);
    });
  }

  /**
   * Import a solver CSV into a strategy node: the headers become the node's
   * action set, the rows its grid, and one linked action child is generated
   * per action that does not already have one.
   */
  async function importStrategyCsv(node: PokerNode, text: string): Promise<ImportResult> {
    const current = asStrategy(node);
    let parsed;
    try {
      parsed = parseStrategyCsv(text, current.actions);
    } catch (e) {
      return { ok: false, error: e instanceof CsvImportError ? e.message : "Could not read the file" };
    }

    // Replacing an existing grid is destructive; ask first.
    const { data: existing, error: existingError } = await supabase
      .from("poker_strategies")
      .select("weights")
      .eq("node_id", node.id)
      .maybeSingle();
    if (existingError) return { ok: false, error: existingError.message };
    const prevWeights = normalizeWeights(existing?.weights);
    const hasGrid =
      Object.keys(prevWeights.hands).length > 0 || Object.keys(prevWeights.combos).length > 0;
    if (hasGrid && !confirm("Replace this strategy's actions and grid with the CSV?")) {
      return { ok: false, error: "Import cancelled" };
    }

    persistData(node.id, { ...current, actions: parsed.actions });
    setStrategyWeights((prev) => ({ ...prev, [node.id]: parsed.weights }));
    const saved = await saveStrategy({ nodeId: node.id, weights: parsed.weights });
    if (!saved.ok) return { ok: false, error: saved.error };

    // Current children (fetched if the node was never expanded).
    let kids = childrenOf.get(node.id) ?? [];
    if (!loaded.has(node.id)) {
      kids = await fetchChildren(node.id);
      setNodesById((prev) => ({ ...prev, ...Object.fromEntries(kids.map((k) => [k.id, k])) }));
      setLoaded((prev) => new Set(prev).add(node.id));
    }
    const actionKids = kids.filter((k) => k.type === "action");
    const byId = new Map(parsed.actions.map((a) => [a.id, a]));

    // Keep already-linked action nodes in step with the (re)generated actions.
    const linked = new Set<string>();
    let orphaned = 0;
    for (const kid of actionKids) {
      const d = asAction(kid);
      const a = d.strategyActionId ? byId.get(d.strategyActionId) : undefined;
      if (!a) {
        if (d.strategyActionId) orphaned++;
        continue;
      }
      linked.add(a.id);
      if (
        d.label !== a.label ||
        d.color !== a.color ||
        d.kind !== a.kind ||
        (d.sizePct ?? null) !== (a.sizePct ?? null) ||
        (d.sizeUnit ?? null) !== (a.sizeUnit ?? null)
      ) {
        persistData(kid.id, { ...d, kind: a.kind, sizePct: a.sizePct ?? null, sizeUnit: a.sizeUnit ?? null, label: a.label, color: a.color });
      }
    }

    // One new action node per unlinked action that is actually played, in
    // header order (a 0% sizing needs no node). Sequential so the server
    // assigns increasing positions.
    const freqs = globalFrequencies(parsed.weights, parsed.actions.length, deadCardsFor(node.id));
    let created = 0;
    let unused = 0;
    for (const [i, a] of parsed.actions.entries()) {
      if (linked.has(a.id)) continue;
      if (!freqs || freqs[i] <= 0) {
        unused++;
        continue;
      }
      const data: NodeData = {
        strategyActionId: a.id,
        kind: a.kind,
        sizePct: a.sizePct ?? null,
        sizeUnit: a.sizeUnit ?? null,
        label: a.label,
        color: a.color,
      };
      const r = await createNode({ spotId, parentId: node.id, type: "action", data });
      if (!r.ok) return { ok: false, error: r.error };
      const now = new Date().toISOString();
      const child: PokerNode = {
        id: r.id,
        spot_id: spotId,
        parent_id: node.id,
        type: "action",
        position: kids.length + created,
        data,
        created_at: now,
        updated_at: now,
      };
      setNodesById((prev) => ({ ...prev, [child.id]: child }));
      created++;
    }
    if (created > 0 || kids.length > 0) {
      setWithChildren((prev) => new Set(prev).add(node.id));
      setExpanded((prev) => new Set(prev).add(node.id));
    }

    const parts = [
      `${parsed.rows} row${parsed.rows === 1 ? "" : "s"}`,
      `${parsed.actions.length} actions`,
      `${created} action node${created === 1 ? "" : "s"} created`,
    ];
    if (unused > 0) parts.push(`${unused} at 0% skipped`);
    if (orphaned > 0) parts.push(`${orphaned} existing action node${orphaned === 1 ? "" : "s"} no longer match an action`);
    return { ok: true, message: `Imported ${parts.join(" · ")}`, warnings: parsed.warnings };
  }

  function handleSelect(node: PokerNode) {
    setSelectedId(node.id);
  }

  const deadCardsFor = useCallback((nodeId: string) => deadCardsIn(nodesById, nodeId), [nodesById]);
  const allNodes = useMemo(() => Object.values(nodesById), [nodesById]);

  /* ------------------------------------------------------------------ pan/zoom */

  const [view, setView] = useState({ tx: 0, ty: 0, scale: 1 });
  const panning = useRef<{ x: number; y: number; startX: number; startY: number } | null>(null);
  const viewportRef = useRef<HTMLDivElement>(null);

  function closeDrawers() {
    setSelectedId(null);
  }

  // Pan/deselect live on the viewport, not the transformed layer: once the
  // layer is panned or zoomed out its box no longer covers the screen, so
  // clicks on the uncovered area never reached it and the drawer stayed open.
  // Node cards stop propagation, so anything arriving here is empty canvas.
  function onViewportPointerDown(e: React.PointerEvent) {
    if (e.button !== 0) return;
    // While the canvas is dragged, nothing on the page (the inspector included)
    // gets text-selected.
    document.body.classList.add("no-select");
    panning.current = {
      x: e.clientX - view.tx,
      y: e.clientY - view.ty,
      startX: e.clientX,
      startY: e.clientY,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  function onViewportPointerMove(e: React.PointerEvent) {
    const p = panning.current;
    if (!p) return;
    setView((v) => ({ ...v, tx: e.clientX - p.x, ty: e.clientY - p.y }));
  }
  function onViewportPointerUp(e: React.PointerEvent) {
    const p = panning.current;
    panning.current = null;
    document.body.classList.remove("no-select");
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    // A click (not a drag) on empty canvas closes the drawer.
    if (p && Math.hypot(e.clientX - p.startX, e.clientY - p.startY) < 4) closeDrawers();
  }

  // A drag cut short by leaving the canvas must not keep the page unselectable.
  useEffect(() => () => document.body.classList.remove("no-select"), []);

  // Escape closes the drawer (the grid editor handles its own Escape).
  useEffect(() => {
    if (strategy) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT")) return;
      closeDrawers();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [strategy]);
  function onWheel(e: React.WheelEvent) {
    const rect = viewportRef.current?.getBoundingClientRect();
    if (!rect) return;
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    setView((v) => {
      const scale = Math.min(2, Math.max(0.3, v.scale * factor));
      const k = scale / v.scale;
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      return { scale, tx: cx - (cx - v.tx) * k, ty: cy - (cy - v.ty) * k };
    });
  }

  // Pan the canvas so a revealed node sits in the upper middle of the screen.
  useEffect(() => {
    if (!centerOn || mode !== "edit") return;
    const pos = layout.positions.get(centerOn);
    const rect = viewportRef.current?.getBoundingClientRect();
    if (!pos || !rect) return;
    // The inspector drawer (26rem) covers the right of wide screens.
    const visibleWidth = selectedId && rect.width > 800 ? rect.width - 416 : rect.width;
    setView((v) => ({
      scale: v.scale,
      tx: visibleWidth / 2 - (pos.x + pos.w / 2) * v.scale,
      ty: rect.height / 3 - pos.y * v.scale,
    }));
    setCenterOn(null);
  }, [centerOn, layout, mode, selectedId]);

  const selected = selectedId && selectedId !== ROOT_ID ? nodesById[selectedId] : null;
  const selectedParent = selected?.parent_id ? nodesById[selected.parent_id] ?? null : null;

  const modeToggle = (
    <Segmented
      size="sm"
      value={mode}
      onChange={switchMode}
      options={[
        { id: "edit", label: "Edit" },
        { id: "revision", label: "Study" },
      ]}
    />
  );

  if (mode === "revision") {
    return (
      <div className="relative h-full w-full overflow-hidden bg-background">
        {error && (
          <div className="absolute left-1/2 top-2 z-30 -translate-x-1/2 rounded border border-red-500/40 bg-red-500/10 px-3 py-1 text-xs text-red-500">
            {error}
            <button className="ml-2 underline" onClick={() => setError(null)}>
              dismiss
            </button>
          </div>
        )}
        <SpotStudy
          setup={setup}
          nodes={allNodes}
          loading={!allLoaded}
          nodeStates={nodeStates}
          rootState={rootState}
          weights={strategyWeights}
          requestWeights={requestWeights}
          deadCards={deadCardsFor}
          focusId={studyFocus}
          onFocus={setStudyFocus}
          toolbar={modeToggle}
        />
      </div>
    );
  }

  return (
    <div className="relative h-full w-full overflow-hidden bg-background">
      {error && (
        <div className="absolute left-1/2 top-2 z-30 -translate-x-1/2 rounded border border-red-500/40 bg-red-500/10 px-3 py-1 text-xs text-red-500">
          {error}
          <button className="ml-2 underline" onClick={() => setError(null)}>
            dismiss
          </button>
        </div>
      )}

      {/* Mode toggle */}
      <div className="absolute right-2 top-2 z-20">{modeToggle}</div>

      {/* Canvas viewport */}
      <div
        ref={viewportRef}
        className="h-full w-full touch-none select-none"
        onWheel={onWheel}
        onPointerDown={onViewportPointerDown}
        onPointerMove={onViewportPointerMove}
        onPointerUp={onViewportPointerUp}
        onPointerCancel={() => {
          panning.current = null;
          document.body.classList.remove("no-select");
        }}
      >
        <div
          className="relative h-full w-full"
          style={{
            transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})`,
            transformOrigin: "0 0",
          }}
        >
          <svg
            width={layout.width}
            height={layout.height}
            className="pointer-events-none absolute left-0 top-0 overflow-visible"
          >
            {layout.edges.map(({ from, to }) => {
              const a = layout.positions.get(from);
              const b = layout.positions.get(to);
              if (!a || !b) return null;
              const x1 = a.x + a.w / 2;
              const y1 = a.y + a.h;
              const x2 = b.x + b.w / 2;
              const y2 = b.y;
              const mid = (y1 + y2) / 2;
              const toMini = minis.has(to);
              return (
                <path
                  key={`${from}-${to}`}
                  d={`M ${x1} ${y1} C ${x1} ${mid}, ${x2} ${mid}, ${x2} ${y2}`}
                  className="stroke-line"
                  fill="none"
                  strokeWidth={toMini ? 1 : 1.5}
                  strokeDasharray={toMini ? "3 3" : undefined}
                />
              );
            })}
          </svg>

          {layout.positions.get(ROOT_ID) && (
            <MeasuredNode
              key={ROOT_ID}
              nodeId={ROOT_ID}
              x={layout.positions.get(ROOT_ID)!.x}
              y={layout.positions.get(ROOT_ID)!.y}
              observer={getObserver}
            >
              <RootCard
                setup={setup}
                selected={selectedId === ROOT_ID}
                onSelect={() => setSelectedId(ROOT_ID)}
              />
            </MeasuredNode>
          )}

          {visible.map((node) => {
            const pos = layout.positions.get(node.id);
            if (!pos) return null;
            return (
              <MeasuredNode
                key={node.id}
                nodeId={node.id}
                x={pos.x}
                y={pos.y}
                observer={getObserver}
              >
                {minis.has(node.id) ? (
                  <MiniNodeCard
                    node={node}
                    onClick={() => node.parent_id && void expand(node.parent_id)}
                  />
                ) : (
                <NodeCard
                  node={node}
                  mode={mode}
                  selected={node.id === selectedId}
                  hasChildren={nodeHasChildren(node.id)}
                  expanded={expanded.has(node.id)}
                  weights={node.type === "strategy" ? strategyWeights[node.id] : undefined}
                  dead={node.type === "strategy" ? deadCardsFor(node.id) : undefined}
                  frequency={actionFrequency(node)}
                  trainerCount={trainerCounts[node.id] ?? 0}
                  ns={setupReady ? (nodeStates.get(node.id) ?? null) : null}
                  developed={
                    node.type === "strategy" && (loaded.has(node.id) || !withChildren.has(node.id))
                      ? developedOf(node)
                      : undefined
                  }
                  onDevelop={(actionId) => void addChild(node, "action", actionId)}
                  onSelect={() => handleSelect(node)}
                  onToggle={() => toggle(node.id)}
                />
                )}
              </MeasuredNode>
            );
          })}
        </div>
      </div>

      {visible.length === 0 && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <p className="mt-40 text-sm text-muted">
            {setupReady
              ? "Select the start card to add the first node."
              : "Select the start card: set who plays and where the tree starts."}
          </p>
        </div>
      )}

      {/* Root inspector (edit mode) */}
      {mode === "edit" && selectedId === ROOT_ID && (
        <RootInspector
          setup={setup}
          childTypes={childTypesOf(null)}
          childLabel={childLabel(null)}
          onChange={saveSetup}
          onAddChild={(type) => void addChild(null, type)}
          onClose={() => setSelectedId(null)}
        />
      )}

      {/* Inspector (edit mode) */}
      {mode === "edit" && selected && (
        <NodeInspector
          key={selected.id}
          node={selected}
          parent={selectedParent}
          dead={deadCardsFor(selected.id)}
          ns={setupReady ? (nodeStates.get(selected.id) ?? null) : null}
          before={
            setupReady
              ? selectedParent
                ? (nodeStates.get(selectedParent.id)?.state ?? null)
                : rootState
              : null
          }
          setup={setup}
          childTypes={childTypesOf(selected)}
          childLabel={childLabel(selected)}
          onPatch={(data) => persistData(selected.id, data)}
          onAddChild={(type) => void addChild(selected, type)}
          onDelete={() => removeNode(selected.id)}
          onOpenStrategy={() => void openStrategy(selected)}
          onImportCsv={(text) => importStrategyCsv(selected, text)}
          onClose={() => setSelectedId(null)}
        />
      )}

      {/* Strategy grid editor (edit mode) */}
      {mode === "edit" && strategy && selected && strategy.nodeId === selected.id && (
        <StrategyEditor
          key={strategy.nodeId}
          title={`${selected ? NODE_LABELS[selected.type] : "Strategy"} — grid`}
          initialActions={asStrategy(nodesById[strategy.nodeId]).actions}
          initialWeights={strategy.weights}
          dead={deadCardsFor(strategy.nodeId)}
          linkedActionIds={linkedActionIds(strategy.nodeId)}
          onActionsChange={(actions) => {
            persistData(strategy.nodeId, {
              ...asStrategy(nodesById[strategy.nodeId]),
              actions,
            });
            syncLinkedChildren(strategy.nodeId, actions);
          }}
          onWeightsChange={saveStrategyWeights}
          onClose={() => setStrategy(null)}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------ measuring */

/**
 * A positioned node wrapper that reports its rendered size to the shared
 * ResizeObserver, so the layout re-flows whenever a card grows or shrinks.
 */
function MeasuredNode({
  nodeId,
  x,
  y,
  observer,
  children,
}: {
  nodeId: string;
  x: number;
  y: number;
  observer: () => ResizeObserver;
  children: React.ReactNode;
}) {
  const ref = useCallback(
    (el: HTMLDivElement | null) => {
      if (!el) return;
      const ro = observer();
      ro.observe(el);
      return () => ro.unobserve(el);
    },
    [observer],
  );
  return (
    <div
      ref={ref}
      data-node-id={nodeId}
      className="absolute"
      style={{ left: x, top: y }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {children}
    </div>
  );
}

/** Board cards dealt above a node (its flop / turn / river ancestors). */
function deadCardsIn(nodesById: Record<string, PokerNode>, nodeId: string): Set<string> {
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

/* -------------------------------------------------------------- defaults */

function normalizeWeights(raw: unknown): StrategyWeights {
  const w = (raw ?? {}) as Partial<StrategyWeights>;
  return { hands: w.hands ?? {}, combos: w.combos ?? {} };
}

function defaultData(
  type: NodeType,
  parent: PokerNode | null,
  before: HandState | null,
  optionId: string | undefined,
): NodeData {
  switch (type) {
    case "flop":
      return { cards: [] };
    case "turn":
    case "river":
      return { card: null };
    case "strategy": {
      // The options a player usually has here; a CSV import replaces them.
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
          return {
            strategyActionId: a.id,
            kind: a.kind,
            sizePct: a.sizePct ?? null,
            sizeUnit: a.sizeUnit ?? null,
            label: a.label,
            color: a.color,
          };
        }
      }
      return { kind: "check", label: "Check", color: colorForKind("check") };
    }
    default:
      return {};
  }
}
