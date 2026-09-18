"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { createClient } from "@/lib/supabase/client";
import { colorForKind, recolorActions } from "@/lib/solver/colors";
import { layoutTree, NODE_H, NODE_W } from "@/lib/solver/layout";
import {
  createNode,
  deleteNode as deleteNodeAction,
  saveStrategy,
  updateNode,
} from "@/server/actions/solver";
import { CsvImportError, parseStrategyCsv } from "@/lib/solver/csvImport";
import {
  asAction,
  asFlop,
  asStrategy,
  asStreet,
  emptyWeights,
  NODE_LABELS,
  type NodeData,
  type NodeType,
  type PokerNode,
  type StrategyWeights,
} from "@/lib/solver/types";
import type { ImportResult } from "@/components/poker/NodeInspector";
import { NodeCard, type CanvasMode } from "@/components/poker/NodeCard";
import { NodeInspector } from "@/components/poker/NodeInspector";
import { StrategyEditor } from "@/components/poker/StrategyEditor";
import { StrategyReview } from "@/components/poker/StrategyReview";
import { Segmented } from "@/components/poker/ui";

const NODE_SELECT = "id, spot_id, parent_id, type, position, data, created_at, updated_at";

/** Child types offered under each node type (permissive but guided). */
const CHILD_SUGGESTIONS: Record<NodeType, NodeType[]> = {
  text: ["flop", "strategy", "action", "turn", "river", "text"],
  flop: ["strategy", "text"],
  turn: ["strategy", "text"],
  river: ["strategy", "text"],
  strategy: ["action", "text"],
  action: ["turn", "river", "strategy", "text"],
};

