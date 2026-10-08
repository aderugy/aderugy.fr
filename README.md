# aderugy.fr

Personal website and utility tools. Next.js (App Router) · Tailwind · Supabase · Vercel.

Five tools live here so far:

- **`/agenda`** — a weekly planner: typed tasks in a backlog, reusable blocks,
  and a week grid you assemble by hand. Claude can read the week and plan blocks of its own
  through the connector ([docs/agenda/calendar-connector.md](docs/agenda/calendar-connector.md)).
- **`/poker`** — pot odds, drawing equity and the fold equity a semi-bluff
  needs, with the site's rake taken off the pot. No account and nothing stored:
  the whole model is pure functions in `src/lib/poker.ts`, and the page is
  static.
- **`/maths`** — a probability & statistics learning path (in French): a DAG
  of 192 concepts, courses in MDX with KaTeX, exercises, runnable Python
  (Pyodide) and FSRS spaced repetition. See [The maths path](#the-maths-path).
- **`/poker/live`** — a live session tracker for the phone: buy-ins, rebuys,
  breaks and cash-out; the table and who sits where, with a player database
  (tags, timestamped notes); hands entered action by action and replayed; Claude
  tools to review them. See [docs/live/design.md](docs/live/design.md).
- **`/jobs`** — the internship search: applications with their companies,
  type-of-job tags, notes and a saved copy of each offer; interviews that go on
  the agenda; Claude tools to prepare them. See [docs/jobs/design.md](docs/jobs/design.md).

## Getting started

```bash
npm install
cp .env.example .env.local   # fill in your Supabase URL and anon key
npm run dev
```

### Supabase

1. Create a project at [supabase.com](https://supabase.com).
2. Run `supabase/migrations/0001_agenda_init.sql` in the SQL editor (or
   `supabase db push` with the CLI linked to the project).
3. Copy the project URL and anon key from **Project Settings → API** into
   `.env.local`.
4. Under **Authentication → URL Configuration**:
   - **Site URL** → `https://aderugy.fr`. It defaults to `http://localhost:3000`,
     and Supabase silently falls back to it whenever a requested redirect is not
     allow-listed — which is why links sometimes land on localhost from prod.
   - **Redirect URLs** →

     ```
     http://localhost:3000/auth/callback
     https://aderugy.fr/auth/callback
     https://*-<your-vercel-team>.vercel.app/auth/callback
     ```

### Google sign-in

Sign-in is Google OAuth. Nothing is e-mailed, so there is no sending quota to
run into.

1. **Google Cloud Console → APIs & Services → Credentials → Create OAuth client
   ID**, type *Web application*. Under **Authorized redirect URIs** add exactly
   one entry — Supabase's own callback, not this app's:

   ```
   https://<project-ref>.supabase.co/auth/v1/callback
   ```

   The browser goes Google → Supabase → `/auth/callback`, so Google never needs
   to know about `aderugy.fr`.
2. Configure the **OAuth consent screen** (External). While it is in *Testing*,
   only accounts listed under **Test users** can sign in — add your own address
   or you will be refused at the Google step.
3. **Supabase → Authentication → Providers → Google**: enable it and paste the
   client ID and client secret.

Login requests identity scopes only. Google Calendar will be a separate consent
later, so a planning feature can never silently widen what sign-in can reach.

## Google Calendar

Your commitments appear in the planner, and — once you turn it on — your
planned blocks appear in Google, in a calendar of their own. Your existing
calendars are only ever read. No Google credential reaches Vercel: the whole
engine, both directions, runs as Supabase Edge Functions.

### 1. Google Cloud Console

Add **three** authorized redirect URIs to the OAuth client. The first is for
signing in (Google → Supabase); the others are for the Calendar grant, which
this app initiates itself:

```
https://<project-ref>.supabase.co/auth/v1/callback
https://www.aderugy.fr/agenda/settings/google/callback
http://localhost:3000/agenda/settings/google/callback
```

Add `.../auth/calendar.readonly` and `.../auth/calendar.app.created` to the
consent screen's scopes. The second is what pushing blocks needs: it lets the
app create calendars and write to *those only* — it grants nothing over the
calendars you already have.

**The publishing status matters more than anything else here.** While it is
*Testing*, Google expires refresh tokens after 7 days and background sync dies
every week, silently. Publish the app — the unverified-app interstitial at
consent time is the price, and the 100-user cap is irrelevant for a personal
tool.

### 2. Migrations

Run `0002_google_calendar.sql` then `0003_google_secrets.sql`. The second needs
the `supabase_vault` extension, which is on by default for dashboard-created
projects.

### 3. Edge Functions

```bash
supabase functions deploy google-oauth google-sync google-channels google-webhook google-push web-push

supabase secrets set GOOGLE_CLIENT_ID=...
supabase secrets set GOOGLE_CLIENT_SECRET=...
supabase secrets set GOOGLE_WEBHOOK_URL=https://<project-ref>.supabase.co/functions/v1/google-webhook

# Optional, for pushing blocks: the Agenda calendar's time zone (default
# Europe/Paris), and the site URL linked from each event.
supabase secrets set APP_TIMEZONE=Europe/Paris
supabase secrets set APP_URL=https://www.aderugy.fr
```

`google-webhook` is deployed with `verify_jwt = false` (see `config.toml`):
Google cannot present a Supabase JWT, so the channel token it echoes back is
what authenticates a ping.

### 4. Scheduled jobs

Run `supabase/cron.sql` in the SQL editor after filling in the project URL, then
add the service-role key to the Vault with the one statement it shows. Without the
key the jobs run and do nothing; check with `select * from cron.job_run_details`.
It schedules the 5-minute sync sweep, daily channel renewal, pruning, and the
one-minute push sweep (which only invokes the function when there is work).

The cron lives here rather than on Vercel because **Vercel's Hobby plan caps
cron at once per day** — a `*/5` expression fails at deployment. `pg_cron` has a
one-minute floor.

### How freshness is maintained

| Layer | Trigger | Covers |
|---|---|---|
| Push | Google → `google-webhook` | The normal case, seconds |
| Cron | `pg_cron`, every 5 min | Missed notifications, dead channels |
| On load | `/agenda`, if the mirror is over a minute old | The week you are looking at |
| Realtime | Supabase Realtime on `external_events` | An open tab updates itself |

All four call the same idempotent sync. A row lease in `google_sync_state`
prevents two from interleaving — the loser would otherwise persist a sync token
that does not account for the rows the winner wrote.

### 5. Naming your calendars

Every calendar Google reports appears under **Settings** as a *disabled* row.
Enabling one requires giving it a **category**, and that is deliberate: without
it the hours would show on your grid and count toward nothing.

Per calendar you set:

- **Name** — yours, not Google's. Google says *Emploi du temps SCIA 2026-2027*;
  you say **EPITA**, and that is what the week reads.
- **Colour** — how its events look on the grid.
- **Category** — what its hours count as. A lecture then lands in your `studies`
  total and fills a "12 h studies" objective without you planning anything.
- **Inclusions** — all-day events, events you are marked free for, invitations
  you declined. Only the first is on by default.

On the grid an external event shows the **calendar name** as its label and the
**event's own title** as its description. It is read-only: no move, no resize,
no edit. Google is the source of truth and the next sync would revert anything
anyway.

All-day events go to a slim strip above the grid rather than filling a column —
they mark a day, they do not consume ten hours of it.

### 6. Pushing your blocks to Google

**Settings → Push blocks to Google → Start pushing.** A connection made before
this feature existed is read-only, so the button first says **Allow in Google**
and goes through consent once more.

- The app creates an **Agenda** calendar in your Google account and writes every
  block there: create, move, resize, rename, mark done, delete. It never writes
  anywhere else — the scope does not allow it.
- **One-way.** The plan is the source of truth; an edit made to an Agenda event
  in Google is overwritten by the next push of that block. The Agenda calendar
  is never mirrored back into the planner (that would draw every block twice).
- The title is what the grid shows — template name, else the block's
  description, else its task categories (`grind · reading`) — with `✓` for done
  and `✕` for skipped. The event body lists the tasks and their minutes.
  Skipped blocks are marked *free*, so they do not make you look busy.
- **Stop pushing** deletes the Agenda calendar from Google. Your blocks here are
  untouched; starting again recreates it from scratch. Disconnecting Google
  deletes it too.

How it stays current: triggers mark a block `pending` on any change that
affects its event — including edits to its tasks, a category rename or a
template rename — so no write path can forget. Every schedule action then nudges
`google-push` after its response, so a move on the grid reaches your phone in
seconds; a `pg_cron` job sweeps once a minute for anything that missed, and
retries failures up to 8 times. Deleted blocks leave a tombstone so the event
can still be removed after the row is gone. Event ids are derived from block
ids, so a retried insert can never create a duplicate.

Every table is protected by row-level security (`user_id = auth.uid()`), so the
database is the security boundary, not the UI. The Next app holds no
service-role key and no Google client secret: the only elevated credential in
the system lives inside Supabase Edge Functions, which is also the only place
that talks to Google.

## Installing the app and block reminders

The site is installable (`src/app/manifest.ts`): Chrome or Edge on a computer
(install icon in the address bar), Android, and iPhone via Share → Add to Home
Screen. It opens on `/agenda`; the other tools are shortcuts on the icon.

`public/sw.js` handles notifications only — no fetch handler, nothing cached —
so a deploy is never hidden behind a stale copy.

Reminders: each device turns them on from **/agenda → Settings →
Notifications**, and then gets one notification per planned block, a chosen
number of minutes before it starts (10 by default). On iPhone this only works
from the installed app, not from a Safari tab.

How it works: devices are rows in `push_subscriptions`; the `web-push` Edge
Function, swept every minute by pg_cron, sends what
`blocks_due_for_reminder()` returns and records it in `block_reminders_sent`,
keyed on the start time, so moving a block makes it due again. Encryption and
VAPID signing are in `supabase/functions/_shared/webpush.ts`, with no
dependency, tested against RFC 8291's own vector.

Setup, once:

1. `node scripts/vapid-keys.mjs` and follow what it prints: the public key goes
   to Vercel as `NEXT_PUBLIC_VAPID_PUBLIC_KEY` (redeploy after), the three
   secrets to Supabase. Keep the pair — new keys orphan every device.
2. Run `supabase/migrations/0020_block_reminders.sql`.
3. `supabase functions deploy web-push`
4. Re-run `supabase/cron.sql` (it adds the `block-reminders-due` job).

Tests: `supabase/tests/block_reminders_test.sql`,
`supabase/functions/_shared/webpush.test.ts`, `reminders.test.ts`.

## Database backups before migrations

Supabase's GitHub integration applies `supabase/migrations` as soon as they
reach `main`. Before that happens, `.github/workflows/db-backup.yml` dumps the
database to Google Drive: it runs on every pull request to `main`, does the
backup only when the pull request touches `supabase/migrations` (others pass at
once), and branch protection makes it a required check, so a migration cannot
be merged without a fresh backup. It can also be run by hand (Actions →
Database backup → Run workflow).

What is in a backup: the `public` and `auth` schemas and the migration history
(`supabase_migrations`), as one `pg_dump` custom-format file named
`aderugy-db_<UTC time>_<commit>.dump`, in the Drive folder
**aderugy.fr — database backups**. Live sign-in tokens (`auth.sessions`,
`auth.refresh_tokens`, …) are left out. The 30 newest are kept; older ones go
to the Drive trash. The token only has `drive.file` access: it sees the files
it created and nothing else in the Drive.

The repository is public: the job never prints table contents and never
uploads the dump as a workflow artifact. Keep it that way.

**Migrations go through pull requests.** A direct push to `main` skips the
check; the integration would still apply the migration, unprotected.

Setup, once:

1. **Google OAuth client.** In Google Cloud Console (the project used for the
   Calendar connection is fine): enable the *Google Drive API*, then
   *Credentials → Create credentials → OAuth client ID → Desktop app*. On the
   *OAuth consent screen*, set the publishing status to **In production** —
   while it is in *Testing*, Google expires refresh tokens after 7 days and
   backups would start failing a week later. `drive.file` is not a sensitive
   scope, so no verification is needed.
2. **Refresh token.** On your computer:
   `node scripts/db-backup/auth.mjs <client-id> <client-secret>`, open the URL,
   approve, copy the token it prints.
3. **Database URL.** Supabase dashboard → *Connect* → *Session pooler* URI,
   with the database password filled in. Not the direct connection: it is
   IPv6-only, and GitHub's runners have no IPv6.
4. **Secrets.** GitHub → *Settings → Secrets and variables → Actions*:
   `SUPABASE_DB_URL`, `GDRIVE_CLIENT_ID`, `GDRIVE_CLIENT_SECRET`,
   `GDRIVE_REFRESH_TOKEN`.
5. **Branch protection.** *Settings → Branches → Add rule* for `main`:
   *Require status checks to pass before merging* → add **Backup database**.
6. **Try it.** *Actions → Database backup → Run workflow*, then check the file
   appeared in Drive.

Restoring: download the file, look before touching anything —
`pg_restore --list <file>` — and restore into a scratch database first, e.g.
`pg_restore --no-owner --data-only --table=tasks -d <scratch-url> <file>`.
Restoring into the live project means stopping the cron jobs first
(`supabase/cron.sql`) so the Google pusher does not act on half-restored rows.

## Poker rake presets

`/poker` prices every call net of rake, so the presets it offers — Betclic and
Winamax today — live in `public.rake_profiles` rather than in the code. A cap
that changes is one `update` in the SQL editor, not a deploy.

1. Run `supabase/migrations/0006_rake_profiles.sql`. It creates the table and
   seeds the 33 rows currently in use (5 Betclic limits, 7 Winamax limits × 4
   table sizes).
2. Nothing else. The table is world-readable (`for select to anon,
   authenticated`) because the tool has no login, and it has **no** write
   policy: rows change from the SQL editor or a migration.

Two details worth knowing before editing rows by hand:

- `cap_bb` is what the maths uses; `cap_amount` / `big_blind` / `currency` are
  how the site itself states the cap ("1,50 € = 3 bb"). A check constraint
  refuses a row where the two disagree, since that is the one mistake here that
  would be quietly, expensively wrong.
- `seats` is the number of players dealt in, for sites whose cap depends on it;
  the top of a ladder means "and up", which is what `seats_label` says. Leave
  both null when the cap does not vary. `is_default` marks the preset a
  first-time visitor opens, and a unique index allows only one.

The chosen preset is remembered in `localStorage` on the visitor's own device
(`aderugy:poker:rake`) — nothing about it reaches the database. If the presets
cannot be read at all, the menu falls back to its manual percent/cap fields and
the page still works.

## The maths path

Formerly a standalone app (SQLite + Docker), now a signed-in segment of this
site. The specs and design decisions it was built from are kept in
`docs/maths/` (`prompt.md` is authoritative; paths in those docs predate the
move — `content/` is now `content/maths/`, `src/lib/` is `src/lib/maths/`).

**Content lives in git, state lives in Supabase.**

```
content/maths/graph.yaml          source of truth of the DAG — never rename an id
content/maths/graph.layout.json   precomputed layout, versioned (npm run maths:layout)
content/maths/notation.mdx        notation conventions
content/maths/<domain>/<topic>/<concept>/course.mdx | cards.yaml | exercises/*.mdx
src/lib/maths/                    graph, progression rules, FSRS, stats — pure, tested
src/server/maths/data.ts          Supabase reads (one snapshot per request) and writes
src/server/actions/maths.ts       server actions
supabase/migrations/0012_maths.sql  per-user tables maths_*, RLS, two RPCs
```

Run `0012_maths.sql` once. `next.config.ts` adds `content/maths/**` to the
output file trace: the pages read it from disk at request time, which the
tracer cannot see on its own.

| route | what it serves |
|---|---|
| `/maths` | the DAG map, per domain or as a tree |
| `/maths/n/<id>` | a node: course, exercises, progress, cards, session log |
| `/maths/revision` | the FSRS queue, interleaved across the corpus, keyboard-driven |
| `/maths/recherche` | full-text search over courses, exercises and cards |
| `/maths/tableau-de-bord` | hours, review load, forgetting curve, tags, fragile nodes |
| `/maths/corpus` | the whole written corpus — **print to PDF from here** |
| `/maths/notation` | notation conventions |

Writing a node: create `course.mdx` with `status: draft | published` in its
frontmatter, follow the nine sections with their anchors
(`## 6. Contre-exemples et pièges {#pieges}`), then `npm run maths:check`.
After any change to `graph.yaml`, run `npm run maths:layout` or the new node
has no position on the map. Widgets (`src/components/maths/widgets/`) are
used straight from MDX (`<Convergence />`) once declared in
`src/lib/maths/mdx.tsx`.

## The agenda model

| Concept | Meaning |
|---|---|
| **Category** | A node in your own tree describing the *type* of work — `poker > grind`, `studies > SCIA > NLP`. Colors cascade to children. |
| **Task** | One thing to do: a category, an estimate, a priority, an optional deadline. Sits in the backlog until placed. |
| **Block** | A reusable template. No steps → a *shape* (`Deep work, 2h`). With steps → a *bundle* (`Morning routine`), sized to the sum of its parts. |
| **Scheduled block** | A concrete placement on the week grid. Tasks attach to it many-to-many, so one task can span several sessions. |
| **Week** | Monday date, plus a theme, guidelines and objectives. |

## Using it

- **Backlog** — build the category tree, then add tasks against it.
- **Blocks** — define the recurring shapes of your week.
- **Week** — drag tasks or blocks from the left rail onto the grid. Drag a
  placed block to move it, pull its bottom edge to resize, double-click empty
  space for an ad-hoc block, click one to open its detail panel. Day totals turn
  red past ten hours.

Everything snaps to 15 minutes between 06:00 and 23:00 (`src/lib/time.ts`).

## Notes

- Grid interaction is hand-rolled on pointer events — no drag-and-drop library,
  so no React-version compatibility risk and full control over the geometry.
- Times are stored as `timestamptz` and rendered in the browser's local zone.
  The default week is resolved with `NEXT_PUBLIC_APP_TIMEZONE` so the server
  (UTC) and the browser agree on which Monday to open.
- Google Calendar sync is not built yet; `scheduled_blocks` already carries the
  `google_event_id` / `sync_state` columns so adding it is a feature, not a
  migration of live planning data.
