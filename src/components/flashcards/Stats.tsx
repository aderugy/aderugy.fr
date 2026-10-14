import Link from "next/link";
import type { ReactNode } from "react";
import { addDaysISO, mondayOf } from "@/lib/agenda/zoned";
import { plainText } from "@/lib/flashcards/notes";
import type { Stats } from "@/server/flashcards/data";
import { DeckFilter } from "./DeckFilter";

/**
 * Three questions: am I remembering (retention against the target), how much
 * work is coming (the 30-day forecast), am I regular (the year's heatmap,
 * the streak, time per day). Charts are plain SVG in the site's colours, one
 * hue each; every mark carries a native tooltip with its exact value.
 */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const short = (day: string) => `${Number(day.slice(8))} ${MONTHS[Number(day.slice(5, 7)) - 1]}`;

function Panel({ title, note, children }: { title: string; note?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-line bg-surface p-4">
      <h2 className="text-sm font-medium">{title}</h2>
      {note && <p className="mt-0.5 text-xs text-muted">{note}</p>}
      <div className="mt-3">{children}</div>
    </section>
  );
}

function Tile({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="rounded-lg border border-line bg-surface px-4 py-3">
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
      {sub && <p className="mt-0.5 text-xs text-muted">{sub}</p>}
    </div>
  );
}

