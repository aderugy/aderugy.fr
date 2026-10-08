import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { LOGIN_PATH } from "@/lib/supabase/session";
import { GoogleConnection } from "@/components/agenda/GoogleConnection";
import { ConnectedApps, type ConnectedApp } from "@/components/agenda/ConnectedApps";
import {
  NotificationSettings,
  type PushDevice,
} from "@/components/agenda/NotificationSettings";
import type {
  CalendarSource,
  Category,
  GoogleAccount,
  GoogleSyncState,
  PushStatus,
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

  const [accountRes, sourcesRes, syncRes, categoriesRes, pushRes, grantsRes, devicesRes, prefsRes] =
    await Promise.all([
    supabase
      .from("google_accounts")
      .select(
        "google_email, connected_at, disconnected_at, last_error, last_error_at, scopes, push_enabled, push_calendar_id, last_pushed_at, push_error",
      )
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
    supabase
      .from("push_status")
      .select("pending, failed, synced, last_block_error")
      .eq("user_id", user.id)
      .maybeSingle(),
    // Errors when the OAuth server is not enabled on the project — the section
    // then says so rather than claiming nothing is connected.
    supabase.auth.oauth.listGrants().catch((e: unknown) => ({
      data: null,
      error: e instanceof Error ? e : new Error("Could not list connected apps"),
    })),
    supabase
      .from("push_subscriptions")
      .select("id, endpoint, label, created_at, last_success_at, last_error, last_error_at")
      .eq("user_id", user.id)
      .order("created_at"),
    supabase
      .from("notification_prefs")
      .select("block_reminders, lead_minutes")
      .eq("user_id", user.id)
      .maybeSingle(),
  ]);

  const apps: ConnectedApp[] = (grantsRes.data ?? []).map((g) => ({
    clientId: g.client.id,
    name: g.client.name || "Unnamed app",
    grantedAt: g.granted_at,
  }));

  return (
    <main className="mx-auto w-full max-w-2xl space-y-6 px-4 py-6 sm:px-6 sm:py-8">
      <h1 className="text-lg font-semibold tracking-tight">Settings</h1>

      <GoogleConnection
        account={(accountRes.data ?? null) as GoogleAccount | null}
        sources={(sourcesRes.data ?? []) as CalendarSource[]}
        syncState={(syncRes.data ?? []) as GoogleSyncState[]}
        categories={(categoriesRes.data ?? []) as Category[]}
        pushStatus={(pushRes.data ?? null) as PushStatus | null}
        notice={{ error: typeof params.error === "string" ? params.error : undefined }}
      />

      <NotificationSettings
        devices={(devicesRes.data ?? []) as PushDevice[]}
        prefs={{
          // No row yet means the defaults the reminder sweep applies too.
          blockReminders: prefsRes.data?.block_reminders ?? true,
          leadMinutes: prefsRes.data?.lead_minutes ?? 10,
        }}
      />

      <ConnectedApps
        apps={apps}
        unavailable={
          grantsRes.error
            ? `Connected apps are unavailable: ${grantsRes.error.message}`
            : null
        }
      />
    </main>
  );
}
