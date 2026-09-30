"use client";

import { useMemo, useState } from "react";
import { SUIT_COLORS, SUIT_SYMBOLS, cardRank, cardSuit, type Suit } from "@/lib/solver/cards";
import { CATEGORY_COLORS } from "@/lib/solver/categories";
import { fmtBb } from "@/lib/solver/gameState";
import {
  REPORT_RANKS,
  REPORT_SUITS,
  assignCards,
  summarizeRunouts,
  typicalCard,
  type RunoutGroup,
  type RunoutReport,
  type RunoutRow,
  type RunoutSummary,
} from "@/lib/solver/runouts";
import { formatFrequency } from "@/components/poker/format";

/**
 * The runouts report of a node where a card is dealt next, like Pio's
 * aggregated report: every turn (or river) card of the save with both
 * players' equity and EV and the average strategy of the player to act. Plus
 * the user's groups of cards ("bricks"…), each with one card to study.
 */

type Metric = "eq-OOP" | "eq-IP" | "ev-OOP" | "ev-IP" | "strategy";

const RED = [246, 116, 84];
const YELLOW = [255, 236, 90];
const GREEN = [150, 214, 92];
function mix(a: number[], b: number[], t: number) {
  const c = a.map((x, i) => Math.round(x + (b[i] - x) * t));
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}
/** Low → orange-red, middle → yellow, high → green (Pio's report colours). */
function heat(t: number): string {
  const x = Math.min(1, Math.max(0, t));
  return x < 0.5 ? mix(RED, YELLOW, x * 2) : mix(YELLOW, GREEN, (x - 0.5) * 2);
}

function metricValue(row: RunoutRow | RunoutSummary, m: Metric, action: number | null): number | null {
  switch (m) {
    case "eq-OOP":
      return row.equity.OOP ?? null;
    case "eq-IP":
      return row.equity.IP ?? null;
    case "ev-OOP":
      return row.ev.OOP ?? null;
    case "ev-IP":
      return row.ev.IP ?? null;
    case "strategy":
      return action == null ? null : (row.strategy?.[action] ?? null);
  }
}

function fmtMetric(v: number | null, m: Metric): string {
  if (v == null) return "";
  if (m.startsWith("ev")) return fmtBb(Math.round(v * 100) / 100);
  return v.toFixed(1);
}

/** Phones: whole numbers (EV to one decimal) so 13 columns fit. */
function fmtShort(v: number | null, m: Metric): string {
  if (v == null) return "";
  return m.startsWith("ev") ? (Math.round(v * 10) / 10).toString() : Math.round(v).toString();
}

function CardLabel({ card }: { card: string }) {
  const s = cardSuit(card) as Suit;
  return (
    <span className="font-semibold" style={{ color: SUIT_COLORS[s] }}>
      {cardRank(card)}
      {SUIT_SYMBOLS[s]}
    </span>
  );
}

