import Link from "next/link";
import { requireUser } from "@/server/auth";
import { listApplications, loadCompanies, type CompanyWithCount } from "@/server/jobs/data";
import { StatusBadge } from "@/components/jobs/bits";
import { OPEN_STATUSES, type ApplicationSummary } from "@/lib/jobs/types";

export const metadata = { title: "Companies — Jobs" };

export default async function CompaniesPage() {
  const { supabase, user } = await requireUser();

  let companies: CompanyWithCount[];
  let applications: ApplicationSummary[];
  try {
    [companies, applications] = await Promise.all([
      loadCompanies(supabase, user.id),
      listApplications(supabase, user.id),
    ]);
  } catch (e) {
    return (
      <main className="mx-auto max-w-lg px-5 py-16 text-sm sm:px-6 sm:py-20">
        <h1 className="font-medium">Could not load companies</h1>
        <p className="mt-2 text-muted">{(e as { message?: string })?.message ?? String(e)}</p>
      </main>
    );
  }

  const byCompany = new Map<string, ApplicationSummary[]>();
  for (const a of applications) {
    const list = byCompany.get(a.company_id) ?? [];
    list.push(a);
    byCompany.set(a.company_id, list);
  }
  // Companies with something open first, then by name.
  const sorted = [...companies].sort((a, b) => {
    const openA = (byCompany.get(a.id) ?? []).some((x) => OPEN_STATUSES.includes(x.status)) ? 0 : 1;
    const openB = (byCompany.get(b.id) ?? []).some((x) => OPEN_STATUSES.includes(x.status)) ? 0 : 1;
    return openA - openB || a.name.localeCompare(b.name);
  });

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6 sm:py-8">
      <h1 className="text-lg font-semibold tracking-tight">Companies</h1>
      <p className="mt-1 text-xs text-muted">
        One page per company, shared by every application to it. New companies come from new applications.
      </p>
      {sorted.length === 0 ? (
        <p className="mt-10 text-center text-sm text-muted">None yet.</p>
      ) : (
        <ul className="mt-4 divide-y divide-line rounded-lg border border-line bg-surface">
          {sorted.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center gap-2 px-3 py-2.5">
              <Link href={`/jobs/companies/${c.id}`} className="text-sm font-medium hover:text-accent">
                {c.name}
              </Link>
              {c.notes && <span className="text-[11px] text-muted">notes</span>}
              <span className="ml-auto flex flex-wrap gap-1">
                {(byCompany.get(c.id) ?? []).map((a) => (
                  <Link key={a.id} href={`/jobs/${a.id}`} title={a.role_title}>
                    <StatusBadge status={a.status} />
                  </Link>
                ))}
              </span>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
