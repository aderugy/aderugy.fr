# /poker/live — live session tracker

Track live cash sessions from a phone at the table: money and time, who sits
where (and when that changes), a database of players with tags and notes, and
hands entered action by action, then replayed.

## Data (migrations `0018_poker_live.sql`, `0022_live_unknown_players.sql`)

| Table | What it holds |
|---|---|
| `live_sessions` | Venue, game, blinds, currency, 9 or 10 seats, Arthur's current seat, where the button is for the next hand, each seat's stack now (`stacks`), start/end, cash-out, notes, the room's rake rule (`rake`, see below). **At most one running** per user (partial unique index). An ended session must have a cash-out. |
| `live_session_events` | `buy_in`, `rebuy` (with an amount), `break_start`, `break_end`, `expense` (food and drinks: an amount and a `label`, `0033`). |
| `live_seat_events` | The table's log: `sit`, `sit_out`, `back`, `leave`, `hero_move`. `player_id` null = nobody on file (sessions from before unknown players). A seat must exist at the session's table (trigger). |
| `live_players` | Name or nickname, description (how to recognise them), `known` (false for an unknown player). |
| `live_tags` / `live_player_tags` | Arthur's flat tag list (fish, reg, nit…), several per player. |
| `live_player_notes` | Timestamped notes on a player, optionally tied to the session and hand they were taken in. `source` (`app` / `claude`) is set by trigger from the token. |
| `live_hands` | Seats dealt in (with optional stacks), button, blinds, straddle, blinds bought back (`posts`), the action list, Arthur's cards, board, shown cards, who took each pot, Arthur's net, the rake the room took (`rake`, null without a rule), the all-in EV (`allin`, see below), star, notes. Numbered within the session by trigger. |

Amounts are chips in the session's currency; big blinds are computed for display.

## Rake

A session carries the room's rake rule (`src/lib/live/rake.ts`): `percent` of
the pot, rounded up to the next `step` and at least one step, capped at `cap`
when the room caps, preflop pots raked or not. Pierre Charron is 4 %, 0,50 €
steps, no cap, preflop raked (set by `0032_live_rake.sql`). A new session copies
the rule of the last session at the same venue, so a room's rake is entered
once; it is per session so a change of rake never rewrites old hands.

`settle()` takes the rake on the whole hand off the main pot first; nets and
stacks are after it. A hand stores the rake taken; when that is set its
`hero_net` is after rake, when null (no rule, or a hand saved before 0032) it
is before rake. The session result (cash-out − buy-ins) is the real one either
way.

## All-in EV

`src/lib/live/allin.ts`, computed by the server when a hand is saved and kept
in `live_hands.allin`. A hand counts when betting stopped with someone all-in
before the river (`end.runout`), Arthur was still in and every other seat
still in showed its cards. Over every runout of the rest of the board (exact
enumeration — a preflop all-in heads-up is C(48,5) = 1 712 304 boards, under a
second):

    equity_p = Arthur's average share of pot p (1/k on a k-way tie)
    EV       = Σ_p equity_p × (amount_p − rake_p) − what Arthur put in
    luck     = net − EV

The rake depends only on the total pot, fixed once everyone is all-in, so it is
the same on every runout and comes off the main pot first, as `settle()` takes
it. The uncalled part of a bet goes back and is in no pot. Cards known to be out
— Arthur's, the board so far, every card shown, folded hands included — are not
dealt. A session's **all-in EV adjusted result** is its real result minus the
luck of its hands; the sessions page plots both, cumulated.

## Pot odds (hand review)

Under the pot, for the seat facing a bet at the current step
(`src/lib/live/odds.ts`): to call, pot after the call, the rake on that pot,
`need = to call ÷ (pot after − rake)` and `(pot after − rake − to call) : to
call`. No money after the call is assumed. Amounts are in the session's
currency; tapping the pot switches the review to big blinds.

## Food and drinks

`expense` events, added from the session screen or the review. Not poker
money: the result stays cash-out − buy-ins; the review shows the result after
them.

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
stack by what the seat won or lost — once every pot has a taker, after rake when
the session has a rule.

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
