/**
 * Client for PioBridge's PokerTracker 4 endpoints (/pt4/*). The bridge reads
 * the local PT4 database with a read-only role and keeps each player's hands
 * in memory, so a HUD comes back in milliseconds once the player is loaded.
 * Browser only.
 */

import { OFFLINE_MESSAGE, PIO_BRIDGE_URL, PioBridgeError } from "@/lib/solver/pioBridge";
import { filterParams } from "./format";
import type { HudFilters, PlayerHud, Pt4AutoNote, Pt4Limit, Pt4Note, Pt4Player, Pt4Status } from "./types";

/** Saving a note PT4 changed meanwhile: `current` is PT4's version. */
export class NoteConflictError extends PioBridgeError {
  constructor(public current: Pt4Note | null) {
    super("note_changed", "This note was changed in PokerTracker meanwhile");
  }
}

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

async function saveNote(player: number, color: number, text: string, expected: string): Promise<Pt4Note> {
  let res: Response;
  try {
    res = await fetch(PIO_BRIDGE_URL + "/pt4/notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ player, color, text, expected }),
      cache: "no-store",
      targetAddressSpace: "loopback",
    } as RequestInit);
  } catch {
    throw new PioBridgeError("offline", OFFLINE_MESSAGE);
  }
  const body = (await res.json().catch(() => null)) as { note?: Pt4Note | null; error?: string; message?: string } | null;
  if (res.status === 409) throw new NoteConflictError(body?.note ?? null);
  if (!res.ok || !body?.note) {
    throw new PioBridgeError(body?.error ?? `http_${res.status}`, body?.message ?? `PioBridge answered ${res.status}`);
  }
  return body.note;
}

/** Makes the bridge forget its cached hands and read PT4 again. */
async function reload(): Promise<number> {
  let res: Response;
  try {
    res = await fetch(PIO_BRIDGE_URL + "/pt4/reload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      cache: "no-store",
      targetAddressSpace: "loopback",
    } as RequestInit);
  } catch {
    throw new PioBridgeError("offline", OFFLINE_MESSAGE);
  }
  const body = (await res.json().catch(() => null)) as { players?: number; error?: string; message?: string } | null;
  if (!res.ok || !body) {
    throw new PioBridgeError(body?.error ?? `http_${res.status}`, body?.message ?? `PioBridge answered ${res.status}`);
  }
  return body.players ?? 0;
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
  /** Player notes; players without one are absent. */
  notes: (ids: number[]) =>
    call<{ notes: Record<string, Pt4Note> }>("/pt4/notes", { ids: ids.join(",") }).then((r) => r.notes),
  saveNote,
  /** Drop the bridge's cache (after deleting, re-importing or recalculating in PT4). */
  reload,
  /** PT4's auto-notes; players without any are absent. */
  autoNotes: (ids: number[]) =>
    call<{ autonotes: Record<string, Pt4AutoNote[]> }>("/pt4/autonotes", { ids: ids.join(",") }).then((r) => r.autonotes),
};
