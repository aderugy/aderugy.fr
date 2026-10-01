import "server-only";
import { z } from "zod";
import type { McpServer, CallToolResult } from "@modelcontextprotocol/server";
import {
  TASK_LIMITS,
  deadlineDate,
  parseDeadline,
  resolveCategoryRef,
  type CategoryPathRow,
} from "@/lib/agenda/backlog";
import { PRIORITY_LABELS, type TaskStatus } from "@/lib/types";
import {
  getTask,
  insertTasks,
  listTasks,
  loadCategoryPaths,
  openTaskCounts,
  patchTask,
  removeTask,
  type ListedTask,
  type TaskRow,
} from "@/server/agenda/tasks";
import { callerOf } from "./auth";

/**
 * The /agenda backlog as MCP tools.
 *
 * Every tool goes through the same functions as the backlog UI
 * (server/agenda/tasks.ts), with the caller's own token, so RLS and the
 * OAuth-client restrictions of migration 0015 apply. Errors the model can act
 * on — a bad category, a placed task — come back as `isError` results with a
 * sentence, never as thrown 500s.
 */

export const SERVER_INSTRUCTIONS = `Arthur's weekly planner backlog (aderugy.fr/agenda).

How the data works:
- A task has exactly one category from a user-defined tree, written as a path like "poker > grind". The category is the task's label; the description is what distinguishes two tasks in the same category, so write it as a short, specific phrase.
- Call list_categories before creating or recategorising tasks. Categories cannot be created or renamed from here — if none fits, say so and suggest one for Arthur to add.
- Priority: 1 urgent, 2 high, 3 normal (default), 4 someday. Estimates are in minutes (5–1440). Deadlines are dates (YYYY-MM-DD).
- Status: backlog (waiting), scheduled (placed on the week grid — set by the planner, not by you), done, dropped.
- A task placed on the grid cannot be deleted from here; mark it dropped instead.`;

/* ------------------------------------------------------------- shapes */

const categoryRef = z
  .string()
  .min(1)
  .describe('Category path such as "poker > grind", a unique leaf name, or a category id.');

const taskId = z.string().uuid().describe("Task id, from list_tasks or create_tasks.");

const minutes = z
  .number()
  .int()
  .min(TASK_LIMITS.minMinutes)
  .max(TASK_LIMITS.maxMinutes)
  .describe("Estimated duration in minutes.");

const priority = z
  .number()
  .int()
  .min(1)
  .max(4)
  .describe("1 urgent, 2 high, 3 normal, 4 someday.");

const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
  .describe("A date, YYYY-MM-DD.");

const taskOut = z.object({
  id: z.string(),
  category: z.string(),
  description: z.string().nullable(),
  estimated_minutes: z.number(),
  priority: z.number(),
  priority_label: z.string(),
  deadline: z.string().nullable(),
  status: z.enum(["backlog", "scheduled", "done", "dropped"]),
  splittable: z.boolean(),
  placed_minutes: z.number(),
  created_at: z.string(),
});
type TaskOut = z.infer<typeof taskOut>;

/* ------------------------------------------------------------ helpers */

function toOut(
  task: TaskRow & { placed_minutes?: number },
  paths: Map<string, string>,
  categoryPath?: string,
): TaskOut {
  return {
    id: task.id,
    category: categoryPath ?? paths.get(task.category_id) ?? "(unknown category)",
    description: task.description,
    estimated_minutes: task.estimated_minutes,
    priority: task.priority,
    priority_label: PRIORITY_LABELS[task.priority] ?? String(task.priority),
    deadline: deadlineDate(task.deadline),
    status: task.status,
    splittable: task.splittable,
    placed_minutes: task.placed_minutes ?? 0,
    created_at: task.created_at,
  };
}

