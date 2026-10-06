"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { NotesEditor } from "@/components/ui/NotesEditor";
import { ErrorLine, StatusBadge, TagChip } from "./bits";
import { InlineText, Section, useAction } from "./controls";
import { NewApplicationForm } from "./NewApplicationForm";
import type { ApplicationSummary, Company, JobTag } from "@/lib/jobs/types";
import { deleteCompany, updateCompany } from "@/server/actions/jobs";

export function CompanyView({
  company,
  applications,
  tags,
  companies,
}: {
  company: Company;
  applications: ApplicationSummary[];
  tags: JobTag[];
  companies: { id: string; name: string }[];
}) {
  const router = useRouter();
  const { pending, error, run } = useAction();
  const [adding, setAdding] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  return (
    <main className={`mx-auto w-full max-w-4xl px-4 py-6 sm:px-6 sm:py-8 ${pending ? "opacity-80" : ""}`}>
      <Link href="/jobs/companies" className="text-xs text-muted hover:text-foreground">
        ← Companies
      </Link>
      <h1 className="mt-3 text-xl font-semibold tracking-tight">
        <InlineText value={company.name} onSave={(name) => run(() => updateCompany(company.id, { name }))} />
      </h1>
      <div className="mt-1 text-xs text-muted">
        {company.website && (
          <a href={company.website} target="_blank" rel="noreferrer noopener" className="mr-2 text-accent underline">
            website ↗
          </a>
        )}
        <InlineText
          type="url"
          value={company.website ?? ""}
          placeholder="add website"
          onSave={(website) => run(() => updateCompany(company.id, { website: website || null }))}
        />
      </div>
      <ErrorLine error={error} />

      <div className="mt-6 grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <Section title="Notes">
          <NotesEditor
            value={company.notes}
            onSave={(notes) => run(() => updateCompany(company.id, { notes }))}
            placeholder={"Contacts, what they do, culture, news, what people said…\n## Contacts\n- "}
          />
        </Section>

        <Section
          title="Applications"
          aside={
            !adding && (
              <button onClick={() => setAdding(true)} className="text-xs text-accent hover:underline">
                + Application
              </button>
            )
          }
        >
          {adding && (
            <div className="mb-3">
              <NewApplicationForm
                tags={tags}
                companies={companies}
                defaultCompany={company.name}
                onDone={() => setAdding(false)}
              />
            </div>
          )}
          <ul className="space-y-2">
            {applications.map((a) => (
              <li key={a.id} className="flex items-center gap-2 text-sm">
                <Link href={`/jobs/${a.id}`} className="min-w-0 flex-1 truncate hover:text-accent">
                  {a.role_title}
                </Link>
                <span className="hidden gap-1 sm:flex">
                  {a.tags.map((t) => (
                    <TagChip key={t.id} tag={t} />
                  ))}
                </span>
                <StatusBadge status={a.status} />
              </li>
            ))}
          </ul>
          {applications.length === 0 && (
            <div className="text-xs text-muted">
              No application left.{" "}
              {confirmDelete ? (
                <>
                  Delete the company and its notes?{" "}
                  <button onClick={() => setConfirmDelete(false)} className="underline">
                    Keep
                  </button>{" "}
                  <button
                    onClick={() => run(() => deleteCompany(company.id), () => router.push("/jobs/companies"))}
                    className="text-red-500 underline"
                  >
                    Delete
                  </button>
                </>
              ) : (
                <button onClick={() => setConfirmDelete(true)} className="underline hover:text-red-500">
                  Delete the company
                </button>
              )}
            </div>
          )}
        </Section>
      </div>
    </main>
  );
}
