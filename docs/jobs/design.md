# /jobs — internship search

Track every application of the end-of-studies internship search, keep the offers,
put interviews on the agenda, and let Claude help prepare them.

## Data (migration `0017_jobs.sql`)

| Table | What it holds |
|---|---|
| `companies` | One row per company, name unique per user (any case). Markdown `notes` shared by all its applications. Cannot be deleted while it has applications. |
| `job_tags` | Flat list of job types (quant, research, DS/ML, CIFRE…), colour and order. |
| `applications` | Company, role title, offer link, status, Markdown notes, applied date, deadline, and a **saved copy of the offer** (`offer_md`, `offer_source`, `offer_fetched_at`, `offer_fetch_error`). |
| `application_tags` | Several tags per application. |
| `application_events` | Status history. Written only by a trigger, on insert and on every status change. |
| `interviews` | Kind, time, with whom, where, **`prep_notes`** (Claude writes here) and **`debrief_notes`** (Arthur's). `scheduled_block_id` points at its agenda block. |
| `tasks.application_id` | A backlog task can belong to an application (prep, follow-up, "apply before Friday"). |

Statuses: `to_apply → applied → interviewing → offer → accepted`, plus `rejected` and
`withdrawn`. Moving to `applied` fills `applied_on` if it is empty. Scheduling an
interview moves `to_apply`/`applied` to `interviewing`. "No news for three weeks" is
a hint on the list, computed, never stored.

## The offer copy

Postings disappear once they close, and interviews come weeks later, so the offer
is saved when the link is added (`src/server/jobs/fetch-offer.ts`, `src/lib/jobs/offer.ts`):

1. schema.org `JobPosting` JSON-LD if the page has it: title, company, place,
   dates and the description.
2. Otherwise the page's `<main>`/`<article>`/body converted to Markdown (turndown),
   with navigation, scripts and forms removed.
3. Under 200 characters means a shell page (JavaScript-built or a login wall):
   the error says so and the page offers to paste the text. Claude can also read
   the page in a browser and store it with `set_offer_text`.

The fetch is fenced: http(s) only, public addresses only (checked after DNS and on
each redirect), 10 s, 3 MB.

## Link with the agenda

An interview put on the agenda is a **scheduled block** holding one **ad-hoc task**
under a category Arthur picks (the last one used is the default), titled
`Interview · Company (kind)`. So it counts in the week's distribution and is
pushed to Google like any block.

- The block is the source of truth for the time once it exists. Moving the
  interview in /jobs moves the block; dragging the block on the grid moves the
  interview (trigger `scheduled_blocks_move_interview`).
- Deleting the block on the grid keeps the interview and its notes
  (`on delete set null`); the interview card offers to put it back.
- Deleting the interview (or the application) in /jobs deletes its block.
- Changing the kind, or the company's name, retitles the block.
- The block panel in the week view shows the interview, its prep, and a debrief
  editor, so the debrief can be written right after without leaving the agenda.

## Claude connector

Same MCP server as the backlog (`/api/mcp`), more tools (`src/server/mcp/jobs-tools.ts`):
`list_applications`, `get_application`, `list_interviews`, `create_application`,
`update_application`, `refresh_offer`, `set_offer_text`, `list_companies`,
`update_company`, `list_job_tags`, `write_interview_prep`.

What a connected app may do is enforced in the database (the tool list is not a
boundary, as in 0015):

| | Connected app (Claude) |
|---|---|
| `companies`, `applications`, `application_tags` | read and write own rows |
| `job_tags`, `application_events` | read only |
| `interviews` | read; update `prep_notes` only (trigger); no insert, no delete |
| scheduling / moving interviews | not possible — needs `scheduled_blocks`, denied since 0015 |

Tests: `supabase/tests/jobs_test.sql` (history, applied date, block ↔ interview,
tag ownership, and every Claude rule above), `src/lib/jobs/offer.test.ts`
(extraction, dates in Paris time across DST, list order).

## Decisions

- Companies and tags are per-user rows reused across applications, not shared
  between users.
- Several tags per application.
- Claude does not schedule interviews, for now.
- Two notes per interview: prep (Claude may write) and debrief (Arthur only).
