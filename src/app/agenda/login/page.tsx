import { LoginForm } from "@/components/agenda/LoginForm";

export const metadata = { title: "Sign in — Agenda" };

export default function LoginPage() {
  const configured =
    !!process.env.NEXT_PUBLIC_SUPABASE_URL &&
    !!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  return (
    <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center px-6 py-24">
      <h1 className="text-xl font-semibold tracking-tight">Agenda</h1>
      <p className="mt-1 text-sm text-muted">
        Sign in with a magic link — no password to remember.
      </p>

      {configured ? (
        <LoginForm />
      ) : (
        <p className="mt-6 rounded-lg border border-line bg-surface p-4 text-sm text-muted">
          Supabase is not configured. Copy <code>.env.example</code> to{" "}
          <code>.env.local</code> and fill in your project URL and anon key.
        </p>
      )}
    </main>
  );
}
