# aderugy.fr

Personal website and utility tools. Next.js (App Router) · Tailwind · Supabase · Vercel.

The first tool is **`/agenda`** — a weekly planner: typed tasks in a backlog,
reusable blocks, and a week grid you assemble by hand.

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
4. Under **Authentication → URL Configuration**, add
   `http://localhost:3000/auth/callback` and your production callback to the
   redirect allow-list. Sign-in is a magic link, so no password setup is needed.

Every table is protected by row-level security (`user_id = auth.uid()`). The
app never uses a service-role key, so the database is the security boundary,
not the UI.

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
