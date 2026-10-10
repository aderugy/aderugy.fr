-- Blocks go away; a task carries its own time on the grid (phase 1 of 3).
--
-- The model:
--   * a session is one task at one time span — the slot it was planned in.
--     It has no contents of its own and is drawn on the grid as the task;
--   * a task has at most one planned session at a time. Skipping it keeps the
--     row (status 'skipped'), so the attempt stays in the task's history, and
--     the task goes back to the backlog; rescheduling skips the old session
--     and plans a new one. A planned session whose time has passed is
--     "missed": computed when read, never stored;
--   * the task's status follows its sessions (trigger below): 'scheduled'
--     while one is planned, 'backlog' otherwise, 'done' when one is done.
--     'done' and 'dropped' set on the task itself are left alone.
--
-- This migration only ADDS. Blocks, their tasks, templates, their triggers and
-- the functions the current app calls are untouched, except two that become
-- supersets and keep working for both: `users_due_for_push` (the cron calls it
-- by name) and `category_usage`. Phase 2 deploys the code that reads sessions;
-- phase 3 (0024) drops the blocks.
--
-- Google: the event id is derived from the row id (see push-events.ts), so a
-- session that takes over a block reuses the block's id and its Google event
-- is updated in place, not recreated. Every session starts 'pending' so the
-- new pusher rewrites the titles once.
--
-- Backfill rules (decided 2026-10-08):
--   * one-task block      → one session, same id, same span;
--   * multi-task block    → one session per task, back to back in block order,
--                           each as long as its planned minutes; the first one
--                           keeps the block's id (and its Google event);
--   * empty block         → not carried over (its event goes in 0024);
--   * block done          → session done, task done;
--   * block skipped       → session skipped, task back to the backlog;
--   * block planned, over → a backlog task: session skipped, back to the
--                           backlog; a task made on the grid: session done,
--                           task done;
--   * block planned, to come → session planned, task scheduled (skipped if
--                           the task was dropped).
--
-- Re-runnable: the backfill only inserts sessions for blocks not carried over.

-- ---------------------------------------------------------------- table

create table if not exists public.task_sessions (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users (id) on delete cascade,
  task_id          uuid not null references public.tasks (id) on delete cascade,
  -- Kept so the week's theme and objectives stay keyed the same way, and so
  -- RLS can check the week is yours, exactly as blocks did.
  week_id          uuid not null references public.weeks (id) on delete cascade,
  starts_at        timestamptz not null,
  ends_at          timestamptz not null,
  status           text not null default 'planned'
                     check (status in ('planned', 'done', 'skipped')),
  created_by       text not null default 'app'
                     check (created_by in ('app', 'claude')),
  google_event_id  text,
  google_synced_at timestamptz,
  sync_state       text not null default 'pending'
                     check (sync_state in ('pending', 'synced', 'failed')),
  push_attempts    int not null default 0,
  push_error       text,
  -- Where the row came from, for checking the backfill. Dropped in 0024.
  legacy_block_id  uuid,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  check (ends_at > starts_at)
);

create index if not exists task_sessions_task_idx  on public.task_sessions (task_id);
create index if not exists task_sessions_week_idx  on public.task_sessions (week_id);
create index if not exists task_sessions_range_idx on public.task_sessions (user_id, starts_at);
create index if not exists task_sessions_push_idx
  on public.task_sessions (user_id, sync_state)
  where sync_state <> 'synced';
create index if not exists task_sessions_planned_starts_idx
  on public.task_sessions (starts_at)
  where status = 'planned';
-- One live slot per task. Rescheduling skips the old one before planning the
-- next (see reschedule_session), so this never gets in the way.
create unique index if not exists task_sessions_one_planned_idx
  on public.task_sessions (task_id)
  where status = 'planned';

comment on table public.task_sessions is
  'A task placed on the week grid: one task, one time span. Skipped sessions are kept as the task''s history.';

-- ------------------------------------------------------------- backfill

do $$
declare
  cutoff timestamptz := now();
