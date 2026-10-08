-- Push reminders before planned blocks (Web Push, to the installed app or a
-- browser tab with notifications allowed).
--
-- Mechanics:
--   * each device that opts in stores its push subscription here, one row per
--     browser — a phone and a laptop both ring;
--   * the `web-push` Edge Function, swept every minute by pg_cron, sends one
--     notification per planned block `lead_minutes` before it starts, then
--     records which start time it reminded for;
--   * the record is keyed on the start time, so moving a block makes it due
--     again with no trigger to keep in step; deleting the block deletes it.
--
-- Nothing here touches scheduled_blocks, on purpose: a write there bumps
-- updated_at, which the Google pusher reads as "changed while I was pushing".
--
-- Every statement is re-runnable, like 0007 onwards.

-- ------------------------------------------------------- subscriptions

create table if not exists public.push_subscriptions (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users (id) on delete cascade,
  endpoint        text not null check (endpoint ~ '^https://'),
  p256dh          text not null check (length(p256dh) between 80 and 100),
  auth            text not null check (length(auth) between 16 and 32),
  -- "Chrome on Windows" — so the settings page can tell devices apart.
  label           text check (length(label) <= 120),
  created_at      timestamptz not null default now(),
  last_success_at timestamptz,
  last_error      text,
  last_error_at   timestamptz,
  unique (user_id, endpoint)
);

create index if not exists push_subscriptions_user_idx on public.push_subscriptions (user_id);

alter table public.push_subscriptions enable row level security;

drop policy if exists "own rows" on public.push_subscriptions;
create policy "own rows" on public.push_subscriptions
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- Same rule as 0015: a connected app (the Claude connector) has no business
-- registering devices to ring.
drop policy if exists "no oauth clients" on public.push_subscriptions;
create policy "no oauth clients" on public.push_subscriptions
  as restrictive for all to authenticated
  using (not (select public.is_oauth_client()))
  with check (not (select public.is_oauth_client()));

-- ------------------------------------------------------------ preferences

-- No row means the defaults: on, 10 minutes before.
create table if not exists public.notification_prefs (
  user_id         uuid primary key references auth.users (id) on delete cascade,
  block_reminders boolean not null default true,
  lead_minutes    int not null default 10 check (lead_minutes between 0 and 120),
  updated_at      timestamptz not null default now()
);

alter table public.notification_prefs enable row level security;

drop policy if exists "own rows" on public.notification_prefs;
create policy "own rows" on public.notification_prefs
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists "no oauth clients" on public.notification_prefs;
create policy "no oauth clients" on public.notification_prefs
  as restrictive for all to authenticated
  using (not (select public.is_oauth_client()))
  with check (not (select public.is_oauth_client()));

-- ------------------------------------------------------ what was sent

create table if not exists public.block_reminders_sent (
  scheduled_block_id uuid primary key references public.scheduled_blocks (id) on delete cascade,
  user_id            uuid not null references auth.users (id) on delete cascade,
  -- The start time the reminder announced. A block moved since is due again.
  starts_at          timestamptz not null,
  sent_at            timestamptz not null default now()
);

alter table public.block_reminders_sent enable row level security;
-- No policy: written and read by the service role only.

-- --------------------------------------------------------- what is due

-- Planned blocks starting within their owner's lead time, not yet reminded for
-- this start time, for owners with at least one device. A block whose start
-- has passed is never due: a reminder after the fact is noise.
create or replace function public.blocks_due_for_reminder(p_limit int default 200)
returns table (
  scheduled_block_id uuid,
  user_id            uuid,
  starts_at          timestamptz,
  ends_at            timestamptz,
  lead_minutes       int
)
language sql
stable
security definer
set search_path = public
as $$
  select b.id, b.user_id, b.starts_at, b.ends_at, coalesce(p.lead_minutes, 10)
    from public.scheduled_blocks b
    left join public.notification_prefs p on p.user_id = b.user_id
    left join public.block_reminders_sent s on s.scheduled_block_id = b.id
   where b.status = 'planned'
     and coalesce(p.block_reminders, true)
     and b.starts_at > now()
     and b.starts_at <= now() + make_interval(mins => coalesce(p.lead_minutes, 10))
     and (s.scheduled_block_id is null or s.starts_at is distinct from b.starts_at)
     and exists (select 1 from public.push_subscriptions d where d.user_id = b.user_id)
   order by b.starts_at
   limit p_limit;
$$;

revoke execute on function public.blocks_due_for_reminder(int) from public, authenticated, anon;

-- The sweep hits blocks by start time across users.
create index if not exists scheduled_blocks_starts_idx
  on public.scheduled_blocks (starts_at)
  where status = 'planned';
