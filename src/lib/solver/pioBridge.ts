/**
 * Client for PioBridge, the local app (tools/pio-bridge) that runs PioSOLVER
 * on this computer and serves its saves to the site over http://127.0.0.1.
 *
 * Chrome asks once whether aderugy.fr may reach apps on this device (Local
 * Network Access); `targetAddressSpace` declares the request as such. Browser
 * only.
 */

import type { PioDecision, PioNode, PioRunouts, PioTree } from "./pio";

export const PIO_BRIDGE_URL = (process.env.NEXT_PUBLIC_PIO_BRIDGE_URL ?? "http://127.0.0.1:7878").replace(/\/$/, "");

export class PioBridgeError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export const OFFLINE_MESSAGE =
  "PioBridge isn't answering. Start PioBridge.exe on this computer (tray icon), and if Chrome asked, allow aderugy.fr to access apps on this device.";

async function call<T>(path: string, params: Record<string, string | undefined> = {}): Promise<T> {
  const url = new URL(PIO_BRIDGE_URL + path);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v);
  let res: Response;
  try {
    res = await fetch(url, { cache: "no-store", targetAddressSpace: "loopback" } as RequestInit);
  } catch {
    throw new PioBridgeError("offline", OFFLINE_MESSAGE);
  }
  const body = (await res.json().catch(() => null)) as (T & { error?: string; message?: string }) | null;
  if (!res.ok || !body) {
    throw new PioBridgeError(body?.error ?? `http_${res.status}`, body?.message ?? `PioBridge answered ${res.status}`);
  }
  return body;
}

export type PioFileEntry = { name: string; path: string; kind: "dir" | "cfr"; size?: number; modified: string };

export type PioHealth = {
  bridge: string;
  version: string;
  status: { state: string; message?: string; file?: string; board?: string[]; pioVersion?: string };
  solvesDir: string;
};

let handOrder: Promise<string[]> | null = null;

export const pioBridge = {
  health: () => call<PioHealth>("/api/health"),
  files: (dir = "") => call<{ dir: string; entries: PioFileEntry[] }>("/api/files", { dir }),
  tree: (file: string) => call<PioTree>("/api/tree", { file }),
  node: (file: string, id: string) => call<{ file: string; node: PioNode; children: PioNode[] }>("/api/node", { file, id }),
  /**
   * A decision with its stats. `resolve`: read it even when the save doesn't
   * hold it (a river of a no_rivers save) — PioSOLVER re-solves it on the fly.
   */
  decision: (file: string, id: string, resolve = false) =>
    call<PioDecision>("/api/decision", { file, id, stats: "1", villain: "1", resolve: resolve ? "1" : undefined }),
  /**
   * Every card of a split node summed up (loads the whole save once: a few
   * seconds). With `after`, the same line below every card instead (e.g. "c").
   * `resolve`: cards the save doesn't hold are re-solved on the fly (~1 s each).
   */
  runouts: (file: string, id: string, after?: string, resolve = false) =>
    call<PioRunouts>("/api/runouts", { file, id, after: after || undefined, resolve: resolve ? "1" : undefined }),
  /** The 1326 combos in solver order; fetched once per page. */
  handOrder: () => {
    handOrder ??= call<{ hands: string[] }>("/api/hand-order")
      .then((r) => r.hands)
      .catch((e) => {
        handOrder = null;
        throw e;
      });
    return handOrder;
  },
};
