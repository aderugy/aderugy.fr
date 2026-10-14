import { requireUser } from "@/server/auth";
import { loadSettings, loadTags } from "@/server/flashcards/data";
import { SettingsForm } from "@/components/flashcards/SettingsForm";

export const metadata = { title: "Settings — Flashcards" };

export default async function SettingsPage() {
  const { supabase, user } = await requireUser();
  const [settings, tags] = await Promise.all([loadSettings(supabase, user.id), loadTags(supabase)]);
  return <SettingsForm settings={settings} tags={tags} />;
}
