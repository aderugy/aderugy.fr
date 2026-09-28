/**
 * Unit tests for the hand-state engine. Run with `npm test`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Seat } from "./seats";
import {
  applyAction,
  childTypes,
  dealCards,
  effectiveStack,
  INVALID_ABOVE,
  initialState,
  previewAction,
  toCall,
  totalPot,
  walkPath,
  type HandState,
} from "./gameState";
import type { ActionKind, PokerNode, SpotSetup } from "./types";

let seq = 0;
function node(type: PokerNode["type"], data: object, parent: PokerNode | null): PokerNode {
  seq++;
  return {
    id: `g${seq}`,
    spot_id: "spot",
    parent_id: parent?.id ?? null,
    type,
    position: 0,
    data: data as PokerNode["data"],
    created_at: "",
    updated_at: "",
  };
}

type Spec =
  | ["d"]
  | [ActionKind, number | null, ("pct" | "bb")?, string?]
  | ["flop", string[]]
  | ["turn" | "river", string];

/** A chain of nodes: "d" is a decision, then actions and cards. */
function chain(...specs: Spec[]): PokerNode[] {
  const out: PokerNode[] = [];
  for (const s of specs) {
    const parent = out[out.length - 1] ?? null;
    if (s[0] === "d") out.push(node("strategy", { actions: [] }, parent));
    else if (s[0] === "flop") out.push(node("flop", { cards: s[1] }, parent));
    else if (s[0] === "turn" || s[0] === "river") out.push(node(s[0], { card: s[1] }, parent));
    else {
      const [kind, size, unit, label] = s;
      out.push(node("action", { kind, sizePct: size, sizeUnit: unit ?? null, label: label ?? kind, color: "" }, parent));
    }
  }
  return out;
}

const SRP: SpotSetup & { players: [Seat, Seat] } = {
  players: ["BTN", "BB"],
  street: "preflop",
  potBb: null,
  stackBb: 100,
};

const near = (a: number, b: number, msg?: string) => assert.ok(Math.abs(a - b) < 0.006, `${msg ?? ""} ${a} ≠ ${b}`);

function last(states: ReturnType<typeof walkPath>): HandState {
  const s = states[states.length - 1];
  assert.equal(s.error, null, s.error ?? "");
  return s.state;
}

test("preflop start: blinds posted, SB dead, BTN first to act", () => {
  const s = initialState(SRP);
  assert.equal(s.toAct, "BTN");
  assert.equal(s.bets.BB, 1);
  assert.equal(s.stacks.BB, 99);
  near(s.center, 0.5);
  near(totalPot(s), 1.5);
});

test("the spec's SRP line, preflop to showdown, to the cent", () => {
  const path = chain(
    ["d"], ["raise", 2.5], ["d"], ["call", null],
    ["flop", ["Ks", "7d", "2c"]],
    ["d"], ["check", null], ["d"], ["bet", 33],
  );
  let s = last(walkPath(SRP, path));
  near(totalPot(s), 7.32, "pot after the c-bet");
  near(s.bets.BTN, 1.82, "c-bet");
  assert.equal(s.toAct, "BB");
  near(toCall(s, "BB"), 1.82);

  const flop = walkPath(SRP, path.slice(0, 5));
  near(totalPot(flop[4].state), 5.5, "flop pot");
  near(effectiveStack(flop[4].state), 97.5, "flop stack");
  assert.equal(flop[4].state.status, "betting");
  assert.equal(flop[4].state.toAct, "BB");

  const more = [...path];
  const add = (...specs: Spec[]) => {
    const tail = chain(...specs);
    tail[0].parent_id = more[more.length - 1].id;
    more.push(...tail);
  };
  add(["d"], ["call", null], ["turn", "5h"]);
  s = last(walkPath(SRP, more));
  near(totalPot(s), 9.13, "turn pot");
  near(effectiveStack(s), 95.69, "turn stack");

  add(["d"], ["check", null], ["d"], ["bet", 75], ["d"], ["call", null], ["river", "2h"]);
  s = last(walkPath(SRP, more));
  near(totalPot(s), 22.83, "river pot");
  near(effectiveStack(s), 88.84, "river stack");

  add(["d"], ["check", null], ["d"], ["raise", null, undefined, "All-in"], ["d"], ["call", null]);
  s = last(walkPath(SRP, more));
  assert.equal(s.status, "over");
  assert.equal(s.terminal?.kind, "showdown");
  near(s.terminal!.potBb, 200.5, "showdown pot");
});

