# The week grid in the Claude connector

The connector (`/api/mcp`) reads the whole week grid and can plan tasks on it
(since migration `0019`; on slots rather than blocks since `0027`). Tools in
`src/server/mcp/calendar-tools.ts`:

| Tool | What it does |
|---|---|
| `get_week` | A week, Monday→Sunday in `APP_TIMEZONE`: every slot (task, category, status — missed included — and who planned it), calendar events and all-day items, theme, guidelines, objectives with progress, minutes per category. |
| `find_free_slots` | Gaps between slots (not skipped) and busy calendar events, inside given hours, up to 14 days. |
| `schedule_task` | A slot for a backlog task (`task_id`) or a new task (`new_task`). Length from `end`, `minutes`, or the task's estimate. Refused when the task already has a planned slot. Warns about overlaps and the grid's 06:00–23:00. |
| `move_session` | Move or resize — **Claude's own slots only**. A slot already started is rescheduled instead: it stays as skipped and a new one is planned. |
| `skip_session` | Skip — the slot stays as history, the task goes back to the backlog. Claude's own slots only. |
| `unschedule_session` | Back to the backlog: deleted if not started, skipped otherwise. Claude's own slots only. |

The backlog tools (`src/server/mcp/backlog-tools.ts`) show each task's planned
slot and how often it was skipped; marking a task done or dropped closes its
planned slot when Claude planned it.

Times go in and out as local wall time (`"2026-10-09T18:00"`), converted with
`src/lib/agenda/zoned.ts` — the planner's `lib/time.ts` uses the runtime's zone,
which is UTC on Vercel.

## Who may change what

`task_sessions.created_by` (`app` | `claude`) is forced to `claude` for a
connector token on insert and never changes after. Enforced by RLS (0027),
checked first by the tools so the answer is a sentence:

| | Connected app (Claude) |
|---|---|
| `task_sessions` | read all; insert; update/delete only `created_by = 'claude'`; `reschedule_session` on Arthur's slot raises 42501 |
| `weeks` | read; insert a bare row (no theme/guidelines); no update/delete |
| `objectives`, `calendar_sources`, `external_events`, `hidden_external_events` | read only |
| `google_*` | nothing |

For everyone, a slot must sit in one of the caller's weeks and point at the
caller's task.

Claude's slots are pushed to Google like Arthur's: the triggers of 0027 mark
them pending and the cron sweep pushes them within a minute (the push function
does not accept connector tokens, so there is no immediate nudge).

## Hidden events

Arthur can hide an event mirrored from a calendar, from its detail on the week:
that occurrence, or every event with its title in that calendar (a class he
skips). The rules live in `hidden_external_events` (migration 0024), apart from
the mirror, so a resync that rebuilds `external_events` never brings one back.
Hidden events are dropped where events are loaded (`withoutHidden` in
`src/lib/external.ts`, used by the week page and `loadEvents`), and the
`week_category_minutes` view leaves them out of the totals. For the connector
that time is free: `get_week` and `find_free_slots` do not see them. They are
listed in the settings, each with "Show again".

## Shared code

The grid's writes live in `src/server/agenda/schedule.ts`, taking the client to
act through; the server actions (`src/server/actions/schedule.ts`) are thin
wrappers, the tools call the same functions. The rules about time — missed,
when a move becomes a reschedule, when a slot may be deleted — are pure
functions in `src/lib/agenda/sessions.ts`.

Tests: `supabase/tests/task_sessions_test.sql`, `src/lib/agenda/sessions.test.ts`,
`src/lib/agenda/zoned.test.ts`.
