-- The week grid, open to the Claude connector.
--
-- 0015 kept connected apps to the backlog: the grid, the week's intent, the
-- templates and the mirrored calendars were out of reach. This opens the
-- calendar side, with one rule for writes: Claude may plan its own blocks and
-- never touch Arthur's.
--
--   weeks                   read; create (a week row appears when a block lands
--                           in it); theme and guidelines stay Arthur's
--   objectives              read only
--   blocks, block_items     read only (the template library)
--   calendar_sources        read only
--   external_events         read only (no deleting archives)
--   scheduled_blocks        read all; create; move, edit, delete only the ones
--                           it created (created_by = 'claude')
--   scheduled_block_tasks   read all; add, change, remove tasks only inside the
--                           blocks it created
--   google_*                still nothing
--
-- Same model as 0015: the connector's tokens reach PostgREST directly, so
-- these policies are the boundary, not the MCP tool list.
--
-- Every statement is re-runnable, like 0007 onwards.

-- ------------------------------------------------- who created a block

alter table public.scheduled_blocks
  add column if not exists created_by text not null default 'app';

alter table public.scheduled_blocks
  drop constraint if exists scheduled_blocks_created_by_check;
alter table public.scheduled_blocks
  add constraint scheduled_blocks_created_by_check check (created_by in ('app', 'claude'));

comment on column public.scheduled_blocks.created_by is
  'Who put the block on the grid: Arthur in the app, or Claude through the '
  'connector. Set from the token on insert and never changed afterwards; a '
  'connected app may only change the blocks it created.';

-- From the token, never from the caller, and fixed for the block's life:
-- moving a block Claude planned does not make it Claude's to delete, nor
-- Arthur's to lose.
create or replace function public.scheduled_blocks_created_by()
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

drop trigger if exists scheduled_blocks_created_by on public.scheduled_blocks;
create trigger scheduled_blocks_created_by
  before insert or update on public.scheduled_blocks
  for each row execute function public.scheduled_blocks_created_by();

-- --------------------------------------------- lifting 0015's blanket ban

do $$
declare
  t text;
begin
  foreach t in array array[
    'weeks', 'objectives', 'blocks', 'block_items',
    'calendar_sources', 'external_events', 'scheduled_blocks'
  ] loop
    execute format('drop policy if exists "no oauth clients" on public.%I', t);
  end loop;
end;
$$;

-- ------------------------------------------------------------ read only

do $$
declare
  t text;
begin
  foreach t in array array['objectives', 'blocks', 'block_items', 'calendar_sources', 'external_events'] loop
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

-- ---------------------------------------------------------------- weeks

-- A block needs its week's row, created on first use. The week's intent is
-- Arthur's: a connected app creates the row bare and cannot edit or delete it.
drop policy if exists "oauth clients create bare weeks" on public.weeks;
create policy "oauth clients create bare weeks" on public.weeks
  as restrictive for insert to authenticated
  with check (not (select public.is_oauth_client()) or (theme is null and guidelines is null));

drop policy if exists "oauth clients cannot edit weeks" on public.weeks;
create policy "oauth clients cannot edit weeks" on public.weeks
  as restrictive for update to authenticated
  using (not (select public.is_oauth_client()))
  with check (not (select public.is_oauth_client()));

drop policy if exists "oauth clients cannot delete weeks" on public.weeks;
create policy "oauth clients cannot delete weeks" on public.weeks
  as restrictive for delete to authenticated
  using (not (select public.is_oauth_client()));

-- ----------------------------------------------------- scheduled blocks

-- Everyone: a block goes in one of the caller's own weeks. "own rows" checks
-- the block's user_id, not the week it points at.
drop policy if exists "own week" on public.scheduled_blocks;
create policy "own week" on public.scheduled_blocks
  as restrictive for all to authenticated
  using (true)
  with check (exists (select 1 from public.weeks w where w.id = week_id and w.user_id = auth.uid()));

drop policy if exists "oauth clients change their own blocks" on public.scheduled_blocks;
create policy "oauth clients change their own blocks" on public.scheduled_blocks
  as restrictive for update to authenticated
  using (not (select public.is_oauth_client()) or created_by = 'claude')
  with check (not (select public.is_oauth_client()) or created_by = 'claude');

drop policy if exists "oauth clients delete their own blocks" on public.scheduled_blocks;
create policy "oauth clients delete their own blocks" on public.scheduled_blocks
  as restrictive for delete to authenticated
  using (not (select public.is_oauth_client()) or created_by = 'claude');

-- ------------------------------------------------- tasks inside blocks

-- 0015 made the links read only for connected apps. They may now fill the
-- blocks they created, and still not touch the inside of Arthur's.
drop policy if exists "oauth clients read only: insert" on public.scheduled_block_tasks;
drop policy if exists "oauth clients read only: update" on public.scheduled_block_tasks;
drop policy if exists "oauth clients read only: delete" on public.scheduled_block_tasks;
drop policy if exists "oauth clients fill their own blocks" on public.scheduled_block_tasks;

-- Everyone: a link joins the caller's own block to the caller's own task.
drop policy if exists "own block and task" on public.scheduled_block_tasks;
create policy "own block and task" on public.scheduled_block_tasks
  as restrictive for all to authenticated
  using (true)
  with check (
    exists (select 1 from public.scheduled_blocks b where b.id = scheduled_block_id and b.user_id = auth.uid())
    and exists (select 1 from public.tasks t where t.id = task_id and t.user_id = auth.uid())
  );

-- Per command, not `for all`: a restrictive `using` would also apply to
-- SELECT and hide the inside of Arthur's blocks, which stays readable.
drop policy if exists "oauth clients fill their own blocks: insert" on public.scheduled_block_tasks;
create policy "oauth clients fill their own blocks: insert" on public.scheduled_block_tasks
  as restrictive for insert to authenticated
  with check (
    not (select public.is_oauth_client())
    or exists (select 1 from public.scheduled_blocks b
                where b.id = scheduled_block_id and b.created_by = 'claude')
  );

drop policy if exists "oauth clients fill their own blocks: update" on public.scheduled_block_tasks;
create policy "oauth clients fill their own blocks: update" on public.scheduled_block_tasks
  as restrictive for update to authenticated
  using (
    not (select public.is_oauth_client())
    or exists (select 1 from public.scheduled_blocks b
                where b.id = scheduled_block_id and b.created_by = 'claude')
  )
  with check (
    not (select public.is_oauth_client())
    or exists (select 1 from public.scheduled_blocks b
                where b.id = scheduled_block_id and b.created_by = 'claude')
  );

drop policy if exists "oauth clients fill their own blocks: delete" on public.scheduled_block_tasks;
create policy "oauth clients fill their own blocks: delete" on public.scheduled_block_tasks
  as restrictive for delete to authenticated
  using (
    not (select public.is_oauth_client())
    or exists (select 1 from public.scheduled_blocks b
                where b.id = scheduled_block_id and b.created_by = 'claude')
  );