test("raise p% calls first: BB raises 50% over a 1.82 bet into 5.5 → to 6.38", () => {
  const s0 = walkPath({ ...SRP, street: "flop", potBb: 5.5, stackBb: 97.5 }, chain(["flop", ["Ks", "7d", "2c"]], ["d"], ["check", null], ["d"], ["bet", 33]));
  const s = last(s0);
  const p = previewAction(s, "BB", { kind: "raise", sizePct: 50, label: "Raise 50%" });
  near(p.to!, 6.38);
});

test("bb sizes postflop: bet puts the chips in, raise is raise-to", () => {
  const start = last(walkPath({ ...SRP, street: "flop", potBb: 10, stackBb: 90 }, chain(["flop", ["Ks", "7d", "2c"]], ["d"])));
  const bet = applyAction(start, { kind: "bet", sizePct: 4, sizeUnit: "bb", label: "Bet 4bb" });
  assert.ok(bet.ok);
  if (!bet.ok) return;
  assert.equal(bet.state.bets.BB, 4);
  const raise = applyAction(bet.state, { kind: "raise", sizePct: 12, sizeUnit: "bb", label: "Raise 12bb" });
  assert.ok(raise.ok);
  if (raise.ok) assert.equal(raise.state.bets.BTN, 12);
});

test("later start: the board is dealt first, betting starts on the setup street", () => {
  const setup = { ...SRP, street: "turn" as const, potBb: 20, stackBb: 80 };
  const path = chain(["flop", ["Ks", "7d", "2c"]], ["turn", "5h"], ["d"]);
  const states = walkPath(setup, path);
  assert.equal(states[0].state.status, "deal");
  assert.equal(states[0].state.nextStreet, "turn");
  assert.equal(states[2].actor, "BB");
  near(totalPot(states[2].state), 20);
});

test("closing rules: check-check deals, limp gives BB the option, fold ends the hand", () => {
  const cc = last(walkPath({ ...SRP, street: "flop", potBb: 5.5, stackBb: 97.5 }, chain(["flop", ["Ks", "7d", "2c"]], ["d"], ["check", null], ["d"], ["check", null])));
  assert.equal(cc.status, "deal");
  assert.equal(cc.nextStreet, "turn");

  const limp = last(walkPath({ ...SRP, players: ["SB", "BB"] }, chain(["d"], ["call", null])));
  assert.equal(limp.status, "betting");
  assert.equal(limp.toAct, "BB");
  const opt = applyAction(limp, { kind: "check", sizePct: null, label: "Check" });
  assert.ok(opt.ok && opt.state.status === "deal");

  const fold = last(walkPath(SRP, chain(["d"], ["raise", 2.5], ["d"], ["fold", null])));
  assert.equal(fold.terminal?.kind, "fold");
  if (fold.terminal?.kind === "fold") {
    assert.equal(fold.terminal.winner, "BTN");
    near(fold.terminal.potBb, 4);
  }
});

test("all-in called before the river ends the hand as an all-in", () => {
  const s = last(walkPath(SRP, chain(["d"], ["raise", null, undefined, "All-in"], ["d"], ["call", null])));
  assert.equal(s.terminal?.kind, "allin");
  near(s.terminal!.potBb, 200.5);
});

test("short all-in call gives the uncalled excess back", () => {
  const setup = { ...SRP, street: "flop" as const, potBb: 10, stackBb: 50 };
  const path = chain(["flop", ["Ks", "7d", "2c"]], ["d"], ["bet", 1000], ["d"], ["call", null]);
  const s = last(walkPath(setup, path));
  assert.equal(s.terminal?.kind, "allin");
  near(s.terminal!.potBb, 110);
});

