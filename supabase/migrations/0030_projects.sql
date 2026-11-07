-- /projects — research projects, focus and handoff (F22).
--
-- Arthur's research protocol v2 runs every research project on a budget: a
-- contract, steps with a budget and a cut line, one step open at a time, a
-- parking lot, a next action, and notes passed between Arthur and Claude.
-- This makes the app the source of truth for that state, shared by every
-- Claude surface through the connector. See docs/projects/design.md.
--
--   research_projects   the contract, status, next action
--   research_steps      the plan: budget, cut line, status; one open per project
--   research_work       minutes spent on a step; append-only
--   research_items      todos inside a step, or parked items (no step)
--   research_messages   notes between Arthur and Claude, one thread per project
--   research_step_totals  view: minutes spent per step, by source
--
-- Same rules as the rest of the schema: every row is per-user and RLS
-- (`user_id = auth.uid()`) is the boundary. What a connected app (Claude) may
-- do is enforced here too, as in 0015, 0017 and 0028 — the connector's token
-- can reach PostgREST directly, so the MCP tool list is not a boundary.
--
-- Every statement is re-runnable.

-- --------------------------------------------------------------- helpers

create or replace function public.research_objectives_ok(p text[])
returns boolean
language sql
immutable
as $$
  select coalesce(cardinality(p), 0) <= 4
     and coalesce((select bool_and(length(trim(o)) between 1 and 200) from unnest(p) as o), true);
$$;

-- "40 min", "2h00", "-15 min": the same format as src/lib/projects/clock.ts.
create or replace function public.research_fmt_minutes(p int)
returns text
language sql
immutable
as $$
  select case
    when p is null then '—'
    when abs(p) < 60 then p::text || ' min'
    else case when p < 0 then '-' else '' end
         || (abs(p) / 60)::text || 'h' || lpad((abs(p) % 60)::text, 2, '0')
  end;
$$;

-- Who is acting, as the rows record it.
create or replace function public.research_caller()
returns text
language sql
stable
as $$
  select case when public.is_oauth_client() then 'claude' else 'arthur' end;
$$;

-- ------------------------------------------------------------- projects

create table if not exists public.research_projects (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references auth.users (id) on delete cascade,
  slug                text not null check (slug ~ '^[A-Z0-9-]{2,12}$'),
  name                text not null check (length(trim(name)) between 1 and 120),
  question            text check (question is null or length(question) <= 500),
  deliverable         text check (deliverable is null or length(deliverable) <= 500),
  deadline            date,
  objectives          text[] not null default '{}' check (public.research_objectives_ok(objectives)),
  delegated_md        text check (delegated_md is null or length(delegated_md) <= 4000),
  stopping_rules_md   text check (stopping_rules_md is null or length(stopping_rules_md) <= 4000),
  repo_url            text check (repo_url is null or (repo_url ~ '^https?://' and length(repo_url) <= 500)),
  -- The agenda category the work counts under.
  category_id         uuid references public.categories (id) on delete set null,
  status              text not null default 'draft'
                        check (status in ('draft', 'active', 'paused', 'done')),
  validated_at        timestamptz,
  next_action         text check (next_action is null or length(next_action) <= 300),
  next_action_minutes int check (next_action_minutes is null or next_action_minutes between 1 and 600),
  next_action_at      timestamptz,
  next_action_by      text check (next_action_by in ('arthur', 'claude')),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (user_id, slug)
);

-- ----------------------------------------------------------------- steps

