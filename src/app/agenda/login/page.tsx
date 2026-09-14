import { LoginForm } from "@/components/agenda/LoginForm";
import { safeNext } from "@/lib/supabase/session";

export const metadata = { title: "Sign in — Agenda" };

export default async function LoginPage({
  searchParams,
}: PageProps<"/agenda/login">) {
  const params = await searchParams;
  const next = safeNext(typeof params.next === "string" ? params.next : null);
  const error = typeof params.error === "string" ? params.error : null;

  const configured =
    !!process.env.NEXT_PUBLIC_SUPABASE_URL &&
    !!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  return (
    <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center px-6 py-24">
      <h1 className="text-xl font-semibold tracking-tight">Agenda</h1>
      <p className="mt-1 text-sm text-muted">
        Sign in with a magic link — no password to remember.
      </p>

      {error && (
        <p className="mt-4 rounded-lg border border-red-500/40 bg-red-500/5 p-3 text-sm text-red-500">
          {error}
        </p>
      )}

      {configured ? (
        <LoginForm next={next} />
      ) : (
        <p className="mt-6 rounded-lg border border-line bg-surface p-4 text-sm text-muted">
          Supabase is not configured. Copy <code>.env.example</code> to{" "}
          <code>.env.local</code> and fill in your project URL and anon key.
        </p>
      )}
    </main>
  );
}