test("refusals: turn before the round closes, check facing a bet, decision after a fold, action without decision", () => {
  const early = walkPath({ ...SRP, street: "flop", potBb: 5.5, stackBb: 97.5 }, chain(["flop", ["Ks", "7d", "2c"]], ["d"], ["bet", 33], ["turn", "5h"]));
  assert.match(early[3].error ?? "", /isn't finished/);

  const checkBet = walkPath({ ...SRP, street: "flop", potBb: 5.5, stackBb: 97.5 }, chain(["flop", ["Ks", "7d", "2c"]], ["d"], ["bet", 33], ["d"], ["check", null], ["d"]));
  assert.match(checkBet[4].error ?? "", /can't check/);
  assert.equal(checkBet[5].error, INVALID_ABOVE);

  const afterFold = walkPath(SRP, chain(["d"], ["fold", null], ["d"]));
  assert.match(afterFold[2].error ?? "", /hand is over/);

  const loose = walkPath(SRP, chain(["check", null]));
  assert.match(loose[0].error ?? "", /decision/);

  const dup = walkPath({ ...SRP, street: "flop", potBb: 5.5, stackBb: 97.5 }, chain(["flop", ["Ks", "7d", "2c"]], ["d"], ["check", null], ["d"], ["check", null], ["turn", "Ks"]));
  assert.match(dup[5].error ?? "", /twice/);
});

test("overrides reset pot and stacks for everything below", () => {
  const path = chain(["d"], ["raise", 2.5], ["d"], ["call", null], ["flop", ["Ks", "7d", "2c"]]);
  (path[4].data as { override?: object }).override = { potBb: 24, stackBb: 88 };
  const states = walkPath(SRP, path);
  const s = last(states);
  near(totalPot(s), 24);
  near(effectiveStack(s), 88);
  assert.ok(s.manual);
  assert.ok(states[4].overridden);
});

test("child types follow the state", () => {
  const root = initialState(SRP);
  assert.deepEqual(childTypes(null, null, root), ["strategy"]);
  const flopStart = initialState({ ...SRP, street: "flop", potBb: 5.5 });
  assert.deepEqual(childTypes(null, null, flopStart), ["flop"]);
  const path = chain(["d"], ["raise", 2.5], ["d"], ["call", null]);
  const states = walkPath(SRP, path);
  assert.deepEqual(childTypes(path[0], states[0], root), ["action"]);
  assert.deepEqual(childTypes(path[1], states[1], root), ["strategy"]);
  assert.deepEqual(childTypes(path[3], states[3], root), ["flop"]);
  const fold = chain(["d"], ["fold", null]);
  const fs = walkPath(SRP, fold);
  assert.deepEqual(childTypes(fold[1], fs[1], root), []);
});

test("dealCards refuses the wrong street", () => {
  const s = initialState({ ...SRP, street: "flop", potBb: 5.5 });
  const r = dealCards(s, "turn", ["5h"]);
  assert.equal(r.ok, false);
});

test("CSV headers: a unit is read as written, a bare size is NL1000 chips", async () => {
  const { parseActionHeader } = await import("./csvImport");
  assert.deepEqual(
    ["RAISE 18bb", "BET 33%", "BET 45", "RAISE 180", "Bet 12.5", "CALL"].map((raw) => {
      const h = parseActionHeader(raw);
      return h && [h.kind, h.sizePct, h.sizeUnit, h.label];
    }),
    [
      ["raise", 18, "bb", "Raise 18bb"],
      ["bet", 33, "pct", "Bet 33%"],
      ["bet", 4.5, "bb", "Bet 4.5bb"],
      ["raise", 18, "bb", "Raise 18bb"],
      ["bet", 1.25, "bb", "Bet 1.25bb"],
      ["call", null, null, "Call"],
    ],
  );
});

test("CSV import: chips become bb bets in the engine, older imports keep their ids", async () => {
  const { parseStrategyCsv } = await import("./csvImport");
  const old = { id: "old-bet", kind: "bet" as const, sizePct: 45, sizeUnit: null, label: "Bet 45", color: "" };
  const { actions } = parseStrategyCsv("Hand,BET 45,CHECK\nAKs,50,50", [old]);
  assert.deepEqual(
    actions.map((a) => [a.id === "old-bet", a.kind, a.sizePct, a.sizeUnit, a.label]),
    [
      [true, "bet", 4.5, "bb", "Bet 4.5bb"],
      [false, "check", null, null, "Check"],
    ],
  );
  // Flop, pot 5.5: "BET 45" puts 4.5bb in, not 45% of the pot.
  const flop = dealCards(initialState({ ...SRP, street: "flop", potBb: 5.5 }), "flop", ["Ks", "7d", "2c"]);
  assert.ok(flop.ok);
  if (!flop.ok) return;
  const r = applyAction(flop.state, { kind: "bet", sizePct: 4.5, sizeUnit: "bb", label: "Bet 4.5bb" });
  assert.ok(r.ok);
  if (r.ok) assert.equal(totalPot(r.state), 10);
});
