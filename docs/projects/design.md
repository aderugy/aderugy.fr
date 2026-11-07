# /projects — research projects, focus and handoff (F22)

Status: built, 2026-11-07. Migration `0030_projects.sql`.

## Why

Research protocol v2 (R21–R24) runs every research project on a budget: a contract, steps with a budget and a cut line, one step open at a time, a parking lot for everything off the main thread, and a "next action" at the end of every exchange. Until now this lived in hidden files of each repo (`.tutor/contract.md`, `.tutor/progress.md`, `.tutor/clock.json`). That had three problems:

1. **No sync between sessions and surfaces.** A Claude Code session, a claude.ai chat (weekly review, R-B) and the app each saw a different state.
2. **Nothing visual.** No way to see at a glance what is left, what is over budget and what is parked.
3. **No channel.** No way to leave a note for the next Claude session from the phone, and no handoff from Claude that Arthur would actually see.

aderugy.fr is now the **source of truth** for project state and the **mailbox** between Arthur and every Claude surface, over the existing MCP connector. Deliberately small: a project, its steps, its items, its time entries and its messages. No Gantt, no dependencies, no assignees, no sprints.

It replaces the protocol's planned F22 (step clock and parking lot) and takes the light part of F15 (projects with milestones and a reference-class overrun ratio). F12–F14 and F16–F21 stay separate.

## Concepts

| Concept | What it is | Protocol |
|---|---|---|
| **Project** | One research thread, e.g. `MAD`. Holds the **contract**: question, deliverable, deadline, 2–4 learning objectives (the core), what may be delegated, stopping rules. | R21 |
| **Step** | One unit of the plan (`2.1 Ranger les données`) under a milestone label (`Jalon 2`). Budget, cut line, "good enough" criterion, status. **At most one open step per project**: the focus. | R22 |
| **Work entry** | Minutes spent on a step. Time spent = their sum. Append-only. | R22, metric #2 |
| **Item** | A **todo** inside a step (triaged core / support / logistics) or a **parked** item (no step; may say which step it blocks). Origin `arthur` or `claude`. | R18, R23 |
| **Next action** | One line + a duration, on the project. Overwritten; every change is logged in the thread. | R24 |
| **Message** | A note between Arthur and Claude: Arthur's are read at the start of the next session and marked read once acted on; Claude's are handoffs, questions (they ring the phone) and closed steps. | new |

Statuses:
- Project: `draft` → `active` → `paused` / `done`. Moving `draft → active` validates the contract and stamps `validated_at`.
- Step: `todo` → `open` → `done` / `cut`, plus `dropped`. Opening needs an `active` project.
- Item: `open` → `done` / `dropped`. `kind` follows `step_id`: in a step = todo, no step = parked.

