import { requireUser } from "@/server/auth";
import { listApplications, loadCompanies, loadTags } from "@/server/jobs/data";
import { ApplicationList } from "@/components/jobs/ApplicationList";

export const metadata = { title: "Applications — Jobs" };

export default async function JobsPage() {
  const { supabase, user } = await requireUser();

  let loaded;
  try {
    const [applications, tags, companies] = await Promise.all([
      listApplications(supabase, user.id),
      loadTags(supabase, user.id),
      loadCompanies(supabase, user.id),
    ]);
    loaded = { applications, tags, companies };
  } catch (e) {
    return (
      <main className="mx-auto max-w-lg px-5 py-16 text-sm sm:px-6 sm:py-20">
        <h1 className="font-medium">Could not load your applications</h1>
        <p className="mt-2 text-muted">{(e as { message?: string })?.message ?? String(e)}</p>
        <p className="mt-4 text-muted">
          If this is the first visit, apply <code>supabase/migrations/0017_jobs.sql</code> first.
        </p>
      </main>
    );
  }

  return (
    <ApplicationList
      applications={loaded.applications}
      tags={loaded.tags}
      companies={loaded.companies.map((c) => ({ id: c.id, name: c.name }))}
      now={new Date().toISOString()}
    />
  );
}
