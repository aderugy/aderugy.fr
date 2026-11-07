"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createProject } from "@/server/actions/projects";
import { useAction } from "@/components/jobs/controls";

export function NewProjectForm() {
  const router = useRouter();
  const [slug, setSlug] = useState("");
  const [name, setName] = useState("");
  const { pending, error, run } = useAction();

  return (
    <form
      className="mt-8 rounded-lg border border-line bg-surface p-4"
      onSubmit={(e) => {
        e.preventDefault();
        run(async () => {
          const r = await createProject(slug, name);
          if (r.ok) router.push(`/projects/${r.value}?tab=contrat`);
          return r;
        });
      }}
    >
      <h2 className="text-xs font-medium tracking-wide text-muted uppercase">Nouveau projet</h2>
      <div className="mt-3 flex flex-col gap-2 sm:flex-row">
        <input
          value={slug}
          onChange={(e) => setSlug(e.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, ""))}
          placeholder="MAD"
          maxLength={12}
          className="w-full rounded border border-line bg-background px-2 py-1.5 font-mono text-sm sm:w-28"
          aria-label="Slug"
        />
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="market-anomaly-detection"
          maxLength={120}
          className="min-w-0 flex-1 rounded border border-line bg-background px-2 py-1.5 text-sm"
          aria-label="Nom"
        />
        <button
          disabled={pending || slug.length < 2 || !name.trim()}
          className="rounded bg-accent px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
        >
          Créer
        </button>
      </div>
      <p className="mt-2 text-xs text-muted">Il démarre en brouillon : remplis le contrat, puis valide-le.</p>
      {error && <p className="mt-2 text-xs text-red-500">{error}</p>}
    </form>
  );
}
