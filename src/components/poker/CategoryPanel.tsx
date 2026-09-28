"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { GRID_HANDS, RANKS, SUIT_COLORS, SUIT_SYMBOLS, comboBlocked, comboCards, handCombos, type Suit } from "@/lib/solver/cards";
import {
  CATEGORY_COLORS,
  NO_SUITS,
  assignCombos,
  bothFilters,
  categoryIndex,
  groupFilter,
  quickSections,
  rangeCombos,
  suitFilter,
  summarize,
  type GroupSummary,
  type SuitFilter,
  type HandCategory,
  type RangeCombo,
} from "@/lib/solver/categories";
import { DRAW_LABELS, MADE_LABELS, drawClass, madeClass } from "@/lib/solver/handClass";
import { fmtBb } from "@/lib/solver/gameState";
import type { StrategyAction, StrategyStats, StrategyWeights } from "@/lib/solver/types";
import { formatFrequency } from "@/components/poker/format";

/** Combos in no category. */
const OTHER = "#b8b5ae";

/**
 * The Categories tab of a decision: the user's groups (nuts, draws, air…)
 * with each one's share of the range and strategy, and the tools to fill
 * them fast — paint hands on the grid, click single combos, or pick
 * ready-made groups (hand classes, equity / EV buckets) as a filter first.
 */
