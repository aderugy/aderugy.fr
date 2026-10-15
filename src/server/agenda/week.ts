import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { countsAsCommitted, withoutHidden } from "@/lib/external";
import type { CalendarSource, ExternalEvent, HiddenEventRule } from "@/lib/types";
import { weekSpan, type Span, type ViewEvent, type ViewSession } from "@/lib/agenda/week-view";

/** The columns of a hidden-event rule (migration 0024). */
export const HIDDEN_COLUMNS = "id, calendar_source_id, external_event_id, title, label, starts_at, created_at";

/**
 * Reading the week grid for the Claude connector: sessions with their tasks,
 * the calendars' events that count, the week's intent and objectives.
 * Read-only — a week that does not exist yet is not created by looking at it.
 */

const SESSION_COLUMNS =
  "id, task_id, starts_at, ends_at, status, created_by, tasks(category_id, description, status)";

type SessionRow = {
  id: string;
  task_id: string;
  starts_at: string;
  ends_at: string;
  status: ViewSession["status"];
  created_by: ViewSession["created_by"] | null;
  tasks: { category_id: string; description: string | null; status: string } | null;
};

/** Sessions whose start lies in `span`, in order. */
export async function loadSessions(db: SupabaseClient, userId: string, span: Span): Promise<ViewSession[]> {
  const { data, error } = await db
    .from("task_sessions")
    .select(SESSION_COLUMNS)
    .eq("user_id", userId)
    .gte("starts_at", new Date(span.start).toISOString())
    .lt("starts_at", new Date(span.end).toISOString())
    .order("starts_at");
  if (error) throw error;
  const rows = ((data ?? []) as unknown as SessionRow[]).filter((r) => r.tasks);

  // Interviews from /jobs, best effort: the week reads fine without them.
  const interviews = new Map<string, string>();
  if (rows.length) {
    const { data: iv } = await db
      .from("interviews")
      .select("session_id, kind, applications(companies(name))")
      .in(
        "session_id",
        rows.map((r) => r.id),
      );
    for (const r of (iv ?? []) as unknown as {
      session_id: string;
      kind: string;
      applications: { companies: { name: string } | { name: string }[] | null } | null;
    }[]) {
      const c = r.applications?.companies;
      const company = (Array.isArray(c) ? c[0]?.name : c?.name) ?? "?";
      interviews.set(r.session_id, `Interview (${r.kind}) · ${company}`);
    }
  }

  return rows.map((r) => ({
    id: r.id,
    task_id: r.task_id,
    starts_at: r.starts_at,
    ends_at: r.ends_at,
    status: r.status,
    created_by: r.created_by ?? "app",
    category_id: r.tasks!.category_id,
    description: r.tasks!.description,
    task_status: r.tasks!.status,
    interview: interviews.get(r.id) ?? null,
  }));
}

export async function getSession(db: SupabaseClient, userId: string, id: string): Promise<ViewSession | null> {
  const { data, error } = await db
    .from("task_sessions")
    .select("starts_at")
    .eq("user_id", userId)
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const t = Date.parse(data.starts_at as string);
  const sessions = await loadSessions(db, userId, { start: t, end: t + 1 });
  return sessions.find((s) => s.id === id) ?? null;
}

/** Calendar events that count (enabled calendar, not cancelled, busy, not hidden…) overlapping `span`. */
export async function loadEvents(db: SupabaseClient, userId: string, span: Span): Promise<ViewEvent[]> {
  const [events, sources, hidden] = await Promise.all([
    db
      .from("external_events")
      .select("calendar_source_id, external_event_id, title, starts_at, ends_at, all_day, status, transparency, attendee_response, archived_at")
      .eq("user_id", userId)
      .lt("starts_at", new Date(span.end).toISOString())
      .gt("ends_at", new Date(span.start).toISOString())
      .order("starts_at"),
    db
      .from("calendar_sources")
      .select("id, provider, external_id, display_name, color, category_id, enabled, include_all_day, include_free, include_declined, position")
      .eq("user_id", userId),
    db.from("hidden_external_events").select(HIDDEN_COLUMNS).eq("user_id", userId),
  ]);
  // A broken calendar integration degrades the week; it does not fail it.
  if (events.error || sources.error) return [];
  const byId = new Map(((sources.data ?? []) as CalendarSource[]).map((s) => [s.id, s]));
  const out: ViewEvent[] = [];
  // Hidden events are left out; if the rules cannot be read, nothing is hidden.
  for (const e of withoutHidden((events.data ?? []) as ExternalEvent[], (hidden.data ?? []) as HiddenEventRule[])) {
    const s = byId.get(e.calendar_source_id);
    if (!s || !countsAsCommitted(e, s)) continue;
    if (e.all_day && !s.include_all_day) continue;
    out.push({
      calendar: s.display_name,
      category_id: s.category_id,
      title: e.title,
      starts_at: e.starts_at,
      ends_at: e.ends_at,
      all_day: e.all_day,
      archived: Boolean(e.archived_at),
    });
  }
  return out;
}

export type WeekIntent = {
  theme: string | null;
  guidelines: string | null;
  objectives: { title: string; category_id: string | null; target_minutes: number | null; done: boolean }[];
};

export async function loadIntent(db: SupabaseClient, userId: string, monday: string): Promise<WeekIntent> {
  const { data: week, error } = await db
    .from("weeks")
    .select("id, theme, guidelines")
    .eq("user_id", userId)
    .eq("week_start", monday)
    .maybeSingle();
  if (error) throw error;
  if (!week) return { theme: null, guidelines: null, objectives: [] };
  const { data: objectives, error: oError } = await db
    .from("objectives")
    .select("title, category_id, target_minutes, done, position")
    .eq("week_id", week.id)
    .order("position");
  if (oError) throw oError;
  return {
    theme: week.theme as string | null,
    guidelines: week.guidelines as string | null,
    objectives: (objectives ?? []) as WeekIntent["objectives"],
  };
}

export async function loadWeek(db: SupabaseClient, userId: string, monday: string, timeZone: string) {
  const span = weekSpan(monday, timeZone);
  const [sessions, events, intent] = await Promise.all([
    loadSessions(db, userId, span),
    loadEvents(db, userId, span),
    loadIntent(db, userId, monday),
  ]);
  return { span, sessions, events, intent };
}
