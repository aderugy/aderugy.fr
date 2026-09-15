import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { LOGIN_PATH } from "@/lib/supabase/session";
import { GoogleConnection } from "@/components/agenda/GoogleConnection";
import type {
  CalendarSource,
  Category,
  GoogleAccount,
  GoogleSyncState,
} from "@/lib/types";

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

  const [accountRes, sourcesRes, syncRes, categoriesRes] = await Promise.all([
    supabase
      .from("google_accounts")
      .select("google_email, connected_at, disconnected_at, last_error, last_error_at")
      .eq("user_id", user.id)
      .maybeSingle(),
    supabase
      .from("calendar_sources")
      .select(
        "id, provider, external_id, display_name, color, category_id, enabled, include_all_day, include_free, include_declined, position",
      )
      .eq("user_id", user.id)
      .order("position"),
    supabase
      .from("google_sync_state")
      .select("google_calendar_id, summary, last_synced_at, last_error, last_error_at")
      .eq("user_id", user.id),
    supabase
      .from("categories")
      .select("id, parent_id, name, color, position, archived")
      .eq("user_id", user.id)
      .eq("archived", false)
      .order("position"),
  ]);

  return (
    <main className="mx-auto w-full max-w-2xl space-y-6 px-4 py-6 sm:px-6 sm:py-8">
      <h1 className="text-lg font-semibold tracking-tight">Settings</h1>

      <GoogleConnection
        account={(accountRes.data ?? null) as GoogleAccount | null}
        sources={(sourcesRes.data ?? []) as CalendarSource[]}
        syncState={(syncRes.data ?? []) as GoogleSyncState[]}
        categories={(categoriesRes.data ?? []) as Category[]}
        notice={{ error: typeof params.error === "string" ? params.error : undefined }}
      />
    </main>
  );
}