export function CategoryPanel({
  actions,
  weights,
  dead,
  board,
  stats,
  potBb,
  categories,
  onChange,
}: {
  actions: StrategyAction[];
  weights: StrategyWeights;
  dead: Set<string>;
  board: string[];
  stats: StrategyStats | null;
  /** Pot at the decision, for the EV buckets (% of the pot). */
  potBb: number | null;
  categories: HandCategory[];
  onChange: (next: HandCategory[]) => void;
}) {
  const len = actions.length;
  const range = useMemo(() => rangeCombos(weights, len, dead), [weights, len, dead]);
  const byCombo = useMemo(() => new Map(range.map((c) => [c.combo, c])), [range]);
  const sections = useMemo(() => quickSections(range, board, stats, potBb), [range, board, stats, potBb]);

  // What is shown; a paint stroke edits a draft, saved when it ends.
  const [draft, setDraft] = useState<HandCategory[] | null>(null);
  const cats = draft ?? categories;
  const index = useMemo(() => categoryIndex(cats), [cats]);
  const [brush, setBrush] = useState<string | null>(categories[0]?.id ?? null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [suits, setSuits] = useState<SuitFilter>(NO_SUITS);
  const filter = useMemo(() => bothFilters(groupFilter(sections, picked), suitFilter(suits)), [sections, picked, suits]);
  const clearFilter = () => {
    setPicked(new Set());
    setSuits(NO_SUITS);
  };
  const [hovered, setHovered] = useState<string | null>(null);
  const [form, setForm] = useState<{ id: string | null; name: string; color: string } | null>(null);

  const brushCat = cats.find((c) => c.id === brush) ?? null;
  const matching = useMemo(() => (filter ? range.filter(filter) : null), [range, filter]);
  const summaries = useMemo(() => {
    const out = new Map<string, GroupSummary>();
    for (const c of cats) out.set(c.id, summarize(range, (x) => index.get(x.combo) === c.id, len, stats));
    out.set("", summarize(range, (x) => !index.has(x.combo), len, stats));
    return out;
  }, [cats, index, range, len, stats]);

  function commit(next: HandCategory[]) {
    setDraft(null);
    onChange(next);
  }

  /** The combos a click on a hand acts on: in range, through the filter. */
  function targetsOf(hand: string): string[] {
    return handCombos(hand).filter((c) => {
      const rc = byCombo.get(c);
      return rc && (!filter || filter(rc));
    });
  }

  /* ----------------------------------------------------------- painting */

  const stroke = useRef<{ mode: "paint" | "erase"; seen: Set<string>; cats: HandCategory[] } | null>(null);

  function applyTo(hand: string) {
    const s = stroke.current;
    if (!s || s.seen.has(hand)) return;
    s.seen.add(hand);
    const combos = targetsOf(hand);
    if (combos.length === 0) return;
    s.cats = assignCombos(s.cats, combos, s.mode === "paint" ? brush : null);
    setDraft(s.cats);
  }

  function start(hand: string) {
    setHovered(hand);
    if (!brush) return;
    const combos = targetsOf(hand);
    const all = combos.length > 0 && combos.every((c) => index.get(c) === brush);
    stroke.current = { mode: all ? "erase" : "paint", seen: new Set(), cats };
    applyTo(hand);
  }

  function end() {
    const s = stroke.current;
    stroke.current = null;
    if (s && s.seen.size > 0) commit(s.cats);
  }

  useEffect(() => {
    const up = () => end();
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
  });

  function toggleCombo(combo: string) {
    if (!brush) return;
    commit(assignCombos(cats, [combo], index.get(combo) === brush ? null : brush));
  }

  /* ---------------------------------------------------------- categories */

  function saveForm() {
    if (!form) return;
    const name = form.name.trim();
    if (!name) return;
    if (form.id) {
      commit(cats.map((c) => (c.id === form.id ? { ...c, name, color: form.color } : c)));
    } else {
      const id = crypto.randomUUID();
      const next = [...cats, { id, name, color: form.color, combos: [] }];
      // With a filter on, the new category starts with what it matches.
      commit(matching ? assignCombos(next, matching.map((c) => c.combo), id) : next);
      setBrush(id);
      if (matching) clearFilter();
    }
    setForm(null);
  }

  function newForm() {
    const used = new Set(cats.map((c) => c.color));
    setForm({ id: null, name: "", color: CATEGORY_COLORS.find((c) => !used.has(c)) ?? CATEGORY_COLORS[0] });
  }

  function remove(id: string) {
    const c = cats.find((x) => x.id === id);
    if (!c || !window.confirm(`Delete the category “${c.name}”? Its combos go back to Other.`)) return;
    commit(cats.filter((x) => x.id !== id));
    if (brush === id) setBrush(null);
    setForm(null);
  }

  return (
    <div className="space-y-3">
      {/* The categories: each one's share of the range and strategy. Click = brush. */}
      <div className="overflow-hidden rounded-lg border border-line">
        <div className="flex items-center gap-2 bg-foreground/[0.03] px-3 py-1 text-[10px] font-medium uppercase tracking-wide text-muted">
          <span className="size-3 shrink-0" />
          <span className="w-24 shrink-0 sm:w-32">Category</span>
          <span className="w-11 shrink-0 text-right">Range</span>
          <span className="flex-1">Strategy</span>
          <span className="hidden w-24 shrink-0 text-right sm:block">{stats ? "Equity · EV" : ""}</span>
          <span className="w-4 shrink-0" />
        </div>
        {cats.map((c) => (
          <CategoryRow
            key={c.id}
            name={c.name}
            color={c.color}
            summary={summaries.get(c.id)!}
            actions={actions}
            active={brush === c.id}
            onClick={() => setBrush(brush === c.id ? null : c.id)}
            onEdit={() => setForm({ id: c.id, name: c.name, color: c.color })}
          />
        ))}
        <CategoryRow name="Other" color={OTHER} summary={summaries.get("")!} actions={actions} muted />
        {form ? (
          <CategoryForm
            form={form}
            onChange={setForm}
            onSave={saveForm}
            onCancel={() => setForm(null)}
            onDelete={form.id ? () => remove(form.id!) : undefined}
            fromFilter={!form.id && matching ? matching.length : null}
          />
        ) : (
          <button
            type="button"
            onClick={newForm}
            className="flex w-full items-center gap-1.5 border-t border-line px-3 py-1.5 text-left text-xs text-muted hover:bg-foreground/5 hover:text-foreground"
          >
            ＋ New category{matching ? ` from the filter (${matching.length} combos)` : ""}
          </button>
        )}
      </div>

      <p className="text-[11px] text-muted">
        {brushCat ? (
          <>
            Painting <b className="font-medium" style={{ color: brushCat.color }}>{brushCat.name}</b>: click or drag over hands
            {filter ? " (only the combos the filter keeps)" : ""}; again to take them out. Click a combo below for one at a time.
          </>
        ) : cats.length ? (
          "Pick a category above to paint it on the grid."
        ) : (
          "Create a category, then paint hands on the grid or pick groups on the right."
        )}
      </p>

      <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(190px,230px)]">
        <div>
          <CategoryGrid
            actions={actions}
            range={byCombo}
            index={index}
            cats={cats}
            filter={filter}
            dead={dead}
            hovered={hovered}
            painting={!!brush}
            onHover={setHovered}
            onStart={start}
            onEnter={(hand) => stroke.current && applyTo(hand)}
          />
          {filter && matching && (
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
              <span className="text-muted">
                Filter: {matching.length} combos · {formatFrequency(summarize(range, filter, len, null).share)} of the range
              </span>
              {brushCat && (
                <button
                  type="button"
                  onClick={() => commit(assignCombos(cats, matching.map((c) => c.combo), brushCat.id))}
                  className="rounded-md px-2 py-0.5 text-white"
                  style={{ backgroundColor: brushCat.color }}
                >
                  Add all to {brushCat.name}
                </button>
              )}
              <button type="button" onClick={clearFilter} className="text-muted underline-offset-2 hover:text-foreground hover:underline">
                Clear filter
              </button>
            </div>
          )}
          <ComboDetail
            hand={hovered}
            range={byCombo}
            index={index}
            cats={cats}
            board={board}
            stats={stats}
            dead={dead}
            brush={brushCat}
            onToggle={toggleCombo}
          />
        </div>
        <div className="space-y-3">
          <SuitPicker value={suits} onChange={setSuits} />
          <GroupsPanel sections={sections} range={range} actions={actions} picked={picked} onPick={setPicked} />
        </div>
      </div>
    </div>
  );
}

