import Link from "next/link";
import type { SupabaseClient } from "@supabase/supabase-js";
import { activeFocus, unreadFor } from "@/server/projects/data";
import { clockOf, fmtMinutes } from "@/lib/projects/clock";
import { stateTone } from "./tone";

/**
 * The /agenda header's glance at the research focus: the open step, its
 * clock and its state colour. With several active projects, the step opened
 * most recently wins and the others are counted. Tapping opens the project.
 *
 * Never breaks the agenda: before migration 0030, or on any error, it shows
 * nothing.
 */
export async function FocusChip({ db, userId }: { db: SupabaseClient; userId: string }) {
  let states;
  try {
    states = await activeFocus(db, userId);
  } catch {
    return null;
  }
  if (!states.length) return null;

  const withOpen = states
    .filter((s) => s.open)
    .sort((a, b) => (b.open!.opened_at ?? "").localeCompare(a.open!.opened_at ?? ""));
  const main = withOpen[0] ?? states[0];
  const others = states.length - 1;
  const unread = states.reduce((n, s) => n + unreadFor(s, "arthur").length, 0);

  if (!main.open) {
    return (
      <Link
        href={`/projects/${main.project.slug}`}
        className="flex min-w-0 items-center gap-1.5 rounded-full border border-line px-2 py-0.5 text-xs text-muted hover:border-accent"
      >
        <span className="font-mono">{main.project.slug}</span>
        <span className="hidden sm:inline">· aucune étape ouverte</span>
        {unread > 0 && <span className="text-accent">✉{unread}</span>}
      </Link>
    );
  }

  const s = main.open;
  const c = clockOf(s.totals.spent, s.budget_minutes, s.cut_minutes);
  const tone = stateTone(c.state);
  return (
    <Link
      href={`/projects/${main.project.slug}`}
      title={`${main.project.slug} · ${s.code} ${s.title} · ${tone.label}`}
      className="flex min-w-0 items-center gap-1.5 rounded-full border border-line px-2 py-0.5 text-xs hover:border-accent"
    >
      <span className={`h-2 w-2 shrink-0 rounded-full ${tone.bar}`} aria-hidden />
      <span className="font-mono">{main.project.slug}</span>
      <span className="font-mono text-muted">{s.code}</span>
      <span className="hidden max-w-40 truncate md:inline">{s.title}</span>
      <span className={`tabular-nums ${tone.text}`}>
        ⏱ {fmtMinutes(c.spent)}/{fmtMinutes(c.budget)}
      </span>
      {unread > 0 && <span className="text-accent">✉{unread}</span>}
      {others > 0 && <span className="text-muted">+{others}</span>}
    </Link>
  );
}
