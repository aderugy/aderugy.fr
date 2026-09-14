import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { LOGIN_PATH } from "@/lib/supabase/session";
import { CategoryTree } from "@/components/agenda/CategoryTree";
import { TaskTable } from "@/components/agenda/TaskTable";
import type { Category, Task } from "@/lib/types";

export const metadata = { title: "Backlog — Agenda" };

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
        "id, category_id, description, estimated_minutes, priority, deadline, status, splittable, ad_hoc, completed_at, created_at",
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
      <main className="mx-auto max-w-lg px-6 py-20 text-sm">
        <h1 className="font-medium">Could not load the backlog</h1>
        <p className="mt-2 text-muted">{error.message}</p>
      </main>
    );
  }

  const categories = (categoriesRes.data ?? []) as Category[];
  const tasks = (tasksRes.data ?? []) as Task[];

  const taskCounts = new Map<string, number>();
  for (const task of tasks) {
    if (!task.category_id) continue;
    taskCounts.set(task.category_id, (taskCounts.get(task.category_id) ?? 0) + 1);
  }

  return (
    <main className="mx-auto grid w-full max-w-5xl gap-10 px-6 py-8 lg:grid-cols-[260px_1fr]">
      <CategoryTree categories={categories} taskCounts={taskCounts} />
      <TaskTable categories={categories} tasks={tasks} />
    </main>
  );
}
