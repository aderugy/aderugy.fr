"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { globalFrequencies } from "@/lib/solver/strategy";
import {
  effectiveStack,
  fmtBb,
  toCall,
  totalPot,
  type HandState,
  type NodeState,
} from "@/lib/solver/gameState";
import {
  descend,
  parentStop,
  pathTo,
  resolveStop,
  siblings,
  siblingStop,
  stopKind,
  studyTree,
  targets,
  type StudyTarget,
  type StudyTree,
} from "@/lib/solver/studyNav";
import {
  asAction,
  asFlop,
  asMeta,
  asStrategy,
  asStreet,
  NODE_LABELS,
  STREET_LABELS,
  type PokerNode,
  type SpotSetup,
  type StrategyAction,
  type StrategyWeights,
} from "@/lib/solver/types";
import { ROOT_ID, setupLine } from "@/components/poker/SpotRoot";
import { formatFrequency, terminalText } from "@/components/poker/NodeCard";
import { StrategyDetail } from "@/components/poker/StrategyReview";
import { StrategyGrid } from "@/components/poker/StrategyGrid";
import { BoardCards } from "@/components/poker/trainer/Cards";
import { Markdown } from "@/components/poker/Markdown";

/**
 * Where the last move came from, for the enter animation. The map reads left
 * to right — where you came from, where you are, where you can go — with
 * alternatives stacked, so going deeper slides in from the right, going back
 * from the left, and a sibling from below or above.
 */
type Motion = "none" | "down" | "up" | "next" | "prev" | "jump";

/**
 * Study mode: the tree one node at a time. The focused node is big in the
 * middle (its grid, its notes); on its left the node above and the
 * alternatives to where you are; on its right every branch below with a
 * preview of what happens next (who acts and how often each action is
 * taken). A breadcrumb spells the line from the start. Buttons, the keyboard
 * and a click on any preview move the focus.
 */
