# /poker/live — live session tracker

Track live cash sessions from a phone at the table: money and time, who sits
where (and when that changes), a database of players with tags and notes, and
hands entered action by action, then replayed.

## Data (migrations `0018_poker_live.sql`, `0022_live_unknown_players.sql`)

| Table | What it holds |
|---|---|
| `live_sessions` | Venue, game, blinds, currency, 9 or 10 seats, Arthur's current seat, where the button is for the next hand, each seat's stack now (`stacks`), start/end, cash-out, notes. **At most one running** per user (partial unique index). An ended session must have a cash-out. |
| `live_session_events` | `buy_in`, `rebuy` (with an amount), `break_start`, `break_end`. |
| `live_seat_events` | The table's log: `sit`, `sit_out`, `back`, `leave`, `hero_move`. `player_id` null = nobody on file (sessions from before unknown players). A seat must exist at the session's table (trigger). |
| `live_players` | Name or nickname, description (how to recognise them), `known` (false for an unknown player). |
| `live_tags` / `live_player_tags` | Arthur's flat tag list (fish, reg, nit…), several per player. |
| `live_player_notes` | Timestamped notes on a player, optionally tied to the session and hand they were taken in. `source` (`app` / `claude`) is set by trigger from the token. |
| `live_hands` | Seats dealt in (with optional stacks), button, blinds, straddle, blinds bought back (`posts`), the action list, Arthur's cards, board, shown cards, who took each pot, Arthur's net (before rake), star, notes. Numbered within the session by trigger. |

Amounts are chips in the session's currency; big blinds are computed for display.

## Unknown players

Nobody is "not identified" any more: a stranger is a player row with
`known = false`, named "Unknown 4" after their seat, and is tagged, described
and noted like anyone. A new session seats a fresh unknown in every seat but
Arthur's (unless unticked in the start form); an empty seat offers "Someone I
don't know" first, and "Leaves · new player sits" replaces the occupant with a
fresh unknown in one tap.

They stay out of the way: the players page and the picker have a Known and an
Unknown list, and unknowns with nothing on them (the default name, no tag, note
or description) are hidden unless asked for. On the table an unknown shows its
nickname, else the start of its description ("red cap"), else "?".

Upgrading one, from the seat sheet or the player page:

- **Name them** — `known` flips to true; tags, notes and description stay.
- **It's someone I know** — `live_merge_players(from, into)` moves everything
  to that player in one transaction: seat events in every session, notes, tags
  (union), the hands they were dealt into (`seats[].player_id`), and the
  description (taken, or appended to theirs). Then the unknown is deleted.
  Refused when the two sat at the same table at the same time. Security
  invoker, so RLS applies; a connected app (Claude) may not call it.

## Stacks

`live_sessions.stacks` (seat → chips, rules in `src/lib/live/stacks.ts`) is what
each seat has in front of it now. Set it from any seat sheet ("Stack", typed
straight in), Arthur's included; it shows under each name on the table. Arthur
starts with his buy-in and each rebuy is added. A change of seat carries the
stack; a seat that empties or gets someone new is cleared. A new hand starts
from these stacks (editable in its setup), and saving a hand moves each known
stack by what the seat won or lost — once every pot has a taker, before rake.

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
("raise to 15").

Blinds bought back: a player back from missing the blinds posts before the
cards — `posts: [{seat, live, dead}]`. The live part is a bet on the street (a
big blind: they keep the option when nobody raises); the dead part goes to the
main pot and is never refunded as an uncalled bet. In the editor's setup, tap a
seat under "Blinds bought back" to cycle BB → BB + SB dead → none.

At a showdown — on the river, or an all-in before it that runs the board out —
the editor asks for the rest of the board, then each opponent's cards (or "Not
shown"), before the result. In the result, tapping a seat edits its shown cards.
Anywhere in the editor, tapping a board card (or an empty place for the next
street) changes that street, and tapping a seat's cards (or Arthur's empty
slot) changes them; on a saved hand the same taps open the editor.

The editor (setup → action → result) replays the action list on every change;
the server replays it again before saving (`src/lib/live/validate.ts`) and
refuses anything that does not fit. Tapping a later seat during the action folds
everyone before it. Who won is recorded per pot, so side pots and chops are exact;
Arthur's net is computed from them and can be overridden.

The button: `live_sessions.button_seat` is where it is for the next hand, drawn
on the table. Saving a hand moves it to the next seat dealt into that hand;
"Hand played ›" under the table moves it on for a hand not entered; "Put the
button here" in a seat sheet sets it. If its seat is no longer dealt in, the
next hand takes the first dealt-in seat after it. The dealt-in seats default to
everyone sitting in, plus Arthur.

## Screens

- `/poker/live` — the running session (or the start form), totals, past sessions.
- `/poker/live/[id]` — while running: the table, a bottom bar (+ Hand, Rebuy,
  Break/Resume, End), the button and "Hand played ›", a sheet per seat (sit
  someone or an unknown, description, tags, notes, name them / it's someone I
  know, sits out / back, changes seat, leaves, leaves · new player sits, not
  them?, put the button here), the hands and the log. Once ended:
  result, per hour, bb/h, hands, players met, notes, log; edit or undo the end.
- `/poker/live/[id]/hands/[handId]` — replay step by step, the hand written out,
  pots, notes on the hand and on players from it, edit, delete.
- `/poker/live/players` (Known / Unknown), `/poker/live/players/[id]` (with
  name them / it's someone I know for an unknown), `/poker/live/tags`.

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
range, references to someone else's rows, note authorship, every Claude rule),
`supabase/tests/poker_live_unknowns_test.sql` (known by default, posts shape, the
merge and who may call it) and `src/lib/live/live.test.ts` (the engine, side pots,
blinds bought back, positions, the table log, the button, unknowns, money and
time, hand checks, hand text).
