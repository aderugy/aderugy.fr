-- External calendars become first-class blocks in the planner.
--
-- Until now a calendar was an id in an array and its events were a hatched
-- overlay. Now each calendar is a row you name, colour and — crucially — map to
-- a category, so its hours reach the same totals as the time you plan yourself.

-- ------------------------------------------------------------- the sources

create table public.calendar_sources (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users (id) on delete cascade,
  -- 'google' today. An ICS feed is the cheapest way to pull in a timetable that
  -- has no API, and it would slot in here without touching anything else.
  provider         text not null default 'google',
  external_id      text not null,
  -- Yours, not the provider's: Google says "Emploi du temps SCIA 2026-2027",
  -- you say "EPITA", and that is what the grid reads.
  display_name     text not null check (length(trim(display_name)) between 1 and 60),
  color            text not null check (color ~ '^#[0-9a-fA-F]{6}$'),
  category_id      uuid references public.categories (id) on delete restrict,
  enabled          boolean not null default false,
  include_all_day  boolean not null default true,
  include_free     boolean not null default false,
  include_declined boolean not null default false,
  position         int not null default 0,
  created_at       timestamptz not null default now(),

  unique (user_id, provider, external_id),

  -- Enabling is the moment you decide what this time *is*. Without it the hours
  -- would show on the grid and vanish from every total — the exact gap this
  -- change exists to close.
  constraint calendar_sources_enabled_needs_category
    check (not enabled or category_id is not null)
);

create index calendar_sources_user_idx on public.calendar_sources (user_id);

alter table public.calendar_sources enable row level security;

-- Sources are discovered by the sync engine; the owner reads and configures
-- them but never creates or deletes rows directly.
create policy "owner reads" on public.calendar_sources
  for select to authenticated using (auth.uid() = user_id);

-- ------------------------------------------------------------ the mirror

-- external_events is a cache of someone else's data. Rebuilding it from the
-- provider is seconds of work and cannot drift; backfilling it by hand can.
drop table if exists public.external_events;

create table public.external_events (
  user_id            uuid not null references auth.users (id) on delete cascade,
  calendar_source_id uuid not null references public.calendar_sources (id) on delete cascade,
  external_event_id  text not null,
  title              text,
  starts_at          timestamptz not null,
  ends_at            timestamptz not null,
  all_day            boolean not null default false,
  status             text not null default 'confirmed',
  transparency       text not null default 'opaque',
  attendee_response  text,
  updated_at         timestamptz not null default now(),
  primary key (user_id, calendar_source_id, external_event_id)
);

create index external_events_range_idx on public.external_events (user_id, starts_at);
create index external_events_source_idx on public.external_events (calendar_source_id);

alter table public.external_events enable row level security;

create policy "owner reads" on public.external_events
  for select to authenticated using (auth.uid() = user_id);

-- Everything must be re-fetched, since nothing carries a source id yet.
update public.google_sync_state set sync_token = null, full_resync_needed = true;

-- An array of ids cannot carry four settings per calendar.
alter table public.google_accounts drop column if exists busy_calendar_ids;
drop function if exists public.set_busy_calendars(text[]);

-- --------------------------------------------------------------- settings

-- One entry point for the fields the settings page owns. Keeping UPDATE off the
-- table means external_id and user_id cannot be rewritten from the browser.
create or replace function public.update_calendar_source(
  p_id               uuid,
  p_display_name     text default null,
  p_color            text default null,
  p_category_id      uuid default null,
  p_clear_category   boolean default false,
  p_enabled          boolean default null,
  p_include_all_day  boolean default null,
  p_include_free     boolean default null,
  p_include_declined boolean default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.calendar_sources
     set display_name     = coalesce(nullif(trim(p_display_name), ''), display_name),
         color            = coalesce(p_color, color),
         category_id      = case when p_clear_category then null
                                 else coalesce(p_category_id, category_id) end,
         enabled          = coalesce(p_enabled, enabled),
         include_all_day  = coalesce(p_include_all_day, include_all_day),
         include_free     = coalesce(p_include_free, include_free),
         include_declined = coalesce(p_include_declined, include_declined)
   where id = p_id and user_id = auth.uid();

  if not found then
    raise exception 'Calendar not found';
  end if;
exception
  when check_violation then
    raise exception 'Pick a category before enabling this calendar';
end;
$$;

grant execute on function public.update_calendar_source(
  uuid, text, text, uuid, boolean, boolean, boolean, boolean, boolean
) to authenticated;

-- ------------------------------------------------------------- rollups

-- Minutes per category per week, now counting both what you planned and what
-- your calendars already committed.
--
-- Week boundaries are evaluated in UTC here. The planner computes its own
-- totals in the browser's zone; this view is for SQL-side analysis, where an
-- event straddling local midnight on the week edge may land either side.
create or replace view public.week_category_minutes
with (security_invoker = true)
as
with own as (
  select
    sb.user_id,
    sb.week_id,
    sb.category_id,
    sum(extract(epoch from (sb.ends_at - sb.starts_at)) / 60)::int as planned_minutes,
    sum(
      case when sb.status = 'done'
      then extract(epoch from (sb.ends_at - sb.starts_at)) / 60
      else 0 end
    )::int as done_minutes,
    0 as external_minutes
  from public.scheduled_blocks sb
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