create table if not exists public.research_steps (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users (id) on delete cascade,
  project_id      uuid not null references public.research_projects (id) on delete cascade,
  milestone       text check (milestone is null or length(milestone) <= 60),
  code            text not null check (length(trim(code)) between 1 and 12),
  title           text not null check (length(trim(title)) between 1 and 200),
  good_enough     text check (good_enough is null or length(good_enough) <= 500),
  budget_minutes  int not null check (budget_minutes between 5 and 6000),
  -- Filled with 1.5 × budget when left out (trigger below).
  cut_minutes     int not null check (cut_minutes <= 9000),
  status          text not null default 'todo'
                    check (status in ('todo', 'open', 'done', 'cut', 'dropped')),
  position        int not null default 0,
  opened_at       timestamptz,
  closed_at       timestamptz,
  close_note      text check (close_note is null or length(close_note) <= 1000),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (project_id, code),
  constraint research_steps_cut_after_budget check (cut_minutes >= budget_minutes)
);

-- Focus is the point: at most one open step per project.
create unique index if not exists research_steps_one_open_idx
  on public.research_steps (project_id) where status = 'open';
create index if not exists research_steps_project_idx
  on public.research_steps (project_id, position);

-- ------------------------------------------------------------------ work

create table if not exists public.research_work (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  -- Filled from the step (trigger). Deleting the project deletes its history…
  project_id  uuid not null references public.research_projects (id) on delete cascade,
  -- …but a step with logged time cannot be deleted on its own: drop it.
  -- NO ACTION (not RESTRICT) so a project delete, which removes both at once,
  -- passes the end-of-statement check.
  step_id     uuid not null references public.research_steps (id) on delete no action,
  minutes     int not null check (minutes between -600 and 600 and minutes <> 0),
  source      text not null check (source in ('claude_code', 'claude_ai', 'app', 'reported')),
  note        text check (note is null or length(note) <= 300),
  created_by  text not null default 'arthur' check (created_by in ('arthur', 'claude')),
  at          timestamptz not null default now(),
  created_at  timestamptz not null default now()
);

create index if not exists research_work_step_idx on public.research_work (step_id, at);
create index if not exists research_work_project_idx on public.research_work (project_id, at);

-- ----------------------------------------------------------------- items

create table if not exists public.research_items (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users (id) on delete cascade,
  project_id      uuid not null references public.research_projects (id) on delete cascade,
  step_id         uuid references public.research_steps (id) on delete set null,
  -- Derived from step_id by the trigger below; kept as a column so a query can
  -- say what it means.
  kind            text not null default 'park' check (kind in ('todo', 'park')),
  title           text not null check (length(trim(title)) between 1 and 300),
  triage          text check (triage in ('core', 'support', 'logistics')),
  origin          text not null default 'arthur' check (origin in ('arthur', 'claude')),
  -- What it was when raised: parked items opened per day is a protocol metric,
  -- and kind changes as the parking lot is reviewed.
  created_as      text check (created_as in ('todo', 'park')),
  blocks_step_id  uuid references public.research_steps (id) on delete set null,
  status          text not null default 'open' check (status in ('open', 'done', 'dropped')),
  position        int not null default 0,
  closed_at       timestamptz,
  close_note      text check (close_note is null or length(close_note) <= 300),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint research_items_park_has_no_step check ((kind = 'park') = (step_id is null))
);

create index if not exists research_items_project_idx on public.research_items (project_id, status);
create index if not exists research_items_step_idx on public.research_items (step_id) where step_id is not null;

-- -------------------------------------------------------------- messages

create table if not exists public.research_messages (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  project_id  uuid not null references public.research_projects (id) on delete cascade,
  step_id     uuid references public.research_steps (id) on delete set null,
  author      text not null default 'arthur' check (author in ('arthur', 'claude')),
  -- next_action: written by a trigger each time the next action changes, so
  -- its history is the thread.
  kind        text not null default 'note'
                check (kind in ('note', 'handoff', 'question', 'step_closed', 'next_action')),
  body        text not null check (length(trim(body)) between 1 and 4000),
  surface     text not null default 'app' check (surface in ('app', 'claude_code', 'claude_ai')),
  read_at     timestamptz,
  -- Set by the web-push sweep once a Claude question rang Arthur's devices.
  pushed_at   timestamptz,
  created_at  timestamptz not null default now()
);

