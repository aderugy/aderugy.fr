# /poker/trainers — spot trainers

Drill the strategy nodes of Solver notes on a rendered 6-max table, scored in
RNG mode. Authenticated and per-user like `/poker/spots`; every table has the
`user_id = auth.uid()` RLS policy.

## How it fits together

1. **Seats on strategy nodes.** A strategy node now says who plays it and
   against whom (`data.seat`, `data.vsSeat`, in the node's jsonb — no
   migration). IP / OOP is derived from them (postflop order SB → BB → UTG →
   HJ → CO → BTN, the later seat is IP). A new strategy node is prefilled from
   the nearest seated strategy above it: swapped, or out-of-position-first when
   a new street was dealt in between.
2. **Add to trainer.** The inspector of a strategy node has *Add to trainer…*:
   it previews the node's context, lists the trainers (greyed with the reason
   when they would refuse it), and can create a trainer prefilled with the
   node's seats. Cards of nodes in a trainer carry a `▶ n` badge.
3. **Tree walk** (`src/lib/trainer/resolve.ts`). Root → node: flop / turn /
   river nodes build the board; the action nodes after the last card node are
   the line, each attributed to the seat of the strategy it hangs from
   (free-form actions alternate from the first player to act). Refused with a
   message: incomplete or duplicate board, turn without flop, river without
   turn, missing seats on the node or on a strategy above it, a strategy above
   that is another matchup. The server walks the tree again from the database
   before inserting; the client preview is only a preview.
4. **Positions are enforced exactly:** a node goes into a trainer only if
   `seat = hero_seat` and `vsSeat = villain_seat`, and only on the trainer's
   street (set by its first node, cleared when the trainer is emptied). The pot
   is per trainer, hence one street per trainer.
5. **Sessions.** *Start* re-walks every node (stored context updated if the
   tree changed; nodes that no longer fit are skipped and listed), closes any
   session left open (ended at its last answer; an empty one is dropped), and
   returns the strategies so dealing and grading run in the browser. Each answer
   goes straight from the browser to `record_answer()` — one round trip, answer
   + session counters in one transaction. *End session* waits for pending
   writes. Closing the tab loses nothing.

## Dealing and scoring

- A node is picked by `weight`, then a combo in proportion to how much of it is
  in range (`vectorTotal / 100`), board blockers excluded.
- A roll 0–99 is shown every hand. Frequencies are rescaled to 100, actions
  under **2 %** are dropped as solver noise, rescaled again, and cut into bands
  in button order: action *i* owns `[round(cum[i−1]), round(cum[i]))`.
- Grades: **correct** (the roll's action), **wrong band** (another action of the
  mix), **mistake** (only solver noise, 0.5–2 %), **blunder** (< 0.5 %). Session
  score = % correct; blunder rate shown apart.
- Each answer stores a snapshot (combo, board, actions, raw frequencies, roll,
  expected and chosen action), so a re-imported strategy or a deleted node never
  rewrites the past, and the thresholds can be retuned and rescored.

## Table

`buildScene()` turns trainer + context into seats, bets, pot and button
amounts. Conventions: `pot_bb` and `stack_bb` are at the start of the street;
postflop a bet of p % is p % of the pot, a raise of p % calls then adds p % of
the pot after the call; preflop sizes are raise-to amounts in bb, blinds are
posted and the rest of `pot_bb` is dead money; no size = all-in; everything is
capped at the stack. `PokerTable` draws it with hero at the bottom, 16:9 from
`sm`, a tall oval on phones.

## Files

| Path | Role |
|---|---|
| `supabase/migrations/0010_poker_trainers.sql` | 4 tables, RLS, `record_answer()` |
| `src/lib/solver/seats.ts` | Seats, IP/OOP, first to act |
| `src/lib/trainer/{types,resolve,scene,deal,score,history}.ts` | The pure model |
| `src/lib/trainer/trainer.test.ts` | `npm test` |
| `src/server/actions/trainers.ts` | CRUD, add/remove node, start/end session |
| `src/server/trainers.ts` | Page loaders |
| `src/components/poker/trainer/*` | Add-to-trainer popover, table, practice, history |
| `src/app/poker/trainers/**` | List, trainer (Practice · Nodes · History · Settings), session review |

`/poker/spots/[id]?node=<id>` opens the tree down to a node and selects it
(the *Open* link of a trainer's node list).

## Verified

- `npm test`: 19 tests — seat maths for all 30 pairs, every tree refusal, line
  reset per street, scene amounts (c-bet, raise, stack cap, preflop blinds),
  band edges, noise cut, partial-range rescaling, grades, roll uniformity,
  dealing frequencies, history aggregates.
- Migration run twice on a scratch PostgreSQL 16 with a Supabase auth shim:
  constraints, duplicate node, RLS across two users (read, insert, update,
  delete), `record_answer` counters, refusal on a foreign or ended session,
  node deletion cascading to trainers while answers keep their snapshot.
- Browser: table at desktop / phone / dark with no overflow; a 12-hand session
  driven by keyboard through feedback to the end screen (session stubbed — no
  live Supabase in the build environment).

## Not verified

Anything against the live Supabase project: the migration has to be applied
there first, then a real add-to-trainer and session.