/* ============================================= beside the strategy grid */

const OTHER_ID = "__other";

/**
 * The decision's categories next to its strategy: each with its share of the
 * range and strategy. Clicking one shows only its combos in colour on the
 * grid (the rest of the range in grey); again to see everything.
 */
export function CategoryList({
  actions,
  weights,
  dead,
  stats,
  categories,
  selected,
  onSelect,
}: {
  actions: StrategyAction[];
  weights: StrategyWeights;
  dead: Set<string>;
  stats: StrategyStats | null;
  categories: HandCategory[];
  selected: string | null;
  onSelect: (next: { id: string; combos: Set<string> } | null) => void;
}) {
  const len = actions.length;
  const range = useMemo(() => rangeCombos(weights, len, dead), [weights, len, dead]);
  const index = useMemo(() => categoryIndex(categories), [categories]);
  const rows = useMemo(() => {
    const list = categories.map((c) => ({
      id: c.id,
      name: c.name,
      color: c.color,
      combos: new Set(range.filter((x) => index.get(x.combo) === c.id).map((x) => x.combo)),
    }));
    const rest = new Set(range.filter((x) => !index.has(x.combo)).map((x) => x.combo));
    if (rest.size > 0) list.push({ id: OTHER_ID, name: "Other", color: OTHER, combos: rest });
    return list.map((r) => ({ ...r, summary: summarize(range, (x) => r.combos.has(x.combo), len, stats) }));
  }, [categories, index, range, len, stats]);

  return (
    <div>
      <p className="mb-1.5 hidden text-[11px] font-medium uppercase tracking-wide text-muted xl:block">Categories</p>
      <div className="flex flex-wrap gap-1.5 xl:flex-col xl:flex-nowrap">
        {rows.map((r) => {
          const on = selected === r.id;
          return (
            <button
              key={r.id}
              type="button"
              aria-pressed={on}
              onClick={() => onSelect(on ? null : { id: r.id, combos: r.combos })}
              className={[
                "min-w-0 rounded-md border px-2 py-1.5 text-left text-xs transition-colors xl:w-full",
                on ? "border-foreground/50 bg-foreground/[0.06]" : "border-line hover:border-accent",
                selected && !on ? "opacity-55" : "",
              ].join(" ")}
            >
              <span className="flex items-center gap-1.5">
                <span className="size-3 shrink-0 rounded-sm" style={{ backgroundColor: r.color }} />
                <span className="min-w-0 flex-1 truncate font-medium">{r.name}</span>
                <span className="shrink-0 tabular-nums text-muted">{formatFrequency(r.summary.share)}</span>
              </span>
              <span className="mt-1 hidden xl:block">
                <StrategyBar actions={actions} strategy={r.summary.strategy} />
              </span>
            </button>
          );
        })}
      </div>
      {selected && (
        <button type="button" onClick={() => onSelect(null)} className="mt-1.5 text-[11px] text-muted hover:text-foreground">
          Show every hand
        </button>
      )}
    </div>
  );
}

