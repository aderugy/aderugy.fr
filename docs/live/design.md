# /poker/live — live session tracker

Track live cash sessions from a phone at the table: money and time, who sits
where (and when that changes), a database of players with tags and notes, and
hands entered action by action, then replayed.

## Data (migration `0018_poker_live.sql`)

| Table | What it holds |
|---|---|
| `live_sessions` | Venue, game, blinds, currency, 9 or 10 seats, Arthur's current seat, the last hand's button, start/end, cash-out, notes. **At most one running** per user (partial unique index). An ended session must have a cash-out. |
| `live_session_events` | `buy_in`, `rebuy` (with an amount), `break_start`, `break_end`. |
| `live_seat_events` | The table's log: `sit`, `sit_out`, `back`, `leave`, `hero_move`. `player_id` null = someone not identified yet. A seat must exist at the session's table (trigger). |
| `live_players` | Name or nickname, description (how to recognise them). |
| `live_tags` / `live_player_tags` | Arthur's flat tag list (fish, reg, nit…), several per player. |
| `live_player_notes` | Timestamped notes on a player, optionally tied to the session and hand they were taken in. `source` (`app` / `claude`) is set by trigger from the token. |
| `live_hands` | Seats dealt in (with optional stacks), button, blinds, straddle, the action list, Arthur's cards, board, shown cards, who took each pot, Arthur's net (before rake), star, notes. Numbered within the session by trigger. |

Amounts are chips in the session's currency; big blinds are computed for display.

## The table is a log

The table is never stored as a state: `src/lib/live/table.ts` folds the seat log.
That gives the table now, the table at any past time (a hand's default players),
and the session's history for free. A change of seat is a `leave` and a `sit` of
the same player at the same instant, shown as one line. Identifying an unknown
seat later (or correcting a wrong pick) rewrites the player on that whole stay —
seat events and the hands played during it.

## Hands

`src/lib/live/hand.ts` is the NLHE engine: turn order (clockwise = increasing
seat number, seat 1 on the dealer's left), blinds and straddle, heads-up rules,
check/call/bet/raise legality, minimum raise (except all-in), all-ins with known
stacks, street closing, run-outs, and the split into main and side pots with the
uncalled bet returned. `bet`/`raise` amounts are the total on the street
("raise to 15"). Dead and missed blinds are not modelled — they are notes.

The editor (setup → action → result) replays the action list on every change;
the server replays it again before saving (`src/lib/live/validate.ts`) and
refuses anything that does not fit. Tapping a later seat during the action folds
everyone before it. Who won is recorded per pot, so side pots and chops are exact;
Arthur's net is computed from them and can be overridden.

The next hand's button defaults to the first seat dealt in after the last hand's
button; the dealt-in seats default to everyone sitting in, plus Arthur.

## Screens

- `/poker/live` — the running session (or the start form), totals, past sessions.
- `/poker/live/[id]` — while running: the table, a bottom bar (+ Hand, Rebuy,
  Break/Resume, End), a sheet per seat (sit someone, tags, notes, sits out /
  back, changes seat, leaves, "not them?"), the hands and the log. Once ended:
  result, per hour, bb/h, hands, players met, notes, log; edit or undo the end.
- `/poker/live/[id]/hands/[handId]` — replay step by step, the hand written out,
  pots, notes on the hand and on players from it, edit, delete.
- `/poker/live/players`, `/poker/live/players/[id]`, `/poker/live/tags`.

Online only: every tap is a server action; a failure shows a sentence to retry.

## Claude connector

Same MCP server (`/api/mcp`), tools in `src/server/mcp/live-tools.ts`:
`list_live_sessions`, `get_live_session`, `list_live_players`, `get_live_player`,
`list_live_tags`, `add_player_note`, `edit_player_note`, `delete_player_note`,
`tag_player`.

Enforced in the database, as in 0015 and 0017:

| | Connected app (Claude) |
|---|---|
| `live_player_notes` | read; add; edit or delete only notes with `source = 'claude'` |
| `live_player_tags` | read and write (existing tags only) |
| everything else | read only |

Tests: `supabase/tests/poker_live_test.sql` (one running session, numbering, seat
range, references to someone else's rows, note authorship, every Claude rule) and
`src/lib/live/live.test.ts` (the engine, side pots, positions, the table log,
money and time, hand checks, hand text).
