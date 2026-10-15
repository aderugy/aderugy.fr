import "server-only";
import { z } from "zod";
import type { McpServer, CallToolResult } from "@modelcontextprotocol/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { APP_TIMEZONE } from "@/lib/jobs/format";
import { resolveCategoryRef, subtreeOf, type CategoryPathRow } from "@/lib/agenda/backlog";
import {
  addDaysISO,
  fmtClock,
  fmtDayHeading,
  fmtMinutes,
  fmtWhen,
  localDate,
  minutesIntoDay,
  mondayOf,
  parseLocal,
  startOfLocalDay,
} from "@/lib/agenda/zoned";
import {
  allDayDates,
  busySpans,
  gaps,
  minutesByCategory,
  overlapping,
  sessionLabel,
  weekDates,
  type ViewSession,
} from "@/lib/agenda/week-view";
import { isMissed } from "@/lib/agenda/sessions";
import { getSession, loadEvents, loadSessions, loadWeek } from "@/server/agenda/week";
import {
  createTaskAt,
  moveSession,
  placeTask,
  sendToBacklog,
  setSessionStatus,
} from "@/server/agenda/schedule";
import { TASK_COLUMNS, isInterviewTask, loadCategoryPaths, type TaskRow } from "@/server/agenda/tasks";
import { callerOf } from "./auth";

/**
 * The /agenda week grid as MCP tools, on the same connector as the backlog.
 *
 * Reading covers everything Arthur sees on the grid: the slots (sessions) of
 * his tasks, the calendars' events, the week's theme and objectives. Writing
 * is limited to the slots Claude created — enforced by migration 0026 in the
 * database, and checked here first so the answer is a sentence rather than a
 * silent no-op. Every write goes through server/agenda/schedule.ts, the same
 * code as the planner's buttons.
 *
 * Times are read and written in Arthur's zone (APP_TIMEZONE), never UTC.
 */

const TZ = APP_TIMEZONE;

export const CALENDAR_INSTRUCTIONS = `Arthur's week grid (aderugy.fr/agenda), in ${TZ} time.

How the data works:
- The grid holds slots ("sessions"): one task at one span of time. A slot is drawn as its task — category and description — and counts for its length against the task's category in the week's totals. A task has at most one planned slot.
- Slot status: planned, done, skipped. A planned slot whose time is over is "missed" until Arthur marks it done or skips it. Skipping keeps the slot as history and sends the task back to the backlog; rescheduling skips the old slot and plans a new one, so the trace stays.
- His Google calendars (school timetable, etc.) are mirrored in as events: read-only, and they count towards their calendar's category. Events he hid (a class he skips, a meeting he is not going to) are left out: that time is free.
- Each week can have a theme, guidelines and objectives (read-only here).

What you may do: read any week (get_week), find free time (find_free_slots), and plan tasks — schedule_task puts a backlog task (task_id, from list_tasks) or a new task on the grid. You may move, skip or unschedule only the slots you planned ("by Claude" in get_week); Arthur's own slots are his — propose changes to him instead. Slots you plan are pushed to his Google "Agenda" calendar like his own.

Times: write them as local wall time, "YYYY-MM-DDTHH:MM" (e.g. "2026-10-09T18:00"). Look at the week before planning and do not stack slots on top of commitments unless asked; the tools warn about overlaps.`;

/* ------------------------------------------------------------- shapes */

const localTime = z
  .string()
  .min(1)
  .max(40)
  .describe(`Local time in ${TZ}, "YYYY-MM-DDTHH:MM".`);
const localDay = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
  .describe("A date, YYYY-MM-DD.");
const sessionId = z.string().uuid().describe("Slot (session) id, from get_week or schedule_task.");
const minutesIn = z.number().int().min(5).max(1440);
const categoryRef = z.string().min(1).describe('Category path such as "poker > grind", a unique leaf name, or an id (list_categories).');

