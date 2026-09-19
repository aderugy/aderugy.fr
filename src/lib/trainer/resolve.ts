/**
 * Reading a strategy node's context out of its Solver notes tree.
 *
 * Input is the path from the root down to the node. Board cards come from the
 * flop / turn / river nodes on it; the line is the action nodes after the last
 * card node, each attributed to the seat of the strategy it hangs from. Every
 * way the tree can be unusable for a trainer is a refusal with a message the
 * inspector can show as is. Pure functions only.
 */

import { firstToAct, type Seat } from "../solver/seats";
import { asAction, asFlop, asStrategy, asStreet, type PokerNode } from "../solver/types";
import type { LineAction, NodeContext, Street } from "./types";

export type ResolveResult = { ok: true; context: NodeContext } | { ok: false; error: string };

const refuse = (error: string): ResolveResult => ({ ok: false, error });

export function resolveNodeContext(path: PokerNode[]): ResolveResult {
  const target = path[path.length - 1];
  if (!target || target.type !== "strategy") return refuse("Only a strategy node can be trained.");

  // A path must really be a chain: each node the parent of the next.
  for (let i = 1; i < path.length; i++) {
    if (path[i].parent_id !== path[i - 1].id) return refuse("Broken tree path.");
  }
  if (path[0].parent_id !== null) return refuse("Broken tree path.");

  const { seat, vsSeat } = asStrategy(target);
  if (!seat || !vsSeat) return refuse("Set the positions (who plays, against whom) on this node first.");
  if (seat === vsSeat) return refuse("This node's two seats are the same.");
  const players = new Set<Seat>([seat, vsSeat]);

  let street: Street = "preflop";
  const board: string[] = [];
  let line: LineAction[] = [];

  for (let i = 0; i < path.length - 1; i++) {
    const node = path[i];
    switch (node.type) {
      case "flop": {
        if (street !== "preflop") return refuse("Two flops on the path to this node.");
        const { cards } = asFlop(node);
        if (cards.length !== 3) return refuse("The flop above this node needs 3 cards.");
        board.push(...cards);
        street = "flop";
        line = [];
        break;
      }
      case "turn":
      case "river": {
        const expected = node.type === "turn" ? "flop" : "turn";
        if (street !== expected) {
          return refuse(
            node.type === "turn" ? "A turn with no flop above it." : "A river with no turn above it.",
          );
        }
        const { card } = asStreet(node);
        if (!card) return refuse(`The ${node.type} above this node has no card.`);
        board.push(card);
        street = node.type;
        line = [];
        break;
      }
      case "strategy": {
        const s = asStrategy(node);
        if (!s.seat || !s.vsSeat) {
          return refuse("A strategy node above this one has no positions, so its actions can't be placed.");
        }
        if (!players.has(s.seat) || !players.has(s.vsSeat)) {
          return refuse(`A strategy node above is ${s.seat} vs ${s.vsSeat}, not ${seat} vs ${vsSeat}.`);
        }
        break;
      }
      case "action": {
        const a = asAction(node);
        const parent = path[i - 1];
        let actor: Seat;
        if (parent && parent.type === "strategy") {
          actor = asStrategy(parent).seat as Seat; // checked when the parent was visited
        } else if (line.length > 0) {
          actor = line[line.length - 1].seat === seat ? vsSeat : seat;
        } else {
          actor = firstToAct(street, seat, vsSeat);
        }
        line.push({ seat: actor, kind: a.kind, sizePct: a.sizePct ?? null, label: a.label });
        break;
      }
      default:
        break; // text nodes carry no game state
    }
  }

  if (new Set(board).size !== board.length) return refuse("The same card appears twice on the board.");

  return {
    ok: true,
    context: { spotId: target.spot_id, street, board, line, seat, vsSeat },
  };
}

/** Can a node with this context go into a trainer with these seats and street? */
export function compatibility(
  context: Pick<NodeContext, "seat" | "vsSeat" | "street">,
  trainer: { hero_seat: Seat; villain_seat: Seat; street: Street | null },
): { ok: true } | { ok: false; reason: string } {
  if (context.seat !== trainer.hero_seat || context.vsSeat !== trainer.villain_seat) {
    return {
      ok: false,
      reason: `node is ${context.seat} vs ${context.vsSeat}, trainer is ${trainer.hero_seat} vs ${trainer.villain_seat}`,
    };
  }
  if (trainer.street && trainer.street !== context.street) {
    return { ok: false, reason: `${context.street} node, ${trainer.street} trainer` };
  }
  return { ok: true };
}
