-- Google Calendar, read-only.
--
-- Nothing here is written by the browser. The sync engine runs as Edge
-- Functions with the service role; the owner may read its own rows so the
-- settings page can show sync health, and that is all.

-- ----------------------------------------------------------- linked account

create table public.google_accounts (
  user_id                uuid primary key references auth.users (id) on delete cascade,
  google_email           text,
  -- Vault secret id. The refresh token itself never lives in a column.
  refresh_token_secret   uuid not null,
  scopes                 text[] not null default '{}',
  busy_calendar_ids      text[] not null default '{}',
  connected_at           timestamptz not null default now(),
  disconnected_at        timestamptz,
  last_error             text,
  last_error_at          timestamptz
);

-- --------------------------------------------------------------- sync state

create table public.google_sync_state (
  user_id             uuid not null references auth.users (id) on delete cascade,
  google_calendar_id  text not null,
  summary             text,
  sync_token          text,
  -- A lease, not an advisory lock: the connection pooler does not guarantee the
  -- same session across calls, so a session-scoped lock cannot be released
  -- reliably. A row lease survives a crashed worker by simply expiring.
  locked_until        timestamptz,
  last_synced_at      timestamptz,
  last_error          text,
  last_error_at       timestamptz,
  full_resync_needed  boolean not null default false,
  primary key (user_id, google_calendar_id)
);

-- ---------------------------------------------------------- watch channels

create table public.google_sync_channels (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users (id) on delete cascade,
  google_calendar_id text not null,
  channel_id         text not null unique,
  resource_id        text not null,
  channel_token      text not null,
  expiration         timestamptz not null,
  created_at         timestamptz not null default now()
);

create index google_sync_channels_expiry_idx on public.google_sync_channels (expiration);

-- ------------------------------------------------------------ busy mirror

create table public.external_events (
  user_id            uuid not null references auth.users (id) on delete cascade,
  google_calendar_id text not null,
  google_event_id    text not null,
  title              text,
  starts_at          timestamptz not null,
  ends_at            timestamptz not null,
  all_day            boolean not null default false,
  status             text not null default 'confirmed',
  -- 'transparent' means the event does not block time in Google. Honouring it
  -- is the difference between a real busy overlay and a wall of noise.
  transparency       text not null default 'opaque',
  attendee_response  text,
  updated_at         timestamptz not null default now(),
  primary key (user_id, google_calendar_id, google_event_id)
);

create index external_events_range_idx
  on public.external_events (user_id, starts_at);

-- ----------------------------------------------------------------------- RLS

alter table public.google_accounts       enable row level security;
alter table public.google_sync_state     enable row level security;
alter table public.google_sync_channels  enable row level security;
alter table public.external_events       enable row level security;

-- Read-only for the owner. No insert/update/delete policy exists for
-- `authenticated`, so those are denied; the service role bypasses RLS.
create policy "owner reads" on public.google_accounts
  for select to authenticated using (auth.uid() = user_id);

create policy "owner reads" on public.google_sync_state
  for select to authenticated using (auth.uid() = user_id);

create policy "owner reads" on public.external_events
  for select to authenticated using (auth.uid() = user_id);

-- Channel tokens are shared secrets with Google: not even the owner reads them.
-- No policy at all means no access for `authenticated`.

-- ------------------------------------------------------------------- leases

create or replace function public.claim_calendar_sync(
  p_user uuid,
  p_calendar text,
  p_lease_seconds int default 120
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed boolean;
begin
  update public.google_sync_state
     set locked_until = now() + make_interval(secs => p_lease_seconds)
   where user_id = p_user
     and google_calendar_id = p_calendar
     and (locked_until is null or locked_until < now())
  returning true into claimed;

  return coalesce(claimed, false);
end;
$$;

create or replace function public.release_calendar_sync(
  p_user uuid,
  p_calendar text
)
returns void
language sql
security definer
set search_path = public
as $$
  update public.google_sync_state
     set locked_until = null
   where user_id = p_user and google_calendar_id = p_calendar;
$$;

-- Only the sync engine may take leases.
revoke execute on function public.claim_calendar_sync(uuid, text, int) from public, authenticated, anon;
revoke execute on function public.release_calendar_sync(uuid, text) from public, authenticated, anon;

-- ------------------------------------------------------- what needs syncing

-- One query the cron can act on: calendars that asked for a sync, are overdue,
-- or need a full rebuild. Leased rows are excluded so a running worker is not
-- duplicated.
create or replace function public.calendars_due_for_sync(p_max_age_seconds int default 300)
returns table (user_id uuid, google_calendar_id text)
language sql
security definer
set search_path = public
as $$
  select s.user_id, s.google_calendar_id
    from public.google_sync_state s
    join public.google_accounts a on a.user_id = s.user_id
   where a.disconnected_at is null
     and (s.locked_until is null or s.locked_until < now())
     and (
       s.last_synced_at is null
       or s.full_resync_needed
       or s.last_synced_at < now() - make_interval(secs => p_max_age_seconds)
     );
$$;

revoke execute on function public.calendars_due_for_sync(int) from public, authenticated, anon;

-- --------------------------------------------------- owner-writable settings

-- The only write the browser is allowed: which calendars count as busy.
create or replace function public.set_busy_calendars(p_ids text[])
returns void
language sql
security definer
set search_path = public
as $$
  update public.google_accounts
     set busy_calendar_ids = coalesce(p_ids, '{}')
   where user_id = auth.uid();
$$;

grant execute on function public.set_busy_calendars(text[]) to authenticated;

-- ------------------------------------------------------------------ realtime

-- Lets an open week view update itself when a sync writes. Guarded so the file
-- also applies to a plain Postgres without Supabase's publication.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.external_events;
  end if;
end $$;