function failure(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

function ok(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

function time(raw: string, what: string): Date | string {
  const d = parseLocal(raw, TZ);
  return d ?? `${what}: "${raw}" is not a time. Use local time, "YYYY-MM-DDTHH:MM".`;
}

function today(): string {
  return localDate(new Date(), TZ);
}

function resolveCategory(categories: CategoryPathRow[], ref: string): { id: string; path: string } | string {
  const r = resolveCategoryRef(categories, ref);
  if (r.ok) return { id: r.id, path: r.path };
  const hint = r.candidates.length ? ` Closest: ${r.candidates.map((c) => `"${c}"`).join(", ")}.` : "";
  return `${r.error}${hint}`;
}

function span(b: Pick<ViewSession, "starts_at" | "ends_at">) {
  return `${fmtWhen(b.starts_at, TZ)}–${fmtClock(b.ends_at, TZ)}`;
}

function sessionLine(s: ViewSession, paths: Map<string, string>, now: number): string {
  const state = isMissed(s, now) ? "missed" : s.status !== "planned" ? s.status : "";
  const head = [
    `${fmtClock(s.starts_at, TZ)}–${fmtClock(s.ends_at, TZ)}`,
    sessionLabel(s, paths),
    state,
    s.created_by === "claude" ? "by Claude" : "",
  ].filter(Boolean);
  return `- ${head.join(" · ")} (slot ${s.id}, task ${s.task_id})`;
}

/** Warnings about where a slot lands: overlaps, off the grid's hours. */
async function warningsFor(
  db: SupabaseClient,
  userId: string,
  start: Date,
  end: Date,
  exceptSessionId?: string,
): Promise<string[]> {
  const s = { start: start.getTime(), end: end.getTime() };
  const wide = { start: s.start - 86_400_000, end: s.end + 86_400_000 };
  const [sessions, events] = await Promise.all([loadSessions(db, userId, wide), loadEvents(db, userId, wide)]);
  const out: string[] = [];
  const hits = overlapping(s, busySpans(sessions, events, exceptSessionId));
  if (hits.length) {
    out.push(
      `Overlaps ${hits
        .map((h) => `${h.label} (${fmtClock(new Date(h.start), TZ)}–${fmtClock(new Date(h.end), TZ)})`)
        .join(", ")}.`,
    );
  }
  const from = minutesIntoDay(start, TZ);
  const sameDay = localDate(start, TZ) === localDate(new Date(end.getTime() - 1), TZ);
  const to = sameDay ? minutesIntoDay(end, TZ) || 24 * 60 : 24 * 60 + 1;
  if (from < 6 * 60 || to > 23 * 60) out.push("Partly outside the grid's 06:00–23:00: Arthur will not see all of it in the week view.");
  return out;
}

const PUSH_NOTE =
  "It shows on Arthur's grid now, and in his Google Agenda calendar at the next push (about a minute) if he has the push on.";

/** A slot Claude may change, or the sentence saying why not. */
async function ownSession(db: SupabaseClient, userId: string, id: string, paths: Map<string, string> | null = null): Promise<ViewSession | string> {
  const s = await getSession(db, userId, id);
  if (!s) return `No slot with id ${id}.`;
  if (s.created_by !== "claude") {
    return `That slot (${sessionLabel(s, paths)}, ${span(s)}) is Arthur's: you can only change slots you planned. Suggest the change to him instead.`;
  }
  return s;
}

/** Start and end from a start plus an end, a length, or a default length. */
function endFrom(start: Date, input: { end?: string; minutes?: number }, fallbackMinutes: number): Date | string {
  if (input.end) return time(input.end, "end");
  return new Date(start.getTime() + (input.minutes ?? fallbackMinutes) * 60_000);
}

/* -------------------------------------------------------------- tools */

export function registerCalendarTools(server: McpServer) {
  server.registerTool(
    "get_week",
    {
      title: "Read a week of the planner",
      description:
        "One week of Arthur's grid, Monday to Sunday, in his local time: every slot (task, category, status, who planned it), his calendars' events, all-day items, the week's theme, guidelines and objectives with progress, and the minutes per category. Start here before planning.",
      inputSchema: z.object({
        date: localDay.optional().describe("Any day of the week wanted. Default: today."),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ date }, ctx) => {
      const { db, userId } = callerOf(ctx.http?.authInfo);
      const monday = mondayOf(date ?? today());
      const [{ span: week, sessions, events, intent }, categories] = await Promise.all([
        loadWeek(db, userId, monday, TZ),
        loadCategoryPaths(db, userId),
      ]);
      const paths = new Map(categories.map((c) => [c.id, c.path]));
      const days = weekDates(monday);
      const now = Date.now();

      const out: string[] = [`# Week of ${fmtDayHeading(monday)} ${monday.slice(0, 4)} (${monday} → ${days[6]}, ${TZ})`];
      if (intent.theme) out.push(`Theme: ${intent.theme}`);
      if (intent.guidelines) out.push(`Guidelines: ${intent.guidelines}`);

      const totals = minutesByCategory(sessions, events, week);
      const rolled = (rootId: string, m: Map<string, number>) => {
        let sum = 0;
        for (const id of subtreeOf(categories, rootId)) sum += m.get(id) ?? 0;
        return sum;
      };
      if (intent.objectives.length) {
        out.push("", "## Objectives");
        for (const o of intent.objectives) {
          const got = o.category_id ? rolled(o.category_id, totals.planned) + rolled(o.category_id, totals.external) : null;
          const progress =
            o.category_id && o.target_minutes
              ? ` — ${fmtMinutes(got ?? 0)} of ${fmtMinutes(o.target_minutes)} on ${paths.get(o.category_id) ?? "?"}`
              : o.category_id
                ? ` — ${paths.get(o.category_id) ?? "?"}: ${fmtMinutes(got ?? 0)}`
                : "";
          out.push(`- [${o.done ? "x" : " "}] ${o.title}${progress}`);
        }
      }

      for (const day of days) {
        const dayStart = startOfLocalDay(day, TZ).getTime();
        const dayEnd = startOfLocalDay(addDaysISO(day, 1), TZ).getTime();
        const inDay = (iso: string) => {
          const t = Date.parse(iso);
          return t >= dayStart && t < dayEnd;
        };
        const items: { at: number; text: string }[] = [];
        for (const s of sessions) if (inDay(s.starts_at)) items.push({ at: Date.parse(s.starts_at), text: sessionLine(s, paths, now) });
        for (const e of events) {
          if (e.all_day) continue;
          const s = Math.max(Date.parse(e.starts_at), dayStart);
          const en = Math.min(Date.parse(e.ends_at), dayEnd);
          if (en <= s) continue;
          items.push({
            at: s,
            text: `- ${fmtClock(new Date(s), TZ)}–${en === dayEnd ? "24:00" : fmtClock(new Date(en), TZ)} · ${e.calendar} (calendar${e.category_id ? `, counts as ${paths.get(e.category_id) ?? "?"}` : ""})${e.title ? `: ${e.title}` : ""}${e.archived ? " [kept after the calendar deleted it]" : ""}`,
          });
        }
        const allDay = events.filter((e) => e.all_day && allDayDates(e).includes(day));
        out.push("", `## ${fmtDayHeading(day)}${day === today() ? " (today)" : ""}`);
        if (allDay.length) out.push(`All day: ${allDay.map((e) => `${e.calendar}${e.title ? `: ${e.title}` : ""}`).join("; ")}`);
        if (!items.length) out.push("- (nothing)");
        else out.push(...items.sort((a, b) => a.at - b.at).map((i) => i.text));
      }

      const ids = new Set([...totals.planned.keys(), ...totals.external.keys()]);
      if (ids.size) {
        out.push("", "## Minutes by category (own slots + calendars, leaf categories; skipped slots excluded)");
        const rows = [...ids]
          .map((id) => ({
            id,
            planned: totals.planned.get(id) ?? 0,
            done: totals.done.get(id) ?? 0,
            external: totals.external.get(id) ?? 0,
          }))
          .sort((a, b) => b.planned + b.external - (a.planned + a.external));
        for (const r of rows) {
          const bits = [];
          if (r.planned) bits.push(`${fmtMinutes(r.planned)} planned${r.done ? ` (${fmtMinutes(r.done)} done)` : ""}`);
          if (r.external) bits.push(`${fmtMinutes(r.external)} from calendars`);
          out.push(`- ${paths.get(r.id) ?? "?"}: ${bits.join(" + ")}`);
        }
      }
      return ok(out.join("\n"));
    },
  );

  server.registerTool(
    "find_free_slots",
    {
      title: "Find free time",
      description:
        "Gaps in Arthur's days where nothing is planned and no calendar event is busy, between the hours given. Skipped slots and all-day events do not count as busy.",
      inputSchema: z.object({
        from: localDay.optional().describe("First day. Default: today."),
        to: localDay.optional().describe("Last day, included. Default: same as from. At most 14 days."),
        min_minutes: z.number().int().min(5).max(720).optional().describe("Shortest gap worth listing. Default 30."),
        day_start: z.string().regex(/^\d{1,2}:\d{2}$/).optional().describe('Earliest time to consider each day, "HH:MM". Default "08:00".'),
        day_end: z.string().regex(/^\d{1,2}:\d{2}$/).optional().describe('Latest time to consider each day, "HH:MM". Default "22:00".'),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (input, ctx) => {
      const { db, userId } = callerOf(ctx.http?.authInfo);
      const from = input.from ?? today();
      const to = input.to ?? from;
      if (to < from) return failure("`to` is before `from`.");
      const days: string[] = [];
      for (let d = from; d <= to && days.length < 15; d = addDaysISO(d, 1)) days.push(d);
      if (days.length > 14) return failure("At most 14 days at a time.");
      const [sh, sm] = (input.day_start ?? "08:00").split(":").map(Number);
      const [eh, em] = (input.day_end ?? "22:00").split(":").map(Number);
      if (eh * 60 + em <= sh * 60 + sm) return failure("day_end must be after day_start.");
      const min = input.min_minutes ?? 30;

      const range = { start: startOfLocalDay(from, TZ).getTime(), end: startOfLocalDay(addDaysISO(to, 1), TZ).getTime() };
      const wide = { start: range.start - 86_400_000, end: range.end };
      const [sessions, events] = await Promise.all([loadSessions(db, userId, wide), loadEvents(db, userId, range)]);
      const busy = busySpans(sessions, events);
      const now = Date.now();

      const out: string[] = [];
      for (const day of days) {
        const window = {
          start: parseLocal(`${day}T${String(sh).padStart(2, "0")}:${String(sm).padStart(2, "0")}`, TZ)!.getTime(),
          end: parseLocal(`${day}T${String(eh).padStart(2, "0")}:${String(em).padStart(2, "0")}`, TZ)!.getTime(),
        };
        // Time already gone is not free.
        if (window.end <= now) continue;
        window.start = Math.max(window.start, Math.ceil(now / 900_000) * 900_000);
        const free = gaps(window, busy, min);
        out.push(
          `${fmtDayHeading(day)}: ${
            free.length
              ? free.map((g) => `${fmtClock(new Date(g.start), TZ)}–${fmtClock(new Date(g.end), TZ)} (${fmtMinutes((g.end - g.start) / 60_000)})`).join(", ")
              : "nothing free"
          }`,
        );
      }
      return ok(out.length ? out.join("\n") : "Those days are over.");
    },
  );

  server.registerTool(
    "schedule_task",
    {
      title: "Plan a task on the grid",
      description:
        "Give a task a slot on Arthur's week: an existing backlog task (task_id, from list_tasks) or a new task (new_task) created for that slot. The slot lasts until `end`, or `minutes`, or — for a backlog task — its estimate. The task becomes 'scheduled'. A task already planned elsewhere is refused: it has at most one planned slot. Warns about overlaps; does not refuse them.",
      inputSchema: z.object({
        start: localTime,
        end: localTime.optional(),
        minutes: minutesIn.optional().describe("Length, when no end is given."),
        task_id: z.string().uuid().optional().describe("A backlog task to plan."),
        new_task: z
          .object({
            category: categoryRef,
            description: z.string().max(500).optional(),
            notes: z.string().max(10_000).optional().describe("Markdown: context, links, checklist."),
            priority: z.number().int().min(1).max(4).optional(),
          })
          .optional()
          .describe("A new task, created and planned in one go. Skipping its slot later sends it to the backlog like any task."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (input, ctx) => {
      const { db, userId } = callerOf(ctx.http?.authInfo);
      if (!input.task_id === !input.new_task) return failure("Give either task_id or new_task.");
      const start = time(input.start, "start");
      if (typeof start === "string") return failure(start);
      const categories = await loadCategoryPaths(db, userId);
      const paths = new Map(categories.map((c) => [c.id, c.path]));

      if (input.task_id) {
        const { data, error } = await db
          .from("tasks")
          .select(TASK_COLUMNS)
          .eq("user_id", userId)
          .eq("id", input.task_id)
          .maybeSingle();
        if (error) throw error;
        const task = data as TaskRow | null;
        if (!task) return failure(`No task with id ${input.task_id}.`);
        if (isInterviewTask(task)) return failure("That task is an interview's slot; Arthur moves it from /jobs.");
        if (task.status === "done" || task.status === "dropped") return failure(`That task is ${task.status}.`);
        const end = endFrom(start, input, task.estimated_minutes);
        if (typeof end === "string") return failure(end);
        const warnings = await warningsFor(db, userId, start, end);
        const r = await placeTask(db, userId, { taskId: task.id, startsAt: start.toISOString(), endsAt: end.toISOString() });
        if (!r.ok) return failure(r.error);
        const label = `${paths.get(task.category_id) ?? "?"}${task.description ? ` — ${task.description}` : ""}`;
        return ok(
          [`Planned ${label}, ${fmtWhen(start, TZ)}–${fmtClock(end, TZ)} (slot ${r.value}).`, ...warnings.map((w) => `Warning: ${w}`), PUSH_NOTE].join("\n"),
        );
      }

      const n = input.new_task!;
      const c = resolveCategory(categories, n.category);
      if (typeof c === "string") return failure(`Nothing was planned. ${c}`);
      if (!input.end && !input.minutes) return failure("Give the new task's slot an end or a length (minutes).");
      const end = endFrom(start, input, 60);
      if (typeof end === "string") return failure(end);
      const warnings = await warningsFor(db, userId, start, end);
      const r = await createTaskAt(db, userId, {
        categoryId: c.id,
        description: n.description ?? null,
        notes: n.notes ?? null,
        priority: n.priority,
        startsAt: start.toISOString(),
        endsAt: end.toISOString(),
      });
      if (!r.ok) return failure(r.error);
      return ok(
        [
          `Planned a new task ${c.path}${n.description ? ` — ${n.description}` : ""}, ${fmtWhen(start, TZ)}–${fmtClock(end, TZ)} (slot ${r.value.sessionId}, task ${r.value.taskId}).`,
          ...warnings.map((w) => `Warning: ${w}`),
          PUSH_NOTE,
        ].join("\n"),
      );
    },
  );

  server.registerTool(
    "move_session",
    {
      title: "Move or resize a slot you planned",
      description:
        "Move or resize a slot you planned. Giving only `start` keeps its length; only `end` changes its length. A slot whose start has already passed is rescheduled instead: it stays where it was as skipped (history), and the task gets a new planned slot. Skipped slots do not move. Arthur's own slots cannot be changed.",
      inputSchema: z.object({
        session_id: sessionId,
        start: localTime.optional(),
        end: localTime.optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input, ctx) => {
      const { db, userId } = callerOf(ctx.http?.authInfo);
      if (input.start === undefined && input.end === undefined) return failure("Give a new start, a new end, or both.");
      const s = await ownSession(db, userId, input.session_id);
      if (typeof s === "string") return failure(s);
      const oldStart = Date.parse(s.starts_at);
      const oldEnd = Date.parse(s.ends_at);
      let start = new Date(oldStart);
      let end = new Date(oldEnd);
      if (input.start !== undefined) {
        const t = time(input.start, "start");
        if (typeof t === "string") return failure(t);
        start = t;
        if (input.end === undefined) end = new Date(t.getTime() + (oldEnd - oldStart));
      }
      if (input.end !== undefined) {
        const t = time(input.end, "end");
        if (typeof t === "string") return failure(t);
        end = t;
      }
      const warnings = await warningsFor(db, userId, start, end, s.id);
      const r = await moveSession(db, userId, { id: s.id, startsAt: start.toISOString(), endsAt: end.toISOString() });
      if (!r.ok) return failure(r.error);
      const when = `${fmtWhen(start, TZ)}–${fmtClock(end, TZ)}`;
      return ok(
        [
          r.value.rescheduled
            ? `Rescheduled to ${when} (new slot ${r.value.id}); the slot of ${span(s)} stays as skipped.`
            : `Moved to ${when} (slot ${s.id}).`,
          ...warnings.map((w) => `Warning: ${w}`),
        ].join("\n"),
      );
    },
  );

  server.registerTool(
    "skip_session",
    {
      title: "Skip a slot you planned",
      description:
        "Mark a slot you planned as skipped: it stays on the grid as history and the task goes back to the backlog. Arthur's own slots cannot be changed.",
      inputSchema: z.object({ session_id: sessionId }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ session_id }, ctx) => {
      const { db, userId } = callerOf(ctx.http?.authInfo);
      const s = await ownSession(db, userId, session_id);
      if (typeof s === "string") return failure(s);
      if (s.status === "skipped") return ok(`The slot of ${span(s)} was already skipped.`);
      const r = await setSessionStatus(db, userId, { id: s.id, status: "skipped" });
      if (!r.ok) return failure(r.error);
      return ok(`Skipped the slot of ${span(s)}; the task is back in the backlog.`);
    },
  );

  server.registerTool(
    "unschedule_session",
    {
      title: "Take a slot you planned off the grid",
      description:
        "Send the task of a slot you planned back to the backlog. A slot that has not started is deleted (nothing happened there); one already started is skipped instead, so it stays as history. Arthur's own slots cannot be changed.",
      inputSchema: z.object({ session_id: sessionId }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ session_id }, ctx) => {
      const { db, userId } = callerOf(ctx.http?.authInfo);
      const s = await ownSession(db, userId, session_id);
      if (typeof s === "string") return failure(s);
      const r = await sendToBacklog(db, userId, { id: s.id });
      if (!r.ok) return failure(r.error);
      return ok(
        r.value.deleted
          ? `Took the slot of ${span(s)} off the grid; the task is back in the backlog.`
          : `The slot of ${span(s)} had started, so it was skipped (kept as history); the task is back in the backlog.`,
      );
    },
  );
}
