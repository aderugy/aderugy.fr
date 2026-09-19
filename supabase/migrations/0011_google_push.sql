-- Push planned blocks to Google Calendar.
--
-- Until now the integration read Google and never wrote to it. This adds the
-- other direction, with one hard boundary: the app writes only to a calendar it
-- created itself ("Agenda"), under the `calendar.app.created` scope. That scope
-- cannot see or touch any other calendar, so a bug in the pusher can at worst
-- make a mess of its own calendar — never of your timetable.
--
-- The push is one-way. The plan is the source of truth and Google is a view of
-- it: an edit made to an Agenda event in Google is overwritten by the next push
-- of that block, and the Agenda calendar is never mirrored back in (that would
-- show every block twice).
--
-- Mechanics:
--   * every write to a block — or to anything its Google title is built from —
--     flips `scheduled_blocks.sync_state` back to 'pending', in triggers, so no
--     write path can forget to;
--   * deleting a pushed block leaves a tombstone, since the row that knew the
--     event id is gone by the time the pusher runs;
--   * the `google-push` Edge Function drains both, under a per-user lease.
--
-- The event id is derived from the block id (a uuid without dashes is valid
-- base32hex), so an insert that succeeded upstream but crashed before being
-- recorded here is recognised on retry instead of duplicated.

-- ------------------------------------------------------------ the account

alter table public.google_accounts
  add column if not exists push_enabled       boolean not null default false,
  add column if not exists push_calendar_id   text,
  add column if not exists push_locked_until  timestamptz,
  add column if not exists last_pushed_at     timestamptz,
  add column if not exists push_error         text,
  add column if not exists push_error_at      timestamptz;

comment on column public.google_accounts.push_calendar_id is
  'The secondary calendar the app created and writes blocks into. Never a '
  'calendar_sources row: mirroring it back would draw every block twice.';

-- ------------------------------------------------------------- the blocks

-- google_event_id, google_synced_at and sync_state have existed since 0001.
alter table public.scheduled_blocks
  add column if not exists push_attempts int not null default 0,
  add column if not exists push_error    text;

-- The pusher asks one question: what of mine is not in Google yet.
create index if not exists scheduled_blocks_push_idx
  on public.scheduled_blocks (user_id, sync_state)
  where sync_state <> 'synced';

-- ------------------------------------------------------------ tombstones

create table if not exists public.google_push_tombstones (
  user_id          uuid not null references auth.users (id) on delete cascade,
  google_event_id  text not null,
  created_at       timestamptz not null default now(),
  primary key (user_id, google_event_id)
);

alter table public.google_push_tombstones enable row level security;
-- No policy: written by a security-definer trigger, drained by the service role.

-- ------------------------------------------------- marking blocks pending

-- Any change to what the Google event shows puts the block back in the queue.
-- A write that touches only the push bookkeeping does not, or marking a block
-- synced would immediately mark it pending again.
create or replace function public.push_mark_block_pending()
returns trigger
language plpgsql
as $$
begin
  if new.starts_at       is distinct from old.starts_at
  or new.ends_at         is distinct from old.ends_at
  or new.description     is distinct from old.description
  or new.status          is distinct from old.status
  or new.source_block_id is distinct from old.source_block_id then
    new.sync_state    := 'pending';
    new.push_attempts := 0;
    new.push_error    := null;
  end if;
  return new;
end;
$$;

drop trigger if exists scheduled_blocks_push_pending on public.scheduled_blocks;
create trigger scheduled_blocks_push_pending
  before update on public.scheduled_blocks
  for each row execute function public.push_mark_block_pending();

-- The event title and body list the block's tasks, so the tasks, their links,
-- the categories naming them and the template naming the block all count.
-- Deliberately unconditional, even for a block already pending: the write bumps
-- updated_at, and that is how a push already in flight with the old title
-- learns not to mark the block synced.
create or replace function public.push_touch_blocks(p_block_ids uuid[])
returns void
language sql
as $$
  update public.scheduled_blocks
     set sync_state = 'pending', push_attempts = 0, push_error = null
   where id = any(p_block_ids);
$$;


create or replace function public.push_on_block_task_change()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    perform public.push_touch_blocks(array[old.scheduled_block_id]);
  else
    perform public.push_touch_blocks(array[new.scheduled_block_id]);
  end if;
  return null;
