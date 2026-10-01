-- What a connected app may touch.
--
-- Supabase's OAuth 2.1 server lets Claude connect to /agenda through the MCP
-- endpoint at /api/mcp. The tokens it issues are ordinary user JWTs — same
-- `sub`, same `authenticated` role — plus a `client_id` claim. Anyone holding
-- one can call PostgREST directly, bypassing the MCP tools, so the tool list
-- is not a boundary. This migration is.
--
--   tasks                   full access to own rows (unchanged)
--   categories              read only
--   scheduled_block_tasks   read only (to tell a placed task from a free one)
--   everything else         nothing
--
-- Restrictive policies AND with the existing "own rows" policies, so a browser
-- session (no client_id) behaves exactly as before.
--
-- A new user table must be added to the deny list below, or deliberately left
-- out of it. "Everything except" would grant new tables silently; an explicit
-- list makes each one a decision.

create or replace function public.is_oauth_client()
returns boolean
language sql
stable
as $$
  select coalesce(auth.jwt() ->> 'client_id', '') <> '';
$$;

comment on function public.is_oauth_client() is
  'True when the request carries a token issued to an OAuth client (e.g. the Claude connector) rather than a first-party session.';

-- ------------------------------------------------------------- no access

do $$
declare
  t text;
begin
  foreach t in array array[
    'block_items',
    'blocks',
    'calendar_sources',
    'external_events',
    'google_accounts',
    'google_push_tombstones',
    'google_sync_channels',
    'google_sync_state',
    'maths_attempt',
    'maths_node_progress',
    'maths_review_log',
    'maths_review_state',
    'maths_session_log',
    'objectives',
    'poker_nodes',
    'poker_spots',
    'poker_strategies',
    'poker_trainer_answers',
    'poker_trainer_hands',
    'poker_trainer_nodes',
    'poker_trainer_sessions',
    'poker_trainers',
    'rake_profiles',
    'scheduled_blocks',
    'weeks'
  ] loop
    execute format('drop policy if exists "no oauth clients" on public.%I', t);
    execute format(
      'create policy "no oauth clients" on public.%I
         as restrictive for all to authenticated
         using (not (select public.is_oauth_client()))
         with check (not (select public.is_oauth_client()))',
      t);
  end loop;
end;
$$;

-- -------------------------------------------------------------- read only

do $$
declare
  t text;
begin
  foreach t in array array['categories', 'scheduled_block_tasks'] loop
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

-- -------------------------------------------- definer functions users call
--
-- Security-definer functions skip RLS, so the one the browser may call gets
-- the same rule in code. Body unchanged apart from the guard.

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
  if public.is_oauth_client() then
    raise exception 'Not available to connected apps' using errcode = '42501';
  end if;

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

-- ------------------------------------------- Google push stays consistent
--
-- Editing a placed task's description or category re-queues its blocks for
-- the Google push (0011). That trigger runs as the caller, and a connected app
-- may not write scheduled_blocks — so the update would match no rows and the
-- calendar would keep the old title. Run the one bookkeeping write as the
-- owner instead, still limited to the caller's own blocks.

create or replace function public.push_touch_blocks(p_block_ids uuid[])
returns void
language sql
security definer
set search_path = public
as $$
  update public.scheduled_blocks
     set sync_state = 'pending', push_attempts = 0, push_error = null
   where id = any(p_block_ids)
     -- A user (any token) only ever touches their own blocks. With no user —
     -- the service role or a migration — the trigger's own scope applies.
     and (auth.uid() is null or user_id = auth.uid());
$$;

-- Reachable over RPC like every public function. Harmless for a signed-in
-- user (own blocks, re-queued), but nobody anonymous should reach it.
revoke execute on function public.push_touch_blocks(uuid[]) from public, anon;
grant execute on function public.push_touch_blocks(uuid[]) to authenticated;