function line(t: TaskOut): string {
  const bits = [
    `P${t.priority} ${t.priority_label.toLowerCase()}`,
    t.category + (t.description ? ` — ${t.description}` : ""),
    `${t.estimated_minutes} min`,
  ];
  if (t.deadline) bits.push(`due ${t.deadline}`);
  if (t.status !== "backlog") bits.push(t.status);
  if (t.placed_minutes > 0) bits.push(`${t.placed_minutes} min on the grid`);
  return `- ${bits.join(" · ")} (id ${t.id})`;
}

function failure(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

function categoryFailure(ref: string, categories: CategoryPathRow[], prefix = ""): string | null {
  const r = resolveCategoryRef(categories, ref);
  if (r.ok) return null;
  const hint = r.candidates.length
    ? ` Closest: ${r.candidates.map((c) => `"${c}"`).join(", ")}.`
    : "";
  return `${prefix}${r.error}${hint}`;
}

function pathMap(categories: CategoryPathRow[]) {
  return new Map(categories.map((c) => [c.id, c.path]));
}

/* -------------------------------------------------------------- tools */

export function registerBacklogTools(server: McpServer) {
  server.registerTool(
    "list_categories",
    {
      title: "List categories",
      description:
        "The category tree as paths, with the number of open (backlog or scheduled) tasks in each. Use these paths when creating or filtering tasks.",
      inputSchema: z.object({
        include_archived: z
          .boolean()
          .optional()
          .describe("Also list archived categories (they cannot receive tasks)."),
      }),
      outputSchema: z.object({
        categories: z.array(
          z.object({
            id: z.string(),
            path: z.string(),
            open_tasks: z.number(),
            archived: z.boolean(),
          }),
        ),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ include_archived }, ctx) => {
      const { db, userId } = callerOf(ctx.http?.authInfo);
      const [categories, counts] = await Promise.all([
        loadCategoryPaths(db, userId),
        openTaskCounts(db, userId),
      ]);
      const rows = categories
        .filter((c) => include_archived || !c.archived)
        .map((c) => ({
          id: c.id,
          path: c.path,
          open_tasks: counts.get(c.id) ?? 0,
          archived: c.archived,
        }));
      const text = rows.length
        ? rows
            .map(
              (c) =>
                `- ${c.path}${c.open_tasks ? ` (${c.open_tasks} open)` : ""}${c.archived ? " [archived]" : ""}`,
            )
            .join("\n")
        : "No categories yet. Arthur creates them in /agenda/backlog.";
      return {
        content: [{ type: "text", text }],
        structuredContent: { categories: rows },
      };
    },
  );

  server.registerTool(
    "list_tasks",
    {
      title: "List backlog tasks",
      description:
        "Tasks in the backlog, most urgent first (priority, then deadline, then oldest). By default lists open tasks (backlog and scheduled). Tasks drawn directly inside a block on the grid are not part of the backlog and are not listed.",
      inputSchema: z.object({
        category: categoryRef.optional().describe("Only this category and its subcategories."),
        status: z
          .array(z.enum(["backlog", "scheduled", "done", "dropped"]))
          .optional()
          .describe("Statuses to include. Default: backlog and scheduled."),
        max_priority: priority.optional().describe("Keep tasks at least this urgent: 2 keeps urgent and high."),
        deadline_before: date.optional().describe("Keep tasks due on or before this date."),
        query: z.string().max(200).optional().describe("Text to look for in descriptions."),
        limit: z.number().int().min(1).max(200).optional().describe("Default 50."),
      }),
      outputSchema: z.object({
        tasks: z.array(taskOut),
        truncated: z.boolean(),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (input, ctx) => {
      const { db, userId } = callerOf(ctx.http?.authInfo);
      const categories = await loadCategoryPaths(db, userId);

      let categoryId: string | undefined;
      if (input.category) {
        // Filtering may target an archived branch: resolve against live first,
        // then accept an archived match, since reading old work is legitimate.
        const r = resolveCategoryRef(categories, input.category);
        if (r.ok) categoryId = r.id;
        else {
          const archived = resolveCategoryRef(
            categories.map((c) => ({ ...c, archived: false })),
            input.category,
          );
          if (!archived.ok) return failure(categoryFailure(input.category, categories)!);
          categoryId = archived.id;
        }
      }

      let deadlineBefore: string | undefined;
      if (input.deadline_before) {
        const d = parseDeadline(input.deadline_before);
        if (!d.ok) return failure(d.error);
        deadlineBefore = d.value ?? undefined;
      }

      const { tasks, truncated } = await listTasks(db, userId, categories, {
        categoryId,
        statuses: input.status as TaskStatus[] | undefined,
        maxPriority: input.max_priority,
        deadlineBefore,
        query: input.query,
        limit: input.limit,
      });

      const paths = pathMap(categories);
      const out = tasks.map((t: ListedTask) => toOut(t, paths, t.category_path));
      const total = out.reduce((s, t) => s + t.estimated_minutes, 0);
      const text = out.length
        ? `${out.length} task${out.length > 1 ? "s" : ""}, ${total} min estimated${truncated ? " (more exist — narrow the filters or raise the limit)" : ""}:\n${out.map(line).join("\n")}`
        : "No task matches.";
      return {
        content: [{ type: "text", text }],
        structuredContent: { tasks: out, truncated },
      };
    },
  );

  server.registerTool(
    "create_tasks",
    {
      title: "Add tasks to the backlog",
      description:
        "Add one or more tasks (up to 25) to the backlog. All categories are checked first: if any reference is unknown or ambiguous, nothing is created and the error lists the closest categories.",
      inputSchema: z.object({
        tasks: z
          .array(
            z.object({
              category: categoryRef,
              description: z
                .string()
                .max(TASK_LIMITS.maxDescription)
                .optional()
                .describe("What this task specifically is — short and concrete."),
              estimated_minutes: minutes,
              priority: priority.optional().describe("Default 3 (normal)."),
              deadline: date.optional(),
              splittable: z
                .boolean()
                .optional()
                .describe("Can be spread over several sessions on the grid. Default true."),
            }),
          )
          .min(1)
          .max(25),
      }),
      outputSchema: z.object({ created: z.array(taskOut) }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ tasks }, ctx) => {
      const { db, userId } = callerOf(ctx.http?.authInfo);
      const categories = await loadCategoryPaths(db, userId);

      const problems: string[] = [];
      const resolved = tasks.map((t, i) => {
        const at = tasks.length > 1 ? `Task ${i + 1}: ` : "";
        const r = resolveCategoryRef(categories, t.category);
        if (!r.ok) problems.push(categoryFailure(t.category, categories, at)!);
        const d = parseDeadline(t.deadline);
        if (!d.ok) problems.push(at + d.error);
        return { categoryId: r.ok ? r.id : "", deadline: d.ok ? d.value : null };
      });
      if (problems.length) {
        return failure(`Nothing was created.\n${problems.join("\n")}`);
      }

      const result = await insertTasks(
        db,
        userId,
        tasks.map((t, i) => ({
          categoryId: resolved[i].categoryId,
          description: t.description ?? null,
          estimatedMinutes: t.estimated_minutes,
          priority: t.priority ?? 3,
          deadline: resolved[i].deadline,
          splittable: t.splittable,
        })),
      );
      if (!result.ok) return failure(`Nothing was created. ${result.error}`);

      const paths = pathMap(categories);
      const created = result.value.map((t) => toOut(t, paths));
      return {
        content: [
          {
            type: "text",
            text: `Created ${created.length} task${created.length > 1 ? "s" : ""}:\n${created.map(line).join("\n")}`,
          },
        ],
        structuredContent: { created },
      };
    },
  );

  server.registerTool(
    "update_task",
    {
      title: "Edit a task",
      description:
        "Change a backlog task's category, description, estimate, priority or deadline. Only the fields given change; pass null to clear the description or the deadline.",
      inputSchema: z.object({
        id: taskId,
        category: categoryRef.optional(),
        description: z.string().max(TASK_LIMITS.maxDescription).nullable().optional(),
        estimated_minutes: minutes.optional(),
        priority: priority.optional(),
        deadline: date.nullable().optional(),
      }),
      outputSchema: z.object({ task: taskOut }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input, ctx) => {
      const { db, userId } = callerOf(ctx.http?.authInfo);
      const [categories, task] = await Promise.all([
        loadCategoryPaths(db, userId),
        getTask(db, userId, input.id),
      ]);
      if (!task) return failure(`No task with id ${input.id}.`);
      if (task.ad_hoc) {
        return failure("This task was drawn inside a block on the grid; edit it from the week view.");
      }

      let categoryId: string | undefined;
      if (input.category !== undefined) {
        const r = resolveCategoryRef(categories, input.category);
        if (!r.ok) return failure(categoryFailure(input.category, categories)!);
        categoryId = r.id;
      }
      let deadline: string | null | undefined;
      if (input.deadline !== undefined) {
        const d = parseDeadline(input.deadline);
        if (!d.ok) return failure(d.error);
        deadline = d.value;
      }

      const result = await patchTask(db, userId, input.id, {
        categoryId,
        description: input.description,
        estimatedMinutes: input.estimated_minutes,
        priority: input.priority,
        deadline,
      });
      if (!result.ok) return failure(result.error);

      const out = toOut({ ...result.value, placed_minutes: task.placed_minutes }, pathMap(categories));
      return {
        content: [{ type: "text", text: `Updated:\n${line(out)}` }],
        structuredContent: { task: out },
      };
    },
  );

  server.registerTool(
    "set_task_status",
    {
      title: "Complete, drop or reopen a task",
      description:
        'Mark a task done or dropped, or reopen it. Reopening puts it back in the backlog — or back to "scheduled" if it is still placed on the grid.',
      inputSchema: z.object({
        id: taskId,
        status: z.enum(["done", "dropped", "open"]),
      }),
      outputSchema: z.object({ task: taskOut }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ id, status }, ctx) => {
      const { db, userId } = callerOf(ctx.http?.authInfo);
      const [categories, task] = await Promise.all([
        loadCategoryPaths(db, userId),
        getTask(db, userId, id),
      ]);
      if (!task) return failure(`No task with id ${id}.`);
      if (task.ad_hoc) {
        return failure("This task was drawn inside a block on the grid; mark it from the week view.");
      }

      const next: TaskStatus =
        status === "open" ? (task.placements > 0 ? "scheduled" : "backlog") : status;
      const result = await patchTask(db, userId, id, { status: next });
      if (!result.ok) return failure(result.error);

      const out = toOut({ ...result.value, placed_minutes: task.placed_minutes }, pathMap(categories));
      return {
        content: [{ type: "text", text: `Now ${next}:\n${line(out)}` }],
        structuredContent: { task: out },
      };
    },
  );

  server.registerTool(
    "delete_task",
    {
      title: "Delete a task",
      description:
        "Permanently delete a backlog task. Refused for a task placed on the week grid — mark it dropped with set_task_status instead, which keeps the week's history intact.",
      inputSchema: z.object({ id: taskId }),
      outputSchema: z.object({ deleted: z.string() }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ id }, ctx) => {
      const { db, userId } = callerOf(ctx.http?.authInfo);
      const task = await getTask(db, userId, id);
      if (!task) return failure(`No task with id ${id}.`);
      if (task.ad_hoc || task.placements > 0) {
        return failure(
          `This task is placed on the week grid (${task.placed_minutes} min), so deleting it would remove planned time. Use set_task_status with "dropped" instead.`,
        );
      }

      const result = await removeTask(db, userId, id);
      if (!result.ok) return failure(result.error);
      return {
        content: [
          {
            type: "text",
            text: `Deleted the task${task.description ? ` "${task.description}"` : ""} (id ${id}).`,
          },
        ],
        structuredContent: { deleted: id },
      };
    },
  );
}