end;
$$;

drop trigger if exists scheduled_block_tasks_push on public.scheduled_block_tasks;
create trigger scheduled_block_tasks_push
  after insert or update or delete on public.scheduled_block_tasks
  for each row execute function public.push_on_block_task_change();

create or replace function public.push_on_task_change()
returns trigger
language plpgsql
as $$
begin
  if new.description is distinct from old.description
  or new.category_id is distinct from old.category_id then
    perform public.push_touch_blocks(array(
      select scheduled_block_id from public.scheduled_block_tasks
       where task_id = new.id));
  end if;
  return null;
end;
$$;

drop trigger if exists tasks_push on public.tasks;
create trigger tasks_push
  after update on public.tasks
  for each row execute function public.push_on_task_change();

create or replace function public.push_on_category_rename()
returns trigger
language plpgsql
as $$
begin
  if new.name is distinct from old.name then
    perform public.push_touch_blocks(array(
      select l.scheduled_block_id
        from public.scheduled_block_tasks l
        join public.tasks t on t.id = l.task_id
       where t.category_id = new.id));
  end if;
  return null;
end;
$$;

drop trigger if exists categories_push on public.categories;
create trigger categories_push
  after update on public.categories
  for each row execute function public.push_on_category_rename();

create or replace function public.push_on_template_rename()
returns trigger
language plpgsql
as $$
begin
  if new.name is distinct from old.name then
    perform public.push_touch_blocks(array(
      select id from public.scheduled_blocks where source_block_id = new.id));
  end if;
  return null;
end;
$$;

drop trigger if exists blocks_push on public.blocks;
create trigger blocks_push
  after update on public.blocks
  for each row execute function public.push_on_template_rename();

-- -------------------------------------------------------- deleting blocks

-- Security definer: the owner has no write access to tombstones, and must not.
-- Recorded whenever push is on, not only when an event id was stored — the id
-- is deterministic, so a block whose insert landed upstream but was never
-- acknowledged here still gets cleaned up. Deleting an event that does not
-- exist is a 404 the pusher ignores.
create or replace function public.push_on_block_delete()
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

drop trigger if exists scheduled_blocks_push_delete on public.scheduled_blocks;
create trigger scheduled_blocks_push_delete
  after delete on public.scheduled_blocks
  for each row execute function public.push_on_block_delete();

-- ------------------------------------------------------------------ lease

-- Same reasoning as the sync lease in 0002: a row lease survives a crashed
-- worker and does not depend on the pooler keeping a session.
create or replace function public.claim_push(p_user uuid, p_lease_seconds int default 120)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed boolean;
begin
  update public.google_accounts
     set push_locked_until = now() + make_interval(secs => p_lease_seconds)
   where user_id = p_user
     and push_enabled
     and disconnected_at is null
     and (push_locked_until is null or push_locked_until < now())
  returning true into claimed;
  return coalesce(claimed, false);
end;
$$;

create or replace function public.release_push(p_user uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.google_accounts set push_locked_until = null where user_id = p_user;
$$;

-- Users with something to push: pending or retryable blocks, or tombstones.
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
       exists (select 1 from public.scheduled_blocks b
                where b.user_id = a.user_id
                  and (b.sync_state = 'pending'
                       or (b.sync_state = 'failed' and b.push_attempts < p_max_attempts)))
       or exists (select 1 from public.google_push_tombstones t
                   where t.user_id = a.user_id)
     );
$$;

revoke execute on function public.claim_push(uuid, int)       from public, authenticated, anon;
revoke execute on function public.release_push(uuid)          from public, authenticated, anon;
revoke execute on function public.users_due_for_push(int)     from public, authenticated, anon;

-- ------------------------------------------------ what the settings page reads

-- Counts only, so the page can say "3 waiting, 1 failing" without exposing the
-- per-block bookkeeping as a thing to render.
create or replace view public.push_status
with (security_invoker = true)
as
select
  b.user_id,
  count(*) filter (where b.sync_state = 'pending')::int as pending,
  count(*) filter (where b.sync_state = 'failed')::int  as failed,
  count(*) filter (where b.sync_state = 'synced')::int  as synced,
  (array_agg(b.push_error order by b.updated_at desc)
     filter (where b.sync_state = 'failed'))[1]         as last_block_error
from public.scheduled_blocks b
group by b.user_id;
