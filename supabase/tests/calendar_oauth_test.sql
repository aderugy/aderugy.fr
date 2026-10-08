-- Migration 0019: the week grid as a connected app (the Claude connector)
-- sees it — reads everything, plans its own blocks, never touches Arthur's.
--
-- Run after stub.sql and every migration (see oauth_scope_test.sql for the
-- commands), from the repository root:
--   psql -d t -f supabase/tests/calendar_oauth_test.sql   # ends with ALL CHECKS PASSED
-- It re-applies 0019 first: the migration must be re-runnable.
\set ON_ERROR_STOP 1
\i supabase/migrations/0019_oauth_calendar.sql

insert into auth.users values
  ('aaaaaaaa-0000-4000-8000-0000000000c1', 'cal@x'),
  ('bbbbbbbb-0000-4000-8000-0000000000c2', 'other@x');
insert into public.categories (id, user_id, name, position) values
  ('c0000000-0000-4000-8000-0000000000c1', 'aaaaaaaa-0000-4000-8000-0000000000c1', 'poker', 0),
  ('c0000000-0000-4000-8000-0000000000c9', 'bbbbbbbb-0000-4000-8000-0000000000c2', 'theirs', 0);
insert into public.tasks (id, user_id, category_id, description, estimated_minutes, status) values
  ('70000000-0000-4000-8000-0000000000c1', 'aaaaaaaa-0000-4000-8000-0000000000c1', 'c0000000-0000-4000-8000-0000000000c1', 'study', 60, 'backlog'),
  ('70000000-0000-4000-8000-0000000000c2', 'aaaaaaaa-0000-4000-8000-0000000000c1', 'c0000000-0000-4000-8000-0000000000c1', 'grind', 120, 'scheduled'),
  ('70000000-0000-4000-8000-0000000000c9', 'bbbbbbbb-0000-4000-8000-0000000000c2', 'c0000000-0000-4000-8000-0000000000c9', 'theirs', 30, 'backlog');
insert into public.weeks (id, user_id, week_start, theme) values
  ('e0000000-0000-4000-8000-0000000000c1', 'aaaaaaaa-0000-4000-8000-0000000000c1', '2026-10-05', 'focus'),
  ('e0000000-0000-4000-8000-0000000000c9', 'bbbbbbbb-0000-4000-8000-0000000000c2', '2026-10-05', null);
insert into public.objectives (user_id, week_id, title) values
  ('aaaaaaaa-0000-4000-8000-0000000000c1', 'e0000000-0000-4000-8000-0000000000c1', '10h poker');
insert into public.blocks (id, user_id, name, default_category_id) values
  ('ab000000-0000-4000-8000-0000000000c1', 'aaaaaaaa-0000-4000-8000-0000000000c1', 'Deep work', 'c0000000-0000-4000-8000-0000000000c1');
insert into public.calendar_sources (id, user_id, external_id, display_name, color, category_id, enabled) values
  ('5c000000-0000-4000-8000-0000000000c1', 'aaaaaaaa-0000-4000-8000-0000000000c1', 'epita@group', 'EPITA', '#3b5bdb', 'c0000000-0000-4000-8000-0000000000c1', true);
insert into public.external_events (user_id, calendar_source_id, external_event_id, title, starts_at, ends_at, archived_at) values
  ('aaaaaaaa-0000-4000-8000-0000000000c1', '5c000000-0000-4000-8000-0000000000c1', 'ev1', 'ML lecture', '2026-10-06 07:00+00', '2026-10-06 09:00+00', now());
-- Arthur's own block, made in the app.
insert into public.scheduled_blocks (id, user_id, week_id, starts_at, ends_at, sync_state) values
  ('b0000000-0000-4000-8000-0000000000c1', 'aaaaaaaa-0000-4000-8000-0000000000c1', 'e0000000-0000-4000-8000-0000000000c1',
   '2026-10-07 16:00+00', '2026-10-07 18:00+00', 'synced');
insert into public.scheduled_block_tasks (user_id, scheduled_block_id, task_id, planned_minutes) values
  ('aaaaaaaa-0000-4000-8000-0000000000c1', 'b0000000-0000-4000-8000-0000000000c1', '70000000-0000-4000-8000-0000000000c2', 120);