/** Columns of bars for one series over consecutive days. */
function Bars({
  data,
  unit,
  labelEvery = 7,
  height = 120,
}: {
  data: { day: string; value: number; tip: string }[];
  unit: string;
  labelEvery?: number;
  height?: number;
}) {
  const max = Math.max(1, ...data.map((d) => d.value));
  const w = 640;
  const left = 32;
  const plotH = height - 22;
  const step = (w - left) / Math.max(1, data.length);
  const bar = Math.max(2, step - 2);
  const ticks = [0, Math.round(max / 2), max].filter((v, i, a) => a.indexOf(v) === i);
  return (
    <svg viewBox={`0 0 ${w} ${height}`} className="w-full" role="img" aria-label={`Bars, ${unit}`}>
      {ticks.map((t) => {
        const y = plotH - (t / max) * (plotH - 8);
        return (
          <g key={t}>
            <line x1={left} x2={w} y1={y} y2={y} stroke="var(--border)" strokeWidth={1} />
            <text x={left - 6} y={y + 3.5} textAnchor="end" fontSize={10} fill="var(--muted)">
              {t}
            </text>
          </g>
        );
      })}
      {data.map((d, i) => {
        const h = (d.value / max) * (plotH - 8);
        const x = left + i * step + 1;
        return (
          <g key={d.day}>
            <title>{d.tip}</title>
            {/* A hit target taller than the bar. */}
            <rect x={x - 1} y={0} width={step} height={plotH} fill="transparent" />
            {d.value > 0 && <rect x={x} y={plotH - h} width={bar} height={h} rx={Math.min(2, bar / 2)} fill="var(--accent)" />}
            {i % labelEvery === 0 && (
              <text x={x + bar / 2} y={height - 6} textAnchor="middle" fontSize={10} fill="var(--muted)">
                {short(d.day)}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

function Heatmap({ days, today }: { days: Stats["days"]; today: string }) {
  const counts = new Map(days.map((d) => [d.day, d.reviews + d.cram]));
  const start = mondayOf(addDaysISO(today, -364));
  const weeks: string[][] = [];
  for (let w = start; w <= today; w = addDaysISO(w, 7)) {
    weeks.push(Array.from({ length: 7 }, (_, i) => addDaysISO(w, i)));
  }
  const values = [...counts.values()].filter((v) => v > 0).sort((a, b) => a - b);
  // Four steps by quartile of active days, so one huge day does not wash the rest out.
  const q = (p: number) => values[Math.min(values.length - 1, Math.floor(p * values.length))] ?? 1;
  const levels = [q(0.25), q(0.5), q(0.75)];
  const level = (v: number) => (v <= 0 ? 0 : v <= levels[0] ? 1 : v <= levels[1] ? 2 : v <= levels[2] ? 3 : 4);
  const opacity = [0, 0.3, 0.5, 0.75, 1];
  const cell = 11;
  const gap = 2;
  const top = 14;
  const left = 22;
  const width = left + weeks.length * (cell + gap);
  const height = top + 7 * (cell + gap);
  return (
    <div className="overflow-x-auto">
      <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} role="img" aria-label="Ratings per day over the last year">
        {["Mon", "Wed", "Fri"].map((d, i) => (
          <text key={d} x={0} y={top + (i * 2) * (cell + gap) + 9} fontSize={9} fill="var(--muted)">
            {d}
          </text>
        ))}
        {weeks.map((week, wi) => {
          const firstOfMonth = week.find((d) => d.endsWith("-01"));
          return (
            <g key={week[0]}>
              {firstOfMonth && (
                <text x={left + wi * (cell + gap)} y={9} fontSize={9} fill="var(--muted)">
                  {MONTHS[Number(firstOfMonth.slice(5, 7)) - 1]}
                </text>
              )}
              {week.map((day, di) => {
                if (day > today) return null;
                const v = counts.get(day) ?? 0;
                const l = level(v);
                return (
                  <rect
                    key={day}
                    x={left + wi * (cell + gap)}
                    y={top + di * (cell + gap)}
                    width={cell}
                    height={cell}
                    rx={2}
                    fill={l === 0 ? "var(--border)" : "var(--accent)"}
                    fillOpacity={l === 0 ? 1 : opacity[l]}
                  >
                    <title>{`${short(day)}: ${v} rating${v === 1 ? "" : "s"}`}</title>
                  </rect>
                );
              })}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function Retention({ days, today, target }: { days: Stats["days"]; today: string; target: number }) {
  // Twelve weeks, Monday to Sunday; a week with fewer than 5 sampled cards is drawn hollow.
  const weeks = Array.from({ length: 12 }, (_, i) => mondayOf(addDaysISO(today, -7 * (11 - i))));
  const rows = weeks.map((w) => {
    const end = addDaysISO(w, 6);
    const inWeek = days.filter((d) => d.day >= w && d.day <= end);
    const pass = inWeek.reduce((s, d) => s + d.pass, 0);
    const total = inWeek.reduce((s, d) => s + d.total, 0);
    return { week: w, pass, total, rate: total ? pass / total : null };
  });
  const w = 640;
  const h = 140;
  const left = 32;
  const plotTop = 8;
  const plotBottom = h - 22;
  const lo = 0.5;
  const y = (r: number) => plotBottom - ((Math.max(lo, r) - lo) / (1 - lo)) * (plotBottom - plotTop);
  const step = (w - left - 16) / (rows.length - 1);
  const x = (i: number) => left + 8 + i * step;
  const pts = rows.map((r, i) => (r.rate === null ? null : `${x(i)},${y(r.rate)}`));
  // The line breaks over weeks with nothing to sample.
  const segments: string[][] = [];
  let run: string[] = [];
  for (const p of pts) {
    if (p === null) {
      if (run.length) segments.push(run);
      run = [];
    } else run.push(p);
  }
  if (run.length) segments.push(run);
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full" role="img" aria-label="Weekly retention against the target">
      {[0.5, 0.75, 1].map((t) => (
        <g key={t}>
          <line x1={left} x2={w} y1={y(t)} y2={y(t)} stroke="var(--border)" />
          <text x={left - 6} y={y(t) + 3.5} textAnchor="end" fontSize={10} fill="var(--muted)">
            {Math.round(t * 100)}%
          </text>
        </g>
      ))}
      <line x1={left} x2={w} y1={y(target)} y2={y(target)} stroke="var(--muted)" strokeDasharray="4 4" />
      <text x={w - 2} y={y(target) - 4} textAnchor="end" fontSize={10} fill="var(--muted)">
        target {Math.round(target * 100)}%
      </text>
      {segments.filter((s) => s.length > 1).map((s, i) => (
        <polyline key={i} points={s.join(" ")} fill="none" stroke="var(--accent)" strokeWidth={2} />
      ))}
      {rows.map((r, i) => (
        <g key={r.week}>
          <title>{r.rate === null ? `Week of ${short(r.week)}: no review card rated` : `Week of ${short(r.week)}: ${Math.round(r.rate * 100)}% (${r.pass}/${r.total})`}</title>
          <rect x={x(i) - step / 2} y={0} width={step} height={plotBottom} fill="transparent" />
          {r.rate !== null && (
            <circle
              cx={x(i)}
              cy={y(r.rate)}
              r={4}
              fill={r.total >= 5 ? "var(--accent)" : "var(--surface)"}
              stroke="var(--accent)"
              strokeWidth={2}
            />
          )}
          {i % 2 === 0 && (
            <text x={x(i)} y={h - 6} textAnchor="middle" fontSize={10} fill="var(--muted)">
              {short(r.week)}
            </text>
          )}
        </g>
      ))}
    </svg>
  );
}

export function StatsView({ stats, deckId, decks }: { stats: Stats; deckId: string | null; decks: { id: string; path: string; depth: number }[] }) {
  const { days, today, settings } = stats;
  const todayRow = days.find((d) => d.day === today);
  const last30 = Array.from({ length: 30 }, (_, i) => addDaysISO(today, i - 29));
  const recent = days.filter((d) => d.day >= last30[0]);
  const pass30 = recent.reduce((s, d) => s + d.pass, 0);
  const total30 = recent.reduce((s, d) => s + d.total, 0);
  const minutes30 = recent.reduce((s, d) => s + d.ms, 0) / 60_000;
  const forecast = new Map(stats.forecast.map((f) => [f.day, f.cards]));
  const next30 = Array.from({ length: 30 }, (_, i) => addDaysISO(today, i));
  const states = stats.states;
  const totalCards = states.new + states.learning + states.review + states.relearning + states.suspended;

  return (
    <main className="mx-auto w-full max-w-4xl space-y-4 px-4 py-6 sm:px-6 sm:py-8">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold tracking-tight">Stats</h1>
        <div className="ml-auto">
          <DeckFilter decks={decks} value={deckId} path="/flashcards/stats" />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Tile label="Streak" value={`${stats.streak} d`} sub={stats.streak ? "days in a row" : "study today to start one"} />
        <Tile
          label="Today"
          value={(todayRow?.reviews ?? 0) + (todayRow?.cram ?? 0)}
          sub={`${Math.round((todayRow?.ms ?? 0) / 60_000)} min · ${todayRow?.newCards ?? 0} new`}
        />
        <Tile
          label="Retention, 30 days"
          value={total30 ? `${Math.round((pass30 / total30) * 100)}%` : "—"}
          sub={total30 ? `${pass30}/${total30} · target ${Math.round(settings.retention * 100)}%` : "no review card rated yet"}
        />
        <Tile label="Time, 30 days" value={`${Math.round(minutes30)} min`} sub={`${Math.round(minutes30 / 30)} min a day on average`} />
      </div>

      <Panel title="Ratings over the year" note="Each square is a review day; darker means more ratings.">
        <Heatmap days={days} today={today} />
      </Panel>

      <div className="grid gap-4 md:grid-cols-2">
        <Panel title="Due in the next 30 days" note={`${forecast.get(today) ?? 0} today (overdue included) · ${forecast.get(addDaysISO(today, 1)) ?? 0} tomorrow`}>
          <Bars data={next30.map((d) => ({ day: d, value: forecast.get(d) ?? 0, tip: `${short(d)}: ${forecast.get(d) ?? 0} due` }))} unit="cards due" />
        </Panel>
        <Panel title="Time per day" note="Minutes spent reviewing, last 30 days (cram included).">
          <Bars
            data={last30.map((d) => {
              const m = Math.round((days.find((x) => x.day === d)?.ms ?? 0) / 60_000);
              return { day: d, value: m, tip: `${short(d)}: ${m} min` };
            })}
            unit="minutes"
          />
        </Panel>
      </div>

      <Panel
        title="Retention by week"
        note="Share of review cards remembered (not Again) on their first rating of the day. Hollow points rest on fewer than 5 cards."
      >
        <Retention days={days} today={today} target={settings.retention} />
      </Panel>

      <div className="grid gap-4 md:grid-cols-2">
        <Panel title="Cards" note={`${totalCards} in total`}>
          <table className="w-full text-sm">
            <tbody>
              {(
                [
                  ["New", states.new],
                  ["Learning", states.learning],
                  ["Review", states.review],
                  ["Relearning", states.relearning],
                  ["Suspended", states.suspended],
                ] as const
              ).map(([label, n]) => (
                <tr key={label} className="border-b border-line last:border-b-0">
                  <td className="py-1.5">{label}</td>
                  <td className="py-1.5 text-right tabular-nums">{n}</td>
                  <td className="w-24 py-1.5 pl-3">
                    <div className="h-1.5 rounded-full bg-line">
                      <div className="h-1.5 rounded-full bg-accent" style={{ width: `${totalCards ? (n / totalCards) * 100 : 0}%` }} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>

        <Panel title="Hardest cards" note="Most lapses, then highest difficulty. Rewrite or split them.">
          {stats.hardest.length === 0 ? (
            <p className="text-sm text-muted">Nothing yet.</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {stats.hardest.slice(0, 10).map((h) => (
                <li key={h.card.id}>
                  <Link href={`/flashcards/notes/${h.note.id}`} className="block hover:text-accent">
                    <span className="line-clamp-1">{plainText(h.note.front)}</span>
                    <span className="text-xs text-muted">
                      {h.card.lapses} lapse{h.card.lapses === 1 ? "" : "s"} · difficulty {h.card.difficulty.toFixed(1)} · {h.deckPath}
                      {h.card.suspended ? " · suspended" : ""}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </main>
  );
}