begin
  with links as (
    select
      sb.id            as block_id,
      sb.user_id,
      sb.week_id,
      sb.starts_at     as block_starts,
      sb.ends_at       as block_ends,
      sb.status        as block_status,
      sb.created_by,
      sb.google_event_id,
      sb.google_synced_at,
      l.task_id,
      t.ad_hoc,
      t.status         as task_status,
      greatest(l.planned_minutes, 5) as minutes,
      row_number() over (
        partition by sb.id order by l.position, l.task_id
      ) as rn,
      count(*) over (partition by sb.id) as n,
      coalesce(sum(greatest(l.planned_minutes, 5)) over (
        partition by sb.id order by l.position, l.task_id
        rows between unbounded preceding and 1 preceding
      ), 0) as offset_minutes
    from public.scheduled_blocks sb
    join public.scheduled_block_tasks l on l.scheduled_block_id = sb.id
    join public.tasks t on t.id = l.task_id
    where not exists (
      select 1 from public.task_sessions s where s.legacy_block_id = sb.id
    )
  ),
  placed as (
    select
      links.*,
      case when n = 1 then block_starts
           else block_starts + make_interval(mins => offset_minutes::int) end as s_starts,
      case when n = 1 then block_ends
           else block_starts + make_interval(mins => (offset_minutes + minutes)::int) end as s_ends
    from links
  )
  insert into public.task_sessions (
    id, user_id, task_id, week_id, starts_at, ends_at, status, created_by,
    google_event_id, google_synced_at, sync_state, legacy_block_id
  )
  select
    case when rn = 1 then block_id else gen_random_uuid() end,
    user_id,
    task_id,
    week_id,
    s_starts,
    s_ends,
    case
      when block_status = 'done'    then 'done'
      when block_status = 'skipped' then 'skipped'
      when s_ends <= cutoff and ad_hoc     then 'done'
      when s_ends <= cutoff and not ad_hoc then 'skipped'
      -- A dropped task does not stay on the grid.
      when task_status = 'dropped'         then 'skipped'
      else 'planned'
    end,
    created_by,
    case when rn = 1 then google_event_id end,
    case when rn = 1 then google_synced_at end,
    'pending',
    block_id
  from placed;

  -- The task's status from its sessions, by the rules above. 'dropped' stays.
  update public.tasks t
     set status = case
           when exists (select 1 from public.task_sessions s
                         where s.task_id = t.id and s.status = 'done') then 'done'
           when exists (select 1 from public.task_sessions s
                         where s.task_id = t.id and s.status = 'planned') then 'scheduled'
           else 'backlog'
         end,
         completed_at = case
           when exists (select 1 from public.task_sessions s
                         where s.task_id = t.id and s.status = 'done')
             then coalesce(t.completed_at, (select max(s.ends_at) from public.task_sessions s
                                             where s.task_id = t.id and s.status = 'done'))
           else null
         end
   where t.status <> 'dropped'
     and exists (select 1 from public.task_sessions s where s.task_id = t.id);
end $$;

-- Reminders already sent for a block stay sent for the session that took it over.
create table if not exists public.session_reminders_sent (
  session_id uuid primary key references public.task_sessions (id) on delete cascade,
  user_id    uuid not null references auth.users (id) on delete cascade,
  starts_at  timestamptz not null,
  sent_at    timestamptz not null default now()
);
alter table public.session_reminders_sent enable row level security;

insert into public.session_reminders_sent (session_id, user_id, starts_at, sent_at)
select r.scheduled_block_id, r.user_id, r.starts_at, r.sent_at
  from public.block_reminders_sent r
  join public.task_sessions s on s.id = r.scheduled_block_id
on conflict (session_id) do nothing;

-- Interviews follow their session instead of their block.
alter table public.interviews
  add column if not exists session_id uuid unique
    references public.task_sessions (id) on delete set null;

update public.interviews i
   set session_id = i.scheduled_block_id
 where i.session_id is null
   and i.scheduled_block_id is not null
   and exists (select 1 from public.task_sessions s where s.id = i.scheduled_block_id);

-- --------------------------------------------------------------- triggers
-- Created after the backfill so they do not rewrite what it just set.

drop trigger if exists task_sessions_touch_updated_at on public.task_sessions;
create trigger task_sessions_touch_updated_at
  before update on public.task_sessions
  for each row execute function public.touch_updated_at();

-- Who placed it, from the token. Same rule as blocks (0019).
create or replace function public.task_sessions_created_by()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    new.created_by := case when public.is_oauth_client() then 'claude' else 'app' end;
  else
    new.created_by := old.created_by;
  end if;
  return new;
end;
$$;

drop trigger if exists task_sessions_created_by on public.task_sessions;
create trigger task_sessions_created_by
  before insert or update on public.task_sessions
  for each row execute function public.task_sessions_created_by();