export function SpotCanvas({
  spotId,
  initialNodes,
}: {
  spotId: string;
  initialNodes: PokerNode[];
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
  // Cache of strategy grids, loaded on demand for revision-mode previews.
  const [strategyWeights, setStrategyWeights] = useState<Record<string, StrategyWeights>>({});
  const [reviewNodeId, setReviewNodeId] = useState<string | null>(null);

  function switchMode(next: CanvasMode) {
    setMode(next);
    setSelectedId(null);
    setReviewNodeId(null);
    setStrategy(null);
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

  const visible = useMemo(() => {
    const out: PokerNode[] = [];
    const walk = (node: PokerNode) => {
      out.push(node);
      if (expanded.has(node.id)) {
        for (const child of childrenOf.get(node.id) ?? []) walk(child);
      }
    };
    for (const root of childrenOf.get(null) ?? []) walk(root);
    return out;
  }, [childrenOf, expanded]);

  const layout = useMemo(() => layoutTree(visible), [visible]);

  // In revision mode, load the grid for every visible strategy node so the
  // bubbles can preview it. Empties are cached too, so nothing is refetched.
  useEffect(() => {
    if (mode !== "revision") return;
    const need = visible
      .filter((n) => n.type === "strategy" && strategyWeights[n.id] === undefined)
      .map((n) => n.id);
    if (need.length === 0) return;
    (async () => {
      const { data, error } = await supabase
        .from("poker_strategies")
        .select("node_id, weights")
        .in("node_id", need);
      if (error) {
        setError(error.message);
        return;
      }
      setStrategyWeights((prev) => {
        const next = { ...prev };
        for (const id of need) next[id] = emptyWeights();
        for (const row of data ?? []) next[row.node_id as string] = normalizeWeights(row.weights);
        return next;
      });
    })();
  }, [mode, visible, strategyWeights, supabase]);

  function nodeHasChildren(id: string): boolean {
    return withChildren.has(id) || (childrenOf.get(id)?.length ?? 0) > 0;
  }

  /* --------------------------------------------------------------- mutations */

  function persistData(id: string, data: NodeData) {
    setNodesById((prev) => ({ ...prev, [id]: { ...prev[id], data } }));
    startTransition(async () => {
      const r = await updateNode({ id, data });
      if (!r.ok) setError(r.error);
    });
  }

  async function addChild(parent: PokerNode | null, type: NodeType) {
    const data = defaultData(type, parent);
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
  }

  /* --------------------------------------------------------------- strategy */

  async function openStrategy(node: PokerNode) {
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
      if (d.label !== a.label || d.color !== a.color || d.kind !== a.kind || (d.sizePct ?? null) !== (a.sizePct ?? null)) {
        persistData(kid.id, { ...d, kind: a.kind, sizePct: a.sizePct ?? null, label: a.label, color: a.color });
      }
    }

    // One new action node per unlinked action, in header order. Sequential so
    // the server assigns increasing positions.
    let created = 0;
    for (const a of parsed.actions) {
      if (linked.has(a.id)) continue;
      const data: NodeData = {
        strategyActionId: a.id,
        kind: a.kind,
        sizePct: a.sizePct ?? null,
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
    if (orphaned > 0) parts.push(`${orphaned} existing action node${orphaned === 1 ? "" : "s"} no longer match an action`);
    return { ok: true, message: `Imported ${parts.join(" · ")}`, warnings: parsed.warnings };
  }

  function handleSelect(node: PokerNode) {
    if (mode === "revision" && node.type === "strategy") {
      setReviewNodeId(node.id);
    } else {
      setSelectedId(node.id);
    }
  }

  function deadCardsFor(nodeId: string): Set<string> {
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

  /* ------------------------------------------------------------------ pan/zoom */

  const [view, setView] = useState({ tx: 0, ty: 0, scale: 1 });
  const panning = useRef<{ x: number; y: number; startX: number; startY: number } | null>(null);
  const viewportRef = useRef<HTMLDivElement>(null);

  function closeDrawers() {
    setSelectedId(null);
    setReviewNodeId(null);
  }

  // Pan/deselect live on the viewport, not the transformed layer: once the
  // layer is panned or zoomed out its box no longer covers the screen, so
  // clicks on the uncovered area never reached it and the drawer stayed open.
  // Node cards stop propagation, so anything arriving here is empty canvas.
  function onViewportPointerDown(e: React.PointerEvent) {
    if (e.button !== 0) return;
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
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    // A click (not a drag) on empty canvas closes the drawer.
    if (p && Math.hypot(e.clientX - p.startX, e.clientY - p.startY) < 4) closeDrawers();
  }

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

  const selected = selectedId ? nodesById[selectedId] : null;
  const selectedParent = selected?.parent_id ? nodesById[selected.parent_id] ?? null : null;
  const reviewNode =
    reviewNodeId && nodesById[reviewNodeId]?.type === "strategy"
      ? nodesById[reviewNodeId]
      : null;

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

      {/* Root toolbar (adding nodes only makes sense while editing) */}
      {mode === "edit" && (
        <div className="absolute left-2 top-2 z-20 flex flex-wrap gap-1">
          {(["flop", "strategy", "text"] as NodeType[]).map((type) => (
            <button
              key={type}
              type="button"
              onClick={() => void addChild(null, type)}
              className="rounded border border-line bg-surface px-2 py-1 text-xs text-muted shadow-sm hover:border-accent"
            >
              ＋ {NODE_LABELS[type]}
            </button>
          ))}
        </div>
      )}

      {/* Mode toggle */}
      <div className="absolute right-2 top-2 z-20">
        <Segmented
          size="sm"
          value={mode}
          onChange={switchMode}
          options={[
            { id: "edit", label: "Edit" },
            { id: "revision", label: "Revision" },
          ]}
        />
      </div>

      {/* Canvas viewport */}
      <div
        ref={viewportRef}
        className="h-full w-full touch-none"
        onWheel={onWheel}
        onPointerDown={onViewportPointerDown}
        onPointerMove={onViewportPointerMove}
        onPointerUp={onViewportPointerUp}
        onPointerCancel={() => (panning.current = null)}
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
              const x1 = a.x + NODE_W / 2;
              const y1 = a.y + NODE_H;
              const x2 = b.x + NODE_W / 2;
              const y2 = b.y;
              const mid = (y1 + y2) / 2;
              return (
                <path
                  key={`${from}-${to}`}
                  d={`M ${x1} ${y1} C ${x1} ${mid}, ${x2} ${mid}, ${x2} ${y2}`}
                  className="stroke-line"
                  fill="none"
                  strokeWidth={1.5}
                />
              );
            })}
          </svg>

          {visible.map((node) => {
            const pos = layout.positions.get(node.id);
            if (!pos) return null;
            return (
              <div
                key={node.id}
                className="absolute"
                style={{ left: pos.x, top: pos.y }}
                onPointerDown={(e) => e.stopPropagation()}
              >
                <NodeCard
                  node={node}
                  mode={mode}
                  selected={node.id === selectedId || node.id === reviewNodeId}
                  hasChildren={nodeHasChildren(node.id)}
                  expanded={expanded.has(node.id)}
                  weights={node.type === "strategy" ? strategyWeights[node.id] : undefined}
                  dead={node.type === "strategy" ? deadCardsFor(node.id) : undefined}
                  onSelect={() => handleSelect(node)}
                  onToggle={() => toggle(node.id)}
                />
              </div>
            );
          })}
        </div>
      </div>

      {visible.length === 0 && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <p className="text-sm text-muted">
            Empty spot — add a root node from the top-left toolbar.
          </p>
        </div>
      )}

      {/* Inspector (edit mode) */}
      {mode === "edit" && selected && (
        <NodeInspector
          key={selected.id}
          node={selected}
          parent={selectedParent}
          dead={deadCardsFor(selected.id)}
          childSuggestions={CHILD_SUGGESTIONS[selected.type]}
          onPatch={(data) => persistData(selected.id, data)}
          onAddChild={(type) => void addChild(selected, type)}
          onDelete={() => removeNode(selected.id)}
          onOpenStrategy={() => void openStrategy(selected)}
          onImportCsv={(text) => importStrategyCsv(selected, text)}
          onClose={() => setSelectedId(null)}
        />
      )}

      {/* Strategy review drawer (revision mode) */}
      {mode === "revision" && reviewNode && (
        <StrategyReview
          key={reviewNode.id}
          title={`${asStrategy(reviewNode).label || "Strategy"}`}
          actions={asStrategy(reviewNode).actions}
          weights={strategyWeights[reviewNode.id] ?? emptyWeights()}
          dead={deadCardsFor(reviewNode.id)}
          onClose={() => setReviewNodeId(null)}
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
          onActionsChange={(actions) =>
            persistData(strategy.nodeId, {
              ...asStrategy(nodesById[strategy.nodeId]),
              actions,
            })
          }
          onWeightsChange={saveStrategyWeights}
          onClose={() => setStrategy(null)}
        />
      )}
    </div>
  );
}

/* -------------------------------------------------------------- defaults */

function normalizeWeights(raw: unknown): StrategyWeights {
  const w = (raw ?? {}) as Partial<StrategyWeights>;
  return { hands: w.hands ?? {}, combos: w.combos ?? {} };
}

function defaultData(type: NodeType, parent: PokerNode | null): NodeData {
  switch (type) {
    case "text":
      return { title: "Note", body: "" };
    case "flop":
      return { cards: [] };
    case "turn":
    case "river":
      return { card: null };
    case "strategy":
      return {
        position: null,
        actions: recolorActions([
          { id: crypto.randomUUID(), kind: "check", label: "Check", color: "" },
          { id: crypto.randomUUID(), kind: "bet", sizePct: 75, label: "Bet 75%", color: "" },
        ]),
      };
    case "action": {
      if (parent && parent.type === "strategy") {
        const first = asStrategy(parent).actions[0];
        if (first) {
          return {
            strategyActionId: first.id,
            kind: first.kind,
            sizePct: first.sizePct ?? null,
            label: first.label,
            color: first.color,
          };
        }
      }
      return { kind: "check", label: "Check", color: colorForKind("check") };
    }
    default:
      return {};
  }
}