create function pg_temp.check(ok boolean, what text) returns void language plpgsql as $$
begin
  if not ok then raise exception 'FAIL: %', what; end if;
  raise notice 'ok   %', what;
end $$;
grant execute on function pg_temp.check(boolean, text) to authenticated, anon;

select pg_temp.check(
  (select created_by from public.scheduled_blocks where id = 'b0000000-0000-4000-8000-0000000000c1') = 'app',
  'a block made in the app is Arthur''s');

-- ========================================================= as Claude (OAuth)
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-4000-8000-0000000000c1","role":"authenticated","client_id":"claude-client"}';

select pg_temp.check(
  (select count(*) from public.weeks) = 1
  and (select count(*) from public.objectives) = 1
  and (select count(*) from public.blocks) = 1
  and (select count(*) from public.calendar_sources) = 1
  and (select count(*) from public.external_events) = 1
  and (select count(*) from public.scheduled_blocks) = 1
  and (select count(*) from public.scheduled_block_tasks) = 1,
  'claude reads the week, objectives, templates, calendars, events, blocks and what is inside them');
select pg_temp.check((select count(*) from public.google_accounts) = 0, 'google accounts stay hidden');

-- Planning its own block, in a week it creates.
insert into public.weeks (id, user_id, week_start) values
  ('e0000000-0000-4000-8000-0000000000c2', 'aaaaaaaa-0000-4000-8000-0000000000c1', '2026-10-12');
insert into public.scheduled_blocks (id, user_id, week_id, starts_at, ends_at, created_by) values
  ('b0000000-0000-4000-8000-0000000000c2', 'aaaaaaaa-0000-4000-8000-0000000000c1', 'e0000000-0000-4000-8000-0000000000c2',
   '2026-10-13 08:00+00', '2026-10-13 09:00+00', 'app');
select pg_temp.check(
  (select created_by from public.scheduled_blocks where id = 'b0000000-0000-4000-8000-0000000000c2') = 'claude',
  'a block claude creates is marked as claude''s, whatever it says');
insert into public.scheduled_block_tasks (user_id, scheduled_block_id, task_id, planned_minutes) values
  ('aaaaaaaa-0000-4000-8000-0000000000c1', 'b0000000-0000-4000-8000-0000000000c2', '70000000-0000-4000-8000-0000000000c1', 60);
update public.scheduled_block_tasks set planned_minutes = 45 where scheduled_block_id = 'b0000000-0000-4000-8000-0000000000c2';
update public.scheduled_blocks set starts_at = '2026-10-13 09:00+00', ends_at = '2026-10-13 10:00+00', status = 'done'
 where id = 'b0000000-0000-4000-8000-0000000000c2';
select pg_temp.check(
  (select starts_at = '2026-10-13 09:00+00' and status = 'done' and created_by = 'claude'
     from public.scheduled_blocks where id = 'b0000000-0000-4000-8000-0000000000c2'),
  'claude fills, moves and marks its own block');

-- Arthur's block: no row matches, nothing changes.
update public.scheduled_blocks set starts_at = '2026-10-07 20:00+00', ends_at = '2026-10-07 21:00+00'
 where id = 'b0000000-0000-4000-8000-0000000000c1';
delete from public.scheduled_blocks where id = 'b0000000-0000-4000-8000-0000000000c1';
update public.scheduled_block_tasks set planned_minutes = 5 where scheduled_block_id = 'b0000000-0000-4000-8000-0000000000c1';
delete from public.scheduled_block_tasks where scheduled_block_id = 'b0000000-0000-4000-8000-0000000000c1';
select pg_temp.check(
  (select starts_at = '2026-10-07 16:00+00' from public.scheduled_blocks where id = 'b0000000-0000-4000-8000-0000000000c1')
  and (select planned_minutes = 120 from public.scheduled_block_tasks where scheduled_block_id = 'b0000000-0000-4000-8000-0000000000c1'),
  'claude cannot move, delete or rearrange Arthur''s block (no row matched)');

update public.scheduled_blocks set created_by = 'claude' where id = 'b0000000-0000-4000-8000-0000000000c1';
select pg_temp.check(
  (select created_by from public.scheduled_blocks where id = 'b0000000-0000-4000-8000-0000000000c1') = 'app',
  'claude cannot claim Arthur''s block');

