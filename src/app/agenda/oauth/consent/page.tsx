import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { LOGIN_PATH } from "@/lib/supabase/session";
import { approveConnection, denyConnection } from "@/server/actions/oauth";

export const metadata = { title: "Connect an app — Agenda" };

/** Hosts the Claude apps send their OAuth callback to. */
const CLAUDE_HOSTS = new Set(["claude.ai", "claude.com"]);
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Consent screen for Supabase's OAuth 2.1 server (Authentication → OAuth
 * Server → Authorization path = /agenda/oauth/consent).
 *
 * Lives under /agenda so the existing gate handles a signed-out visit: the
 * proxy sends it to the login page with this URL — query string included — as
 * `next`, and sign-in lands back here.
 */
export default async function ConsentPage({
  searchParams,
}: PageProps<"/agenda/oauth/consent">) {
  const params = await searchParams;
  const id = typeof params.authorization_id === "string" ? params.authorization_id : "";
  const actionError = typeof params.error === "string" ? params.error : null;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect(LOGIN_PATH);

  if (!id) {
    return (
      <Shell>
        <Problem>
          This page is opened by an app asking to connect to your agenda. It was
          reached without an authorization request, so there is nothing to approve.
        </Problem>
      </Shell>
    );
  }

  const { data, error } = await supabase.auth.oauth.getAuthorizationDetails(id);

  if (error || !data) {
    return (
      <Shell>
        <Problem>
          {error?.message ?? "This authorization request could not be read."} It
          may have expired or already been answered — start the connection again
          from the app.
        </Problem>
      </Shell>
    );
  }

  // Already consented to these scopes: Supabase hands back the redirect.
  if (!("authorization_id" in data)) redirect(data.redirect_url);

  let host = data.redirect_uri;
  try {
    host = new URL(data.redirect_uri).host;
  } catch {
    // Show the raw value; an unparseable redirect is itself worth seeing.
  }
  const hostname = host.replace(/:\d+$/, "");
  const isClaude = CLAUDE_HOSTS.has(hostname);
  const isLoopback = LOOPBACK_HOSTS.has(hostname);
  const clientName = data.client.name || "An unnamed app";

  return (
    <Shell>
      <div className="rounded-lg border border-line bg-surface p-5 text-sm">
        <h1 className="text-base font-semibold tracking-tight">
          {clientName} wants to access your agenda
        </h1>
        <p className="mt-1 text-xs text-muted">
          Signed in as {data.user.email || user.email}
        </p>

        <dl className="mt-4 space-y-1 text-xs">
          <div className="flex gap-2">
            <dt className="w-32 shrink-0 text-muted">Sends you back to</dt>
            <dd className="font-mono font-medium break-all">{host}</dd>
          </div>
          {data.client.uri && (
            <div className="flex gap-2">
              <dt className="w-32 shrink-0 text-muted">Website</dt>
              <dd className="break-all">{data.client.uri}</dd>
            </div>
          )}
        </dl>

        {!isClaude && (
          <p className="mt-3 rounded border border-amber-500/40 bg-amber-500/5 p-2 text-xs text-amber-600 dark:text-amber-400">
            {isLoopback
              ? "This app runs on your own computer (a local address). Any program on that machine could be the one asking — approve only if you just started this from Claude Code or a tool you trust."
              : "This is not Claude. Approve only if you started this connection yourself and recognise the address above."}
          </p>
        )}

        <div className="mt-4 border-t border-line pt-4">
          <p className="font-medium">It will be able to</p>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-muted">
            <li>read, add, edit, complete and delete tasks in your backlog;</li>
            <li>read your category tree.</li>
          </ul>
          <p className="mt-3 font-medium">It will not be able to</p>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-muted">
            <li>change categories, your week, blocks or objectives;</li>
            <li>reach Google Calendar, poker or maths data.</li>
          </ul>
          <p className="mt-3 text-xs text-muted">
            You can revoke access at any time in Settings.
          </p>
        </div>

        {actionError && (
          <p className="mt-4 rounded border border-red-500/40 bg-red-500/5 p-2 text-xs text-red-500">
            {actionError}
          </p>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <form action={denyConnection}>
            <input type="hidden" name="authorization_id" value={data.authorization_id} />
            <button
              type="submit"
              className="rounded border border-line px-3 py-1.5 text-xs hover:border-accent"
            >
              Deny
            </button>
          </form>
          <form action={approveConnection}>
            <input type="hidden" name="authorization_id" value={data.authorization_id} />
            <button
              type="submit"
              className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-white"
            >
              Allow
            </button>
          </form>
        </div>
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return <main className="mx-auto w-full max-w-md px-4 py-10 sm:py-16">{children}</main>;
}

function Problem({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-line bg-surface p-5 text-sm">
      <h1 className="font-medium">Cannot connect this app</h1>
      <p className="mt-2 text-muted">{children}</p>
    </div>
  );
}