create index if not exists research_messages_project_idx on public.research_messages (project_id, created_at);
create index if not exists research_messages_to_push_idx
  on public.research_messages (created_at)
  where author = 'claude' and kind = 'question' and pushed_at is null;

-- ---------------------------------------------------------- updated_at

do $$
declare
  t text;
begin
  foreach t in array array['research_projects', 'research_steps', 'research_items'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_touch_updated_at', t);
    execute format(
      'create trigger %I before update on public.%I
         for each row execute function public.touch_updated_at()',
      t || '_touch_updated_at', t);
  end loop;
end;
$$;

-- ------------------------------------------------------ project rules
--
-- Anyone: draft → active stamps validated_at; changing the next action stamps
-- who and when. A connected app additionally:
--   creates drafts only; never touches validated_at;
--   may move a project only from active to paused (validation, resuming and
--   closing a project are Arthur's);
--   may not change the objectives once the contract has been validated.

create or replace function public.research_projects_guard()
returns trigger
language plpgsql
as $$
declare
  claude boolean := public.is_oauth_client();
begin
  if tg_op = 'INSERT' then
    if claude and (new.status <> 'draft' or new.validated_at is not null) then
      raise exception 'A project created by Claude starts as a draft: Arthur validates the contract'
        using errcode = '42501';
    end if;
    if new.status = 'active' and new.validated_at is null then
      new.validated_at := now();
    end if;
    if new.next_action is not null then
      new.next_action_by := public.research_caller();
      new.next_action_at := now();
    end if;
    return new;
  end if;

  if new.slug is distinct from old.slug and claude then
    raise exception 'Only Arthur renames a project''s slug' using errcode = '42501';
  end if;

  if new.status is distinct from old.status then
    if claude and not (old.status = 'active' and new.status = 'paused') then
      raise exception 'Claude may only pause an active project; % → % is Arthur''s call', old.status, new.status
        using errcode = '42501';
    end if;
    if old.status = 'draft' and new.status = 'active' and new.validated_at is null then
      new.validated_at := now();
    end if;
  end if;

  if claude and new.validated_at is distinct from old.validated_at then
    raise exception 'Only Arthur validates a contract' using errcode = '42501';
  end if;

  if claude and old.validated_at is not null and new.objectives is distinct from old.objectives then
    raise exception 'The objectives of a validated contract are Arthur''s: propose the change in a message'
      using errcode = '42501';
  end if;

  if new.next_action is distinct from old.next_action
     or new.next_action_minutes is distinct from old.next_action_minutes then
    new.next_action_by := public.research_caller();
    new.next_action_at := now();
  elsif new.next_action_by is distinct from old.next_action_by
     or new.next_action_at is distinct from old.next_action_at then
    -- Stamps follow the text; nobody sets them by hand.
    new.next_action_by := old.next_action_by;
    new.next_action_at := old.next_action_at;
  end if;

  return new;
end;
$$;

drop trigger if exists research_projects_guard on public.research_projects;
create trigger research_projects_guard
  before insert or update on public.research_projects
  for each row execute function public.research_projects_guard();

-- The next action's history is the message thread.
create or replace function public.research_projects_log_next_action()
returns trigger
language plpgsql
as $$
begin
  if new.next_action is not null and (
       tg_op = 'INSERT'
       or new.next_action is distinct from old.next_action
       or new.next_action_minutes is distinct from old.next_action_minutes) then
    insert into public.research_messages (user_id, project_id, kind, body, surface)
    values (
      new.user_id, new.id, 'next_action',
      new.next_action || coalesce(' (≈ ' || public.research_fmt_minutes(new.next_action_minutes) || ')', ''),
      case when public.is_oauth_client() then 'claude_ai' else 'app' end
    );
  end if;
  return null;
end;
$$;

drop trigger if exists research_projects_log_next_action on public.research_projects;
create trigger research_projects_log_next_action
  after insert or update of next_action, next_action_minutes on public.research_projects
  for each row execute function public.research_projects_log_next_action();

-- --------------------------------------------------------- step rules
--
-- Anyone: the step stays in its project; the cut line defaults to 1.5 × the
-- budget; opening needs an active project and stamps opened_at; closing
-- (done, cut, dropped) stamps closed_at. A connected app additionally:
--   inserts steps as todo;
--   moves a step only todo → open, open → done | cut, todo → dropped — so it
--   cannot reopen a closed step, nor put the open one back to todo (which
--   would let it move the cut line and open it again);
--   cannot change the budget, cut line or "good enough" of a step once it has
--   been opened: the one who enforces the cut line doesn't get to move it.

create or replace function public.research_steps_guard()
returns trigger
language plpgsql
as $$
declare
  claude boolean := public.is_oauth_client();
  project_status text;
begin
  select p.status into project_status
    from public.research_projects p
   where p.id = new.project_id and p.user_id = new.user_id;
  if not found then
    raise exception 'Unknown project' using errcode = '23503';
  end if;

  if tg_op = 'UPDATE' and new.project_id is distinct from old.project_id then
    raise exception 'A step cannot move to another project';
  end if;

  if new.cut_minutes is null then
    new.cut_minutes := least(9000, greatest(new.budget_minutes, round(new.budget_minutes * 1.5)::int));
  end if;

  if tg_op = 'INSERT' then
    if claude and new.status <> 'todo' then
      raise exception 'Claude adds steps as todo; open one with open_step' using errcode = '42501';
    end if;
  else
    if new.status is distinct from old.status and claude and not (
         (old.status = 'todo' and new.status in ('open', 'dropped'))
      or (old.status = 'open' and new.status in ('done', 'cut'))) then
      raise exception 'Claude cannot move a step from % to %: closing is done or cut, reopening is Arthur''s',
        old.status, new.status using errcode = '42501';
    end if;
    if claude and old.status <> 'todo' and (
         new.budget_minutes is distinct from old.budget_minutes
      or new.cut_minutes    is distinct from old.cut_minutes
      or new.good_enough    is distinct from old.good_enough) then
      raise exception 'The budget, cut line and "good enough" of step % are Arthur''s once it has been opened: propose a change in a message',
        old.code using errcode = '42501';
    end if;
  end if;

  if new.status = 'open' and (tg_op = 'INSERT' or old.status is distinct from 'open') then
    if project_status <> 'active' then
      raise exception 'The project is % — a step can only be opened once the contract is validated (active)', project_status;
    end if;
    new.opened_at := coalesce(new.opened_at, now());
    new.closed_at := null;
  elsif new.status in ('done', 'cut', 'dropped')
        and (tg_op = 'INSERT' or old.status is distinct from new.status) then
    new.closed_at := now();
  elsif new.status = 'todo' then
    new.closed_at := null;
  end if;

  return new;
end;
$$;

drop trigger if exists research_steps_guard on public.research_steps;
create trigger research_steps_guard
  before insert or update on public.research_steps
  for each row execute function public.research_steps_guard();

-- Deleting a step parks its todos: a todo has a step, a parked item has none,
-- and on delete set null alone would break that rule. Skipped when the whole
-- project is going (its items are going too).
create or replace function public.research_steps_park_items()
returns trigger
language plpgsql
as $$
begin
  if exists (select 1 from public.research_projects where id = old.project_id) then
    update public.research_items
       set step_id = null
     where step_id = old.id;
  end if;
  return old;
end;
$$;

drop trigger if exists research_steps_park_items on public.research_steps;
create trigger research_steps_park_items
  before delete on public.research_steps
  for each row execute function public.research_steps_park_items();

-- --------------------------------------------------------- work rules
--
-- Append-only for everyone: a mistake is corrected with a negative entry,
-- because estimates vs actuals are the reference class. A step's total never
-- goes below zero. The source says where the time was counted: the app logs
-- `app`, Claude logs `claude_code` / `claude_ai`, either may log `reported`
-- (Arthur's time away from both). A connected app additionally:
--   logs on the open step, or on one closed less than a day ago (a late sync);
--   gives a note with any negative entry, and its negative entries on a step
--   over the last day cannot exceed what it logged there over that day —
--   so a correction cannot take the clock out of closing mode.

create or replace function public.research_work_guard()
returns trigger
language plpgsql
as $$
declare
  claude boolean := public.is_oauth_client();
  s record;
  total int;
  own_recent int;
begin
  if tg_op = 'UPDATE' then
    raise exception 'Work entries are append-only: correct with a negative entry';
  end if;

  select st.project_id, st.status, st.closed_at, st.code into s
    from public.research_steps st
   where st.id = new.step_id and st.user_id = new.user_id;
  if not found then
    raise exception 'Unknown step' using errcode = '23503';
  end if;
  new.project_id := s.project_id;
  new.created_by := public.research_caller();

  if claude then
    if new.source not in ('claude_code', 'claude_ai', 'reported') then
      raise exception 'Claude logs time as claude_code, claude_ai or reported' using errcode = '42501';
    end if;
    new.at := now();
    if not (s.status = 'open' or (s.closed_at is not null and s.closed_at > now() - interval '1 day')) then
      raise exception 'Step % is not open: Claude logs time on the open step, or on one closed less than a day ago', s.code
        using errcode = '42501';
    end if;
    if new.minutes < 0 then
      if new.note is null or length(trim(new.note)) = 0 then
        raise exception 'A correction needs a note saying what it corrects' using errcode = '42501';
      end if;
      select coalesce(sum(w.minutes), 0) into own_recent
        from public.research_work w
       where w.step_id = new.step_id and w.created_by = 'claude' and w.at > now() - interval '1 day';
      if own_recent + new.minutes < 0 then
        raise exception 'Claude can only correct time it logged on step % over the last day (% there); Arthur can correct the rest',
          s.code, public.research_fmt_minutes(own_recent) using errcode = '42501';
      end if;
    end if;
  elsif new.source not in ('app', 'reported') then
    raise exception 'The app logs time as app or reported';
  end if;

  select coalesce(sum(w.minutes), 0) into total
    from public.research_work w where w.step_id = new.step_id;
  if total + new.minutes < 0 then
    raise exception 'Step % has % logged: a correction cannot take it below zero', s.code, public.research_fmt_minutes(total);
  end if;

  return new;
end;
$$;

drop trigger if exists research_work_guard on public.research_work;
create trigger research_work_guard
  before insert or update on public.research_work
  for each row execute function public.research_work_guard();

-- --------------------------------------------------------- item rules
--
-- kind follows step_id: an item in a step is a todo, an item with no step is
-- parked. Moving a parked item into a step is how the parking-lot review
-- keeps it. Origin is whoever created it, and cannot be changed afterwards.

create or replace function public.research_items_guard()
returns trigger
language plpgsql
as $$
begin
  if not exists (select 1 from public.research_projects p where p.id = new.project_id and p.user_id = new.user_id) then
    raise exception 'Unknown project' using errcode = '23503';
  end if;
  if tg_op = 'UPDATE' and new.project_id is distinct from old.project_id then
    raise exception 'An item cannot move to another project';
  end if;
  if new.step_id is not null and not exists (
       select 1 from public.research_steps s where s.id = new.step_id and s.project_id = new.project_id) then
    raise exception 'That step is not in this project' using errcode = '23503';
  end if;
  if new.blocks_step_id is not null and not exists (
       select 1 from public.research_steps s where s.id = new.blocks_step_id and s.project_id = new.project_id) then
    raise exception 'The blocked step is not in this project' using errcode = '23503';
  end if;

  new.kind := case when new.step_id is null then 'park' else 'todo' end;

  if tg_op = 'INSERT' then
    new.origin := public.research_caller();
    new.created_as := new.kind;
  elsif new.origin is distinct from old.origin or new.created_as is distinct from old.created_as then
    raise exception 'Who raised an item, and as what, cannot be changed' using errcode = '42501';
  end if;

  if new.status in ('done', 'dropped') and (tg_op = 'INSERT' or old.status is distinct from new.status) then
    new.closed_at := now();
  elsif new.status = 'open' then
    new.closed_at := null;
  end if;
  return new;
end;
$$;

drop trigger if exists research_items_guard on public.research_items;
create trigger research_items_guard
  before insert or update on public.research_items
  for each row execute function public.research_items_guard();

-- ------------------------------------------------------ message rules
--
-- The author is whoever wrote it. A connected app may update only read_at,
-- and only on Arthur's messages ("marked read once acted on").

create or replace function public.research_messages_guard()
returns trigger
language plpgsql
as $$
declare
  claude boolean := public.is_oauth_client();
begin
  if tg_op = 'INSERT' then
    if not exists (select 1 from public.research_projects p where p.id = new.project_id and p.user_id = new.user_id) then
      raise exception 'Unknown project' using errcode = '23503';
    end if;
    new.author := public.research_caller();
    if claude then
      if new.surface not in ('claude_code', 'claude_ai') then
        raise exception 'Claude writes from claude_code or claude_ai' using errcode = '42501';
      end if;
      new.read_at := null;
      new.pushed_at := null;
    else
      new.surface := 'app';
    end if;
  else
    if new.author is distinct from old.author then
      raise exception 'Who wrote a message cannot be changed' using errcode = '42501';
    end if;
    if claude then
      if old.author <> 'arthur' and new.read_at is distinct from old.read_at then
        raise exception 'Claude marks only Arthur''s messages as read' using errcode = '42501';
      end if;
      if new.project_id is distinct from old.project_id
        or new.step_id    is distinct from old.step_id
        or new.kind       is distinct from old.kind
        or new.body       is distinct from old.body
        or new.surface    is distinct from old.surface
        or new.pushed_at  is distinct from old.pushed_at
        or new.created_at is distinct from old.created_at then
        raise exception 'Claude may only mark a message as read' using errcode = '42501';
      end if;
    end if;
  end if;

  if new.step_id is not null and not exists (
       select 1 from public.research_steps s where s.id = new.step_id and s.project_id = new.project_id) then
    raise exception 'That step is not in this project' using errcode = '23503';
  end if;
  return new;
end;
$$;

drop trigger if exists research_messages_guard on public.research_messages;
create trigger research_messages_guard
  before insert or update on public.research_messages
  for each row execute function public.research_messages_guard();

-- ------------------------------------------------------------- totals

create or replace view public.research_step_totals
with (security_invoker = true) as
select
  s.id                                                                as step_id,
  s.project_id,
  s.user_id,
  coalesce(sum(w.minutes), 0)::int                                    as spent,
  coalesce(sum(w.minutes) filter (where w.source = 'claude_code'), 0)::int as claude_code,
  coalesce(sum(w.minutes) filter (where w.source = 'claude_ai'), 0)::int   as claude_ai,
  coalesce(sum(w.minutes) filter (where w.source = 'app'), 0)::int         as app,
  coalesce(sum(w.minutes) filter (where w.source = 'reported'), 0)::int    as reported
from public.research_steps s
left join public.research_work w on w.step_id = s.id
group by s.id, s.project_id, s.user_id;

-- ------------------------------------------------------ open and close
--
-- One transaction each, so a close-and-open-next never leaves the project
-- with nothing open half-way, and the step_closed message is never missing.
-- Security invoker: RLS and every rule above apply to the caller.

create or replace function public.research_open_step(p_step uuid)
returns void
language plpgsql
as $$
declare
  s record;
  other record;
begin
  select id, project_id, code, status into s from public.research_steps where id = p_step;
  if not found then
    raise exception 'Unknown step';
  end if;
  if s.status = 'open' then
    return;
  end if;
  select code, title into other
    from public.research_steps
   where project_id = s.project_id and status = 'open' and id <> p_step;
  if found then
    raise exception 'Step % (%) is open: close it before opening %', other.code, other.title, s.code;
  end if;
  update public.research_steps set status = 'open' where id = p_step;
end;
$$;

create or replace function public.research_close_step(
  p_step      uuid,
  p_outcome   text,
  p_note      text,
  p_next_step uuid default null,
  p_surface   text default null
)
returns jsonb
language plpgsql
as $$
declare
  s record;
  spent int;
  ratio numeric;
  body text;
begin
  if p_outcome not in ('done', 'cut') then
    raise exception 'A step closes as done or cut';
  end if;
  if p_note is null or length(trim(p_note)) = 0 then
    raise exception 'Say in one line how the step ended';
  end if;

  select id, project_id, user_id, code, title, status, budget_minutes into s
    from public.research_steps where id = p_step;
  if not found then
    raise exception 'Unknown step';
  end if;
  if s.status <> 'open' then
    raise exception 'Step % is %, not open', s.code, s.status;
  end if;

  update public.research_steps
     set status = p_outcome, close_note = left(trim(p_note), 1000)
   where id = p_step;

  select coalesce(sum(minutes), 0) into spent from public.research_work where step_id = p_step;
  ratio := round(spent::numeric / s.budget_minutes, 2);

  body := s.code || ' ' || s.title || ' — ' || case p_outcome when 'done' then 'done' else 'cut' end
       || ' · ' || public.research_fmt_minutes(spent) || ' / ' || public.research_fmt_minutes(s.budget_minutes)
       || ' · ratio ' || to_char(ratio, 'FM990.00') || E'\n\n' || trim(p_note);

  insert into public.research_messages (user_id, project_id, step_id, kind, body, surface)
  values (s.user_id, s.project_id, s.id, 'step_closed', left(body, 4000),
          coalesce(p_surface, case when public.is_oauth_client() then 'claude_ai' else 'app' end));

  if p_next_step is not null then
    perform public.research_open_step(p_next_step);
  end if;

  return jsonb_build_object('spent', spent, 'budget', s.budget_minutes, 'ratio', ratio);
end;
$$;

revoke execute on function public.research_open_step(uuid) from public, anon;
revoke execute on function public.research_close_step(uuid, text, text, uuid, text) from public, anon;
grant execute on function public.research_open_step(uuid) to authenticated;
grant execute on function public.research_close_step(uuid, text, text, uuid, text) to authenticated;

-- ------------------------------------------------------------------- RLS

alter table public.research_projects enable row level security;
alter table public.research_steps    enable row level security;
alter table public.research_work     enable row level security;
alter table public.research_items    enable row level security;
alter table public.research_messages enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array[
    'research_projects', 'research_steps', 'research_work', 'research_items', 'research_messages'
  ] loop
    execute format('drop policy if exists "own rows" on public.%I', t);
    execute format(
      'create policy "own rows" on public.%I
         for all to authenticated
         using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id)',
      t);

    -- What Claude may touch: no deletes anywhere (drop instead). The rest of
    -- the rules are column- and transition-level, so they live in the
    -- triggers above — RLS has no column rules, and column grants would bind
    -- the browser too, which shares the `authenticated` role.
    execute format('drop policy if exists "oauth clients cannot delete" on public.%I', t);
    execute format(
      'create policy "oauth clients cannot delete" on public.%I
         as restrictive for delete to authenticated
         using (not (select public.is_oauth_client()))',
      t);
  end loop;
end;
$$;