-- The task's status follows its sessions.
create or replace function public.task_sessions_sync_task()
returns trigger
language plpgsql
as $$
declare
  v_task uuid := coalesce(new.task_id, old.task_id);
begin
  if tg_op <> 'DELETE' and new.status = 'done'
     and (tg_op = 'INSERT' or old.status is distinct from 'done') then
    update public.tasks
       set status = 'done', completed_at = coalesce(completed_at, now())
     where id = v_task and status <> 'done';
    return null;
  end if;

  -- Undoing a done session reopens the task, unless another session is done.
  if tg_op = 'UPDATE' and old.status = 'done' and new.status <> 'done' then
    update public.tasks t
       set status = 'backlog', completed_at = null
     where t.id = v_task
       and t.status = 'done'
       and not exists (select 1 from public.task_sessions s
                        where s.task_id = t.id and s.status = 'done');
  end if;

  update public.tasks t
     set status = case
           when exists (select 1 from public.task_sessions s
                         where s.task_id = t.id and s.status = 'planned') then 'scheduled'
           else 'backlog'
         end
   where t.id = v_task
     and t.status in ('backlog', 'scheduled');
  return null;
end;
$$;

drop trigger if exists task_sessions_sync_task on public.task_sessions;
create trigger task_sessions_sync_task
  after insert or update of status, task_id or delete on public.task_sessions
  for each row execute function public.task_sessions_sync_task();

-- An interview moves with its session.
create or replace function public.task_sessions_move_interview()
returns trigger
language plpgsql
as $$
begin
  if old.starts_at is distinct from new.starts_at
     or old.ends_at is distinct from new.ends_at then
    update public.interviews
       set starts_at = new.starts_at,
           ends_at   = new.ends_at
     where session_id = new.id
       and (starts_at is distinct from new.starts_at or ends_at is distinct from new.ends_at);
  end if;
  return null;
end;
$$;

drop trigger if exists task_sessions_move_interview on public.task_sessions;
create trigger task_sessions_move_interview
  after update of starts_at, ends_at on public.task_sessions
  for each row execute function public.task_sessions_move_interview();

