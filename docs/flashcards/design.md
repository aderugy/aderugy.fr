# /flashcards — spaced-repetition flash cards

Decks of notes, reviewed with FSRS: the long-term memory for what is studied
elsewhere on the site (maths, poker, interview prep, courses). Built for daily,
short sessions on the phone. The functional spec and the technical spec this
was built from are in the "Flash cards — cahier des charges fonctionnel" doc.

## Data (migration `0023_flashcards.sql`)

| Table | What it holds |
|---|---|
| `fc_settings` | One row per user: target retention (0.70–0.97, default 0.90), new cards and reviews per day, learning and relearning steps (minutes), the hour a review day starts (4), the time zone, the leech threshold, swipe gestures. Absent until first saved; defaults apply. |
| `fc_decks` | A tree (`parent_id`). Names are unique among siblings, any case, and cannot contain `::` (the path separator: `Maths::Lois`). |
| `fc_notes` | Deck, kind (`basic`, `reversed`, `cloze`, `type_answer`), front, back, extra, source, `tags text[]`, `inbox`, `created_by`, `deleted_at` (trash, 30 days). |
| `fc_cards` | One per note side or cloze gap (`ord`): state (`new`, `learning`, `review`, `relearning`), step, FSRS stability and difficulty, due (`timestamptz`), reps, lapses, suspended, buried until, flagged. |
| `fc_reviews` | One row per rating, `review` or `cram`: the rating, review day, time taken, and the card's full state before (`before` jsonb) and after. Undo, statistics and a future FSRS fit all read it. |
| `fc_media` | Pasted images (≤ 1 MB, resized in the browser), served by `/flashcards/media/[id]` under the viewer's session. No Storage bucket. |

Invariants in the database: a note's deck, a card's note and a deck's parent
belong to the same user (triggers, since a policy cannot read its own table);
a note in the inbox has no cards; tags are single words.

RPCs (security invoker, RLS applies): `fc_save_review` (new state + journal in
one transaction; refuses with `FC001` if the card was rated elsewhere since the
app read it), `fc_undo_review` (latest rating of a card only),
`fc_delete_deck` (notes go to a chosen deck, sub-decks move up), `fc_rename_tag`
(children too; onto an existing tag = merge), and the aggregates
`fc_deck_counts`, `fc_daily_stats`, `fc_forecast`, `fc_tags`. `fc_purge_trash`
runs daily from `supabase/cron.sql`.

## Scheduling

`src/lib/flashcards/scheduler.ts`, pure, on top of the FSRS-4.5 of /maths
(`src/lib/maths/fsrs`, whose step functions are now exported; /maths itself is
unchanged).

| State | Again | Hard | Good | Easy |
|---|---|---|---|---|
| new | initial S, D; step 1 | initial S, D; between steps 1 and 2 | initial S, D; step 2, or review if one step | initial S, D; review |
| learning | step 1 | same step | next step, or review | review |
| review | FSRS lapse, lapses + 1; relearning | FSRS success | FSRS success | FSRS success |
| relearning | step 1 | same step | next step, or review | review |

- FSRS moves S and D only on ratings a review day or more apart; the steps
  only move a card through them.
- Interval = FSRS's for the target retention, 1 day to 10 years, with
  Hard ≤ Good < Easy enforced. No fuzz: deterministic and testable.
- A review day starts at `day_starts_hour` in `time_zone`
  (`src/lib/flashcards/day.ts`, on `src/lib/agenda/zoned.ts`). Review cards
  are due at the start of their day; cards in steps to the minute.
- Leech: at the threshold (8) and every half threshold after, the card is
  suspended and its note tagged `leech`, in the rating's transaction.

## Sessions

`buildQueue` (`src/lib/flashcards/queue.ts`) takes the cards of a deck
subtree and today's ratings: cards in steps due within 20 minutes, then
review cards due today from least to most likely recalled, then new cards
by note age, within the daily limits, and one new-or-review card per note per
day (siblings). The client (`components/flashcards/Reviewer.tsx`) shows the
next card at once after a rating and saves in the background, one save after
another; cards still in steps come back into its queue. Undo waits for saves
in flight. Cram (`?cram=1`, by deck and/or tag) journals ratings as `cram`
and reschedules nothing.

Keys: Space/Enter reveal, 1–4 rate (Space = Good once revealed), E edit,
Z undo. Touch: tap reveals, hold opens the card menu, swipe left Again /
right Good (can be turned off).

## Routes

| Route | What it serves |
|---|---|
| `/flashcards` | Deck tree with today's counts; decks created, renamed, moved, deleted |
| `/flashcards/review` | A session (`?deck=`, `?cram=1&tag=`) |
| `/flashcards/browse` | Search and filters in the URL, bulk move / tag / trash, the trash |
| `/flashcards/notes/new`, `/flashcards/notes/[id]` | Editor (preview, cloze helper, pasted images, duplicate warning); cards with their history |
| `/flashcards/inbox` | Notes Claude wrote: accept (cards are made), edit, reject |
| `/flashcards/stats` | Streak, retention against target, 30-day forecast, time per day, year heatmap, hardest cards |
| `/flashcards/import`, `/flashcards/export` | CSV/TSV in (column mapping, duplicates skip/update/create); CSV or full JSON out |
| `/flashcards/settings` | Scheduling settings, tag rename/merge |

Fields render as Markdown + KaTeX + highlighted code
(`components/flashcards/Rich.tsx`, `rehype-highlight`).

## Claude connector

Same MCP server (`/api/mcp`), five tools (`src/server/mcp/flashcards-tools.ts`):
`list_decks`, `search_notes`, `create_notes`, `get_flashcard_stats`,
`list_hard_cards`.

| | Connected app (Claude) |
|---|---|
| `fc_notes` | read; insert, forced into the inbox and signed `claude` (trigger); update only while in the inbox, never out of it; no delete, no trash |
| `fc_decks`, `fc_cards`, `fc_reviews`, `fc_settings` | read only |
| `fc_media` | nothing |
| write RPCs | refused |

Cards of a Claude note are created when Arthur accepts it, in the browser:
Claude never writes a card or a rating.

## Tests

- `supabase/tests/flashcards_test.sql`: ownership, the rating and undo RPCs
  (stale refusal, leech, cram), aggregates, tag renaming, deck deletion,
  another user, every connector rule above, the purge.
- `src/lib/flashcards/scheduler.test.ts`: transitions, button order, target
  retention, leeches, review days across the October clock change.
- `src/lib/flashcards/notes.test.ts`: cloze parsing with LaTeX braces, cards
  per kind, validation, the queue (limits, siblings, order), decks, typed
  answer diff, CSV.

## Decisions

- Route `/flashcards`, UI in English like /jobs.
- Free deck tree; Claude cannot create decks.
- V1 has no Anki import, notifications, offline mode, poker rendering or
  /agenda, /maths, /poker and /jobs links: those are V2 in the spec.
