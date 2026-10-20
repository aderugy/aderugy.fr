-- /maths — capsules (décision D25, Arthur's request, Oct 2026).
--
-- A concept's course is now cut into capsules, one notion each, in
-- content/maths/**/modules/NN-<id>.mdx. The content stays in git; the only new
-- state is which capsules Arthur has finished. One row per finished capsule:
-- no row means not finished, so "reopen" is a delete.
--
-- Finishing the last capsule of a node also sets maths_node_progress.course_read
-- (done by the app, not here): course_read stays the one evidence the
-- progression rules read.
--
-- Connected apps (the Claude connector, 0015/0028) may read the table, not
-- write it: a capsule is finished by reading it, in the app.
--
-- Same rules as 0012: RLS `user_id = auth.uid()`. Re-runnable.

create table if not exists public.maths_module_progress (
  user_id      uuid not null references auth.users (id) on delete cascade,
  node_id      text not null,
  -- The file name without its number: reordering capsules keeps their rows.
  module_id    text not null,
  completed_at timestamptz not null default now(),
  primary key (user_id, node_id, module_id)
);

alter table public.maths_module_progress enable row level security;

drop policy if exists "own rows" on public.maths_module_progress;
create policy "own rows" on public.maths_module_progress
  for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ------------------------------------------------- connected apps: read only

drop policy if exists "oauth clients read only: insert" on public.maths_module_progress;
drop policy if exists "oauth clients read only: update" on public.maths_module_progress;
drop policy if exists "oauth clients read only: delete" on public.maths_module_progress;

create policy "oauth clients read only: insert" on public.maths_module_progress
  as restrictive for insert to authenticated
  with check (not (select public.is_oauth_client()));
create policy "oauth clients read only: update" on public.maths_module_progress
  as restrictive for update to authenticated
  using (not (select public.is_oauth_client()))
  with check (not (select public.is_oauth_client()));
create policy "oauth clients read only: delete" on public.maths_module_progress
  as restrictive for delete to authenticated
  using (not (select public.is_oauth_client()));
