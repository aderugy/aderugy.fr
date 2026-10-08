import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { LOGIN_PATH } from "@/lib/supabase/session";
import { BacklogView } from "@/components/agenda/backlog/BacklogView";
import type { BacklogTask } from "@/components/agenda/backlog/shared";
import { fmtWhen, localDate } from "@/lib/agenda/zoned";
import type { Category, Task } from "@/lib/types";

export const metadata = { title: "Backlog — Agenda" };

const APP_TIMEZONE = process.env.NEXT_PUBLIC_APP_TIMEZONE ?? "Europe/Paris";

type BlockLink = {
  task_id: string;
  scheduled_blocks:
    | { starts_at: string; status: string }
    | { starts_at: string; status: string }[]
    | null;
};

export default async function BacklogPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  // Defence in depth: the proxy already gates this, but a bypassed or
  // misconfigured proxy must not render a blank page.
  if (!user) redirect(LOGIN_PATH);

  const [categoriesRes, tasksRes] = await Promise.all([
    supabase
      .from("categories")
      .select("id, parent_id, name, color, position, archived")
      .eq("user_id", user.id)
      .eq("archived", false)
      .order("position"),
    supabase
      .from("tasks")
      .select(
        "id, category_id, description, notes, estimated_minutes, priority, deadline, status, splittable, ad_hoc, completed_at, created_at",
      )
      .eq("user_id", user.id)
      .in("status", ["backlog", "scheduled"])
      // Tasks created inside a block are instances of a plan, not work waiting
      // to be planned. They belong to their block, and listing them here would
      // fill the backlog with rows you cannot act on.
      .eq("ad_hoc", false)
      .order("created_at", { ascending: false }),
  ]);

  const error = categoriesRes.error ?? tasksRes.error;
  if (error) {
    return (
      <main className="mx-auto max-w-lg px-5 py-16 text-sm sm:px-6 sm:py-20">
        <h1 className="font-medium">Could not load the backlog</h1>
        <p className="mt-2 text-muted">{error.message}</p>
      </main>
    );
  }

  const categories = (categoriesRes.data ?? []) as Category[];
  const rows = (tasksRes.data ?? []) as Task[];
  const now = new Date().getTime();

  // When each scheduled task is on the grid: its next block that is not
  // skipped, or the last one if they are all past. Shown on the row, and used
  // to order the Scheduled list.
  const scheduledIds = rows.filter((t) => t.status === "scheduled").map((t) => t.id);
  const when = new Map<string, string>();
  if (scheduledIds.length) {
    const { data: links } = await supabase
      .from("scheduled_block_tasks")
      .select("task_id, scheduled_blocks(starts_at, status)")
      .eq("user_id", user.id)
      .in("task_id", scheduledIds);

    const starts = new Map<string, number[]>();
    for (const link of (links ?? []) as unknown as BlockLink[]) {
      const block = Array.isArray(link.scheduled_blocks)
        ? link.scheduled_blocks[0]
        : link.scheduled_blocks;
      if (!block || block.status === "skipped") continue;
      const list = starts.get(link.task_id) ?? [];
      list.push(Date.parse(block.starts_at));
      starts.set(link.task_id, list);
    }
    for (const [id, list] of starts) {
      const upcoming = list.filter((t) => t >= now).sort((a, b) => a - b);
      const pick = upcoming[0] ?? Math.max(...list);
      when.set(id, new Date(pick).toISOString());
    }
  }

  const tasks: BacklogTask[] = rows.map((t) => {
    const at = when.get(t.id) ?? null;
    return {
      ...t,
      scheduled_at: at,
      scheduled_label: at ? fmtWhen(at, APP_TIMEZONE) : null,
    };
  });

  return (
    <BacklogView
      categories={categories}
      tasks={tasks}
      today={localDate(now, APP_TIMEZONE)}
    />
  );
}