/* ================================================================== rows */

function CategoryRow({
  name,
  color,
  summary,
  actions,
  active,
  muted,
  onClick,
  onEdit,
}: {
  name: string;
  color: string;
  summary: GroupSummary;
  actions: StrategyAction[];
  active?: boolean;
  muted?: boolean;
  onClick?: () => void;
  onEdit?: () => void;
}) {
  return (
    <div
      className={[
        "group/row flex items-center gap-2 border-t border-line px-3 py-1.5 text-xs",
        active ? "bg-foreground/[0.06]" : "",
        onClick ? "cursor-pointer hover:bg-foreground/5" : "",
      ].join(" ")}
      onClick={onClick}
      role={onClick ? "button" : undefined}
      aria-pressed={onClick ? active : undefined}
    >
      <span
        className={["size-3 shrink-0 rounded-sm", active ? "ring-2 ring-offset-1 ring-offset-surface" : ""].join(" ")}
        style={{ backgroundColor: color, ["--tw-ring-color" as string]: color }}
      />
      <span className={["w-24 min-w-0 shrink-0 truncate font-medium sm:w-32", muted ? "text-muted" : ""].join(" ")}>{name}</span>
      <span className="w-11 shrink-0 text-right tabular-nums text-muted">{formatFrequency(summary.share)}</span>
      <div className="min-w-0 flex-1">
        <StrategyBar actions={actions} strategy={summary.strategy} />
      </div>
      <span className="hidden w-24 shrink-0 text-right tabular-nums text-muted sm:block">
        {summary.equity != null ? `${summary.equity.toFixed(0)}%` : ""}
        {summary.ev != null ? ` · ${fmtBb(summary.ev)}bb` : ""}
      </span>
      {onEdit ? (
        <button
          type="button"
          aria-label={`Edit ${name}`}
          onClick={(e) => {
            e.stopPropagation();
            onEdit();
          }}
          className="w-4 shrink-0 text-muted opacity-60 hover:text-foreground hover:opacity-100"
        >
          ✎
        </button>
      ) : (
        <span className="w-4 shrink-0" />
      )}
    </div>
  );
}

/** The options' shares side by side, the main one's % written in. */
function StrategyBar({ actions, strategy }: { actions: StrategyAction[]; strategy: number[] | null }) {
  if (!strategy) return <div className="h-4 rounded-sm bg-foreground/5" />;
  return (
    <div
      className="flex h-4 overflow-hidden rounded-sm"
      title={actions.map((a, i) => `${a.label} ${formatFrequency(strategy[i] ?? 0)}`).join(" · ")}
    >
      {actions.map((a, i) => {
        const pct = strategy[i] ?? 0;
        if (pct <= 0.05) return null;
        return (
          <span key={a.id} className="flex items-center justify-center overflow-hidden text-[9px] font-medium text-white" style={{ width: `${pct}%`, backgroundColor: a.color }}>
            {pct >= 18 ? `${Math.round(pct)}` : ""}
          </span>
        );
      })}
    </div>
  );
}

