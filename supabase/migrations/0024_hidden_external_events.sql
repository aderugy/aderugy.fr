-- Hiding events mirrored from other calendars.
--
-- A connected calendar brings in everything it holds: the class you skip, the
-- colleague's meeting you were invited to out of courtesy. Hiding one takes it
-- off the grid and out of the week's totals, and frees that time for planning.
--
-- Two kinds of rule, one table:
--   * one event              (external_event_id) — this occurrence only;
--   * every event of a title (title) in that calendar — a recurring class or
--     meeting. The sync does not keep Google's series id, and a timetable
--     repeats the same title every week, so the title is the reliable key.
--
-- Kept apart from external_events on purpose: the mirror is the sync engine's
-- and is wiped and rebuilt when its token expires, which would bring every
-- hidden event back. A rule here outlives any resync; it goes with its
-- calendar (on delete cascade) and when Arthur unhides it.
--
-- The Claude connector reads the rules (so it does not plan around time that is
-- free in practice) and never writes them.
--
-- Every statement is re-runnable, like 0007 onwards.

create table if not exists public.hidden_external_events (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users (id) on delete cascade,
  calendar_source_id uuid not null references public.calendar_sources (id) on delete cascade,
  external_event_id  text check (external_event_id is null or length(external_event_id) between 1 and 1024),
  title              text check (title is null or length(title) <= 1000),
  -- What it looked like when hidden, for the settings list: a one-off event
  -- may have left the mirror since.
  label              text check (label is null or length(label) <= 1000),
  starts_at          timestamptz,
  created_at         timestamptz not null default now(),
  -- Exactly one kind of rule.
  constraint hidden_external_events_one_kind check ((external_event_id is null) <> (title is null))
);

create unique index if not exists hidden_external_events_event_idx
  on public.hidden_external_events (user_id, calendar_source_id, external_event_id)
  where external_event_id is not null;
create unique index if not exists hidden_external_events_title_idx
  on public.hidden_external_events (user_id, calendar_source_id, title)
  where title is not null;

alter table public.hidden_external_events enable row level security;

drop policy if exists "own rows" on public.hidden_external_events;
create policy "own rows" on public.hidden_external_events
  for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- "own rows" checks user_id, not the calendar it points at.
drop policy if exists "own calendar" on public.hidden_external_events;
create policy "own calendar" on public.hidden_external_events
  as restrictive for all to authenticated
  using (true)
  with check (exists (
    select 1 from public.calendar_sources cs where cs.id = calendar_source_id and cs.user_id = auth.uid()
  ));

drop policy if exists "oauth clients read only: insert" on public.hidden_external_events;
drop policy if exists "oauth clients read only: update" on public.hidden_external_events;
drop policy if exists "oauth clients read only: delete" on public.hidden_external_events;
create policy "oauth clients read only: insert" on public.hidden_external_events
  as restrictive for insert to authenticated
  with check (not (select public.is_oauth_client()));
create policy "oauth clients read only: update" on public.hidden_external_events
  as restrictive for update to authenticated
  using (not (select public.is_oauth_client()))
  with check (not (select public.is_oauth_client()));
create policy "oauth clients read only: delete" on public.hidden_external_events
  as restrictive for delete to authenticated
  using (not (select public.is_oauth_client()));

-- ------------------------------------------------ the week's totals

-- As in 0007, with hidden events left out.
create or replace view public.week_category_minutes
with (security_invoker = true)
as
with own as (
  select
    sb.user_id,
    sb.week_id,
    t.category_id,
    sum(l.planned_minutes)::int as planned_minutes,
    sum(
      case when sb.status = 'done' then l.planned_minutes else 0 end
    )::int as done_minutes,
    0 as external_minutes
  from public.scheduled_blocks sb
  join public.scheduled_block_tasks l on l.scheduled_block_id = sb.id
  join public.tasks t on t.id = l.task_id
  group by 1, 2, 3
),
ext as (
  select
    w.user_id,
    w.id as week_id,
    cs.category_id,
    0 as planned_minutes,
    0 as done_minutes,
    sum(
      extract(epoch from (
        least(e.ends_at, (w.week_start + 7)::timestamptz)
        - greatest(e.starts_at, w.week_start::timestamptz)
      )) / 60
    )::int as external_minutes
  from public.weeks w
  join public.external_events e on e.user_id = w.user_id
  join public.calendar_sources cs on cs.id = e.calendar_source_id
  where cs.enabled
    and cs.category_id is not null
    and not e.all_day
    and e.status <> 'cancelled'
    and (cs.include_free or e.transparency = 'opaque')
    and (cs.include_declined or e.attendee_response is distinct from 'declined')
    -- Hidden by Arthur: off the grid and out of the totals.
    and not exists (
      select 1 from public.hidden_external_events h
       where h.user_id = e.user_id
         and h.calendar_source_id = e.calendar_source_id
         and (h.external_event_id = e.external_event_id
              or h.title = e.title)
    )
    and e.starts_at < (w.week_start + 7)::timestamptz
    and e.ends_at   > w.week_start::timestamptz
  group by 1, 2, 3
)
select
  user_id,
  week_id,
  category_id,
  sum(planned_minutes)::int  as planned_minutes,
  sum(done_minutes)::int     as done_minutes,
  sum(external_minutes)::int as external_minutes
from (select * from own union all select * from ext) combined
group by 1, 2, 3;
