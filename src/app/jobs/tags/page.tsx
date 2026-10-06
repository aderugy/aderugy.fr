import { requireUser } from "@/server/auth";
import { listApplications, loadTags } from "@/server/jobs/data";
import { TagManager } from "@/components/jobs/TagManager";
import type { ApplicationSummary, JobTag } from "@/lib/jobs/types";

export const metadata = { title: "Tags — Jobs" };

export default async function TagsPage() {
  const { supabase, user } = await requireUser();

  let tags: JobTag[];
  let applications: ApplicationSummary[];
  try {
    [tags, applications] = await Promise.all([loadTags(supabase, user.id), listApplications(supabase, user.id)]);
  } catch (e) {
    return (
      <main className="mx-auto max-w-lg px-5 py-16 text-sm sm:px-6 sm:py-20">
        <h1 className="font-medium">Could not load tags</h1>
        <p className="mt-2 text-muted">{(e as { message?: string })?.message ?? String(e)}</p>
      </main>
    );
  }

  const counts: Record<string, number> = {};
  for (const a of applications) for (const t of a.tags) counts[t.id] = (counts[t.id] ?? 0) + 1;

  return <TagManager tags={tags} counts={counts} />;
}
