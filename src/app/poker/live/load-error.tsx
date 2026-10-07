/** What a page shows when its data cannot be read (often: the migration is not applied yet). */
export function LoadError({ what, error }: { what: string; error: unknown }) {
  return (
    <main className="mx-auto max-w-lg px-5 py-16 text-sm sm:px-6 sm:py-20">
      <h1 className="font-medium">Could not load {what}</h1>
      <p className="mt-2 text-muted">{(error as { message?: string })?.message ?? String(error)}</p>
      <p className="mt-4 text-muted">
        If this is the first visit, apply <code>supabase/migrations/0018_poker_live.sql</code> first.
      </p>
    </main>
  );
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
