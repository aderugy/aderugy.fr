# aderugy.fr

Personal website and utility tools. Next.js (App Router) · Tailwind · Supabase · Vercel.

Two tools live here so far:

- **`/agenda`** — a weekly planner: typed tasks in a backlog, reusable blocks,
  and a week grid you assemble by hand.
- **`/poker`** — pot odds, drawing equity and the fold equity a semi-bluff
  needs, with the site's rake taken off the pot. No account and nothing stored:
  the whole model is pure functions in `src/lib/poker.ts`, and the page is
  static.

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

## Google Calendar (read-only)

Your commitments block time in the planner. Nothing is ever written back to
Google, and no Google credential reaches Vercel: the whole sync engine runs as
Supabase Edge Functions.

### 1. Google Cloud Console

Add **three** authorized redirect URIs to the OAuth client. The first is for
signing in (Google → Supabase); the others are for the Calendar grant, which
this app initiates itself:

```
https://<project-ref>.supabase.co/auth/v1/callback
https://www.aderugy.fr/agenda/settings/google/callback
http://localhost:3000/agenda/settings/google/callback
```

Add `.../auth/calendar.readonly` to the consent screen's scopes.

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
supabase functions deploy google-oauth google-sync google-channels google-webhook

supabase secrets set GOOGLE_CLIENT_ID=...
supabase secrets set GOOGLE_CLIENT_SECRET=...
supabase secrets set GOOGLE_WEBHOOK_URL=https://<project-ref>.supabase.co/functions/v1/google-webhook
```

`google-webhook` is deployed with `verify_jwt = false` (see `config.toml`):
Google cannot present a Supabase JWT, so the channel token it echoes back is
what authenticates a ping.

### 4. Scheduled jobs

Run `supabase/cron.sql` in the SQL editor after filling in the two placeholders.
It schedules the 5-minute sync sweep, daily channel renewal, and pruning.

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

Every table is protected by row-level security (`user_id = auth.uid()`), so the
database is the security boundary, not the UI. The Next app holds no
service-role key and no Google client secret: the only elevated credential in
the system lives inside Supabase Edge Functions, which is also the only place
that talks to Google.

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