function CategoryForm({
  form,
  onChange,
  onSave,
  onCancel,
  onDelete,
  fromFilter,
}: {
  form: { id: string | null; name: string; color: string };
  onChange: (f: { id: string | null; name: string; color: string }) => void;
  onSave: () => void;
  onCancel: () => void;
  onDelete?: () => void;
  fromFilter: number | null;
}) {
  return (
    <form
      className="flex flex-wrap items-center gap-2 border-t border-line bg-background/60 px-3 py-2"
      onSubmit={(e) => {
        e.preventDefault();
        onSave();
      }}
    >
      <input
        autoFocus
        value={form.name}
        onChange={(e) => onChange({ ...form, name: e.target.value })}
        onKeyDown={(e) => e.key === "Escape" && onCancel()}
        placeholder="Name (nuts, strong draws, air…)"
        className="min-w-0 flex-1 basis-40 rounded-md border border-line bg-surface px-2 py-1 text-xs outline-none focus:border-accent"
      />
      <div className="flex flex-wrap items-center gap-1">
        {CATEGORY_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            aria-label={`Color ${c}`}
            onClick={() => onChange({ ...form, color: c })}
            className={["size-5 rounded-full border-2", form.color === c ? "border-foreground" : "border-transparent"].join(" ")}
            style={{ backgroundColor: c }}
          />
        ))}
        <input
          type="color"
          aria-label="Other color"
          value={form.color}
          onChange={(e) => onChange({ ...form, color: e.target.value })}
          className="size-5 cursor-pointer rounded-full border-0 bg-transparent p-0"
        />
      </div>
      <div className="flex items-center gap-1.5">
        <button type="submit" disabled={!form.name.trim()} className="rounded-md bg-accent px-2 py-1 text-xs text-white disabled:opacity-50">
          {form.id ? "Save" : fromFilter != null ? `Create with ${fromFilter} combos` : "Create"}
        </button>
        <button type="button" onClick={onCancel} className="rounded-md px-2 py-1 text-xs text-muted hover:text-foreground">
          Cancel
        </button>
        {onDelete && (
          <button type="button" onClick={onDelete} className="rounded-md px-2 py-1 text-xs text-red-600 hover:bg-red-600/10">
            Delete
          </button>
        )}
      </div>
    </form>
  );
}

/* ================================================================== grid */