export function RunoutReportView({
  report,
  groups,
  seats,
  street,
  inTree,
  busy,
  onCompute,
  onGroups,
  onOpen,
  lineLabel,
}: {
  /** Set when the report is about a later node of the street ("this line"), not the card's first decision. */
  lineLabel?: string;
  report: RunoutReport | null;
  groups: RunoutGroup[];
  seats: { OOP: string; IP: string };
  street: "turn" | "river";
  /** Cards already in the tree. */
  inTree: Set<string>;
  busy: boolean;
  onCompute: () => void;
  onGroups: (next: RunoutGroup[]) => void;
  /** Go to a card's line (importing it first when it isn't in the tree). */
  onOpen: (card: string) => void;
}) {
  const [metric, setMetric] = useState<Metric>("eq-OOP");
  // Strategy: null = the whole mix in each cell; an option = its frequency, in colour scale.
  const [action, setAction] = useState<number | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [brush, setBrush] = useState<string | null>(null);
  const [form, setForm] = useState<{ id: string | null; name: string; color: string } | null>(null);

  const rows = useMemo(() => new Map((report?.rows ?? []).map((r) => [r.card, r])), [report]);
  const nActions = report?.actions.length ?? 0;
  const all = useMemo(() => summarizeRunouts(report?.rows ?? [], nActions), [report, nActions]);
  const groupOf = useMemo(() => {
    const m = new Map<string, RunoutGroup>();
    for (const g of groups) for (const c of g.cards) m.set(c, g);
    return m;
  }, [groups]);

  if (!report) {
    return (
      <div className="rounded-lg border border-dashed border-line p-4 text-sm">
        <p className="text-muted">
          {lineLabel
            ? `This spot on every ${street} of the save: both players' equity and EV here, and how the player to act plays it on each card.`
            : `Every ${street} card of the save at a glance — both players' equity and EV, and how the player to act plays — to choose which runouts to study.`}{" "}
          Pio reads the whole save once (a few seconds).
        </p>
        <button
          type="button"
          disabled={busy}
          onClick={onCompute}
          className="mt-3 rounded-md bg-accent px-3 py-1.5 text-xs text-white disabled:opacity-50"
        >
          {busy ? "Reading…" : lineLabel ? `This line on every ${street} from Pio` : `Report on every ${street} from Pio`}
        </button>
      </div>
    );
  }

  const actor = report.actor;
  const values = [...rows.values()].map((r) => metricValue(r, metric, action)).filter((v): v is number => v != null);
  const lo = values.length ? Math.min(...values) : 0;
  const hi = values.length ? Math.max(...values) : 1;
  const tabs: { id: Metric; label: string }[] = [
    { id: "eq-OOP", label: `Equity ${seats.OOP}` },
    { id: "eq-IP", label: `Equity ${seats.IP}` },
    { id: "ev-OOP", label: `EV ${seats.OOP}` },
    { id: "ev-IP", label: `EV ${seats.IP}` },
  ];
  if (actor && nActions) tabs.push({ id: "strategy", label: `Strategy ${seats[actor]}` });
  const brushGroup = groups.find((g) => g.id === brush) ?? null;
  const hoveredRow = hovered ? rows.get(hovered) : undefined;

  function click(card: string) {
    if (!rows.has(card)) return;
    if (brushGroup) {
      const inIt = brushGroup.cards.includes(card);
      onGroups(assignCards(groups, [card], inIt ? null : brushGroup.id));
    } else onOpen(card);
  }

  function saveForm() {
    if (!form || !form.name.trim()) return;
    if (form.id) {
      onGroups(groups.map((g) => (g.id === form.id ? { ...g, name: form.name.trim(), color: form.color } : g)));
    } else {
      const id = crypto.randomUUID();
      onGroups([...groups, { id, name: form.name.trim(), color: form.color, cards: [], study: null }]);
      setBrush(id);
    }
    setForm(null);
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex flex-wrap rounded-lg border border-line bg-surface p-0.5">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              aria-pressed={metric === t.id}
              onClick={() => setMetric(t.id)}
              className={[
                "rounded-md px-2.5 py-1 text-xs transition-colors",
                metric === t.id ? "bg-accent font-medium text-white" : "text-muted hover:text-foreground",
              ].join(" ")}
            >
              {t.label}
            </button>
          ))}
        </div>
        <span className="text-[11px] text-muted">
          {report.rows.length} {street}s{report.missing.length ? ` · ${report.missing.length} not in the save` : ""}
          <button type="button" disabled={busy} onClick={onCompute} className="ml-2 underline-offset-2 hover:text-foreground hover:underline disabled:opacity-50">
            {busy ? "Reading…" : "Refresh"}
          </button>
        </span>
      </div>

      {metric === "strategy" && (
        <div className="flex flex-wrap items-center gap-1.5">
          {report.actions.map((a, i) => (
            <button
              key={a.label}
              type="button"
              aria-pressed={action === i}
              onClick={() => setAction(action === i ? null : i)}
              className={[
                "flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs",
                action === i ? "border-foreground/50 bg-foreground/[0.06]" : "border-line",
              ].join(" ")}
            >
              <span className="size-2.5 rounded-sm" style={{ backgroundColor: a.color }} />
              {a.label}
              <span className="tabular-nums text-muted">{formatFrequency(all.strategy?.[i] ?? 0)}</span>
            </button>
          ))}
          <span className="text-[11px] text-muted">
            {action == null ? "Click an option to see its frequency on each card." : "Click it again to see the whole mix."}
          </span>
        </div>
      )}

      {/* The grid: suits × ranks, like Pio's report */}
      <div className="overflow-x-auto">
        <div
          className="grid min-w-[330px] select-none gap-px rounded-md border border-line bg-line text-xs tabular-nums sm:text-sm"
          style={{ gridTemplateColumns: `minmax(1.8rem, 3rem) repeat(${REPORT_RANKS.length}, minmax(0, 1fr))` }}
          onPointerLeave={() => setHovered(null)}
        >
          <div className="relative flex items-center justify-center overflow-hidden bg-amber-200 px-0.5 py-1.5 font-semibold text-black" title="Average of every runout">
            {metric === "strategy" && action == null && all.strategy ? (
              <MixBars actions={report.actions} strategy={all.strategy} />
            ) : (
              fmtMetric(metricValue(all, metric, action), metric)
            )}
          </div>
          {REPORT_RANKS.map((r) => (
            <div key={r} className="flex items-center justify-center bg-background py-1.5 text-base font-semibold sm:text-lg">
              {r}
            </div>
          ))}
          {REPORT_SUITS.map((s) => (
            <Row key={s} suit={s}>
              {REPORT_RANKS.map((r) => {
                const card = `${r}${s}`;
                const row = rows.get(card);
                const v = row ? metricValue(row, metric, action) : null;
                const g = groupOf.get(card);
                const t = v == null ? 0 : hi > lo ? (v - lo) / (hi - lo) : 0.5;
                const strat = metric === "strategy" && row?.strategy;
                return (
                  <button
                    key={card}
                    type="button"
                    disabled={!row}
                    onClick={() => click(card)}
                    onPointerEnter={() => setHovered(card)}
                    title={row ? `${card}${g ? ` · ${g.name}` : ""}` : `${card}: not dealt here`}
                    className={[
                      "relative flex min-h-9 items-center justify-center overflow-hidden text-black sm:min-h-11",
                      row ? "cursor-pointer" : "bg-background",
                      hovered === card ? "outline outline-2 -outline-offset-2 outline-accent" : "",
                      brushGroup && row ? "cursor-cell" : "",
                    ].join(" ")}
                    style={row && v != null ? { backgroundColor: heat(t) } : undefined}
                  >
                    {/* Strategy: the whole mix over the cell; with an option picked, its
                        frequency in colour scale and the mix along the bottom. */}
                    {strat && action == null && <MixBars actions={report.actions} strategy={strat} />}
                    {strat && action != null && (
                      <span className="absolute inset-x-0 bottom-0 flex h-1.5 sm:h-2">
                        {report.actions.map((a, i) =>
                          (strat[i] ?? 0) > 0 ? <span key={a.label} style={{ width: `${strat[i]}%`, backgroundColor: a.color }} /> : null,
                        )}
                      </span>
                    )}
                    {g && <span className="absolute inset-x-0 top-0 h-1.5" style={{ backgroundColor: g.color }} />}
                    <span className="relative hidden sm:inline">{fmtMetric(v, metric)}</span>
                    <span className="relative sm:hidden">{fmtShort(v, metric)}</span>
                    {g?.study === card && <span className="absolute left-0.5 top-1 text-[10px] leading-none">★</span>}
                    {inTree.has(card) && <span className="absolute right-0.5 top-2 size-1.5 rounded-full bg-black/60" title="In the tree" />}
                  </button>
                );
              })}
            </Row>
          ))}
        </div>
      </div>

      <p className="min-h-[1.25rem] text-[11px] tabular-nums text-muted">
        {hoveredRow ? (
          <>
            <CardLabel card={hoveredRow.card} /> · Equity {seats.OOP} {fmtMetric(hoveredRow.equity.OOP ?? null, "eq-OOP")}% · {seats.IP}{" "}
            {fmtMetric(hoveredRow.equity.IP ?? null, "eq-IP")}% · EV {seats.OOP} {fmtMetric(hoveredRow.ev.OOP ?? null, "ev-OOP")} ·{" "}
            {seats.IP} {fmtMetric(hoveredRow.ev.IP ?? null, "ev-IP")} bb
            {hoveredRow.strategy &&
              ` · ${report.actions.map((a, i) => `${a.label} ${formatFrequency(hoveredRow.strategy![i] ?? 0)}`).join(", ")}`}
            {groupOf.get(hoveredRow.card) ? ` · ${groupOf.get(hoveredRow.card)!.name}` : ""}
            {inTree.has(hoveredRow.card) ? " · in the tree" : ""}
          </>
        ) : brushGroup ? (
          <>
            Click cards to put them in <b style={{ color: brushGroup.color }}>{brushGroup.name}</b> (again to take them out).
          </>
        ) : (
          "Click a card to open its line (it is imported from Pio if it isn't in the tree). ● = in the tree, ★ = studied for its group."
        )}
      </p>

      {/* Groups of runouts */}
      <div className="overflow-hidden rounded-lg border border-line text-xs">
        <div className="grid grid-cols-[minmax(0,1fr)_repeat(4,3.2rem)] items-center gap-2 bg-foreground/[0.03] px-3 py-1 text-[10px] font-medium uppercase tracking-wide text-muted sm:grid-cols-[minmax(0,1fr)_repeat(4,3.6rem)_6rem_9rem]">
          <span>Group</span>
          <span className="text-right">Eq {seats.OOP}</span>
          <span className="text-right">Eq {seats.IP}</span>
          <span className="text-right">EV {seats.OOP}</span>
          <span className="text-right">EV {seats.IP}</span>
          <span className="hidden sm:block">{actor ? seats[actor] : ""}</span>
          <span className="hidden sm:block">Study</span>
        </div>
        <GroupRow name={`All ${street}s`} color="#d6d3ce" summary={all} actions={report.actions} />
        {groups.map((g) => {
          const mine = report.rows.filter((r) => g.cards.includes(r.card));
          const typical = typicalCard(report.rows, g.cards);
          return (
            <GroupRow
              key={g.id}
              name={g.name}
              color={g.color}
              summary={summarizeRunouts(mine, nActions)}
              actions={report.actions}
              active={brush === g.id}
              onClick={() => setBrush(brush === g.id ? null : g.id)}
              onEdit={() => setForm({ id: g.id, name: g.name, color: g.color })}
              study={
                <StudyPicker
                  group={g}
                  typical={typical}
                  inTree={inTree}
                  onPick={(card) => onGroups(groups.map((x) => (x.id === g.id ? { ...x, study: card } : x)))}
                  onOpen={onOpen}
                />
              }
            />
          );
        })}
        {groups.length > 0 && (
          <GroupRow
            name="Not grouped"
            color="#ffffff"
            summary={summarizeRunouts(report.rows.filter((r) => !groupOf.has(r.card)), nActions)}
            actions={report.actions}
            muted
          />
        )}
        {form ? (
          <form
            className="flex flex-wrap items-center gap-2 border-t border-line bg-background/60 px-3 py-2"
            onSubmit={(e) => {
              e.preventDefault();
              saveForm();
            }}
          >
            <input
              autoFocus
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              onKeyDown={(e) => e.key === "Escape" && setForm(null)}
              placeholder="Name (bricks, flush cards, overcards…)"
              className="min-w-0 flex-1 basis-40 rounded-md border border-line bg-surface px-2 py-1 text-xs outline-none focus:border-accent"
            />
            <div className="flex flex-wrap items-center gap-1">
              {CATEGORY_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  aria-label={`Color ${c}`}
                  onClick={() => setForm({ ...form, color: c })}
                  className={["size-5 rounded-full border-2", form.color === c ? "border-foreground" : "border-transparent"].join(" ")}
                  style={{ backgroundColor: c }}
                />
              ))}
            </div>
            <button type="submit" disabled={!form.name.trim()} className="rounded-md bg-accent px-2 py-1 text-white disabled:opacity-50">
              {form.id ? "Save" : "Create"}
            </button>
            <button type="button" onClick={() => setForm(null)} className="rounded-md px-2 py-1 text-muted hover:text-foreground">
              Cancel
            </button>
            {form.id && (
              <button
                type="button"
                onClick={() => {
                  const g = groups.find((x) => x.id === form.id);
                  if (g && window.confirm(`Delete the group “${g.name}”? Its cards stay in the report.`)) {
                    onGroups(groups.filter((x) => x.id !== form.id));
                    if (brush === form.id) setBrush(null);
                    setForm(null);
                  }
                }}
                className="rounded-md px-2 py-1 text-red-600 hover:bg-red-600/10"
              >
                Delete
              </button>
            )}
          </form>
        ) : (
          <button
            type="button"
            onClick={() => {
              const used = new Set(groups.map((g) => g.color));
              setForm({ id: null, name: "", color: CATEGORY_COLORS.find((c) => !used.has(c)) ?? CATEGORY_COLORS[0] });
            }}
            className="w-full border-t border-line px-3 py-1.5 text-left text-muted hover:bg-foreground/5 hover:text-foreground"
          >
            ＋ New group of {street}s
          </button>
        )}
      </div>
    </div>
  );
}

