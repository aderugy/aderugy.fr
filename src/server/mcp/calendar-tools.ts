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
  weekDates,
  type ViewBlock,
} from "@/lib/agenda/week-view";
import { loadCategoryPaths } from "@/server/agenda/tasks";
import { getBlock, loadBlocks, loadEvents, loadTemplates, loadWeek } from "@/server/agenda/week";
import {
  addTaskToBlock,
  attachTask,
  detachTask,
  insertAdHocTasks,
  insertBlock,
  moveBlock,
  patchBlock,
  placeTemplate,
  removeBlock,
  setBlockTaskMinutes,
} from "@/server/agenda/schedule";
import { livePlacements, syncTaskStatus } from "@/server/weeks";
import { callerOf } from "./auth";

/**
 * The /agenda week grid as MCP tools, on the same connector as the backlog.
 *
 * Reading covers everything Arthur sees on the grid: blocks and the tasks in
 * them, the calendars' events, the week's theme and objectives, the template
 * library. Writing is limited to the blocks Claude created — enforced by
 * migration 0019 in the database, and checked here first so the answer is a
 * sentence rather than a silent no-op. Every write goes through
 * server/agenda/schedule.ts, the same code as the planner's buttons.
 *
 * Times are read and written in Arthur's zone (APP_TIMEZONE), never UTC.
 */

const TZ = APP_TIMEZONE;

export const CALENDAR_INSTRUCTIONS = `Arthur's week grid (aderugy.fr/agenda), in ${TZ} time.

How the data works:
- The grid holds blocks: spans of time. A block has no category of its own; the tasks inside it do, each with its planned minutes — that is what the week's totals count. A block can come from a template ("Morning routine") or hold an interview from /jobs.
- His Google calendars (school timetable, etc.) are mirrored in as events: read-only, and they count towards their calendar's category.
- Each week can have a theme, guidelines and objectives (read-only here).
- Block status: planned, done, skipped. A backlog task inside a skipped block is back in the backlog.

What you may do: read any week (get_week), find free time (find_free_slots), list templates, and plan blocks — create_block (backlog tasks and/or new one-off tasks), place_template. You may move, resize, edit, mark done/skipped or delete only the blocks you created ("by Claude" in get_week); Arthur's own blocks are his — propose changes to him instead. Blocks you plan are pushed to his Google "Agenda" calendar like his own.

Times: write them as local wall time, "YYYY-MM-DDTHH:MM" (e.g. "2026-10-09T18:00"). Look at the week before planning and do not stack blocks on top of commitments unless asked; the tools warn about overlaps.`;

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
const blockId = z.string().uuid().describe("Block id, from get_week or create_block.");
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

function span(b: Pick<ViewBlock, "starts_at" | "ends_at">) {
  return `${fmtWhen(b.starts_at, TZ)}–${fmtClock(b.ends_at, TZ)}`;
}

function taskLine(t: ViewBlock["tasks"][number], paths: Map<string, string>): string {
  const path = paths.get(t.category_id) ?? "?";
  return `${path}${t.description ? ` — ${t.description}` : ""} ${fmtMinutes(t.minutes)}${t.ad_hoc ? "" : ` (backlog task ${t.task_id})`}`;
}

function blockLine(b: ViewBlock, paths: Map<string, string>): string {
  // A block named by its template, description or interview shows that name;
  // one named by nothing is described by its tasks alone.
  const named = b.interview ?? b.template ?? b.description;
  const head = [
    `${fmtClock(b.starts_at, TZ)}–${fmtClock(b.ends_at, TZ)}`,
    named ?? "",
    b.status !== "planned" ? b.status : "",
    b.created_by === "claude" ? "by Claude" : "",
  ].filter(Boolean);
  const inside = b.tasks.length ? `${head.length > 1 ? ": " : " · "}${b.tasks.map((t) => taskLine(t, paths)).join("; ")}` : " · (empty)";
  const total = b.tasks.reduce((s, t) => s + t.minutes, 0);
  const length = Math.round((Date.parse(b.ends_at) - Date.parse(b.starts_at)) / 60_000);
  const fill = total > length ? ` [tasks ask ${fmtMinutes(total)} in ${fmtMinutes(length)}]` : total < length && b.tasks.length ? ` [${fmtMinutes(length - total)} unattributed]` : "";
  return `- ${head.join(" · ")}${inside}${fill} (block ${b.id})`;
}

