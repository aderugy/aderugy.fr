# The week grid in the Claude connector

The connector (`/api/mcp`) covered the backlog only; since migration `0019` it
also reads the whole week grid and can plan blocks. Tools in
`src/server/mcp/calendar-tools.ts`:

| Tool | What it does |
|---|---|
| `get_week` | A week, Monday→Sunday in `APP_TIMEZONE`: blocks with their tasks (category, minutes, who planned them), calendar events and all-day items, theme, guidelines, objectives with progress, minutes per category. |
| `find_free_slots` | Gaps between blocks (not skipped) and busy calendar events, inside given hours, up to 14 days. |
| `list_block_templates` | The template library. |
| `create_block` | A block holding backlog tasks and/or new one-off tasks. Length from `end`, `minutes`, or the sum of its tasks. Warns about overlaps and the grid's 06:00–23:00. |
| `place_template` | A template at a time, as the planner does it. |
| `update_block` / `delete_block` | Move, resize, relabel, mark done/skipped, delete — **Claude's own blocks only**. |
| `add_to_block` / `remove_from_block` | Fill or empty Claude's own blocks. |

Times go in and out as local wall time (`"2026-10-09T18:00"`), converted with
`src/lib/agenda/zoned.ts` — the planner's `lib/time.ts` uses the runtime's zone,
which is UTC on Vercel.

## Who may change what

`scheduled_blocks.created_by` (`app` | `claude`) is set from the token on insert
and never changes. Enforced by RLS (0019), checked first by the tools so the
answer is a sentence:

| | Connected app (Claude) |
|---|---|
| `scheduled_blocks` | read all; insert; update/delete only `created_by = 'claude'` |
| `scheduled_block_tasks` | read all; write only inside Claude's blocks |
| `weeks` | read; insert a bare row (no theme/guidelines); no update/delete |
| `objectives`, `blocks`, `block_items`, `calendar_sources`, `external_events` | read only |
| `google_*` | nothing |

For everyone, a block must sit in one of the caller's weeks and a link must join
the caller's block to the caller's task.

Claude's blocks are pushed to Google like Arthur's: the triggers of 0011 mark
them pending and the cron sweep pushes them within a minute (the push function
does not accept connector tokens, so there is no immediate nudge).

## Shared code

The grid's writes moved from `src/server/actions/schedule.ts` into
`src/server/agenda/schedule.ts`, taking the client to act through; the server
actions are thin wrappers, the tools call the same functions. A delete or
detach that RLS turned into a no-op never touches the block's tasks.

Tests: `supabase/tests/calendar_oauth_test.sql`, `src/lib/agenda/zoned.test.ts`.
