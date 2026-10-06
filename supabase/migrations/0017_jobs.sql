-- /jobs — the internship search.
--
-- Applications to job offers, the companies behind them, free tags for the
-- type of job, the interviews they lead to, and the history of each
-- application's status. Same rules as the rest of the schema: every row is
-- per-user and RLS (`user_id = auth.uid()`) is the boundary.
--
--   companies             one row per company, reused by every application to it
--   job_tags              flat list of job types (quant, research, DS/ML, CIFRE…)
--   applications          one offer applied to (or to apply to)
--   application_tags      many tags per application
--   application_events    status history, written by trigger only
--   interviews            one interview; on the agenda as a scheduled block
--   tasks.application_id  a backlog task can belong to an application
--
-- The link with the agenda: an interview points at the scheduled block that
-- holds its time. The block (and its one ad-hoc task, under whatever interview
-- category Arthur picks) is created by the app, so it is planned, counted and
-- pushed to Google like any other block. Moving the block on the grid moves
-- the interview (trigger below); deleting it leaves the interview and its notes
-- in place, marked as no longer on the agenda.
--
-- Every statement is re-runnable, like 0007 onwards.

-- ---------------------------------------------------------------- companies

create table if not exists public.companies (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  name        text not null check (length(trim(name)) between 1 and 120),
  website     text check (website is null or length(website) <= 500),
  notes       text check (notes is null or length(notes) <= 20000),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create unique index if not exists companies_user_name_idx
  on public.companies (user_id, lower(trim(name)));

-- ----------------------------------------------------------------- job tags

create table if not exists public.job_tags (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  name        text not null check (length(trim(name)) between 1 and 40),
  color       text check (color ~ '^#[0-9a-fA-F]{6}$'),
  position    int not null default 0,
  created_at  timestamptz not null default now()
);

create unique index if not exists job_tags_user_name_idx
  on public.job_tags (user_id, lower(trim(name)));

-- ------------------------------------------------------------- applications

create table if not exists public.applications (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users (id) on delete cascade,
  -- Restrict: a company with applications is history, not clutter.
  company_id        uuid not null references public.companies (id) on delete restrict,
  role_title        text not null check (length(trim(role_title)) between 1 and 200),
  offer_url         text check (offer_url is null or offer_url ~ '^https?://' and length(offer_url) <= 2000),
  status            text not null default 'to_apply'
                      check (status in ('to_apply', 'applied', 'interviewing', 'offer',
                                        'accepted', 'rejected', 'withdrawn')),
  notes             text check (notes is null or length(notes) <= 20000),
  applied_on        date,
  deadline          date,
  -- A copy of the offer as it was when saved. Postings are taken down once
  -- they close, and the interviews come weeks later.
  offer_md          text check (offer_md is null or length(offer_md) <= 60000),
  offer_source      text check (offer_source in ('fetched', 'pasted')),
  offer_fetched_at  timestamptz,
  offer_fetch_error text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists applications_user_status_idx on public.applications (user_id, status);
create index if not exists applications_company_idx on public.applications (company_id);

create table if not exists public.application_tags (
  user_id         uuid not null references auth.users (id) on delete cascade,
  application_id  uuid not null references public.applications (id) on delete cascade,
  tag_id          uuid not null references public.job_tags (id) on delete cascade,
  primary key (application_id, tag_id)
);

create index if not exists application_tags_tag_idx on public.application_tags (tag_id);

-- --------------------------------------------------------- status history

create table if not exists public.application_events (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users (id) on delete cascade,
  application_id  uuid not null references public.applications (id) on delete cascade,
  from_status     text,
  to_status       text not null,
  at              timestamptz not null default now()
);

create index if not exists application_events_app_idx
  on public.application_events (application_id, at);

-- ---------------------------------------------------------------- interviews

create table if not exists public.interviews (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references auth.users (id) on delete cascade,
  application_id      uuid not null references public.applications (id) on delete cascade,
  -- Null once the block is deleted from the grid: the interview and its notes
  -- stay, and the page offers to put it back on the agenda.
  scheduled_block_id  uuid unique references public.scheduled_blocks (id) on delete set null,
  kind                text not null default 'other'
                        check (kind in ('screening', 'hr', 'technical', 'case', 'final', 'other')),
  starts_at           timestamptz not null,
  ends_at             timestamptz not null,
  with_whom           text check (with_whom is null or length(with_whom) <= 300),
  location            text check (location is null or length(location) <= 500),
  -- Two notes on purpose: prep is where Claude writes, debrief is Arthur's.
  -- A connected app may write the first and never the second (trigger below).
  prep_notes          text check (prep_notes is null or length(prep_notes) <= 20000),
  debrief_notes       text check (debrief_notes is null or length(debrief_notes) <= 20000),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  check (ends_at > starts_at)
);

create index if not exists interviews_app_idx on public.interviews (application_id);
create index if not exists interviews_user_time_idx on public.interviews (user_id, starts_at);

-- --------------------------------------------------- tasks of an application

-- Prep work, a follow-up email, "apply before Friday": ordinary backlog tasks,
-- planned on the grid like the rest, that also show on the application.
alter table public.tasks
  add column if not exists application_id uuid references public.applications (id) on delete set null;

create index if not exists tasks_application_idx
  on public.tasks (application_id) where application_id is not null;

-- ------------------------------------------------------------------ triggers

drop trigger if exists companies_touch_updated_at on public.companies;
create trigger companies_touch_updated_at
  before update on public.companies
  for each row execute function public.touch_updated_at();

drop trigger if exists applications_touch_updated_at on public.applications;
create trigger applications_touch_updated_at
  before update on public.applications
  for each row execute function public.touch_updated_at();

drop trigger if exists interviews_touch_updated_at on public.interviews;
create trigger interviews_touch_updated_at
  before update on public.interviews
  for each row execute function public.touch_updated_at();

-- Moving to "applied" with no date fills it in: the day it happened is the
-- day it was recorded, unless a date was given.
create or replace function public.applications_applied_on()
returns trigger
language plpgsql
as $$
begin
  if new.status <> 'applied' or new.applied_on is not null then
    return new;
  end if;
  if tg_op = 'UPDATE' then
    if old.status = new.status then
      return new;
    end if;
  end if;
  new.applied_on := (now() at time zone 'Europe/Paris')::date;
  return new;
end;
$$;

drop trigger if exists applications_applied_on on public.applications;
create trigger applications_applied_on
  before insert or update of status on public.applications
  for each row execute function public.applications_applied_on();

-- History is written here and nowhere else, so no write path can forget it.
-- Security definer: a connected app may change a status but may not write
-- the history table itself (see the OAuth rules below).
create or replace function public.applications_log_status()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.application_events (user_id, application_id, from_status, to_status)
    values (new.user_id, new.id, null, new.status);
  elsif old.status is distinct from new.status then
    insert into public.application_events (user_id, application_id, from_status, to_status)
    values (new.user_id, new.id, old.status, new.status);
  end if;
  return null;
end;
$$;

revoke execute on function public.applications_log_status() from public, anon;

drop trigger if exists applications_log_status on public.applications;
create trigger applications_log_status
  after insert or update of status on public.applications
  for each row execute function public.applications_log_status();

-- The block is where the time lives once an interview is on the agenda:
-- dragging or resizing it on the grid carries the interview along.
create or replace function public.scheduled_blocks_move_interview()
returns trigger
language plpgsql
as $$
begin
  if old.starts_at is distinct from new.starts_at
     or old.ends_at is distinct from new.ends_at then
    update public.interviews
       set starts_at = new.starts_at,
           ends_at   = new.ends_at
     where scheduled_block_id = new.id
       and (starts_at is distinct from new.starts_at or ends_at is distinct from new.ends_at);
  end if;
  return null;
end;
$$;

drop trigger if exists scheduled_blocks_move_interview on public.scheduled_blocks;
create trigger scheduled_blocks_move_interview
  after update of starts_at, ends_at on public.scheduled_blocks
  for each row execute function public.scheduled_blocks_move_interview();

-- ----------------------------------------------------------------------- RLS

alter table public.companies          enable row level security;
alter table public.job_tags           enable row level security;
alter table public.applications       enable row level security;
alter table public.application_tags   enable row level security;
alter table public.application_events enable row level security;
alter table public.interviews         enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array[
    'companies', 'job_tags', 'applications', 'application_tags',
    'application_events', 'interviews'
  ] loop
    execute format('drop policy if exists "own rows" on public.%I', t);
    execute format(
      'create policy "own rows" on public.%I
         for all to authenticated
         using (auth.uid() = user_id) with check (auth.uid() = user_id)',
      t);
  end loop;
end;
$$;

-- A tag must be the caller's own to be put on the caller's application; the
-- "own rows" check alone would let an id guessed from someone else through.
drop policy if exists "own tag" on public.application_tags;
create policy "own tag" on public.application_tags
  as restrictive for insert to authenticated
  with check (exists (select 1 from public.job_tags g where g.id = tag_id and g.user_id = auth.uid()));

drop policy if exists "own application" on public.application_tags;
create policy "own application" on public.application_tags
  as restrictive for insert to authenticated
  with check (exists (select 1 from public.applications a where a.id = application_id and a.user_id = auth.uid()));

-- ------------------------------------------------- what Claude may touch
--
-- Same model as 0015: the connector's tokens can reach PostgREST directly, so
-- these policies are the boundary, not the MCP tool list. Each new table is a
-- decision:
--
--   companies, applications, application_tags   full access to own rows
--   job_tags, application_events                read only
--   interviews                                  read; update prep_notes only;
--                                               no insert, no delete
--   tasks.application_id                        covered by tasks (full access)
--
-- Scheduling an interview from Claude is deliberately not possible: it would
-- need scheduled_blocks, which connected apps cannot write (0015).

do $$
declare
  t text;
begin
  foreach t in array array['job_tags', 'application_events'] loop
    execute format('drop policy if exists "oauth clients read only: insert" on public.%I', t);
    execute format('drop policy if exists "oauth clients read only: update" on public.%I', t);
    execute format('drop policy if exists "oauth clients read only: delete" on public.%I', t);
    execute format(
      'create policy "oauth clients read only: insert" on public.%I
         as restrictive for insert to authenticated
         with check (not (select public.is_oauth_client()))',
      t);
    execute format(
      'create policy "oauth clients read only: update" on public.%I
         as restrictive for update to authenticated
         using (not (select public.is_oauth_client()))
         with check (not (select public.is_oauth_client()))',
      t);
    execute format(
      'create policy "oauth clients read only: delete" on public.%I
         as restrictive for delete to authenticated
         using (not (select public.is_oauth_client()))',
      t);
  end loop;
end;
$$;

drop policy if exists "oauth clients cannot add interviews" on public.interviews;
create policy "oauth clients cannot add interviews" on public.interviews
  as restrictive for insert to authenticated
  with check (not (select public.is_oauth_client()));

drop policy if exists "oauth clients cannot delete interviews" on public.interviews;
create policy "oauth clients cannot delete interviews" on public.interviews
  as restrictive for delete to authenticated
  using (not (select public.is_oauth_client()));

-- RLS has no column-level rule, so the "prep only" part is a trigger. Column
-- grants would also bind the browser, which must keep editing everything.
create or replace function public.interviews_oauth_prep_only()
returns trigger
language plpgsql
as $$
begin
  if public.is_oauth_client() and (
       new.application_id     is distinct from old.application_id
    or new.scheduled_block_id is distinct from old.scheduled_block_id
    or new.kind               is distinct from old.kind
    or new.starts_at          is distinct from old.starts_at
    or new.ends_at            is distinct from old.ends_at
    or new.with_whom          is distinct from old.with_whom
    or new.location           is distinct from old.location
    or new.debrief_notes      is distinct from old.debrief_notes
    or new.user_id            is distinct from old.user_id
  ) then
    raise exception 'Connected apps may only write interview prep notes'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists interviews_oauth_prep_only on public.interviews;
create trigger interviews_oauth_prep_only
  before update on public.interviews
  for each row execute function public.interviews_oauth_prep_only();
