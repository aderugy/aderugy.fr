import Link from "next/link";
import { requireUser } from "@/server/auth";
import { listProjects, loadStates, focusOf, unreadFor } from "@/server/projects/data";
import { clockOf } from "@/lib/projects/clock";
import { PROJECT_STATUS_LABELS } from "@/lib/projects/types";
import { NewProjectForm } from "@/components/projects/NewProjectForm";
import { stateTone } from "@/components/projects/tone";

export const metadata = { title: "Projets de recherche" };

export default async function ProjectsPage() {
  const { supabase, user } = await requireUser();

  let states;
  try {
    const projects = await listProjects(supabase, user.id);
    states = await loadStates(supabase, user.id, projects, { itemStatuses: ["open"], messageLimit: 5 });
  } catch (e) {
    return (
      <main className="mx-auto max-w-lg px-5 py-16 text-sm sm:px-6 sm:py-20">
        <h1 className="font-medium">Impossible de charger les projets</h1>
        <p className="mt-2 text-muted">{(e as { message?: string })?.message ?? String(e)}</p>
        <p className="mt-4 text-muted">
          Première visite ? Applique d&apos;abord <code>supabase/migrations/0030_projects.sql</code>.
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-2xl px-4 py-6 sm:px-6 sm:py-10">
      <div className="flex items-baseline gap-3">
        <h1 className="flex-1 text-lg font-semibold tracking-tight">Projets de recherche</h1>
      </div>
      <p className="mt-1 text-sm text-muted">
        Contrat, étapes budgétées, une seule étape ouverte, parking, et le fil avec Claude.
      </p>

      <ul className="mt-6 space-y-3">
        {states.map((s) => {
          const clock = s.open ? clockOf(s.open.totals.spent, s.open.budget_minutes, s.open.cut_minutes) : null;
          const unread = unreadFor(s, "arthur").length;
          return (
            <li key={s.project.id}>
              <Link
                href={`/projects/${s.project.slug}`}
                className={`block rounded-lg border bg-surface p-4 transition-colors hover:border-accent ${
                  s.project.status === "active" ? "border-line" : "border-line opacity-70"
                }`}
              >
                <div className="flex items-baseline gap-2">
                  <span className="font-mono text-sm font-semibold">{s.project.slug}</span>
                  <span className="min-w-0 flex-1 truncate text-sm">{s.project.name}</span>
                  {unread > 0 && (
                    <span className="rounded-full bg-accent px-1.5 text-[11px] font-medium text-white">✉ {unread}</span>
                  )}
                  <span className="shrink-0 text-xs text-muted">{PROJECT_STATUS_LABELS[s.project.status]}</span>
                </div>
                <p className={`mt-1.5 text-xs ${clock ? stateTone(clock.state).text : "text-muted"}`}>{focusOf(s, "arthur")}</p>
              </Link>
            </li>
          );
        })}
        {states.length === 0 && (
          <li className="rounded-lg border border-dashed border-line p-6 text-center text-sm text-muted">
            Aucun projet. Crée-en un ici, ou demande à Claude de rédiger le contrat (save_project).
          </li>
        )}
      </ul>

      <NewProjectForm />
    </main>
  );
}
