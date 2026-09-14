import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { LOGIN_PATH } from "@/lib/supabase/session";
import { GoogleConnection } from "@/components/agenda/GoogleConnection";
import type { GoogleAccount, GoogleSyncState } from "@/lib/types";

export const metadata = { title: "Settings — Agenda" };

export default async function SettingsPage({
  searchParams,
}: PageProps<"/agenda/settings">) {
  const params = await searchParams;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect(LOGIN_PATH);

  const [accountRes, calendarsRes] = await Promise.all([
    supabase
      .from("google_accounts")
      .select(
        "google_email, busy_calendar_ids, connected_at, disconnected_at, last_error, last_error_at",
      )
      .eq("user_id", user.id)
      .maybeSingle(),
    supabase
      .from("google_sync_state")
      .select("google_calendar_id, summary, last_synced_at, last_error, last_error_at")
      .eq("user_id", user.id)
      .order("summary"),
  ]);

  return (
    <main className="mx-auto w-full max-w-2xl space-y-6 px-6 py-8">
      <h1 className="text-lg font-semibold tracking-tight">Settings</h1>

      <GoogleConnection
        account={(accountRes.data ?? null) as GoogleAccount | null}
        calendars={(calendarsRes.data ?? []) as GoogleSyncState[]}
        notice={{
          error: typeof params.error === "string" ? params.error : undefined,
          connected: params.connected === "1",
        }}
      />
    </main>
  );
}
