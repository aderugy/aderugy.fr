import { notFound } from "next/navigation";
import { requireUser } from "@/server/auth";
import { getCompany, listApplications, loadCompanies, loadTags } from "@/server/jobs/data";
import { CompanyView } from "@/components/jobs/CompanyView";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const metadata = { title: "Company — Jobs" };

export default async function CompanyPage({ params }: PageProps<"/jobs/companies/[id]">) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const { supabase, user } = await requireUser();

  let loaded;
  try {
    const [company, applications, tags, companies] = await Promise.all([
      getCompany(supabase, user.id, id),
      listApplications(supabase, user.id, { companyId: id }),
      loadTags(supabase, user.id),
      loadCompanies(supabase, user.id),
    ]);
    loaded = { company, applications, tags, companies };
  } catch (e) {
    return (
      <main className="mx-auto max-w-lg px-5 py-16 text-sm sm:px-6 sm:py-20">
        <h1 className="font-medium">Could not load this company</h1>
        <p className="mt-2 text-muted">{(e as { message?: string })?.message ?? String(e)}</p>
      </main>
    );
  }
  if (!loaded.company) notFound();

  return (
    <CompanyView
      company={loaded.company}
      applications={loaded.applications}
      tags={loaded.tags}
      companies={loaded.companies.map((c) => ({ id: c.id, name: c.name }))}
    />
  );
}
