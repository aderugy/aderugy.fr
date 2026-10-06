import { notFound } from "next/navigation";
import { requireUser } from "@/server/auth";
import { getApplicationDetail, loadCompanies, loadTags } from "@/server/jobs/data";
import { lastInterviewCategory } from "@/server/jobs/agenda";
import { ApplicationView } from "@/components/jobs/ApplicationView";
import type { Category } from "@/lib/types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function generateMetadata({ params }: PageProps<"/jobs/[id]">) {
  const { id } = await params;
  if (!UUID.test(id)) return { title: "Application — Jobs" };
  const { supabase, user } = await requireUser();
  const { data } = await supabase
    .from("applications")
    .select("role_title, companies(name)")
    .eq("user_id", user.id)
    .eq("id", id)
    .maybeSingle();
  const c = data?.companies as { name: string } | { name: string }[] | null | undefined;
  const company = Array.isArray(c) ? c[0]?.name : c?.name;
  return { title: company ? `${company} — Jobs` : "Application — Jobs" };
}

export default async function ApplicationPage({ params, searchParams }: PageProps<"/jobs/[id]">) {
  const { id } = await params;
  const { warning } = await searchParams;
  if (!UUID.test(id)) notFound();
  const { supabase, user } = await requireUser();

  let loaded;
  try {
    const [detail, tags, companies, categoriesRes, interviewCategory] = await Promise.all([
      getApplicationDetail(supabase, user.id, id),
      loadTags(supabase, user.id),
      loadCompanies(supabase, user.id),
      supabase
        .from("categories")
        .select("id, parent_id, name, color, position, archived")
        .eq("user_id", user.id)
        .eq("archived", false)
        .order("position"),
      lastInterviewCategory(supabase, user.id),
    ]);
    if (categoriesRes.error) throw categoriesRes.error;
    loaded = { detail, tags, companies, categories: (categoriesRes.data ?? []) as Category[], interviewCategory };
  } catch (e) {
    return (
      <main className="mx-auto max-w-lg px-5 py-16 text-sm sm:px-6 sm:py-20">
        <h1 className="font-medium">Could not load this application</h1>
        <p className="mt-2 text-muted">{(e as { message?: string })?.message ?? String(e)}</p>
      </main>
    );
  }
  if (!loaded.detail) notFound();

  return (
    <ApplicationView
      app={loaded.detail}
      tags={loaded.tags}
      companies={loaded.companies.map((c) => ({ id: c.id, name: c.name }))}
      categories={loaded.categories}
      interviewCategoryId={loaded.interviewCategory}
      warning={typeof warning === "string" ? warning : null}
      now={new Date().toISOString()}
    />
  );
}