update public.weeks set theme = 'hijacked';
delete from public.weeks;
select pg_temp.check(
  (select theme from public.weeks where id = 'e0000000-0000-4000-8000-0000000000c1') = 'focus'
  and (select count(*) from public.weeks) = 2,
  'claude cannot edit or delete weeks (no row matched)');

delete from public.external_events;
select pg_temp.check((select count(*) from public.external_events) = 1, 'claude cannot delete archived events');

-- Then: deleting its own block works.
delete from public.scheduled_blocks where id = 'b0000000-0000-4000-8000-0000000000c2';
select pg_temp.check(
  not exists (select 1 from public.scheduled_blocks where id = 'b0000000-0000-4000-8000-0000000000c2'),
  'claude deletes its own block');
commit;

-- Refused outright.
do $$
declare
  stmts text[] := array[
    -- a task into Arthur's block
    $q$insert into public.scheduled_block_tasks (user_id, scheduled_block_id, task_id, planned_minutes) values ('aaaaaaaa-0000-4000-8000-0000000000c1', 'b0000000-0000-4000-8000-0000000000c1', '70000000-0000-4000-8000-0000000000c1', 30)$q$,
    -- a week with an intent
    $q$insert into public.weeks (user_id, week_start, theme) values ('aaaaaaaa-0000-4000-8000-0000000000c1', '2026-10-19', 'mine')$q$,
    -- objectives, templates
    $q$insert into public.objectives (user_id, week_id, title) values ('aaaaaaaa-0000-4000-8000-0000000000c1', 'e0000000-0000-4000-8000-0000000000c1', 'x')$q$,
    $q$insert into public.blocks (user_id, name, default_category_id) values ('aaaaaaaa-0000-4000-8000-0000000000c1', 'x', 'c0000000-0000-4000-8000-0000000000c1')$q$,
    -- a block in someone else's week
    $q$insert into public.scheduled_blocks (user_id, week_id, starts_at, ends_at) values ('aaaaaaaa-0000-4000-8000-0000000000c1', 'e0000000-0000-4000-8000-0000000000c9', '2026-10-08 08:00+00', '2026-10-08 09:00+00')$q$
  ];
  s text;
begin
  foreach s in array stmts loop
    begin
      set local role authenticated;
      perform set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-4000-8000-0000000000c1","role":"authenticated","client_id":"claude-client"}', true);
      execute s;
      raise exception 'FAIL: should have been refused: %', s;
    exception when insufficient_privilege then
      raise notice 'ok   refused: %', left(s, 80);
    end;
  end loop;
end $$;
reset role;

-- ========================================== as Arthur (browser, no client_id)
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-4000-8000-0000000000c1","role":"authenticated"}';
insert into public.scheduled_blocks (id, user_id, week_id, starts_at, ends_at) values
  ('b0000000-0000-4000-8000-0000000000c3', 'aaaaaaaa-0000-4000-8000-0000000000c1', 'e0000000-0000-4000-8000-0000000000c1',
   '2026-10-08 08:00+00', '2026-10-08 09:00+00');
update public.scheduled_blocks set starts_at = '2026-10-07 15:00+00' where id = 'b0000000-0000-4000-8000-0000000000c1';
update public.weeks set theme = 'still mine' where id = 'e0000000-0000-4000-8000-0000000000c1';
select pg_temp.check(
  (select created_by from public.scheduled_blocks where id = 'b0000000-0000-4000-8000-0000000000c3') = 'app'
  and (select starts_at = '2026-10-07 15:00+00' from public.scheduled_blocks where id = 'b0000000-0000-4000-8000-0000000000c1')
  and (select theme from public.weeks where id = 'e0000000-0000-4000-8000-0000000000c1') = 'still mine',
  'the app is unchanged: creates, moves, edits the week');
commit;

do $$ begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-4000-8000-0000000000c1","role":"authenticated"}', true);
  insert into public.scheduled_block_tasks (user_id, scheduled_block_id, task_id, planned_minutes) values
    ('aaaaaaaa-0000-4000-8000-0000000000c1', 'b0000000-0000-4000-8000-0000000000c3', '70000000-0000-4000-8000-0000000000c9', 30);
  raise exception 'FAIL: someone else''s task was put in a block';
exception when insufficient_privilege then raise notice 'ok   someone else''s task cannot go in my block';
end $$;
reset role;

\echo ALL CHECKS PASSED