Derived, never stored (`src/lib/projects/clock.ts`):
- **Clock state** of the open step, in this order of precedence: `closing` (spent ≥ cut line), `drift` (spent > 1.2 × budget), `over` (spent > budget), `ok`. Colours: neutral for ok, light amber for over, amber for drift, red for closing.
- **Overrun ratio** of a closed step: spent ÷ budget.
- **Project stats**: median ratio of closed (done + cut) steps, share closed by the cut line, steps closed per Paris week over the last 4 weeks, parked items raised per day over 14 days (`created_as = 'park'`) and the Claude-raised share (metrics #2, #13, #15).

## Data

| Table | Notes |
|---|---|
| `research_projects` | `slug` (`^[A-Z0-9-]{2,12}$`, unique per user), contract fields, `category_id` → categories, `status`, `validated_at`, `next_action`, `next_action_minutes`, `next_action_at`, `next_action_by` (stamped by trigger). |
| `research_steps` | `project_id` (cascade), `milestone`, `code` (unique per project), `title`, `good_enough`, `budget_minutes` (5–6000), `cut_minutes` (≥ budget, ≤ 9000, default 1.5 × budget), `status`, `position`, `opened_at`, `closed_at`, `close_note`. |
| `research_work` | `step_id` (**no action**: a step with logged time can't be deleted — drop it), `project_id` (cascade, filled from the step), `minutes` (−600…600, ≠ 0), `source`, `note`, `created_by`, `at`. No updates. |
| `research_items` | `project_id`, `step_id` (set null), `kind`, `title`, `triage`, `origin`, `created_as`, `blocks_step_id`, `status`, `position`, `closed_at`, `close_note`. |
| `research_messages` | `project_id`, `step_id`, `author`, `kind` (`note`, `handoff`, `question`, `step_closed`, `next_action`), `body`, `surface`, `read_at`, `pushed_at`. |
| `research_step_totals` | View (security invoker): spent per step, and per source. |
| `research_open_step(step)`, `research_close_step(step, outcome, note, next_step, surface)` | One transaction each. Close writes the `step_closed` message with the ratio; `next_step` opens it in the same transaction. Security invoker: every rule below applies. |

Invariants, for everyone (tested in `supabase/tests/projects_test.sql`):
- One open step per project (partial unique index).
- Opening needs an active project; opening stamps `opened_at`, closing stamps `closed_at`.
- `kind = 'park'` ⇔ `step_id is null`, maintained by trigger. Deleting a step parks its todos.
- Steps, items, messages and work stay inside their project.
- Work is append-only; a correction is a negative entry; a step's total never goes below zero. The app logs `app` or `reported`.
- Origin of items, author of messages and `created_by` of work are set from the caller (Claude ⇔ OAuth client), never from what is sent, and never change.
- Changing the next action writes a `next_action` message: the thread is its history.

### What Claude may do

The connector token is an ordinary user JWT with a `client_id` claim, so the tool list is not a boundary. Triggers and restrictive policies keyed on `is_oauth_client()`:

| Table | Claude |
|---|---|
| `research_projects` | Read. Insert as `draft` only. Update the contract while it's a draft; once validated, everything but `objectives`. Status: only `active → paused`. Never `validated_at` or `slug`. No delete. |
| `research_steps` | Read. Insert as `todo`. Status moves: `todo → open`, `open → done/cut`, `todo → dropped` — so no reopening, no `open → todo` (that would let it move the cut line and reopen), no dropping the open step. `budget_minutes`, `cut_minutes` and `good_enough` are frozen once the step has been opened. No delete. |
| `research_work` | Insert as `claude_code`, `claude_ai` or `reported`, timed now, on the open step or one closed less than a day ago. Negative entries need a note and can only take back what Claude logged on that step over the last day — a correction can't get it out of closing mode. No update, no delete. |
| `research_items` | Read, insert, update (origin always `claude`). No delete. |
| `research_messages` | Read. Insert (author `claude`, surface `claude_code`/`claude_ai`). Update only `read_at`, only on Arthur's messages. No delete. |

Arthur in the app can do everything else: validate, resume, close or reopen projects, move any budget or cut line, put a step back to todo, reopen a closed one, correct any time, delete (with a confirm).

## Claude connector

`src/server/mcp/projects-tools.ts`, registered in `src/app/api/mcp/route.ts` with `PROJECTS_INSTRUCTIONS`. Data access goes through `src/server/projects/data.ts` with the caller's token. Projects are named by slug (`MAD`), steps by code (`2.1`), or by id. Every write returns the focus line.

| Tool | What it does |
|---|---|
| `get_focus` | Session start. Per active project (or one): focus line, contract digest, open step with its clock, its todos, next action, Arthur's unread messages, parked items blocking the open step, parking count. |
| `get_project` | Full contract, roadmap by milestone with ratios, open items, stats, last 20 messages. |
| `save_project` | Upsert by slug; creates drafts. |
| `save_steps` | Upsert by code, ≤ 60 per call; status only `todo`/`dropped`. |
| `open_step` | Fails, naming it, if another step is open. |
| `log_work` | Minutes on a step (default: the open one). |
| `close_step` | `done` / `cut` + one line, optional `next_step`. Says which todos are left open. |
| `save_items` | Upsert ≤ 30: add a todo, park, keep (move into a step), merge (drop with a note), drop, tick. |
| `set_next_action` | Text + minutes. |
| `send_message` | `handoff` / `question` / `note`. Questions ring the phone. |
| `mark_read` | Arthur's messages only, once acted on. |

Focus line, everywhere:

```
MAD · 2.1 Ranger les données · ⏱ 3h10 / 2h00 (cut line 3h00) · closing · next: tables matchs + mises à jour (≈ 40 min) · 2 messages
```

"2 messages" counts unread messages from the other side (from Arthur when Claude reads it, from Claude in the app); `next_action` log lines never count.

## UI: `/projects`

Mobile-first; server pages plus client islands, like `/jobs`. French labels.

- **List** (`/projects`): active projects first, each with its focus line and unread count; a form to create a draft.
- **Project** (`/projects/MAD`), tab **Focus**:
  - Focus card: progress bar with budget and cut-line ticks, state colour, +15 / +30 / +… (`source = app`; "+…" takes `1h10`, `-15`), "Fermer l'étape", next action (tap to edit), link to messages.
  - Close sheet: done or cut, one line, step to open next (defaults to the next todo in the plan), and an offer to park the open todos as blocking that step.
  - Todos of the open step: check to tick, C / S / L chip cycles the triage, "garer" parks a todo (blocking the open step).
  - Roadmap: a row per milestone, a pill per step (todo hollow, open ringed, done filled with its ratio, cut hatched, dropped struck). Tap a pill: the step sheet — edit fields, budget and cut line, open / reopen / back to todo / drop / delete, time by source, work log (append-only, negative to correct, "hors app" for reported time), items.
  - Parking: count against 10 (amber above), origin badge (A / C), the step each item blocks. "Revue": one item at a time — keep (into a step), merge (into another item), drop, skip.
  - Messages: one thread, newest last. Claude's unread messages are bold and marked read when the page opens. Arthur's show "lu par Claude" with the time. Next-action history is folded away.
- Tab **Contrat**: fields, "Valider le contrat" while draft, stats, status (pause, resume, finish, back to draft), delete.
- `/agenda` header: a focus chip — open step, ⏱, state colour, unread count. With several active projects, the step opened most recently, "+N" for the others. Streamed (Suspense), and silent on any error.
- Home page: a "Projects" card.

Phone notifications: the `web-push` sweep also sends each Claude `question` once (claimed with `pushed_at`, released if no device took it, ignored after 24 h). Payload: `supabase/functions/_shared/questions.ts`.

## Decisions

- The app is the source of truth for project state: contract, steps, budgets, time, items, next action and messages. The repo keeps what is about the code and data (facts sheet, journal, predictions, AI-use log, H4 items, gate audits). `.tutor/` files are an offline fallback only.
- Sync goes through Claude calling MCP tools, not hooks posting to an API: hooks have no OAuth token, and a personal access token would be a second auth path to secure. The Claude Code clock counts locally and Claude pushes the delta with `log_work`.
- One open step per project, enforced by the database, because focus is the point.
- Work entries are append-only with negative corrections: estimates vs actuals are the reference class (metric #5). For the same reason a step with logged time can't be deleted, only dropped.
- Claude can't move the cut line (or the budget, or "good enough") of a step once opened, can't get around it by putting the step back to todo or by negative entries, and can't rewrite the core (objectives) once Arthur validated it.
- Only Claude `question` messages push to the phone; handoffs and closed steps wait for the app.
- No due dates on items, no assignees, no dependencies beyond "blocks step X", no priorities. Steps are ordered; that is the plan.
- The maths sessions (Scripts A–E) stay in `/maths` for now; revisit after a few weeks of `/projects` on MAD.

## Not built yet

Phase 3, the agenda link: a "planned" step creating a backlog task (`tasks.research_step_id`) under the project's category with the time left as estimate, closing the step marking it done, and a done grid session offering to log its minutes as work. Decided: the grid time is logged **only when Arthur confirms**, with the prompt showing what is already logged on that step for the same window (a Claude Code session can run during a grid session).

## Tests

- `supabase/tests/projects_test.sql` — every invariant and every Claude rule above, plus Arthur doing all of it.
- `src/lib/projects/clock.test.ts` — clock thresholds, focus line (h/min, negative corrections), duration parsing, stats (median with 1, 2 and 5 values, share by cut line, Paris weeks across DST), step ordering and milestone grouping, unread rule.
- `supabase/functions/_shared/questions.test.ts` — the question notification.