/** Warnings about where a block lands: overlaps, off the grid's hours, fill. */
async function warningsFor(
  db: SupabaseClient,
  userId: string,
  start: Date,
  end: Date,
  exceptBlockId?: string,
): Promise<string[]> {
  const s = { start: start.getTime(), end: end.getTime() };
  const wide = { start: s.start - 86_400_000, end: s.end + 86_400_000 };
  const [blocks, events] = await Promise.all([loadBlocks(db, userId, wide), loadEvents(db, userId, wide)]);
  const out: string[] = [];
  const hits = overlapping(s, busySpans(blocks, events, exceptBlockId));
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

function placedText(when: string, blockIdValue: string, inside: string[], warnings: string[]): string {
  return [
    `Planned ${when} (block ${blockIdValue}).`,
    inside.length ? `Inside: ${inside.join("; ")}.` : "",
    ...warnings.map((w) => `Warning: ${w}`),
    "It shows on Arthur's grid now, and in his Google Agenda calendar at the next push (about a minute) if he has the push on.",
  ]
    .filter(Boolean)
    .join("\n");
}

/** A block Claude may change, or the sentence saying why not. */
async function ownBlock(db: SupabaseClient, userId: string, id: string): Promise<ViewBlock | string> {
  const b = await getBlock(db, userId, id);
  if (!b) return `No block with id ${id}.`;
  if (b.created_by !== "claude") {
    const named = b.interview ?? b.template ?? b.description;
    return `That block (${named ? `${named}, ` : ""}${span(b)}) is Arthur's: you can only change blocks you created. Suggest the change to him instead.`;
  }
  return b;
}

/* -------------------------------------------------------------- tools */

export function registerCalendarTools(server: McpServer) {
  server.registerTool(
    "get_week",
    {
      title: "Read a week of the planner",
      description:
        "One week of Arthur's grid, Monday to Sunday, in his local time: every block with the tasks inside it (category, minutes, who planned it), his calendars' events, all-day items, the week's theme, guidelines and objectives with progress, and the minutes per category. Start here before planning.",
      inputSchema: z.object({
        date: localDay.optional().describe("Any day of the week wanted. Default: today."),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ date }, ctx) => {
      const { db, userId } = callerOf(ctx.http?.authInfo);
      const monday = mondayOf(date ?? today());
      const [{ span: week, blocks, events, intent }, categories] = await Promise.all([
        loadWeek(db, userId, monday, TZ),
        loadCategoryPaths(db, userId),
      ]);
      const paths = new Map(categories.map((c) => [c.id, c.path]));
      const days = weekDates(monday);

      const out: string[] = [`# Week of ${fmtDayHeading(monday)} ${monday.slice(0, 4)} (${monday} → ${days[6]}, ${TZ})`];
      if (intent.theme) out.push(`Theme: ${intent.theme}`);
      if (intent.guidelines) out.push(`Guidelines: ${intent.guidelines}`);

      const totals = minutesByCategory(blocks, events, week);
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
        for (const b of blocks) if (inDay(b.starts_at)) items.push({ at: Date.parse(b.starts_at), text: blockLine(b, paths) });
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
        out.push("", "## Minutes by category (own blocks + calendars, leaf categories)");
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
        "Gaps in Arthur's days where nothing is planned and no calendar event is busy, between the hours given. Blocks marked skipped and all-day events do not count as busy.",
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
      const [blocks, events] = await Promise.all([loadBlocks(db, userId, wide), loadEvents(db, userId, range)]);
      const busy = busySpans(blocks, events);
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
    "list_block_templates",
    {
      title: "List block templates",
      description: "Arthur's reusable blocks (\"Morning routine\", \"Deep work\"): length, default category, preferred part of the day, and the steps a bundle holds. Place one with place_template.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (_input, ctx) => {
      const { db, userId } = callerOf(ctx.http?.authInfo);
      const [templates, categories] = await Promise.all([loadTemplates(db, userId), loadCategoryPaths(db, userId)]);
      if (!templates.length) return ok("No templates.");
      const paths = new Map(categories.map((c) => [c.id, c.path]));
      return ok(
        templates
          .map((t) => {
            const len = t.items.length ? t.items.reduce((s, i) => s + i.estimated_minutes, 0) : t.default_minutes;
            const head = `- ${t.name} — ${fmtMinutes(len)} · ${paths.get(t.default_category_id) ?? "?"}${t.preferred_daypart ? ` · ${t.preferred_daypart}` : ""} (template ${t.id})`;
            const steps = t.items.map((i) => `    - ${i.label} ${fmtMinutes(i.estimated_minutes)}${i.category_id ? ` (${paths.get(i.category_id) ?? "?"})` : ""}`);
            return [head, ...steps].join("\n");
          })
          .join("\n"),
      );
    },
  );

  server.registerTool(
    "create_block",
    {
      title: "Plan a block on the grid",
      description:
        "Put a block on Arthur's week and fill it: backlog tasks (by id, from list_tasks) and/or new one-off tasks that exist only in this block. The block lasts until `end`, or `minutes`, or the sum of its tasks. A backlog task's minutes default to what is left of its estimate. Its tasks become 'scheduled'. Warns about overlaps; does not refuse them.",
      inputSchema: z.object({
        start: localTime,
        end: localTime.optional(),
        minutes: minutesIn.optional().describe("Length, when no end is given."),
        tasks: z
          .array(z.object({ task_id: z.string().uuid(), minutes: minutesIn.optional() }))
          .max(20)
          .optional()
          .describe("Backlog tasks to work in this block, in order."),
        new_tasks: z
          .array(z.object({ category: categoryRef, description: z.string().max(500).optional(), minutes: minutesIn }))
          .max(20)
          .optional()
          .describe("One-off tasks created inside the block (deleted with it)."),
        description: z.string().max(500).optional().describe("A label for the block itself; usually leave empty — the tasks name it."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (input, ctx) => {
      const { db, userId } = callerOf(ctx.http?.authInfo);
      const start = time(input.start, "start");
      if (typeof start === "string") return failure(start);
      if (!input.tasks?.length && !input.new_tasks?.length) {
        return failure("Put at least one task in the block (tasks or new_tasks): a block counts as nothing until a task says what its time is.");
      }

      const categories = await loadCategoryPaths(db, userId);
      const paths = new Map(categories.map((c) => [c.id, c.path]));
      const fresh: { categoryId: string; description: string | null; minutes: number; label: string }[] = [];
      for (const n of input.new_tasks ?? []) {
        const c = resolveCategory(categories, n.category);
        if (typeof c === "string") return failure(`Nothing was planned. ${c}`);
        fresh.push({ categoryId: c.id, description: n.description?.trim() || null, minutes: n.minutes, label: `${c.path}${n.description ? ` — ${n.description}` : ""}` });
      }

      const backlog: { id: string; minutes: number; label: string }[] = [];
      if (input.tasks?.length) {
        const ids = [...new Set(input.tasks.map((t) => t.task_id))];
        const { data, error } = await db
          .from("tasks")
          .select("id, category_id, description, estimated_minutes, status, ad_hoc")
          .eq("user_id", userId)
          .in("id", ids);
        if (error) throw error;
        const rows = new Map((data ?? []).map((t) => [t.id as string, t]));
        const placed = await livePlacements(db, ids);
        for (const t of input.tasks) {
          const row = rows.get(t.task_id);
          if (!row) return failure(`Nothing was planned. No task with id ${t.task_id}.`);
          if (row.ad_hoc) return failure(`Nothing was planned. Task ${t.task_id} belongs to another block.`);
          if (row.status === "done" || row.status === "dropped") return failure(`Nothing was planned. Task ${t.task_id} is ${row.status}.`);
          if (backlog.some((b) => b.id === t.task_id)) continue;
          const left = row.estimated_minutes - (placed.get(t.task_id)?.minutes ?? 0);
          const minutes = t.minutes ?? Math.max(15, left > 0 ? left : row.estimated_minutes);
          const path = paths.get(row.category_id as string) ?? "?";
          backlog.push({ id: t.task_id, minutes, label: `${path}${row.description ? ` — ${row.description}` : ""}` });
        }
      }

      const total = [...backlog, ...fresh].reduce((s, t) => s + t.minutes, 0);
      let end: Date;
      if (input.end) {
        const e = time(input.end, "end");
        if (typeof e === "string") return failure(e);
        end = e;
      } else {
        end = new Date(start.getTime() + (input.minutes ?? total) * 60_000);
      }
      const length = Math.round((end.getTime() - start.getTime()) / 60_000);
      if (length < 5) return failure("The block must end at least 5 minutes after it starts.");
      if (length > 1440) return failure("A block lasts 24 hours at most.");

      const warnings = await warningsFor(db, userId, start, end);
      if (total > length) warnings.push(`The tasks ask ${fmtMinutes(total)} in a ${fmtMinutes(length)} block.`);

      const id = await insertBlock(db, userId, {
        weekStart: mondayOf(localDate(start, TZ)),
        startsAt: start,
        endsAt: end,
        description: input.description ?? null,
      });
      try {
        if (backlog.length) {
          const { error } = await db.from("scheduled_block_tasks").insert(
            backlog.map((t, i) => ({ user_id: userId, scheduled_block_id: id, task_id: t.id, planned_minutes: t.minutes, position: i })),
          );
          if (error) throw error;
        }
        await insertAdHocTasks(db, userId, id, fresh, backlog.length);
        await syncTaskStatus(db, userId, backlog.map((t) => t.id));
      } catch (e) {
        // All or nothing: a half-filled block would count wrong.
        await removeBlock(db, userId, id);
        throw e;
      }
      const inside = [...backlog, ...fresh].map((t) => `${t.label} ${fmtMinutes(t.minutes)}`);
      return ok(placedText(`${fmtWhen(start, TZ)}–${fmtClock(end, TZ)}`, id, inside, warnings));
    },
  );

  server.registerTool(
    "place_template",
    {
      title: "Place a template on the grid",
      description: "Put one of Arthur's block templates at a time: it lands as one block holding the template's steps, sized to their sum (list_block_templates).",
      inputSchema: z.object({
        template: z.string().min(1).describe("Template name (any case) or id."),
        start: localTime,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ template, start: rawStart }, ctx) => {
      const { db, userId } = callerOf(ctx.http?.authInfo);
      const start = time(rawStart, "start");
      if (typeof start === "string") return failure(start);
      const templates = await loadTemplates(db, userId);
      const t =
        templates.find((x) => x.id === template) ??
        templates.find((x) => x.name.toLowerCase() === template.trim().toLowerCase());
      if (!t) return failure(`No template "${template}". Templates: ${templates.map((x) => `"${x.name}"`).join(", ") || "none"}.`);
      const len = t.items.length ? t.items.reduce((s, i) => s + i.estimated_minutes, 0) : t.default_minutes;
      const end = new Date(start.getTime() + len * 60_000);
      const warnings = await warningsFor(db, userId, start, end);
      const id = await placeTemplate(db, userId, {
        weekStart: mondayOf(localDate(start, TZ)),
        blockId: t.id,
        startsAt: start.toISOString(),
      });
      return ok(placedText(`${t.name}, ${fmtWhen(start, TZ)}–${fmtClock(end, TZ)}`, id, t.items.map((i) => `${i.label} ${fmtMinutes(i.estimated_minutes)}`), warnings));
    },
  );

  server.registerTool(
    "update_block",
    {
      title: "Move or edit a block you planned",
      description:
        "Move, resize, relabel, or mark done/skipped a block you created. Giving only `start` moves the block and keeps its length; only `end` changes its length. Skipping a block sends its backlog tasks back to the backlog. Arthur's own blocks cannot be changed.",
      inputSchema: z.object({
        block_id: blockId,
        start: localTime.optional(),
        end: localTime.optional(),
        description: z.string().max(500).nullable().optional(),
        status: z.enum(["planned", "done", "skipped"]).optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input, ctx) => {
      const { db, userId } = callerOf(ctx.http?.authInfo);
      const b = await ownBlock(db, userId, input.block_id);
      if (typeof b === "string") return failure(b);
      const warnings: string[] = [];
      let when = span(b);

      if (input.start !== undefined || input.end !== undefined) {
        const oldStart = Date.parse(b.starts_at);
        const oldEnd = Date.parse(b.ends_at);
        let start = new Date(oldStart);
        let end = new Date(oldEnd);
        if (input.start !== undefined) {
          const s = time(input.start, "start");
          if (typeof s === "string") return failure(s);
          start = s;
          if (input.end === undefined) end = new Date(s.getTime() + (oldEnd - oldStart));
        }
        if (input.end !== undefined) {
          const e = time(input.end, "end");
          if (typeof e === "string") return failure(e);
          end = e;
        }
        const length = (end.getTime() - start.getTime()) / 60_000;
        if (length < 5 || length > 1440) return failure("A block lasts between 5 minutes and 24 hours.");
        warnings.push(...(await warningsFor(db, userId, start, end, b.id)));
        const r = await moveBlock(db, userId, { id: b.id, startsAt: start.toISOString(), endsAt: end.toISOString() });
        if (!r.ok) return failure(r.error);
        when = `${fmtWhen(start, TZ)}–${fmtClock(end, TZ)}`;
      }
      if (input.description !== undefined || input.status !== undefined) {
        const r = await patchBlock(db, userId, { id: b.id, description: input.description, status: input.status });
        if (!r.ok) return failure(r.error);
      }
      return ok([`Updated: ${when}${input.status ? ` · ${input.status}` : ""} (block ${b.id}).`, ...warnings.map((w) => `Warning: ${w}`)].join("\n"));
    },
  );

  server.registerTool(
    "delete_block",
    {
      title: "Delete a block you planned",
      description: "Remove a block you created. Its backlog tasks go back to the backlog; its one-off tasks are deleted with it. Arthur's own blocks cannot be deleted.",
      inputSchema: z.object({ block_id: blockId }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ block_id }, ctx) => {
      const { db, userId } = callerOf(ctx.http?.authInfo);
      const b = await ownBlock(db, userId, block_id);
      if (typeof b === "string") return failure(b);
      const r = await removeBlock(db, userId, b.id);
      if (!r.ok) return failure(r.error);
      return ok(`Deleted the block of ${span(b)}.`);
    },
  );

  server.registerTool(
    "add_to_block",
    {
      title: "Add a task to a block you planned",
      description:
        "Put a backlog task (task_id) or a new one-off task (new_task) into a block you created, for `minutes`. A task already in the block gets the new minutes instead.",
      inputSchema: z.object({
        block_id: blockId,
        task_id: z.string().uuid().optional(),
        new_task: z.object({ category: categoryRef, description: z.string().max(500).optional() }).optional(),
        minutes: minutesIn,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (input, ctx) => {
      const { db, userId } = callerOf(ctx.http?.authInfo);
      if (!input.task_id === !input.new_task) return failure("Give either task_id or new_task.");
      const b = await ownBlock(db, userId, input.block_id);
      if (typeof b === "string") return failure(b);

      if (input.task_id) {
        if (b.tasks.some((t) => t.task_id === input.task_id)) {
          const r = await setBlockTaskMinutes(db, userId, { scheduledBlockId: b.id, taskId: input.task_id, plannedMinutes: input.minutes });
          if (!r.ok) return failure(r.error);
          return ok(`That task now has ${fmtMinutes(input.minutes)} in the block of ${span(b)}.`);
        }
        const { data: task, error } = await db
          .from("tasks")
          .select("id, status, ad_hoc")
          .eq("user_id", userId)
          .eq("id", input.task_id)
          .maybeSingle();
        if (error) throw error;
        if (!task) return failure(`No task with id ${input.task_id}.`);
        if (task.ad_hoc) return failure("That task belongs to another block.");
        if (task.status === "done" || task.status === "dropped") return failure(`That task is ${task.status}.`);
        await attachTask(db, userId, { scheduledBlockId: b.id, taskId: task.id, plannedMinutes: input.minutes });
      } else {
        const categories = await loadCategoryPaths(db, userId);
        const c = resolveCategory(categories, input.new_task!.category);
        if (typeof c === "string") return failure(c);
        const r = await addTaskToBlock(db, userId, {
          scheduledBlockId: b.id,
          categoryId: c.id,
          description: input.new_task!.description ?? null,
          minutes: input.minutes,
        });
        if (!r.ok) return failure(r.error);
      }
      const total = b.tasks.reduce((s, t) => s + t.minutes, 0) + input.minutes;
      const length = Math.round((Date.parse(b.ends_at) - Date.parse(b.starts_at)) / 60_000);
      return ok(
        [`Added to the block of ${span(b)}.`, total > length ? `Warning: its tasks now ask ${fmtMinutes(total)} in ${fmtMinutes(length)}; lengthen it with update_block if needed.` : ""]
          .filter(Boolean)
          .join("\n"),
      );
    },
  );

  server.registerTool(
    "remove_from_block",
    {
      title: "Take a task out of a block you planned",
      description: "A backlog task goes back to the backlog; a one-off task is deleted.",
      inputSchema: z.object({ block_id: blockId, task_id: z.string().uuid() }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ block_id, task_id }, ctx) => {
      const { db, userId } = callerOf(ctx.http?.authInfo);
      const b = await ownBlock(db, userId, block_id);
      if (typeof b === "string") return failure(b);
      if (!b.tasks.some((t) => t.task_id === task_id)) return failure("That task is not in this block.");
      const r = await detachTask(db, userId, { scheduledBlockId: b.id, taskId: task_id });
      if (!r.ok) return failure(r.error);
      return ok(`Removed from the block of ${span(b)}.`);
    },
  );
}