/** The options' frequencies side by side over the whole cell. */
function MixBars({ actions, strategy }: { actions: RunoutReport["actions"]; strategy: number[] }) {
  const total = strategy.reduce((a, b) => a + (b ?? 0), 0) || 1;
  return (
    <span
      className="absolute inset-0 flex"
      title={actions.map((a, i) => `${a.label} ${formatFrequency(strategy[i] ?? 0)}`).join(" · ")}
    >
      {actions.map((a, i) =>
        (strategy[i] ?? 0) > 0 ? <span key={a.label} style={{ width: `${((strategy[i] ?? 0) / total) * 100}%`, backgroundColor: a.color }} /> : null,
      )}
    </span>
  );
}

function Row({ suit, children }: { suit: Suit; children: React.ReactNode }) {
  return (
    <>
      <div className="flex items-center justify-center bg-background text-lg sm:text-2xl" style={{ color: SUIT_COLORS[suit] }}>
        {SUIT_SYMBOLS[suit]}
      </div>
      {children}
    </>
  );
}

function GroupRow({
  name,
  color,
  summary,
  actions,
  active,
  muted,
  onClick,
  onEdit,
  study,
}: {
  name: string;
  color: string;
  summary: RunoutSummary;
  actions: RunoutReport["actions"];
  active?: boolean;
  muted?: boolean;
  onClick?: () => void;
  onEdit?: () => void;
  study?: React.ReactNode;
}) {
  const f = (v: number | undefined, ev = false) => (v == null ? "—" : ev ? fmtBb(Math.round(v * 100) / 100) : `${v.toFixed(1)}%`);
  return (
    <div
      className={[
        "grid grid-cols-[minmax(0,1fr)_repeat(4,3.2rem)] items-center gap-2 border-t border-line px-3 py-1.5 tabular-nums sm:grid-cols-[minmax(0,1fr)_repeat(4,3.6rem)_6rem_9rem]",
        active ? "bg-foreground/[0.06]" : "",
        onClick ? "cursor-pointer hover:bg-foreground/5" : "",
      ].join(" ")}
      onClick={onClick}
      role={onClick ? "button" : undefined}
      aria-pressed={onClick ? active : undefined}
    >
      <span className="flex min-w-0 items-center gap-1.5">
        <span
          className={["size-3 shrink-0 rounded-sm border border-black/10", active ? "ring-2 ring-offset-1 ring-offset-surface" : ""].join(" ")}
          style={{ backgroundColor: color, ["--tw-ring-color" as string]: color }}
        />
        <span className={["truncate font-medium", muted ? "text-muted" : ""].join(" ")}>{name}</span>
        <span className="shrink-0 text-muted">{summary.cards}</span>
        {onEdit && (
          <button
            type="button"
            aria-label={`Edit ${name}`}
            onClick={(e) => {
              e.stopPropagation();
              onEdit();
            }}
            className="shrink-0 text-muted opacity-60 hover:text-foreground hover:opacity-100"
          >
            ✎
          </button>
        )}
      </span>
      <span className="text-right">{f(summary.equity.OOP)}</span>
      <span className="text-right">{f(summary.equity.IP)}</span>
      <span className="text-right">{f(summary.ev.OOP, true)}</span>
      <span className="text-right">{f(summary.ev.IP, true)}</span>
      <span className="hidden sm:block">
        {summary.strategy ? (
          <span
            className="flex h-3.5 overflow-hidden rounded-sm"
            title={actions.map((a, i) => `${a.label} ${formatFrequency(summary.strategy![i] ?? 0)}`).join(" · ")}
          >
            {actions.map((a, i) =>
              (summary.strategy![i] ?? 0) > 0 ? <span key={a.label} style={{ width: `${summary.strategy![i]}%`, backgroundColor: a.color }} /> : null,
            )}
          </span>
        ) : null}
      </span>
      <span className="col-span-full sm:col-span-1" onClick={(e) => e.stopPropagation()}>
        {study}
      </span>
    </div>
  );
}

