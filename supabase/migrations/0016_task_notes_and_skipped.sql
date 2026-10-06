-- Two backlog changes.
--
-- 1. Tasks get `notes`: an extended description in Markdown. `description`
--    stays the short line shown on the grid and the rail; `notes` is the
--    longer "what exactly, and how" — links, checklists, context.
--
-- 2. A task placed only in skipped blocks is back in the backlog. Skipping a
--    block means the work did not happen, so the task is still waiting for a
--    slot. The link stays — the skipped block keeps showing what was planned —
--    but it no longer counts as a placement.

-- ------------------------------------------------------------------- notes

alter table public.tasks
  add column if not exists notes text;

alter table public.tasks
  drop constraint if exists tasks_notes_length;
alter table public.tasks
  add constraint tasks_notes_length check (notes is null or length(notes) <= 20000);

-- -------------------------------------------------------------- placements

-- One definition of "placed", shared by the planner (task status) and the
-- Claude connector (placed minutes, delete guard, reopen). Security definer
-- because a connected app may not read scheduled_blocks (0015) and still needs
-- to know whether a placement is live; it learns counts and minutes per task,
-- nothing about the blocks themselves, and only for the caller's own tasks.
create or replace function public.task_placements(p_task_ids uuid[])
returns table (
  task_id      uuid,
  live_count   int,
  live_minutes int,
  total_count  int
)
language sql
stable
security definer
set search_path = public
as $$
  select
    l.task_id,
    (count(*) filter (where sb.status <> 'skipped'))::int,
    coalesce(sum(l.planned_minutes) filter (where sb.status <> 'skipped'), 0)::int,
    count(*)::int
  from public.scheduled_block_tasks l
  join public.scheduled_blocks sb on sb.id = l.scheduled_block_id
  where l.task_id = any(p_task_ids)
    and l.user_id = auth.uid()
  group by l.task_id;
$$;

revoke execute on function public.task_placements(uuid[]) from public, anon;
grant execute on function public.task_placements(uuid[]) to authenticated;

-- ----------------------------------------------------------------- backfill

-- Tasks already stuck as "scheduled" behind a skipped block (or behind
-- nothing at all) go back to the backlog. Ad-hoc tasks belong to their block
-- and are left alone.
update public.tasks t
   set status = 'backlog'
 where t.status = 'scheduled'
   and not t.ad_hoc
   and not exists (
     select 1
       from public.scheduled_block_tasks l
       join public.scheduled_blocks sb on sb.id = l.scheduled_block_id
      where l.task_id = t.id
        and sb.status <> 'skipped'
   );
