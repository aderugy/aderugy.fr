import "server-only";
import { createClient } from "@supabase/supabase-js";
import type { RakeProfile } from "@/lib/poker";

const COLUMNS =
  "platform, platform_label, stakes, stakes_label, seats, seats_label, percent, cap_bb, cap_amount, big_blind, currency, is_default, position";

type Row = Record<string, unknown>;

/**
 * The rake presets shown by /poker.
 *
 * Read with a plain anon client rather than the cookie-bound one: these rows
 * are the same for everyone, and reading cookies would opt the page out of
 * static rendering for data that changes a few times a year.
 *
 * An unreachable database is not a broken page — the menu falls back to its
 * manual percent/cap fields, which is every preset's escape hatch anyway.
 */
export async function getRakeProfiles(): Promise<RakeProfile[]> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return [];

  const supabase = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data, error } = await supabase
    .from("rake_profiles")
    .select(COLUMNS)
    .order("position");

  if (error || !data) return [];
  return (data as Row[]).map(toProfile);
}

function toProfile(row: Row): RakeProfile {
  return {
    platform: String(row.platform),
    platformLabel: String(row.platform_label),
    stakes: String(row.stakes),
    stakesLabel: String(row.stakes_label),
    seats: row.seats === null || row.seats === undefined ? null : Number(row.seats),
    seatsLabel: row.seats_label === null ? null : String(row.seats_label),
    // PostgREST can hand back `numeric` as a string when it does not fit a
    // double cleanly; Number() covers both shapes.
    percent: Number(row.percent),
    capBB: Number(row.cap_bb),
    capAmount: row.cap_amount === null ? null : Number(row.cap_amount),
    bigBlind: row.big_blind === null ? null : Number(row.big_blind),
    currency: row.currency === null ? null : String(row.currency),
    isDefault: Boolean(row.is_default),
    position: Number(row.position),
  };
}