function CategoryGrid({
  actions,
  range,
  index,
  cats,
  filter,
  dead,
  hovered,
  painting,
  onHover,
  onStart,
  onEnter,
}: {
  actions: StrategyAction[];
  range: Map<string, RangeCombo>;
  index: Map<string, string>;
  cats: HandCategory[];
  filter: ((c: RangeCombo) => boolean) | null;
  dead: Set<string>;
  hovered: string | null;
  painting: boolean;
  onHover: (hand: string | null) => void;
  onStart: (hand: string) => void;
  onEnter: (hand: string) => void;
}) {
  const colorOf = useMemo(() => new Map(cats.map((c) => [c.id, c.color])), [cats]);
  const handAt = (x: number, y: number) => (document.elementFromPoint(x, y)?.closest("[data-hand]") as HTMLElement | null)?.dataset.hand ?? null;

  return (
    <div
      className="grid select-none gap-0.5"
      style={{ gridTemplateColumns: `repeat(${RANKS.length}, minmax(0, 1fr))`, touchAction: painting ? "none" : undefined }}
      onPointerDown={(e) => {
        const hand = handAt(e.clientX, e.clientY);
        if (!hand) return;
        if (painting) (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        onStart(hand);
      }}
      onPointerMove={(e) => {
        const hand = handAt(e.clientX, e.clientY);
        if (!hand) return;
        if (e.pointerType === "mouse" && hand !== hovered) onHover(hand);
        onEnter(hand);
      }}
      onPointerLeave={(e) => e.pointerType === "mouse" && e.buttons === 0 && onHover(null)}
    >
      {GRID_HANDS.map((hand) => {
        const combos = handCombos(hand);
        const live = combos.filter((c) => !comboBlocked(c, dead));
        // Bars by category, weighted by how much of each combo is in range.
        const parts = new Map<string, number>();
        let inRange = 0;
        let shown = 0;
        for (const c of live) {
          const rc = range.get(c);
          if (!rc) continue;
          inRange += rc.reach;
          if (filter && !filter(rc)) continue;
          shown += rc.reach;
          const k = index.get(c) ?? "";
          parts.set(k, (parts.get(k) ?? 0) + rc.reach);
        }
        // The strategy behind (of the combos shown), the categories as a band on top.
        const height = live.length ? ((filter ? shown : inRange) / live.length) * 100 : 0;
        const order = cats.map((c) => c.id).filter((k) => parts.has(k));
        const strat = actions.map(() => 0);
        for (const c of live) {
          const rc = range.get(c);
          if (!rc || (filter && !filter(rc))) continue;
          for (let i = 0; i < strat.length; i++) strat[i] += (rc.strategy[i] ?? 0) * rc.reach;
        }
        const stratTotal = strat.reduce((a, b) => a + b, 0);
        return (
          <div
            key={hand}
            data-hand={hand}
            title={hand}
            className={[
              "relative aspect-square overflow-hidden rounded-sm border text-[9px] font-semibold",
              painting ? "cursor-crosshair" : "",
              hovered === hand ? "border-accent ring-1 ring-accent" : "border-line",
              live.length === 0 ? "opacity-25" : filter && shown === 0 ? "opacity-30" : "",
            ].join(" ")}
          >
            {/* Top: the categories, on grey (Other stays grey). */}
            <span className="absolute inset-x-0 top-0 flex h-[30%] border-b border-black/20" style={{ backgroundColor: OTHER }}>
              {shown > 0 &&
                order.map((k) => (
                  <span key={k} style={{ width: `${((parts.get(k) ?? 0) / shown) * 100}%`, backgroundColor: colorOf.get(k) }} />
                ))}
            </span>
            {/* Below: the strategy, height = share in range. */}
            <span className="absolute inset-x-0 bottom-0 top-[30%] flex flex-col justify-end bg-background">
              {stratTotal > 0 && (
                <span className="flex w-full" style={{ height: `${Math.max(8, height)}%` }}>
                  {actions.map((a, i) =>
                    strat[i] > 0 ? <span key={a.id} style={{ width: `${(strat[i] / stratTotal) * 100}%`, backgroundColor: a.color }} /> : null,
                  )}
                </span>
              )}
            </span>
            <span className="pointer-events-none absolute inset-x-0 bottom-0 top-[30%] flex items-center justify-center text-black">{hand}</span>
          </div>
        );
      })}
    </div>
  );
}

/* ================================================================ combos */

function ComboDetail({
  hand,
  range,
  index,
  cats,
  board,
  stats,
  dead,
  brush,
  onToggle,
}: {
  hand: string | null;
  range: Map<string, RangeCombo>;
  index: Map<string, string>;
  cats: HandCategory[];
  board: string[];
  stats: StrategyStats | null;
  dead: Set<string>;
  brush: HandCategory | null;
  onToggle: (combo: string) => void;
}) {
  const byId = new Map(cats.map((c) => [c.id, c]));
  const actor = stats?.players[stats.actor];
  const combos = hand ? handCombos(hand).filter((c) => !comboBlocked(c, dead) && range.has(c)) : [];
  return (
    <div className="mt-3 min-h-[13rem] border-t border-line pt-3 text-xs">
      {!hand ? (
        <p className="text-muted">Hover a hand (tap on a phone) to see its combos.</p>
      ) : combos.length === 0 ? (
        <p className="text-muted">{hand}: not in range here.</p>
      ) : (
        <>
          <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted">{hand} · combos</p>
          <div className="grid grid-cols-2 gap-1 sm:grid-cols-3">
            {combos.map((c) => {
              const cat = byId.get(index.get(c) ?? "");
              const rc = range.get(c)!;
              const cls = board.length >= 3 ? MADE_LABELS[madeClass(c, board)] : null;
              const dr = board.length >= 3 && board.length < 5 ? drawClass(c, board) : "no_draw";
              return (
                <button
                  key={c}
                  type="button"
                  disabled={!brush}
                  onClick={() => onToggle(c)}
                  title={brush ? (cat?.id === brush.id ? `Take out of ${brush.name}` : `Put in ${brush.name}`) : undefined}
                  className="flex items-center gap-1.5 rounded-md border border-line px-1.5 py-1 text-left enabled:hover:border-accent"
                >
                  <span className="h-6 w-1 shrink-0 rounded-full" style={{ backgroundColor: cat?.color ?? OTHER }} />
                  <span className="min-w-0">
                    <span className="flex items-center gap-1">
                      <ComboText combo={c} />
                      <span className="tabular-nums text-muted">
                        {rc.reach < 0.995 ? `${Math.round(rc.reach * 100)}%` : ""}
                        {actor?.equity[c] != null ? ` ${actor.equity[c].toFixed(0)}% eq` : ""}
                      </span>
                    </span>
                    <span className="block truncate text-[10px] text-muted">
                      {cls}
                      {dr !== "no_draw" ? ` · ${DRAW_LABELS[dr]}` : ""}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

function ComboText({ combo }: { combo: string }) {
  return (
    <span className="font-semibold tabular-nums">
      {comboCards(combo).map((card) => (
        <span key={card} style={{ color: SUIT_COLORS[card[1] as Suit] }}>
          {card[0]}
          {SUIT_SYMBOLS[card[1] as Suit]}
        </span>
      ))}
    </span>
  );
}

/* ================================================================= suits */

/**
 * Two rows of suits, for the high card and the low card of a combo (a pair
 * matches either way round). Left click keeps only the suits clicked, right
 * click leaves a suit out; again to undo.
 */
function SuitPicker({ value, onChange }: { value: SuitFilter; onChange: (next: SuitFilter) => void }) {
  const set = (row: "high" | "low", suit: Suit, mark: "in" | "out") => {
    const marks = { ...value[row] };
    if (marks[suit] === mark) delete marks[suit];
    else marks[suit] = mark;
    onChange({ ...value, [row]: marks });
  };
  return (
    <div className="text-[11px]">
      <p className="mb-1 font-medium uppercase tracking-wide text-muted">Suits</p>
      {(["high", "low"] as const).map((row) => (
        <div key={row} className="mb-1 flex items-center gap-1">
          <span className="w-14 shrink-0 text-muted">{row === "high" ? "High card" : "Low card"}</span>
          {(["s", "h", "d", "c"] as Suit[]).map((suit) => {
            const mark = value[row][suit];
            return (
              <button
                key={suit}
                type="button"
                aria-label={`${row} card ${suit}${mark ? `: ${mark === "in" ? "kept" : "left out"}` : ""}`}
                aria-pressed={!!mark}
                title="Click: only this suit · Right click: leave it out"
                onClick={() => set(row, suit, "in")}
                onContextMenu={(e) => {
                  e.preventDefault();
                  set(row, suit, "out");
                }}
                className={[
                  "relative flex size-7 items-center justify-center rounded border text-base leading-none transition-colors",
                  mark === "in" ? "border-foreground bg-foreground/10" : mark === "out" ? "border-red-500/60 opacity-40" : "border-line hover:border-accent",
                ].join(" ")}
                style={{ color: SUIT_COLORS[suit] }}
              >
                {SUIT_SYMBOLS[suit]}
                {mark === "out" && <span className="absolute inset-x-1 top-1/2 h-0.5 -rotate-45 rounded bg-red-500" />}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/* ================================================================ groups */

function GroupsPanel({
  sections,
  range,
  actions,
  picked,
  onPick,
}: {
  sections: ReturnType<typeof quickSections>;
  range: RangeCombo[];
  actions: StrategyAction[];
  picked: Set<string>;
  onPick: (next: Set<string>) => void;
}) {
  if (sections.length === 0) return null;
  return (
    <div className="space-y-3 text-[11px]">
      <p className="text-muted">Pick groups to filter: any in a section, all across sections.</p>
      {sections.map((s) => (
        <Section key={s.id} label={s.label}>
          {s.groups.map((g) => {
            const sum = summarize(range, g.test, actions.length, null);
            const on = picked.has(g.id);
            return (
              <button
                key={g.id}
                type="button"
                aria-pressed={on}
                onClick={() => {
                  const next = new Set(picked);
                  if (on) next.delete(g.id);
                  else next.add(g.id);
                  onPick(next);
                }}
                className={[
                  "flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left",
                  on ? "bg-accent/15 font-medium text-foreground ring-1 ring-accent/50" : "hover:bg-foreground/5",
                ].join(" ")}
              >
                <span className="w-20 shrink-0">
                  <StrategyBar actions={actions} strategy={sum.strategy} />
                </span>
                <span className="w-9 shrink-0 text-right tabular-nums text-muted">{formatFrequency(sum.share)}</span>
                <span className="min-w-0 truncate">{g.label}</span>
              </button>
            );
          })}
        </Section>
      ))}
    </div>
  );
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <p className="mb-1 font-medium uppercase tracking-wide text-muted">{label}</p>
      <div className="space-y-px">{children}</div>
    </div>
  );
}
