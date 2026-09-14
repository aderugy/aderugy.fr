-- The category becomes the label; the description becomes the content.
--
-- Titles are dropped from tasks and scheduled blocks. What a row *is* is now its
-- category; what it specifically covers is its description. That makes the
-- category mandatory: a row without one would have nothing to render.

-- ------------------------------------------------- a home for orphaned rows

-- Rows with no category cannot be labelled, so they need one before the
-- constraint lands. Created per user, and only for users who actually have
-- orphans — an empty "Uncategorised" in everyone's tree would be noise.
with needing as (
  select distinct user_id from public.tasks where category_id is null
  union
  select distinct user_id from public.scheduled_blocks where category_id is null
  union
  select distinct user_id from public.blocks where default_category_id is null
)
insert into public.categories (user_id, parent_id, name, color, position)
select n.user_id, null, 'Uncategorised', '#64748b', 9999
from needing n
where not exists (
  select 1 from public.categories c
   where c.user_id = n.user_id and c.parent_id is null and lower(c.name) = 'uncategorised'
);

-- ---------------------------------------------------------------- tasks

alter table public.tasks add column if not exists description text;

-- Keep whatever was written: an explicit note first, the old title otherwise.
update public.tasks
   set description = nullif(trim(coalesce(nullif(trim(notes), ''), title)), '')
 where description is null;

update public.tasks t
   set category_id = (
     select c.id from public.categories c
      where c.user_id = t.user_id and c.parent_id is null
        and lower(c.name) = 'uncategorised'
      limit 1
   )
 where t.category_id is null;

alter table public.tasks drop column notes;
alter table public.tasks drop column title;
alter table public.tasks alter column category_id set not null;

-- Nulling the category on delete would leave an unlabelable row, so deletion of
-- a category that is still in use must be refused instead.
alter table public.tasks drop constraint tasks_category_id_fkey;
alter table public.tasks
  add constraint tasks_category_id_fkey
  foreign key (category_id) references public.categories (id) on delete restrict;

-- ------------------------------------------------------- scheduled blocks

alter table public.scheduled_blocks add column if not exists description text;

update public.scheduled_blocks
   set description = nullif(trim(title), '')
 where description is null;

update public.scheduled_blocks sb
   set category_id = (
     select c.id from public.categories c
      where c.user_id = sb.user_id and c.parent_id is null
        and lower(c.name) = 'uncategorised'
      limit 1
   )
 where sb.category_id is null;

alter table public.scheduled_blocks drop column title;
alter table public.scheduled_blocks alter column category_id set not null;

alter table public.scheduled_blocks drop constraint scheduled_blocks_category_id_fkey;
alter table public.scheduled_blocks
  add constraint scheduled_blocks_category_id_fkey
  foreign key (category_id) references public.categories (id) on delete restrict;

-- --------------------------------------------------------------- templates

-- A template with no category could otherwise produce a block with none.
update public.blocks b
   set default_category_id = (
     select c.id from public.categories c
      where c.user_id = b.user_id and c.parent_id is null
        and lower(c.name) = 'uncategorised'
      limit 1
   )
 where b.default_category_id is null;

alter table public.blocks alter column default_category_id set not null;

alter table public.blocks drop constraint blocks_default_category_id_fkey;
alter table public.blocks
  add constraint blocks_default_category_id_fkey
  foreign key (default_category_id) references public.categories (id) on delete restrict;

-- Block items keep an optional category: they are steps inside a named bundle,
-- and the bundle's own category already labels the placed block.

-- ------------------------------------------------------- deletion guard

-- The foreign keys already refuse the delete. This exists so the UI can say
-- *why*, with numbers, instead of surfacing a constraint violation.
--
-- Counts cover the whole subtree: deleting a parent cascades to its children,
-- so a task hanging off a grandchild blocks the delete just the same.
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
    (select count(*) from public.scheduled_blocks sb
      where sb.category_id in (select id from subtree)),
    (select count(*) from public.blocks b
      where b.default_category_id in (select id from subtree)),
    -- greatest(): a category the caller does not own yields an empty subtree,
    -- and count(*) - 1 would report -1 descendants.
    (select greatest(count(*) - 1, 0) from subtree);
$$;

grant execute on function public.category_usage(uuid) to authenticated;
