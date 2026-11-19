/**
 * Client for PioBridge's PokerTracker 4 endpoints (/pt4/*). The bridge reads
 * the local PT4 database with a read-only role and keeps each player's hands
 * in memory, so a HUD comes back in milliseconds once the player is loaded.
 * Browser only.
 */

import { OFFLINE_MESSAGE, PIO_BRIDGE_URL, PioBridgeError } from "@/lib/solver/pioBridge";
import { filterParams } from "./format";
import type { HudFilters, PlayerHud, Pt4Limit, Pt4Player, Pt4Status } from "./types";

async function call<T>(path: string, params: Record<string, string | undefined> = {}, signal?: AbortSignal): Promise<T> {
  const url = new URL(PIO_BRIDGE_URL + path);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v);
  let res: Response;
  try {
    res = await fetch(url, { cache: "no-store", signal, targetAddressSpace: "loopback" } as RequestInit);
  } catch (e) {
    if (signal?.aborted) throw e;
    throw new PioBridgeError("offline", OFFLINE_MESSAGE);
  }
  const body = (await res.json().catch(() => null)) as (T & { error?: string; message?: string }) | null;
  if (!res.ok || !body) {
    throw new PioBridgeError(body?.error ?? `http_${res.status}`, body?.message ?? `PioBridge answered ${res.status}`);
  }
  return body;
}

export const pt4 = {
  status: () => call<Pt4Status>("/pt4/status"),
  limits: () => call<{ limits: Pt4Limit[] }>("/pt4/limits").then((r) => r.limits),
  search: (q: string, signal?: AbortSignal) =>
    call<{ players: Pt4Player[] }>("/pt4/players", { q }, signal).then((r) => r.players),
  huds: (ids: number[], filters: HudFilters, signal?: AbortSignal) =>
    call<{ maxHand: number; players: PlayerHud[]; ms: number }>(
      "/pt4/hud",
      { ids: ids.join(","), ...filterParams(filters) },
      signal,
    ),
};