export function SpotStudy({
  setup,
  nodes,
  loading,
  nodeStates,
  rootState,
  weights,
  requestWeights,
  deadCards,
  focusId,
  onFocus,
  toolbar,
}: {
  setup: SpotSetup;
  /** Every node of the spot (study mode loads the whole tree). */
  nodes: PokerNode[];
  loading: boolean;
  nodeStates: Map<string, NodeState>;
  rootState: HandState | null;
  /** Strategy grids by node id; undefined = not loaded yet. */
  weights: Record<string, StrategyWeights>;
  requestWeights: (ids: string[]) => void;
  deadCards: (id: string) => Set<string>;
  focusId: string | null;
  onFocus: (id: string) => void;
  /** Rendered at the end of the navigation bar (the mode switch). */
  toolbar?: ReactNode;
}) {
  const tree = useMemo(() => studyTree(nodes, ROOT_ID), [nodes]);
  const focus = resolveStop(tree, focusId);
  const kind = stopKind(tree, focus);
  const nexts = useMemo(() => targets(tree, focus), [tree, focus]);
  const sib = useMemo(() => siblings(tree, focus), [tree, focus]);
  const incoming = sib.index >= 0 ? sib.targets[sib.index] : null;
  const up = sib.parent;

  const [motion, setMotion] = useState<Motion>("none");
  const [isolate, setIsolate] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Per stop, the branch last visited below it: "→" goes back down there.
  const [trail, setTrail] = useState<Record<string, string>>({});

  const go = useCallback(
    (id: string | null, how: Motion) => {
      if (!id || id === focus) return;
      const marks: Record<string, string> = {};
      if (how === "down") marks[focus] = id;
      if (how === "up" || how === "jump") {
        // Remember, on every stop above, which branch leads back here.
        let child = focus;
        let p = parentStop(tree, child);
        while (p) {
          marks[p] = child;
          if (p === id) break;
          child = p;
          p = parentStop(tree, child);
        }
      }
      setTrail((prev) => ({ ...prev, ...marks }));
      setMotion(how);
      setIsolate(null);
      onFocus(id);
      scrollRef.current?.scrollTo({ top: 0 });
    },
    [focus, onFocus, tree],
  );

  const firstNext =
    trail[focus] && nexts.some((x) => x.stop === trail[focus])
      ? trail[focus]
      : (nexts.find((x) => x.stop)?.stop ?? null);

  /* ------------------------------------------------------------ strategies */

  // Grids shown: the focus, the node above, and every decision previewed on
  // the right (two levels through runouts).
  const wanted = useMemo(() => {
    const ids = new Set<string>();
    const add = (id: string | null) => {
      if (id && tree.node(id)?.type === "strategy") ids.add(id);
    };
    add(focus);
    add(up);
    for (const x of nexts) {
      add(x.stop);
      if (x.stop && stopKind(tree, x.stop) === "branches") {
        for (const y of targets(tree, x.stop)) add(y.stop);
      }
    }
    return [...ids];
  }, [tree, focus, up, nexts]);

  useEffect(() => {
    if (wanted.length > 0) requestWeights(wanted);
  }, [wanted, requestWeights]);

  const freqs = useMemo(() => {
    const out = new Map<string, number[] | null>();
    for (const id of wanted) {
      const w = weights[id];
      const n = tree.node(id);
      if (!w || !n) continue;
      out.set(id, globalFrequencies(w, asStrategy(n).actions.length, deadCards(id)));
    }
    return out;
  }, [wanted, weights, tree, deadCards]);

  /* ------------------------------------------------------------- keyboard */

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable)) return;
      let handled = true;
      switch (e.key) {
        case "ArrowLeft":
        case "Backspace":
          go(up, "up");
          break;
        case "ArrowRight":
        case "Enter":
          go(firstNext, "down");
          break;
        case "ArrowDown":
          go(siblingStop(tree, focus, 1), "next");
          break;
        case "ArrowUp":
          go(siblingStop(tree, focus, -1), "prev");
          break;
        default:
          if (/^[1-9]$/.test(e.key)) go(nexts[Number(e.key) - 1]?.stop ?? null, "down");
          else handled = false;
      }
      if (handled) e.preventDefault();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go, up, firstNext, tree, focus, nexts]);

  /* ---------------------------------------------------------------- views */

  const ns = focus === ROOT_ID ? null : (nodeStates.get(focus) ?? null);
  const state = focus === ROOT_ID ? rootState : (ns?.state ?? null);
  const ctx: Ctx = { tree, nodeStates, weights, freqs, deadCards };
  const prevSib = siblingStop(tree, focus, -1);
  const nextSib = siblingStop(tree, focus, 1);

  return (
    <div className="flex h-full flex-col">
      {/* Breadcrumb + navigation */}
      <div className="shrink-0 border-b border-line bg-surface/60 px-3 py-2 sm:px-4">
        <div className="flex flex-wrap items-center gap-2">
          <Breadcrumb ctx={ctx} setup={setup} focus={focus} onGo={(id) => go(id, "up")} />
          <div className="ml-auto flex items-center gap-1.5">
            <NavButton label="Back to the node above (←)" disabled={!up} onClick={() => go(up, "up")}>
              <Chevron dir="left" />
            </NavButton>
            <NavButton label="Previous alternative (↑)" disabled={!prevSib} onClick={() => go(prevSib, "prev")}>
              <Chevron dir="up" />
            </NavButton>
            <NavButton label="Next alternative (↓)" disabled={!nextSib} onClick={() => go(nextSib, "next")}>
              <Chevron dir="down" />
            </NavButton>
            <NavButton label="Go down the tree (→)" disabled={!firstNext} onClick={() => go(firstNext, "down")}>
              <Chevron dir="right" />
            </NavButton>
            {toolbar && <span className="ml-1">{toolbar}</span>}
          </div>
        </div>
        {state && <StateSummary state={state} ns={ns} kind={kind} />}
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        {loading ? (
          <p className="p-6 text-sm text-muted">Loading the tree…</p>
        ) : (
          <div
            key={focus}
            className={`study-enter study-enter-${motion} mx-auto grid max-w-[1560px] grid-cols-1 gap-5 p-3 sm:p-5 lg:grid-cols-[minmax(180px,230px)_minmax(0,1fr)_minmax(300px,390px)] lg:gap-6`}
          >
            {/* ← Where you came from and the alternatives to here */}
            <aside className="study-col-from hidden lg:block">
              {up ? (
                <FromColumn ctx={ctx} setup={setup} up={up} sib={sib} onGo={go} />
              ) : (
                <p className="text-xs text-muted">Start of the tree.</p>
              )}
            </aside>

            {/* Mobile: the node above and the alternatives as chips */}
            {up && (
              <div className="-mb-2 flex flex-col gap-2 lg:hidden">
                <button
                  type="button"
                  onClick={() => go(up, "up")}
                  className="self-start text-xs text-muted hover:text-foreground"
                >
                  ← {stopTitle(ctx, setup, up)}
                </button>
                {sib.targets.length > 1 && (
                  <div className="-mx-3 flex gap-1.5 overflow-x-auto px-3 pb-1">
                    {sib.targets.map((t, i) => (
                      <TargetChip
                        key={t.via?.id ?? t.option?.id ?? i}
                        ctx={ctx}
                        from={up}
                        t={t}
                        current={i === sib.index}
                        reveal
                        onClick={() => go(t.stop, i > sib.index ? "next" : "prev")}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* The focused node */}
            <section className="study-col-here min-w-0">
              <FocusPanel
                ctx={ctx}
                setup={setup}
                focus={focus}
                kind={kind}
                incoming={incoming}
                nexts={nexts}
                isolate={isolate}
                onIsolate={setIsolate}
                onGo={(id) => go(id, "down")}
              />
            </section>

            {/* → What happens below */}
            <aside className="study-col-next min-w-0">
              <NextColumn
                ctx={ctx}
                focus={focus}
                kind={kind}
                nexts={nexts}
                trail={trail[focus] ?? null}
                onIsolate={kind === "decision" ? setIsolate : undefined}
                onGo={(id) => go(id, "down")}
              />
            </aside>
          </div>
        )}
      </div>
    </div>
  );
}

/* ================================================================ context */

type Ctx = {
  tree: StudyTree;
  nodeStates: Map<string, NodeState>;
  weights: Record<string, StrategyWeights>;
  freqs: Map<string, number[] | null>;
  deadCards: (id: string) => Set<string>;
};

function actorOf(ctx: Ctx, id: string): string {
  return ctx.nodeStates.get(id)?.actor ?? "?";
}

/** "BTN decision", "BB check · runouts", "Turn 5♥", "Start". */
function stopTitle(ctx: Ctx, setup: SpotSetup, id: string): string {
  if (id === ROOT_ID) return setup.players ? `${setup.players[0]} vs ${setup.players[1]}` : "Start";
  const n = ctx.tree.node(id);
  if (!n) return "Node";
  switch (n.type) {
    case "strategy": {
      const label = asStrategy(n).label;
      return `${actorOf(ctx, id)} decision${label ? ` · ${label}` : ""}`;
    }
    case "action": {
      const seat = n.parent_id ? actorOf(ctx, n.parent_id) : "";
      return `${seat} ${asAction(n).label}`.trim();
    }
    default:
      return `${NODE_LABELS[n.type]} ${cardsOf(n).join(" ")}`.trim();
  }
}

function cardsOf(n: PokerNode): string[] {
  if (n.type === "flop") return asFlop(n).cards;
  if (n.type === "turn" || n.type === "river") {
    const c = asStreet(n).card;
    return c ? [c] : [];
  }
  return [];
}

/* ============================================================= breadcrumb */

/**
 * The line from the start to the focus, one token per action and per board:
 * `Start · BB Check · BTN Check · [5♥] · BB to act`. An action opens the
 * decision it was taken at, a board the first stop after it.
 */
function Breadcrumb({
  ctx,
  setup,
  focus,
  onGo,
}: {
  ctx: Ctx;
  setup: SpotSetup;
  focus: string;
  onGo: (id: string) => void;
}) {
  const crumbs: { key: string; body: ReactNode; target: string | null; title: string }[] = [];
  for (const id of pathTo(ctx.tree, focus)) {
    const current = id === focus;
    if (id === ROOT_ID) {
      crumbs.push({ key: id, body: "Start", target: current ? null : ROOT_ID, title: stopTitle(ctx, setup, id) });
      continue;
    }
    const n = ctx.tree.node(id);
    if (!n) continue;
    if (n.type === "strategy") {
      if (current) crumbs.push({ key: id, body: `${actorOf(ctx, id)} to act`, target: null, title: stopTitle(ctx, setup, id) });
      continue;
    }
    if (n.type === "action") {
      const at = n.parent_id ?? ROOT_ID;
      crumbs.push({
        key: id,
        body: (
          <span className="inline-flex items-center gap-1">
            <span className="size-2 rounded-full" style={{ backgroundColor: asAction(n).color }} />
            {stopTitle(ctx, setup, id)}
          </span>
        ),
        target: current ? null : at,
        title: current ? "You are here" : `Back to the ${actorOf(ctx, at)} decision`,
      });
      continue;
    }
    const cards = cardsOf(n);
    crumbs.push({
      key: id,
      body: cards.length ? <BoardCards cards={cards} size="xs" /> : NODE_LABELS[n.type],
      target: current ? null : descend(ctx.tree, id).stop === focus ? null : descend(ctx.tree, id).stop,
      title: stopTitle(ctx, setup, id),
    });
  }
  return (
    <nav aria-label="Line" className="flex w-full min-w-0 flex-wrap items-center gap-y-1 text-xs sm:w-auto sm:flex-1">
      {crumbs.map((c, i) => (
        <span key={c.key} className="flex items-center">
          {i > 0 && <span className="px-1 text-muted/60">›</span>}
          {c.target ? (
            <button
              type="button"
              title={c.title}
              onClick={() => onGo(c.target!)}
              className="rounded px-1 py-0.5 text-muted hover:bg-background hover:text-foreground"
            >
              {c.body}
            </button>
          ) : (
            <span title={c.title} className="study-crumb-current rounded bg-accent/10 px-1.5 py-0.5 font-medium text-foreground">
              {c.body}
            </span>
          )}
        </span>
      ))}
    </nav>
  );
}

function StateSummary({ state, ns, kind }: { state: HandState; ns: NodeState | null; kind: string }) {
  if (ns?.error) return <p className="mt-1 text-[11px] text-red-500">⚠ {ns.error}</p>;
  const call = ns?.actor ? toCall(state, ns.actor) : 0;
  return (
    <p className="mt-1 flex flex-wrap items-center gap-x-2 text-[11px] tabular-nums text-muted">
      <span className="font-medium text-foreground">{STREET_LABELS[state.street]}</span>
      {state.board.length > 0 && <BoardCards cards={state.board} size="xs" />}
      <span>Pot {fmtBb(totalPot(state))}</span>
      <span>Eff. {fmtBb(effectiveStack(state))}</span>
      {kind === "decision" && ns?.actor && (
        <span>
          <b className="text-foreground">{ns.actor}</b> to act{call > 0 ? ` · ${fmtBb(call)} to call` : ""}
        </span>
      )}
      {ns?.overridden && <span className="rounded bg-amber-500/15 px-1 text-amber-700 dark:text-amber-400">manual</span>}
    </p>
  );
}

/* ========================================================= left: from */

function FromColumn({
  ctx,
  setup,
  up,
  sib,
  onGo,
}: {
  ctx: Ctx;
  setup: SpotSetup;
  up: string;
  sib: ReturnType<typeof siblings>;
  onGo: (id: string | null, how: Motion) => void;
}) {
  const upNode = ctx.tree.node(up);
  const upFreqs = ctx.freqs.get(up);
  return (
    <div className="sticky top-0">
      <ColumnLabel>From</ColumnLabel>
      <button
        type="button"
        onClick={() => onGo(up, "up")}
        className="w-full rounded-lg border border-line bg-surface p-2.5 text-left shadow-sm transition-colors hover:border-accent"
      >
        <span className="text-[10px] font-semibold uppercase tracking-wide text-muted">
          {up === ROOT_ID ? "Start" : upNode ? NODE_LABELS[upNode.type] : ""}
        </span>
        <span className="mt-0.5 block text-sm font-medium">{stopTitle(ctx, setup, up)}</span>
        {upNode?.type === "strategy" && (
          <div className="mt-2">
            <FreqBar actions={asStrategy(upNode).actions} freqs={upFreqs} loading={ctx.weights[up] === undefined} compact />
          </div>
        )}
      </button>

      {sib.targets.length > 0 && (
        <div className="study-rail study-rail-left mt-3">
          {sib.targets.map((t, i) => (
            <div key={t.via?.id ?? t.option?.id ?? i} className="study-tick">
              <TargetChip
                ctx={ctx}
                from={up}
                t={t}
                current={i === sib.index}
                block
                onClick={() => onGo(t.stop, i > sib.index ? "next" : "prev")}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** One way out of a stop, in a line: the option (with its frequency) or the card. */
function TargetChip({
  ctx,
  from,
  t,
  current,
  block,
  reveal,
  onClick,
}: {
  ctx: Ctx;
  from: string;
  t: StudyTarget;
  current: boolean;
  block?: boolean;
  /** Scroll the current chip into view in a horizontal row. */
  reveal?: boolean;
  onClick: () => void;
}) {
  const freq = t.optionIndex >= 0 ? ctx.freqs.get(from)?.[t.optionIndex] : undefined;
  const cards = t.folded.flatMap(cardsOf);
  return (
    <button
      type="button"
      ref={reveal && current ? (el) => el?.scrollIntoView({ inline: "center", block: "nearest" }) : undefined}
      disabled={!t.stop || current}
      onClick={onClick}
      aria-current={current ? "location" : undefined}
      className={[
        "flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-1 text-left text-xs transition-colors",
        block ? "w-full" : "",
        current
          ? "border-accent bg-accent/10 font-medium text-foreground"
          : t.stop
            ? "border-line bg-surface hover:border-accent"
            : "border-dashed border-line text-muted opacity-60",
      ].join(" ")}
    >
      <TargetLabel ctx={ctx} t={t} />
      {cards.length > 0 && t.option && <BoardCards cards={cards} size="xs" />}
      {freq != null && <span className="ml-auto tabular-nums text-muted">{formatFrequency(freq)}</span>}
      {current && <span className="sr-only">(you are here)</span>}
    </button>
  );
}

function TargetLabel({ ctx, t }: { ctx: Ctx; t: StudyTarget }) {
  if (t.option) {
    return (
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="size-2.5 shrink-0 rounded-sm" style={{ backgroundColor: t.option.color }} />
        <span className="truncate">{t.option.label}</span>
      </span>
    );
  }
  const via = t.via;
  if (!via) return <span>—</span>;
  const cards = cardsOf(via);
  if (cards.length) return <BoardCards cards={cards} size="xs" />;
  if (via.type === "action") {
    const a = asAction(via);
    return (
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="size-2.5 shrink-0 rounded-sm" style={{ backgroundColor: a.color }} />
        <span className="truncate">{a.label}</span>
      </span>
    );
  }
  if (via.type === "strategy") return <span>{actorOf(ctx, via.id)} decision</span>;
  return <span>{NODE_LABELS[via.type]}</span>;
}

/* ======================================================= centre: focus */

function FocusPanel({
  ctx,
  setup,
  focus,
  kind,
  incoming,
  nexts,
  isolate,
  onIsolate,
  onGo,
}: {
  ctx: Ctx;
  setup: SpotSetup;
  focus: string;
  kind: ReturnType<typeof stopKind>;
  incoming: StudyTarget | null;
  nexts: StudyTarget[];
  isolate: number | null;
  onIsolate: (i: number | null) => void;
  onGo: (id: string) => void;
}) {
  const node = ctx.tree.node(focus);
  const meta = focus === ROOT_ID ? { summary: setup.summary ?? "", notes: setup.notes ?? "" } : node ? asMeta(node) : null;
  const ns = ctx.nodeStates.get(focus);

  return (
    <div className="rounded-xl border border-line bg-surface p-3 shadow-sm sm:p-5">
      <ColumnLabel>{focus === ROOT_ID ? "Start" : node ? NODE_LABELS[node.type] : ""}</ColumnLabel>
      <h2 className="text-lg font-semibold leading-tight">{stopTitle(ctx, setup, focus)}</h2>
      {focus === ROOT_ID && <p className="mt-0.5 text-sm tabular-nums text-muted">{setupLine(setup)}</p>}
      {meta?.summary && <p className="mt-1 whitespace-pre-line text-sm text-muted">{meta.summary}</p>}

      <div className="mt-4">
        {kind === "decision" && node && (
          <DecisionBody ctx={ctx} node={node} isolate={isolate} onIsolate={onIsolate} />
        )}
        {kind === "branches" && <BranchesOverview ctx={ctx} nexts={nexts} onGo={onGo} />}
        {kind === "leaf" && (
          <p className="rounded-md bg-foreground/5 px-3 py-2 text-sm font-medium tabular-nums">
            {ns?.state.terminal ? `■ ${terminalText(ns.state.terminal)}` : "Nothing below — this branch isn't developed yet."}
          </p>
        )}
        {kind === "root" && nexts.length === 0 && (
          <p className="text-sm text-muted">This tree is empty. Switch to Edit to build it.</p>
        )}
      </div>

      {meta?.notes.trim() && (
        <div className="mt-5 border-t border-line pt-4">
          <Markdown source={meta.notes} />
        </div>
      )}

      <AlongTheWay ctx={ctx} setup={setup} incoming={incoming} />
    </div>
  );
}

function DecisionBody({
  ctx,
  node,
  isolate,
  onIsolate,
}: {
  ctx: Ctx;
  node: PokerNode;
  isolate: number | null;
  onIsolate: (i: number | null) => void;
}) {
  const actions = asStrategy(node).actions;
  const w = ctx.weights[node.id];
  const f = ctx.freqs.get(node.id);
  if (w === undefined) {
    return <div className="aspect-square w-full max-w-[560px] animate-pulse rounded-lg bg-foreground/5" />;
  }
  if (!f) {
    return (
      <div>
        <p className="mb-2 text-sm text-muted">No strategy imported for this decision. Its options:</p>
        <div className="flex flex-wrap gap-1.5">
          {actions.map((a) => (
            <span key={a.id} className="rounded px-2 py-0.5 text-xs text-white" style={{ backgroundColor: a.color }}>
              {a.label}
            </span>
          ))}
        </div>
      </div>
    );
  }
  return (
    <div className="max-w-[560px]">
      <StrategyDetail
        actions={actions}
        weights={w}
        dead={ctx.deadCards(node.id)}
        frequencies={f}
        isolate={isolate}
        onIsolate={onIsolate}
      />
    </div>
  );
}

/**
 * After an action that closes a round: one row per runout, one column per
 * action of the decision dealt on it — the street at a glance.
 */
function BranchesOverview({
  ctx,
  nexts,
  onGo,
}: {
  ctx: Ctx;
  nexts: StudyTarget[];
  onGo: (id: string) => void;
}) {
  // Columns: every option label met below, in order of appearance.
  const columns: { label: string; color: string }[] = [];
  const rows = nexts.map((t) => {
    const stop = t.stop ? ctx.tree.node(t.stop) : undefined;
    const decision = stop?.type === "strategy" ? stop : undefined;
    const actions = decision ? asStrategy(decision).actions : [];
    for (const a of actions) if (!columns.some((c) => c.label === a.label)) columns.push({ label: a.label, color: a.color });
    return { t, decision, actions, freqs: decision ? ctx.freqs.get(decision.id) : undefined };
  });

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[320px] border-separate border-spacing-y-1 text-sm tabular-nums">
        <thead>
          <tr className="text-left text-[11px] uppercase tracking-wide text-muted">
            <th className="px-2 font-medium">Card</th>
            <th className="px-2 font-medium">Acts</th>
            {columns.map((c) => (
              <th key={c.label} className="px-2 text-right font-medium">
                <span className="inline-flex items-center gap-1">
                  <span className="size-2 rounded-sm" style={{ backgroundColor: c.color }} />
                  {c.label}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(({ t, decision, actions, freqs }, i) => (
            <tr
              key={t.via?.id ?? i}
              onClick={() => t.stop && onGo(t.stop)}
              className={t.stop ? "cursor-pointer" : ""}
            >
              <td className="rounded-l-md border-y border-l border-line bg-background px-2 py-1.5 hover:border-accent">
                <TargetLabel ctx={ctx} t={t} />
              </td>
              <td className="border-y border-line bg-background px-2 py-1.5 text-xs text-muted">
                {decision ? actorOf(ctx, decision.id) : t.stop ? stopShort(ctx, t.stop) : "—"}
              </td>
              {columns.map((c, ci) => {
                const idx = actions.findIndex((a) => a.label === c.label);
                const v = idx >= 0 && freqs ? freqs[idx] : null;
                const last = ci === columns.length - 1;
                return (
                  <td
                    key={c.label}
                    className={`border-y border-line px-2 py-1.5 text-right ${last ? "rounded-r-md border-r" : ""}`}
                    style={{ backgroundColor: v != null ? tint(c.color, v) : undefined }}
                  >
                    {v != null ? formatFrequency(v) : decision && ctx.weights[decision.id] === undefined ? "…" : ""}
                  </td>
                );
              })}
              {columns.length === 0 && <td className="rounded-r-md border-y border-r border-line px-2" />}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Notes of the nodes walked through to get here (the action taken, the card dealt). */
function AlongTheWay({ ctx, setup, incoming }: { ctx: Ctx; setup: SpotSetup; incoming: StudyTarget | null }) {
  const withNotes = (incoming?.folded ?? []).filter((n) => {
    const m = asMeta(n);
    return m.summary || m.notes.trim();
  });
  if (withNotes.length === 0) return null;
  return (
    <div className="mt-5 space-y-3 border-t border-line pt-4">
      <ColumnLabel>On the way here</ColumnLabel>
      {withNotes.map((n) => {
        const m = asMeta(n);
        return (
          <div key={n.id} className="rounded-md bg-background p-3">
            <p className="text-xs font-semibold">{stopTitle(ctx, setup, n.id)}</p>
            {m.summary && <p className="mt-0.5 text-sm text-muted">{m.summary}</p>}
            {m.notes.trim() && (
              <div className="mt-2">
                <Markdown source={m.notes} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ========================================================= right: next */

function NextColumn({
  ctx,
  focus,
  kind,
  nexts,
  trail,
  onIsolate,
  onGo,
}: {
  ctx: Ctx;
  focus: string;
  kind: ReturnType<typeof stopKind>;
  nexts: StudyTarget[];
  trail: string | null;
  onIsolate?: (i: number | null) => void;
  onGo: (id: string) => void;
}) {
  if (nexts.length === 0) {
    return (
      <div>
        <ColumnLabel>Next</ColumnLabel>
        <p className="text-xs text-muted">{kind === "leaf" ? "End of this line." : "Nothing below yet."}</p>
      </div>
    );
  }
  return (
    <div>
      <ColumnLabel>{kind === "decision" ? "Options" : kind === "branches" ? "Runouts" : "Next"}</ColumnLabel>
      <div className="study-rail study-rail-right space-y-2">
        {nexts.map((t, i) => (
          <div key={t.via?.id ?? t.option?.id ?? i} className="study-tick study-stagger" style={{ animationDelay: `${60 + i * 35}ms` }}>
            <TargetCard
              ctx={ctx}
              from={focus}
              t={t}
              n={i + 1}
              visited={!!t.stop && t.stop === trail}
              onHover={onIsolate && t.optionIndex >= 0 ? (on) => onIsolate(on ? t.optionIndex : null) : undefined}
              onGo={onGo}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

/** A branch below the focus and a look at what happens there. */
function TargetCard({
  ctx,
  from,
  t,
  n,
  visited,
  onHover,
  onGo,
}: {
  ctx: Ctx;
  from: string;
  t: StudyTarget;
  n: number;
  visited: boolean;
  onHover?: (on: boolean) => void;
  onGo: (id: string) => void;
}) {
  const freq = t.optionIndex >= 0 ? ctx.freqs.get(from)?.[t.optionIndex] : undefined;
  const cards = t.option ? t.folded.flatMap(cardsOf) : [];
  const Tag = t.stop ? "button" : "div";
  return (
    <Tag
      type={t.stop ? "button" : undefined}
      onClick={t.stop ? () => onGo(t.stop!) : undefined}
      onPointerEnter={onHover ? () => onHover(true) : undefined}
      onPointerLeave={onHover ? () => onHover(false) : undefined}
      onFocus={onHover ? () => onHover(true) : undefined}
      onBlur={onHover ? () => onHover(false) : undefined}
      className={[
        "group block w-full rounded-lg border p-2.5 text-left transition-[border-color,box-shadow,transform] duration-150",
        t.stop
          ? "border-line bg-surface shadow-sm hover:-translate-y-px hover:border-accent hover:shadow"
          : "border-dashed border-line bg-transparent",
        visited ? "ring-1 ring-accent/50" : "",
      ].join(" ")}
    >
      <div className="flex items-center gap-2 text-sm">
        {n <= 9 && t.stop && (
          <kbd className="hidden rounded border border-line px-1 text-[10px] text-muted sm:inline">{n}</kbd>
        )}
        <span className="min-w-0 font-medium">
          <TargetLabel ctx={ctx} t={t} />
        </span>
        {cards.length > 0 && (
          <span className="flex items-center gap-1 text-xs text-muted">
            → <BoardCards cards={cards} size="xs" />
          </span>
        )}
        {freq != null && <span className="ml-auto text-xs tabular-nums text-muted">{formatFrequency(freq)}</span>}
      </div>
      {freq != null && t.option && (
        <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-foreground/5">
          <div className="h-full rounded-full" style={{ width: `${Math.min(100, freq)}%`, backgroundColor: t.option.color }} />
        </div>
      )}
      <div className="mt-2">
        {t.stop ? (
          <StopPreview ctx={ctx} stop={t.stop} />
        ) : (
          <p className="text-xs text-muted">Not developed</p>
        )}
      </div>
    </Tag>
  );
}

/** What waits at a stop, small: who acts and how often, the runouts, or how the hand ended. */
function StopPreview({ ctx, stop }: { ctx: Ctx; stop: string }) {
  const node = ctx.tree.node(stop);
  const kind = stopKind(ctx.tree, stop);
  if (kind === "decision" && node) {
    const actions = asStrategy(node).actions;
    const w = ctx.weights[stop];
    const f = ctx.freqs.get(stop);
    return (
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="mb-1 text-[11px] text-muted">
            <b className="text-foreground">{actorOf(ctx, stop)}</b> to act
          </p>
          <FreqBar actions={actions} freqs={f} loading={w === undefined} />
        </div>
        {w && f && (
          <div className="w-[72px] shrink-0">
            <StrategyGrid actions={actions} weights={w} dead={ctx.deadCards(stop)} variant="mini" />
          </div>
        )}
      </div>
    );
  }
  if (kind === "branches") {
    const runs = targets(ctx.tree, stop);
    const shown = runs.slice(0, 8);
    return (
      <div>
        <p className="mb-1 text-[11px] text-muted">
          {stopShort(ctx, stop)} · {runs.length} runouts
        </p>
        <div className="space-y-1">
          {shown.map((r, i) => {
            const d = r.stop ? ctx.tree.node(r.stop) : undefined;
            return (
              <div key={r.via?.id ?? i} className="flex items-center gap-2">
                <span className="w-12 shrink-0">
                  <TargetLabel ctx={ctx} t={r} />
                </span>
                <div className="min-w-0 flex-1">
                  {d?.type === "strategy" ? (
                    <FreqBar
                      actions={asStrategy(d).actions}
                      freqs={ctx.freqs.get(d.id)}
                      loading={ctx.weights[d.id] === undefined}
                      compact
                    />
                  ) : (
                    <span className="text-[11px] text-muted">{r.stop ? stopShort(ctx, r.stop) : "—"}</span>
                  )}
                </div>
              </div>
            );
          })}
          {runs.length > shown.length && <p className="text-[11px] text-muted">+{runs.length - shown.length} more</p>}
        </div>
      </div>
    );
  }
  return <p className="text-xs text-muted">{stopShort(ctx, stop)}</p>;
}

/** A stop in a few words, for previews: terminal, runouts, end of the tree. */
function stopShort(ctx: Ctx, stop: string): string {
  const kind = stopKind(ctx.tree, stop);
  const ns = ctx.nodeStates.get(stop);
  if (kind === "decision") return `${actorOf(ctx, stop)} to act`;
  if (ns?.state.terminal) return terminalText(ns.state.terminal);
  if (kind === "branches") {
    const next = ns?.state.nextStreet;
    return next ? `${STREET_LABELS[next]} dealt` : "Branches";
  }
  return "Nothing below yet";
}

/* ================================================================ pieces */

/** Global frequencies of a decision as one stacked bar, with the numbers under it. */
function FreqBar({
  actions,
  freqs,
  loading,
  compact,
}: {
  actions: StrategyAction[];
  freqs: number[] | null | undefined;
  loading?: boolean;
  compact?: boolean;
}) {
  if (loading) return <div className="h-2.5 w-full animate-pulse rounded-full bg-foreground/10" />;
  if (!freqs) {
    return (
      <p className="text-[11px] text-muted">
        No strategy · {actions.map((a) => a.label).join(" / ") || "no options"}
      </p>
    );
  }
  const label = actions.map((a, i) => `${a.label} ${formatFrequency(freqs[i] ?? 0)}`).join(" · ");
  return (
    <div title={label}>
      <div className={`flex w-full overflow-hidden rounded-full bg-foreground/5 ${compact ? "h-2" : "h-2.5"}`}>
        {actions.map((a, i) =>
          (freqs[i] ?? 0) > 0 ? (
            <span key={a.id} style={{ width: `${freqs[i]}%`, backgroundColor: a.color }} />
          ) : null,
        )}
      </div>
      {!compact && (
        <div className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 text-[11px] tabular-nums text-muted">
          {actions.map((a, i) => (
            <span key={a.id} className="inline-flex items-center gap-1">
              <span className="size-2 rounded-sm" style={{ backgroundColor: a.color }} />
              {a.label} <b className="font-medium text-foreground">{formatFrequency(freqs[i] ?? 0)}</b>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function ColumnLabel({ children }: { children: ReactNode }) {
  return <p className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-muted">{children}</p>;
}

function NavButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="flex size-7 items-center justify-center rounded-md border border-line bg-surface text-muted transition-colors hover:border-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-35"
    >
      {children}
    </button>
  );
}

function Chevron({ dir }: { dir: "left" | "right" | "up" | "down" }) {
  const rotate = { right: 0, down: 90, left: 180, up: 270 }[dir];
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ transform: `rotate(${rotate}deg)` }}>
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

/** An action colour behind a frequency, stronger as it grows. */
function tint(hex: string, pct: number): string {
  const alpha = Math.round(Math.min(1, Math.max(0, pct / 100)) * 0.55 * 255)
    .toString(16)
    .padStart(2, "0");
  return /^#[0-9a-f]{6}$/i.test(hex) ? `${hex}${alpha}` : "transparent";
}
