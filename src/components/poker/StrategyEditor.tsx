"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ACTION_SWATCHES, recolorActions } from "@/lib/solver/colors";
import { eventHitsElement } from "@/lib/dom";
import { GRID_HANDS, RANKS, comboBlocked, handCombos } from "@/lib/solver/cards";
import {
  comboVector,
  handDisplayVector,
  paintCombo,
  paintHand,
  pureVector,
  remapWeights,
  zeroVector,
} from "@/lib/solver/strategy";
import {
  ACTION_KIND_LABELS,
  ACTION_KINDS,
  kindHasSize,
  type ActionKind,
  type StrategyAction,
  type StrategyWeights,
} from "@/lib/solver/types";
import { Segmented } from "@/components/poker/ui";
import { CellBars } from "@/components/poker/StrategyGrid";

type Mode = "paint" | "inspect";

/**
 * Full strategy editor for one node. It owns local copies of the action set and
 * the weight matrix (seeded once, since a fresh editor is mounted per open) so
 * a fast paint-drag applies functional updates without waiting on the parent to
 * re-render. Changes are pushed up to persist — actions immediately, weights
 * debounced — and any pending weight save is flushed on close.
 */
export function StrategyEditor({
  title,
  initialActions,
  initialWeights,
  dead,
  onActionsChange,
  onWeightsChange,
  onClose,
}: {
  title: string;
  initialActions: StrategyAction[];
  initialWeights: StrategyWeights;
  dead: Set<string>;
  onActionsChange: (actions: StrategyAction[]) => void;
  onWeightsChange: (weights: StrategyWeights) => void;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [actions, setActions] = useState(initialActions);
  const [weights, setWeights] = useState(initialWeights);
  const [mode, setMode] = useState<Mode>("paint");
  const [activeIndex, setActiveIndex] = useState(0); // -1 = erase
  const [selectedHand, setSelectedHand] = useState<string | null>(null);
  const painting = useRef(false);

  const len = actions.length;

  // Debounced weight save, flushed on unmount.
  const saveTimer = useRef<number | null>(null);
  const latestWeights = useRef(weights);
  useEffect(() => {
    latestWeights.current = weights;
  }, [weights]);

  function scheduleSave() {
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      onWeightsChange(latestWeights.current);
      saveTimer.current = null;
    }, 400);
  }
  useEffect(() => {
    return () => {
      if (saveTimer.current) {
        window.clearTimeout(saveTimer.current);
        onWeightsChange(latestWeights.current);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function editWeights(fn: (prev: StrategyWeights) => StrategyWeights) {
    setWeights((prev) => fn(prev));
    scheduleSave();
  }

  // Escape closes; an outside click closes (deferred so the opening click does
  // not immediately dismiss it).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    function onDown(e: PointerEvent) {
      if (!eventHitsElement(e, panelRef.current)) onClose();
    }
    window.addEventListener("keydown", onKey);
    const id = window.setTimeout(
      () => window.addEventListener("pointerdown", onDown),
      0,
    );
    return () => {
      window.removeEventListener("keydown", onKey);
      window.clearTimeout(id);
      window.removeEventListener("pointerdown", onDown);
    };
  }, [onClose]);

  useEffect(() => {
    function stop() {
      painting.current = false;
    }
    window.addEventListener("pointerup", stop);
    return () => window.removeEventListener("pointerup", stop);
  }, []);

  function applyPaint(hand: string) {
    if (activeIndex < 0) {
      editWeights((prev) => clearHand(prev, hand));
    } else {
      editWeights((prev) => paintHand(prev, hand, pureVector(len, activeIndex)));
    }
  }

  /* --------------------------------------------------------- action set */

  function commitActions(next: StrategyAction[]) {
    setActions(next);
    onActionsChange(next);
  }

  function updateAction(index: number, patch: Partial<StrategyAction>) {
    const next = actions.map((a, i) => (i === index ? { ...a, ...patch } : a));
    // A kind or sizing change re-ranks the bets, so re-apply the palette.
    const reorders = patch.kind !== undefined || patch.sizePct !== undefined;
    commitActions(reorders ? recolorActions(next) : next);
  }

  function addAction() {
    commitActions(
      recolorActions([
        ...actions,
        { id: crypto.randomUUID(), kind: "bet", sizePct: 75, label: "Bet 75%", color: "" },
      ]),
    );
    editWeights((prev) => remapWeights(prev, len, len + 1, null));
  }

  function removeAction(index: number) {
    if (actions.length <= 1) return;
    commitActions(recolorActions(actions.filter((_, i) => i !== index)));
    editWeights((prev) => remapWeights(prev, len, len - 1, index));
    if (activeIndex >= actions.length - 1) setActiveIndex(Math.max(0, actions.length - 2));
  }

  const body = (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div
        ref={panelRef}
        className="flex max-h-full w-full max-w-4xl flex-col overflow-hidden rounded-lg border border-line bg-surface shadow-xl"
      >
        <div className="flex shrink-0 items-center gap-3 border-b border-line px-4 py-2.5">
          <h2 className="truncate text-sm font-medium">{title}</h2>
          <div className="ml-auto flex items-center gap-3">
            <Segmented
              size="sm"
              value={mode}
              onChange={setMode}
              options={[
                { id: "paint", label: "Paint" },
                { id: "inspect", label: "Inspect" },
              ]}
            />
            <button
              type="button"
              onClick={onClose}
              className="rounded border border-line px-2 py-1 text-xs hover:border-accent"
            >
              Done
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <ActionBar
            actions={actions}
            activeIndex={activeIndex}
            mode={mode}
            onPick={setActiveIndex}
            onUpdate={updateAction}
            onRemove={removeAction}
            onAdd={addAction}
          />

          <p className="mt-2 text-xs text-muted">
            {mode === "paint"
              ? "Pick an action, then drag across the grid to assign it. Switch to Inspect for mixed and per-combo weights."
              : "Click a hand to edit its distribution and drill into individual combos."}
          </p>

          <div className="mt-4 flex flex-col gap-4 lg:flex-row">
            <Grid
              actions={actions}
              weights={weights}
              dead={dead}
              onCellDown={(hand) => {
                if (mode === "paint") {
                  painting.current = true;
                  applyPaint(hand);
                } else {
                  setSelectedHand(hand);
                }
              }}
              onCellEnter={(hand) => {
                if (mode === "paint" && painting.current) applyPaint(hand);
              }}
            />

            {mode === "inspect" && selectedHand && (
              <HandDetail
                hand={selectedHand}
                actions={actions}
                weights={weights}
                dead={dead}
                onEdit={editWeights}
                onClose={() => setSelectedHand(null)}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );

  return createPortal(body, document.body);
}

function clearHand(w: StrategyWeights, hand: string): StrategyWeights {
  const hands = { ...w.hands };
  delete hands[hand];
  const combos = { ...w.combos };
  for (const c of handCombos(hand)) delete combos[c];
  return { hands, combos };
}

/* ---------------------------------------------------------------- actions */

function ActionBar({
  actions,
  activeIndex,
  mode,
  onPick,
  onUpdate,
  onRemove,
  onAdd,
}: {
  actions: StrategyAction[];
  activeIndex: number;
  mode: Mode;
  onPick: (i: number) => void;
  onUpdate: (i: number, patch: Partial<StrategyAction>) => void;
  onRemove: (i: number) => void;
  onAdd: () => void;
}) {
  const [editing, setEditing] = useState<number | null>(null);

  return (
    <div className="flex flex-wrap items-center gap-2">
      {actions.map((action, i) => (
        <div key={action.id} className="relative">
          <button
            type="button"
            onClick={() =>
              mode === "paint" ? onPick(i) : setEditing(editing === i ? null : i)
            }
            className={[
              "flex items-center gap-1.5 rounded border px-2 py-1 text-xs",
              mode === "paint" && activeIndex === i
                ? "border-accent ring-1 ring-accent"
                : "border-line hover:border-accent",
            ].join(" ")}
          >
            <span className="size-3 rounded-sm" style={{ backgroundColor: action.color }} />
            {action.label}
          </button>
          {editing === i && (
            <ActionEditor
              action={action}
              canRemove={actions.length > 1}
              onUpdate={(patch) => onUpdate(i, patch)}
              onRemove={() => {
                onRemove(i);
                setEditing(null);
              }}
              onClose={() => setEditing(null)}
            />
          )}
        </div>
      ))}
      {mode === "paint" && (
        <button
          type="button"
          onClick={() => onPick(-1)}
          className={[
            "rounded border px-2 py-1 text-xs",
            activeIndex === -1
              ? "border-accent ring-1 ring-accent"
              : "border-line hover:border-accent",
          ].join(" ")}
        >
          Erase
        </button>
      )}
      <button
        type="button"
        onClick={onAdd}
        className="rounded border border-line px-2 py-1 text-xs text-muted hover:border-accent"
      >
        ＋ Action
      </button>
    </div>
  );
}

function ActionEditor({
  action,
  canRemove,
  onUpdate,
  onRemove,
  onClose,
}: {
  action: StrategyAction;
  canRemove: boolean;
  onUpdate: (patch: Partial<StrategyAction>) => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  return (
    <div className="absolute left-0 top-full z-10 mt-1 w-56 space-y-2 rounded-lg border border-line bg-surface p-3 shadow-lg">
      <label className="block text-xs text-muted">
        Label
        <input
          value={action.label}
          onChange={(e) => onUpdate({ label: e.target.value })}
          className="mt-0.5 w-full rounded border border-line bg-background px-2 py-1 text-xs text-foreground outline-none focus:border-accent"
        />
      </label>
      <label className="block text-xs text-muted">
        Kind
        <select
          value={action.kind}
          onChange={(e) => onUpdate({ kind: e.target.value as ActionKind })}
          className="mt-0.5 w-full rounded border border-line bg-background px-2 py-1 text-xs text-foreground outline-none focus:border-accent"
        >
          {ACTION_KINDS.map((k) => (
            <option key={k} value={k}>
              {ACTION_KIND_LABELS[k]}
            </option>
          ))}
        </select>
      </label>
      {kindHasSize(action.kind) && (
        <label className="block text-xs text-muted">
          Size (% pot)
          <input
            type="number"
            min={0}
            value={action.sizePct ?? ""}
            onChange={(e) =>
              onUpdate({ sizePct: e.target.value === "" ? null : Number(e.target.value) })
            }
            className="mt-0.5 w-full rounded border border-line bg-background px-2 py-1 text-xs text-foreground outline-none focus:border-accent"
          />
        </label>
      )}
      <div>
        <span className="text-xs text-muted">Colour</span>
        <div className="mt-1 flex flex-wrap gap-1">
          {ACTION_SWATCHES.map((color) => (
            <button
              key={color}
              type="button"
              onClick={() => onUpdate({ color })}
              className={[
                "size-5 rounded-sm border",
                action.color === color ? "border-foreground" : "border-transparent",
              ].join(" ")}
              style={{ backgroundColor: color }}
            />
          ))}
        </div>
      </div>
      <div className="flex justify-between pt-1">
        {canRemove ? (
          <button
            type="button"
            onClick={onRemove}
            className="text-xs text-red-500 hover:underline"
          >
            Remove
          </button>
        ) : (
          <span />
        )}
        <button
          type="button"
          onClick={onClose}
          className="text-xs text-muted hover:text-foreground"
        >
          Close
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------- grid */

function Grid({
  actions,
  weights,
  dead,
  onCellDown,
  onCellEnter,
}: {
  actions: StrategyAction[];
  weights: StrategyWeights;
  dead: Set<string>;
  onCellDown: (hand: string) => void;
  onCellEnter: (hand: string) => void;
}) {
  const len = actions.length;
  return (
    <div
      className="grid flex-1 select-none gap-0.5"
      style={{ gridTemplateColumns: `repeat(${RANKS.length}, minmax(0, 1fr))` }}
    >
      {GRID_HANDS.map((hand) => {
        const vec = handDisplayVector(weights, hand, len);
        const blocked = handCombos(hand).every((c) => comboBlocked(c, dead));
        return (
          <button
            key={hand}
            type="button"
            onPointerDown={() => onCellDown(hand)}
            onPointerEnter={() => onCellEnter(hand)}
            title={hand}
            className={[
              "relative aspect-square overflow-hidden rounded-sm border border-line text-[9px] font-semibold",
              blocked ? "opacity-25" : "",
            ].join(" ")}
          >
            <CellBars actions={actions} vector={vec} />
            <span className="absolute inset-0 flex items-center justify-center text-white mix-blend-difference">
              {hand}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/* -------------------------------------------------------------- hand detail */

function HandDetail({
  hand,
  actions,
  weights,
  dead,
  onEdit,
  onClose,
}: {
  hand: string;
  actions: StrategyAction[];
  weights: StrategyWeights;
  dead: Set<string>;
  onEdit: (fn: (prev: StrategyWeights) => StrategyWeights) => void;
  onClose: () => void;
}) {
  const len = actions.length;
  const [perCombo, setPerCombo] = useState(false);

  const combos = useMemo(
    () => handCombos(hand).filter((c) => !comboBlocked(c, dead)),
    [hand, dead],
  );

  const handVec = handDisplayVector(weights, hand, len) ?? zeroVector(len);

  return (
    <div className="w-full shrink-0 space-y-3 rounded-lg border border-line bg-background p-3 lg:w-72">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">{hand}</h3>
        <button
          type="button"
          onClick={onClose}
          className="text-xs text-muted hover:text-foreground"
        >
          Close
        </button>
      </div>

      <div className="space-y-1.5">
        {actions.map((action, i) => (
          <WeightInput
            key={action.id}
            action={action}
            value={Math.round(handVec[i] ?? 0)}
            onChange={(v) =>
              onEdit((prev) => {
                const vec = [...(handDisplayVector(prev, hand, len) ?? zeroVector(len))];
                vec[i] = v;
                return paintHand(prev, hand, vec);
              })
            }
          />
        ))}
      </div>

      <button
        type="button"
        onClick={() => setPerCombo((v) => !v)}
        className="text-xs text-accent hover:underline"
      >
        {perCombo ? "Hide" : "Show"} per-combo detail ({combos.length})
      </button>

      {perCombo && (
        <div className="space-y-2 border-t border-line pt-2">
          {combos.map((combo) => {
            const vec = comboVector(weights, combo, hand, len);
            const overridden = Boolean(weights.combos[combo]);
            return (
              <div key={combo}>
                <div className="flex items-center justify-between text-[11px]">
                  <span className="font-medium tabular-nums">{combo}</span>
                  {overridden && (
                    <button
                      type="button"
                      onClick={() => onEdit((prev) => paintCombo(prev, combo, null))}
                      className="text-muted hover:text-foreground"
                    >
                      reset
                    </button>
                  )}
                </div>
                <div className="mt-0.5 space-y-1">
                  {actions.map((action, i) => (
                    <WeightInput
                      key={action.id}
                      action={action}
                      value={Math.round(vec[i] ?? 0)}
                      onChange={(v) =>
                        onEdit((prev) => {
                          const cv = [...comboVector(prev, combo, hand, len)];
                          cv[i] = v;
                          return paintCombo(prev, combo, cv);
                        })
                      }
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function WeightInput({
  action,
  value,
  onChange,
}: {
  action: StrategyAction;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-xs">
      <span className="size-3 shrink-0 rounded-sm" style={{ backgroundColor: action.color }} />
      <span className="w-16 truncate text-muted">{action.label}</span>
      <input
        type="range"
        min={0}
        max={100}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="flex-1 accent-accent"
      />
      <span className="w-8 text-right tabular-nums">{value}</span>
    </label>
  );
}
