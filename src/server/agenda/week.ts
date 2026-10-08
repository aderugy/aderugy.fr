import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { countsAsCommitted } from "@/lib/external";
import type { CalendarSource, ExternalEvent } from "@/lib/types";
import { weekSpan, type Span, type ViewBlock, type ViewEvent } from "@/lib/agenda/week-view";

/**
 * Reading the week grid for the Claude connector: blocks with what is inside
 * them, the calendars' events that count, the week's intent and objectives.
 * Read-only — a week that does not exist yet is not created by looking at it.
 */

const BLOCK_COLUMNS =
  "id, starts_at, ends_at, description, source_block_id, status, created_by, scheduled_block_tasks(task_id, planned_minutes, position, tasks(id, description, category_id, ad_hoc))";

type BlockRow = {
  id: string;
  starts_at: string;
  ends_at: string;
  description: string | null;
  source_block_id: string | null;
  status: ViewBlock["status"];
  created_by: ViewBlock["created_by"] | null;
  scheduled_block_tasks: {
    task_id: string;
    planned_minutes: number;
    position: number;
    tasks: { id: string; description: string | null; category_id: string; ad_hoc: boolean } | null;
  }[];
};

export type Template = {
  id: string;
  name: string;
  default_minutes: number;
  default_category_id: string;
  preferred_daypart: "morning" | "afternoon" | "evening" | null;
  items: { label: string; estimated_minutes: number; category_id: string | null }[];
};

export async function loadTemplates(db: SupabaseClient, userId: string): Promise<Template[]> {
  const { data, error } = await db
    .from("blocks")
    .select("id, name, default_minutes, default_category_id, preferred_daypart, block_items(position, label, estimated_minutes, category_id)")
    .eq("user_id", userId)
    .eq("archived", false)
    .order("name");
  if (error) throw error;
  return (data ?? []).map((b) => {
    const row = b as Omit<Template, "items"> & {
      block_items: { position: number; label: string; estimated_minutes: number; category_id: string | null }[];
    };
    const { block_items, ...rest } = row;
    return {
      ...rest,
      items: [...(block_items ?? [])]
        .sort((x, y) => x.position - y.position)
        .map((i) => ({ label: i.label, estimated_minutes: i.estimated_minutes, category_id: i.category_id })),
    };
  });
}

/** Blocks whose start lies in `span`, with their tasks in order. */
export async function loadBlocks(db: SupabaseClient, userId: string, span: Span): Promise<ViewBlock[]> {
  const [{ data, error }, templates] = await Promise.all([
    db
      .from("scheduled_blocks")
      .select(BLOCK_COLUMNS)
      .eq("user_id", userId)
      .gte("starts_at", new Date(span.start).toISOString())
      .lt("starts_at", new Date(span.end).toISOString())
      .order("starts_at"),
    db.from("blocks").select("id, name").eq("user_id", userId),
  ]);
  if (error) throw error;
  const names = new Map(((templates.data ?? []) as { id: string; name: string }[]).map((t) => [t.id, t.name]));
  const rows = (data ?? []) as unknown as BlockRow[];

  // Interviews from /jobs, best effort: the week reads fine without them.
  const interviews = new Map<string, string>();
  if (rows.length) {
    const { data: iv } = await db
      .from("interviews")
      .select("scheduled_block_id, kind, applications(companies(name))")
      .in(
        "scheduled_block_id",
        rows.map((r) => r.id),
      );
    for (const r of (iv ?? []) as unknown as {
      scheduled_block_id: string;
      kind: string;
      applications: { companies: { name: string } | { name: string }[] | null } | null;
    }[]) {
      const c = r.applications?.companies;
      const company = (Array.isArray(c) ? c[0]?.name : c?.name) ?? "?";
      interviews.set(r.scheduled_block_id, `Interview (${r.kind}) · ${company}`);
    }
  }

  return rows.map((r) => ({
    id: r.id,
    starts_at: r.starts_at,
    ends_at: r.ends_at,
    description: r.description,
    status: r.status,
    created_by: r.created_by ?? "app",
    template: r.source_block_id ? (names.get(r.source_block_id) ?? null) : null,
    interview: interviews.get(r.id) ?? null,
    tasks: [...(r.scheduled_block_tasks ?? [])]
      .sort((a, b) => a.position - b.position || a.task_id.localeCompare(b.task_id))
      .filter((l) => l.tasks)
      .map((l) => ({
        task_id: l.task_id,
        category_id: l.tasks!.category_id,
        description: l.tasks!.description,
        minutes: l.planned_minutes,
        ad_hoc: l.tasks!.ad_hoc,
      })),
  }));
}

export async function getBlock(db: SupabaseClient, userId: string, id: string): Promise<ViewBlock | null> {
  const { data, error } = await db
    .from("scheduled_blocks")
    .select("starts_at")
    .eq("user_id", userId)
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const t = Date.parse(data.starts_at as string);
  const blocks = await loadBlocks(db, userId, { start: t, end: t + 1 });
  return blocks.find((b) => b.id === id) ?? null;
}

/** Calendar events that count (enabled calendar, not cancelled, busy…) overlapping `span`. */
export async function loadEvents(db: SupabaseClient, userId: string, span: Span): Promise<ViewEvent[]> {
  const [events, sources] = await Promise.all([
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
  ]);
  // A broken calendar integration degrades the week; it does not fail it.
  if (events.error || sources.error) return [];
  const byId = new Map(((sources.data ?? []) as CalendarSource[]).map((s) => [s.id, s]));
  const out: ViewEvent[] = [];
  for (const e of (events.data ?? []) as ExternalEvent[]) {
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
  const [blocks, events, intent] = await Promise.all([
    loadBlocks(db, userId, span),
    loadEvents(db, userId, span),
    loadIntent(db, userId, monday),
  ]);
  return { span, blocks, events, intent };
}
