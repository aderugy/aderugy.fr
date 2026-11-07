import { notFound } from "next/navigation";
import { requireUser } from "@/server/auth";
import { loadState } from "@/server/projects/data";
import { loadCategoryPaths } from "@/server/agenda/tasks";
import { ProjectView } from "@/components/projects/ProjectView";

const SLUG = /^[A-Za-z0-9-]{2,12}$/;

export async function generateMetadata({ params }: PageProps<"/projects/[slug]">) {
  const { slug } = await params;
  return { title: `${slug.toUpperCase()} — Projets` };
}

export default async function ProjectPage({ params, searchParams }: PageProps<"/projects/[slug]">) {
  const { slug } = await params;
  const { tab } = await searchParams;
  if (!SLUG.test(slug)) notFound();
  const { supabase, user } = await requireUser();

  const [state, categories] = await Promise.all([
    loadState(supabase, user.id, slug, { messageLimit: 60 }),
    loadCategoryPaths(supabase, user.id),
  ]);
  if (!state) notFound();

  return (
    <ProjectView
      key={state.project.id}
      state={state}
      categories={categories.filter((c) => !c.archived).map((c) => ({ id: c.id, path: c.path }))}
      initialTab={tab === "contrat" ? "contrat" : "focus"}
    />
  );
}