-- Connected apps still may only write an interview's prep notes.
create or replace function public.interviews_oauth_prep_only()
returns trigger
language plpgsql
as $$
begin
  if public.is_oauth_client() and (
       new.application_id     is distinct from old.application_id
    or new.scheduled_block_id is distinct from old.scheduled_block_id
    or new.session_id         is distinct from old.session_id
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

-- ------------------------------------------------------------ Google push
-- The same mechanics as blocks (0011), on sessions.

create or replace function public.push_mark_session_pending()
returns trigger
language plpgsql
as $$
begin
  if new.starts_at is distinct from old.starts_at
  or new.ends_at   is distinct from old.ends_at
  or new.status    is distinct from old.status
  or new.task_id   is distinct from old.task_id then
    new.sync_state    := 'pending';
    new.push_attempts := 0;
    new.push_error    := null;
  end if;
  return new;
end;
$$;

drop trigger if exists task_sessions_push_pending on public.task_sessions;
create trigger task_sessions_push_pending
  before update on public.task_sessions
  for each row execute function public.push_mark_session_pending();

create or replace function public.push_touch_sessions(p_session_ids uuid[])
returns void
language sql
as $$
  update public.task_sessions
     set sync_state = 'pending', push_attempts = 0, push_error = null
   where id = any(p_session_ids);
$$;

-- The event shows the task's category, description and notes.
create or replace function public.push_sessions_on_task_change()
returns trigger
language plpgsql
as $$
begin
  if new.description is distinct from old.description
  or new.notes       is distinct from old.notes
  or new.category_id is distinct from old.category_id then
    perform public.push_touch_sessions(array(
      select id from public.task_sessions where task_id = new.id));
  end if;
  return null;
end;
$$;

drop trigger if exists tasks_push_sessions on public.tasks;
create trigger tasks_push_sessions
  after update on public.tasks
  for each row execute function public.push_sessions_on_task_change();

create or replace function public.push_sessions_on_category_rename()
returns trigger
language plpgsql
as $$
begin
  if new.name is distinct from old.name then
    perform public.push_touch_sessions(array(
      select s.id
        from public.task_sessions s
        join public.tasks t on t.id = s.task_id
       where t.category_id = new.id));
  end if;
  return null;
end;
$$;

drop trigger if exists categories_push_sessions on public.categories;
create trigger categories_push_sessions
  after update on public.categories
  for each row execute function public.push_sessions_on_category_rename();

create or replace function public.push_on_session_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.google_event_id is not null
     or exists (select 1 from public.google_accounts a
                 where a.user_id = old.user_id and a.push_enabled) then
    insert into public.google_push_tombstones (user_id, google_event_id)
    values (old.user_id, coalesce(old.google_event_id, replace(old.id::text, '-', '')))
    on conflict do nothing;
  end if;
  return old;
end;
$$;

drop trigger if exists task_sessions_push_delete on public.task_sessions;
create trigger task_sessions_push_delete
  after delete on public.task_sessions
  for each row execute function public.push_on_session_delete();

-- The cron calls this by name. Blocks stay in until 0024 so either pusher
-- version finds its work during the switch.
create or replace function public.users_due_for_push(p_max_attempts int default 8)
returns table (user_id uuid)
language sql
security definer
set search_path = public
as $$
  select a.user_id
    from public.google_accounts a
   where a.push_enabled
     and a.disconnected_at is null
     and (a.push_locked_until is null or a.push_locked_until < now())
     and (
       exists (select 1 from public.task_sessions s
                where s.user_id = a.user_id
                  and (s.sync_state = 'pending'
                       or (s.sync_state = 'failed' and s.push_attempts < p_max_attempts)))
       or exists (select 1 from public.scheduled_blocks b
                   where b.user_id = a.user_id
                     and (b.sync_state = 'pending'
                          or (b.sync_state = 'failed' and b.push_attempts < p_max_attempts)))
       or exists (select 1 from public.google_push_tombstones t
                   where t.user_id = a.user_id)
     );
$$;
revoke execute on function public.users_due_for_push(int) from public, authenticated, anon;

create or replace view public.session_push_status
with (security_invoker = true)
as
select
  s.user_id,
  count(*) filter (where s.sync_state = 'pending')::int as pending,
  count(*) filter (where s.sync_state = 'failed')::int  as failed,
  count(*) filter (where s.sync_state = 'synced')::int  as synced,
  (array_agg(s.push_error order by s.updated_at desc)
     filter (where s.sync_state = 'failed'))[1]         as last_error
from public.task_sessions s
group by s.user_id;

-- ------------------------------------------------------------- reminders

create or replace function public.sessions_due_for_reminder(p_limit int default 200)
returns table (
  session_id   uuid,
  user_id      uuid,
  starts_at    timestamptz,
  ends_at      timestamptz,
  lead_minutes int
)
language sql
stable
security definer
set search_path = public
as $$
  select s.id, s.user_id, s.starts_at, s.ends_at, coalesce(p.lead_minutes, 10)
    from public.task_sessions s
    left join public.notification_prefs p on p.user_id = s.user_id
    left join public.session_reminders_sent r on r.session_id = s.id
   where s.status = 'planned'
     and coalesce(p.block_reminders, true)
     and s.starts_at > now()
     and s.starts_at <= now() + make_interval(mins => coalesce(p.lead_minutes, 10))
     and (r.session_id is null or r.starts_at is distinct from s.starts_at)
     and exists (select 1 from public.push_subscriptions d where d.user_id = s.user_id)
   order by s.starts_at
   limit p_limit;
$$;
revoke execute on function public.sessions_due_for_reminder(int) from public, authenticated, anon;

-- --------------------------------------------------------------- reading

-- Per task: its live session (if any) and its history, in one call.
create or replace function public.task_session_summary(p_task_ids uuid[])
returns table (
  task_id        uuid,
  planned_id     uuid,
  planned_starts timestamptz,
  planned_ends   timestamptz,
  done_count     int,
  skipped_count  int,
  last_skipped   timestamptz
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    s.task_id,
    (array_agg(s.id order by s.starts_at) filter (where s.status = 'planned'))[1],
    min(s.starts_at) filter (where s.status = 'planned'),
    min(s.ends_at)   filter (where s.status = 'planned'),
    (count(*) filter (where s.status = 'done'))::int,
    (count(*) filter (where s.status = 'skipped'))::int,
    max(s.starts_at) filter (where s.status = 'skipped')
  from public.task_sessions s
  where s.task_id = any(p_task_ids)
  group by s.task_id;
$$;
grant execute on function public.task_session_summary(uuid[]) to authenticated;

-- What a category is used by. "scheduled" now counts sessions, which is what
-- blocks holding its tasks amounted to; templates stay until 0024.
create or replace function public.category_usage(p_id uuid)
returns table (tasks bigint, scheduled bigint, templates bigint, descendants bigint)
language sql
stable
security invoker
set search_path = public
as $$
  with recursive subtree as (
    select id, user_id from public.categories
     where id = p_id and user_id = auth.uid()
    union all
    select c.id, c.user_id
      from public.categories c
      join subtree s on c.parent_id = s.id
  )
  select
    (select count(*) from public.tasks t
      where t.category_id in (select id from subtree) and t.status <> 'dropped'),
    (select count(*)
       from public.task_sessions s
       join public.tasks t on t.id = s.task_id
      where t.category_id in (select id from subtree)),
    (select count(*) from public.blocks b
      where b.default_category_id in (select id from subtree)),
    (select greatest(count(*) - 1, 0) from subtree);
$$;
grant execute on function public.category_usage(uuid) to authenticated;

-- --------------------------------------------------------------- writing

-- Skip a session and plan the task again elsewhere, in one transaction, so
-- the task is never left without its trace or with two live slots.
-- `p_week_id` comes from the app's ensureWeek, as for any new session.
create or replace function public.reschedule_session(
  p_session_id uuid,
  p_week_id    uuid,
  p_starts_at  timestamptz,
  p_ends_at    timestamptz
)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_old     public.task_sessions;
  v_new     uuid;
  v_skipped int;
begin
  select * into v_old from public.task_sessions where id = p_session_id;
  if not found then
    raise exception 'No such session' using errcode = 'P0002';
  end if;

  -- A past attempt already skipped or done is only planned again.
  if v_old.status = 'planned' then
    update public.task_sessions set status = 'skipped'
     where id = p_session_id and status = 'planned';
    get diagnostics v_skipped = row_count;
    -- RLS hid the row from the update: the connector rescheduling your session.
    if v_skipped = 0 then
      raise exception 'Only the sessions you placed can be rescheduled'
        using errcode = '42501';
    end if;
  end if;

  insert into public.task_sessions (user_id, task_id, week_id, starts_at, ends_at)
  values (v_old.user_id, v_old.task_id, p_week_id, p_starts_at, p_ends_at)
  returning id into v_new;

  return v_new;
end;
$$;
grant execute on function public.reschedule_session(uuid, uuid, timestamptz, timestamptz) to authenticated;

-- -------------------------------------------------------------------- RLS
-- The same rules as blocks (0001, 0019): your rows, in your week, on your
-- task; the connector may add sessions but change or delete only its own.

alter table public.task_sessions enable row level security;

drop policy if exists "own rows" on public.task_sessions;
create policy "own rows" on public.task_sessions
  for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own week and task" on public.task_sessions;
create policy "own week and task" on public.task_sessions
  as restrictive for all to authenticated
  using (true)
  with check (
    exists (select 1 from public.weeks w where w.id = week_id and w.user_id = auth.uid())
    and exists (select 1 from public.tasks t where t.id = task_id and t.user_id = auth.uid())
  );

drop policy if exists "oauth clients change their own sessions" on public.task_sessions;
create policy "oauth clients change their own sessions" on public.task_sessions
  as restrictive for update to authenticated
  using (not (select public.is_oauth_client()) or created_by = 'claude')
  with check (not (select public.is_oauth_client()) or created_by = 'claude');

drop policy if exists "oauth clients delete their own sessions" on public.task_sessions;
create policy "oauth clients delete their own sessions" on public.task_sessions
  as restrictive for delete to authenticated
  using (not (select public.is_oauth_client()) or created_by = 'claude');

-- --------------------------------------------------------------- checks
-- Read-only, to run after applying. Expected on 2026-10-08: 144 blocks with
-- tasks carried over as 162 sessions (135 one-task blocks + the 27 tasks of
-- the 9 multi-task blocks), and 0 rows from the last query.
--
--   select count(distinct legacy_block_id) as blocks_carried, count(*) as sessions,
--          count(*) filter (where status = 'planned') as planned,
--          count(*) filter (where status = 'done')    as done,
--          count(*) filter (where status = 'skipped') as skipped
--     from task_sessions;
--
--   select t.status, count(*) from tasks t
--    where exists (select 1 from task_sessions s where s.task_id = t.id)
--    group by 1;
--
--   -- every block with tasks has a session that kept its id:
--   select sb.id from scheduled_blocks sb
--    where exists (select 1 from scheduled_block_tasks l where l.scheduled_block_id = sb.id)
--      and not exists (select 1 from task_sessions s where s.id = sb.id);
