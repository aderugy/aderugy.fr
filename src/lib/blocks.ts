import { DEFAULT_COLOR, type CategoryNode } from "./categories";
import type { GridChild, ScheduledBlock } from "./types";

/** Minutes a block occupies on the grid, tasks or no tasks. */
export function blockMinutes(block: ScheduledBlock): number {
  return Math.round(
    (new Date(block.ends_at).getTime() - new Date(block.starts_at).getTime()) / 60_000,
  );
}

/** Minutes the tasks inside a block claim between them. */
export function childMinutes(block: ScheduledBlock): number {
  return block.scheduled_block_tasks.reduce((sum, l) => sum + l.planned_minutes, 0);
}

/**
 * The tasks of a block, in order and already stacked.
 *
 * `offsetMinutes` is the running sum of what came before, which is what lets
 * the grid place each child against the same time axis as the block itself.
 */
export function blockChildren(
  block: ScheduledBlock,
  categories: Map<string, CategoryNode>,
): GridChild[] {
  let offset = 0;

  return [...block.scheduled_block_tasks]
    .sort((a, b) => a.position - b.position || a.task_id.localeCompare(b.task_id))
    .map((link) => {
      const category = link.tasks ? categories.get(link.tasks.category_id) : undefined;
      const child: GridChild = {
        id: link.task_id,
        label: category?.name ?? "Uncategorised",
        categoryId: link.tasks?.category_id ?? null,
        description: link.tasks?.description ?? null,
        color: category?.effectiveColor ?? DEFAULT_COLOR,
        minutes: link.planned_minutes,
        offsetMinutes: offset,
      };
      offset += link.planned_minutes;
      return child;
    });
}

/**
 * Minutes per category across a set of blocks.
 *
 * A block contributes nothing by itself — it has no category. Its time is the
 * time of the tasks inside it, each counted against its own category and for
 * its own planned minutes. Time in a block that no task claims stays
 * unattributed rather than being spread over the categories present.
 */
export function plannedMinutesByCategory(
  blocks: ScheduledBlock[],
): Map<string, number> {
  const out = new Map<string, number>();

  for (const block of blocks) {
    for (const link of block.scheduled_block_tasks) {
      const categoryId = link.tasks?.category_id;
      if (!categoryId || link.planned_minutes <= 0) continue;
      out.set(categoryId, (out.get(categoryId) ?? 0) + link.planned_minutes);
    }
  }

  return out;
}

/**
 * What the tasks of a block become when the block is resized from `fromMinutes`
 * to `toMinutes`, aligned with `minutes` (the tasks in stacking order).
 *
 * One task: it follows the block when it filled it (or overfilled it) — the
 * usual case, a block drawn on the grid or a single backlog task dropped in.
 * A task deliberately shorter than its block keeps its minutes, and is only
 * clipped if the block shrinks under it.
 *
 * Several tasks: unchanged. Which of them should absorb the difference is a
 * choice, not arithmetic, so the block grows unclaimed time instead.
 */
export function resizedChildMinutes(
  minutes: number[],
  fromMinutes: number,
  toMinutes: number,
): number[] {
  if (minutes.length !== 1 || fromMinutes === toMinutes) return minutes;
  const [only] = minutes;
  if (only >= fromMinutes) return [toMinutes];
  return [Math.min(only, toMinutes)];
}
