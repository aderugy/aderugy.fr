import { createClient } from "@/lib/supabase/server";
import { CategoryTree } from "@/components/agenda/CategoryTree";
import { TaskTable } from "@/components/agenda/TaskTable";
import type { Category, Task } from "@/lib/types";

export const metadata = { title: "Backlog — Agenda" };

export default async function BacklogPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

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
        "id, category_id, title, notes, estimated_minutes, priority, deadline, status, splittable, completed_at, created_at",
      )
      .eq("user_id", user.id)
      .in("status", ["backlog", "scheduled"])
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
