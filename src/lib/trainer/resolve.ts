/**
 * Reading where a hand starts from the tree above an entry node.
 *
 * The walk itself is `walkPath` (gameState.ts); this turns it into the
 * context a trainer stores and shows, and refuses, with a message the
 * inspector can show as is, a node no hand can start from. Pure functions.
 */

import { effectiveStack, totalPot, walkPath } from "../solver/gameState";
import type { Seat } from "../solver/seats";
import { setupProblem, type PokerNode, type SpotSetup } from "../solver/types";
import type { EntryContext } from "./types";

export type ResolveResult = { ok: true; context: EntryContext } | { ok: false; error: string };

const refuse = (error: string): ResolveResult => ({ ok: false, error });

export function resolveEntry(setup: SpotSetup, path: PokerNode[]): ResolveResult {
  const target = path[path.length - 1];
  if (!target) return refuse("No node.");
  for (let i = 1; i < path.length; i++) {
    if (path[i].parent_id !== path[i - 1].id) return refuse("Broken tree path.");
  }
  if (path[0].parent_id !== null) return refuse("Broken tree path.");

  const problem = setupProblem(setup);
  if (problem) return refuse(`The spot isn't set up: ${problem}`);
  const players = setup.players as [Seat, Seat];

  const states = walkPath({ ...setup, players }, path);
  const bad = states.find((s) => s.error);
  if (bad) return refuse(bad.error as string);
  const last = states[states.length - 1];
  const s = last.state;
  if (s.status === "over") return refuse("The hand is over at this node: nothing to train from here.");

  return {
    ok: true,
    context: {
      spotId: target.spot_id,
      players,
      street: s.street,
      board: s.board,
      line: s.log.map((e) => ({ street: e.street, seat: e.seat, kind: e.kind, label: e.label, amountBb: e.amountBb })),
      potBb: totalPot(s),
      stackBb: effectiveStack(s),
      toAct: target.type === "strategy" ? last.actor : s.toAct,
    },
  };
}

/** Can a hand of this spot be played by this trainer's hero against its villain? */
export function compatibility(
  players: [Seat, Seat],
  trainer: { hero_seat: Seat; villain_seat: Seat },
): { ok: true } | { ok: false; reason: string } {
  const [a, b] = players;
  const same =
    (a === trainer.hero_seat && b === trainer.villain_seat) || (b === trainer.hero_seat && a === trainer.villain_seat);
  if (!same) {
    return { ok: false, reason: `spot is ${a} vs ${b}, trainer is ${trainer.hero_seat} vs ${trainer.villain_seat}` };
  }
  return { ok: true };
}