function StudyPicker({
  group,
  typical,
  inTree,
  onPick,
  onOpen,
}: {
  group: RunoutGroup;
  typical: string | null;
  inTree: Set<string>;
  onPick: (card: string | null) => void;
  onOpen: (card: string) => void;
}) {
  if (group.cards.length === 0) return <span className="text-[11px] text-muted">Click cards to add</span>;
  return (
    <span className="flex items-center gap-1">
      <select
        value={group.study ?? ""}
        onChange={(e) => onPick(e.target.value || null)}
        aria-label={`Card studied for ${group.name}`}
        className="min-w-0 rounded border border-line bg-surface px-1 py-0.5 text-[11px]"
      >
        <option value="">{typical ? `Pick (typical: ${typical})` : "Pick"}</option>
        {group.cards.map((c) => (
          <option key={c} value={c}>
            {c}
            {c === typical ? " · typical" : ""}
          </option>
        ))}
      </select>
      {group.study ? (
        <button type="button" onClick={() => onOpen(group.study!)} className="shrink-0 rounded bg-accent px-1.5 py-0.5 text-[11px] text-white">
          {inTree.has(group.study) ? "Open" : "Import"}
        </button>
      ) : (
        typical && (
          <button type="button" onClick={() => onPick(typical)} className="shrink-0 rounded border border-line px-1.5 py-0.5 text-[11px] hover:border-accent">
            Use {typical}
          </button>
        )
      )}
    </span>
  );
}

