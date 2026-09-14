-- A scheduled block stops being a categorised thing and becomes a container of
-- time. What the time *counts as* now lives entirely on the tasks inside it:
-- each task carries its own category and its own planned minutes, and the
-- week's distribution is the sum of those, not of the blocks.
--
-- Consequences handled here:
--   * links between blocks and tasks need an order, since they are stacked
--     inside the block in that order;
--   * a task created from the grid has no life outside its block, so it is
--     marked ad-hoc and removed with it rather than falling into the backlog;
--   * every block that carried a category becomes a block holding one task of
--     that category, so no past week loses its distribution;
--   * `scheduled_blocks.category_id` goes away, and the two SQL objects that
--     read it are rewritten against the tasks.
--
-- Numbered 0007: this was written as a second 0006 alongside the rake presets,
-- and the CLI keys its history on the numeric prefix alone — so it recorded one
-- `0006`, left the other looking unapplied, and replayed it on the next push.
-- Every statement below is also written to be re-runnable, so a replay is a
-- no-op rather than an error.

-- ------------------------------------------------- tasks that belong to a block

-- A task drawn straight onto the grid is an instance, not a backlog item. Kept
-- as a real task row so it carries a category and minutes like any other, but
-- deleted with its block instead of resurfacing in the rail.
alter table public.tasks
  add column if not exists ad_hoc boolean not null default false;

-- -------------------------------------------------------- ordering of children

alter table public.scheduled_block_tasks
  add column if not exists position int not null default 0;

-- ------------------------------------------- category → a task inside the block

-- Both steps below read `scheduled_blocks.category_id`, which this migration
-- removes further down. That makes them one-shot, and they are guarded as such:
-- on a replay the column is already gone, and re-running them would fail on the
-- missing column — or, for the ordering backfill, silently reshuffle an order
-- set since. The presence of the column is the marker for "not yet migrated".
--
-- The block loop runs row by row rather than as one insert...select because the
-- new task's id has to be linked back to the block it came from, which
-- `returning` cannot carry across a set-based insert.
do $$
declare
  b        record;
  minutes  int;
  new_task uuid;
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public'
       and table_name   = 'scheduled_blocks'
       and column_name  = 'category_id'
  ) then
    return;
  end if;

  -- Existing links have no intended order; longest first is as good a starting
  -- point as any, and is at least stable.
  with ordered as (
    select
      scheduled_block_id,
      task_id,
      row_number() over (
        partition by scheduled_block_id
        order by planned_minutes desc, task_id
      ) - 1 as pos
    from public.scheduled_block_tasks
  )
  update public.scheduled_block_tasks sbt
     set position = o.pos
    from ordered o
   where o.scheduled_block_id = sbt.scheduled_block_id
     and o.task_id = sbt.task_id;

  for b in
    select sb.id, sb.user_id, sb.category_id, sb.description, sb.starts_at, sb.ends_at
      from public.scheduled_blocks sb
     where sb.category_id is not null
       and not exists (
         select 1 from public.scheduled_block_tasks l
          where l.scheduled_block_id = sb.id
       )
  loop
    minutes := greatest(
      round(extract(epoch from (b.ends_at - b.starts_at)) / 60)::int,
      1
    );

    insert into public.tasks (
      user_id, category_id, description, estimated_minutes,
      priority, status, splittable, ad_hoc
    )
    values (b.user_id, b.category_id, b.description, minutes, 3, 'scheduled', true, true)
    returning id into new_task;

    insert into public.scheduled_block_tasks (
      user_id, scheduled_block_id, task_id, planned_minutes, position
    )
    values (b.user_id, b.id, new_task, minutes, 0);
  end loop;
end $$;

-- A block that already had tasks keeps them; its own category was never what
-- the distribution counted, so it is simply dropped.
alter table public.scheduled_blocks
  drop constraint if exists scheduled_blocks_category_id_fkey;

-- --------------------------------------------------------------- insights view

-- Same columns as before — only the source of "own" minutes changes, from the
-- block's span to the sum of its tasks. Time inside a block that is not covered
-- by any task is deliberately uncounted: it is planned but not yet attributed.
drop view if exists public.week_category_minutes;

-- A block that already had tasks keeps them; its own category was never what
-- the distribution counted, so it is simply dropped.
alter table public.scheduled_blocks
  drop column if exists category_id;

create view public.week_category_minutes
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

-- ------------------------------------------------------------- deletion guard

-- `scheduled` now counts the blocks that hold a task in this subtree, reached
-- through the tasks rather than through a column the block no longer has.
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
    (select count(distinct l.scheduled_block_id)
       from public.scheduled_block_tasks l
       join public.tasks t on t.id = l.task_id
      where t.category_id in (select id from subtree)),
    (select count(*) from public.blocks b
      where b.default_category_id in (select id from subtree)),
    (select greatest(count(*) - 1, 0) from subtree);
$$;

grant execute on function public.category_usage(uuid) to authenticated;
