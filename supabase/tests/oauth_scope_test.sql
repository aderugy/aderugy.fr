-- What an OAuth-client token (the Claude connector) may touch — migration 0015.
--
-- Plain Postgres 16, no Supabase needed:
--   createdb t && psql -d t -f supabase/tests/stub.sql
--   for f in supabase/migrations/*.sql; do psql -d t -v ON_ERROR_STOP=1 -f $f; done
--   psql -d t -f supabase/tests/oauth_scope_test.sql      # ends with ALL CHECKS PASSED
\set ON_ERROR_STOP 1
-- Fixtures, as the owner.
insert into auth.users values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'a@x'),
  ('bbbbbbbb-0000-4000-8000-000000000002', 'b@x');
insert into public.categories (id, user_id, parent_id, name, position) values
  ('c0000000-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', null, 'poker', 0),
  ('c0000000-0000-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000001', 'grind', 0),
  ('c0000000-0000-4000-8000-000000000009', 'bbbbbbbb-0000-4000-8000-000000000002', null, 'b-cat', 0);
insert into public.tasks (id, user_id, category_id, description, estimated_minutes, priority, status) values
  ('70000000-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000002', 'free task', 60, 3, 'backlog'),
  ('70000000-0000-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000002', 'placed task', 90, 2, 'scheduled'),
  ('70000000-0000-4000-8000-000000000009', 'bbbbbbbb-0000-4000-8000-000000000002', 'c0000000-0000-4000-8000-000000000009', 'b task', 30, 3, 'backlog');
insert into public.weeks (id, user_id, week_start) values
  ('e0000000-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', '2026-09-28');
insert into public.scheduled_blocks (id, user_id, week_id, starts_at, ends_at, sync_state) values
  ('b0000000-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-000000000001',
   '2026-09-29 08:00+00', '2026-09-29 09:30+00', 'synced');
insert into public.scheduled_block_tasks (user_id, scheduled_block_id, task_id, planned_minutes, position) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', '70000000-0000-4000-8000-000000000002', 90, 0);
insert into public.google_accounts (user_id, refresh_token_secret) values
  ('aaaaaaaa-0000-4000-8000-000000000001', gen_random_uuid());

create function pg_temp.check(ok boolean, what text) returns void language plpgsql as $$
begin
  if not ok then raise exception 'FAIL: %', what; end if;
  raise notice 'ok   %', what;
end $$;
grant execute on function pg_temp.check(boolean, text) to authenticated, anon;

-- ================================================ as Claude (OAuth client)
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-4000-8000-000000000001","role":"authenticated","client_id":"claude-client"}';

select pg_temp.check(public.is_oauth_client(), 'token is recognised as an OAuth client');
select pg_temp.check((select count(*) from public.tasks) = 2, 'reads own tasks only (2, not B''s)');
select pg_temp.check((select count(*) from public.categories) = 2, 'reads own categories');
select pg_temp.check((select count(*) from public.categories_with_path) = 2, 'reads categories_with_path');
select pg_temp.check((select count(*) from public.scheduled_block_tasks) = 1, 'reads placement links');
-- 0019 opened the calendar side for reading: calendar_oauth_test.sql covers it.
select pg_temp.check((select count(*) from public.weeks) = 1, 'weeks readable (0019)');
select pg_temp.check((select count(*) from public.scheduled_blocks) = 1, 'scheduled blocks readable (0019)');
select pg_temp.check((select count(*) from public.google_accounts) = 0, 'google_accounts hidden');
select pg_temp.check((select count(*) from public.push_status) <= 1, 'push_status shows own counts only');

insert into public.tasks (user_id, category_id, description, estimated_minutes, priority)
values ('aaaaaaaa-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000002', 'from claude', 45, 2);
select pg_temp.check((select count(*) from public.tasks) = 3, 'creates a task');

update public.tasks set description = 'placed task, renamed' where id = '70000000-0000-4000-8000-000000000002';
select pg_temp.check((select description from public.tasks where id = '70000000-0000-4000-8000-000000000002') = 'placed task, renamed', 'edits a placed task');

with u as (update public.categories set name = 'hacked' returning 1)
select pg_temp.check((select count(*) from u) = 0, 'cannot rename a category');
with d as (delete from public.categories where id = 'c0000000-0000-4000-8000-000000000002' returning 1)
select pg_temp.check((select count(*) from d) = 0, 'cannot delete a category');
with d as (delete from public.scheduled_block_tasks returning 1)
select pg_temp.check((select count(*) from d) = 0, 'cannot unlink a placement');
with u as (update public.tasks set description = 'x' where user_id = 'bbbbbbbb-0000-4000-8000-000000000002' returning 1)
select pg_temp.check((select count(*) from u) = 0, 'cannot touch B''s tasks');
commit;

-- write attempts that must raise
do $$
declare
  stmts text[] := array[
    $q$insert into public.categories (user_id, name, position) values ('aaaaaaaa-0000-4000-8000-000000000001', 'new', 9)$q$,
    $q$insert into public.weeks (user_id, week_start, theme) values ('aaaaaaaa-0000-4000-8000-000000000001', '2026-10-05', 'mine')$q$,
    $q$insert into public.scheduled_block_tasks (user_id, scheduled_block_id, task_id) values ('aaaaaaaa-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', '70000000-0000-4000-8000-000000000001')$q$,
    $q$select public.update_calendar_source(gen_random_uuid(), 'x')$q$
  ];
  s text;
begin
  foreach s in array stmts loop
    begin
      set local role authenticated;
      perform set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-4000-8000-000000000001","role":"authenticated","client_id":"claude-client"}', true);
      execute s;
      raise exception 'FAIL: should have been refused: %', s;
    exception when insufficient_privilege then
      raise notice 'ok   refused: %', left(s, 70);
    end;
  end loop;
end $$;
reset role;

-- The edit of the placed task must have re-queued its block for the Google push.
select pg_temp.check((select sync_state from public.scheduled_blocks where id = 'b0000000-0000-4000-8000-000000000001') = 'pending',
  'editing a placed task re-queues its block for push');
update public.scheduled_blocks set sync_state = 'synced';

-- ===================================== as the owner's own browser session
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-4000-8000-000000000001","role":"authenticated"}';
select pg_temp.check(not public.is_oauth_client(), 'browser session is not an OAuth client');
select pg_temp.check((select count(*) from public.weeks) = 1, 'session sees weeks');
select pg_temp.check((select count(*) from public.google_accounts) >= 0, 'session query on google_accounts runs');
insert into public.categories (user_id, name, position) values ('aaaaaaaa-0000-4000-8000-000000000001', 'studies', 1);
select pg_temp.check((select count(*) from public.categories) = 3, 'session creates a category');
update public.tasks set description = 'placed task again' where id = '70000000-0000-4000-8000-000000000002';
-- push_touch_blocks is limited to the caller's blocks
select public.push_touch_blocks(array['b0000000-0000-4000-8000-000000000001'::uuid]);
commit;

-- B cannot re-queue A's blocks through the RPC.
update public.scheduled_blocks set sync_state = 'synced';
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"bbbbbbbb-0000-4000-8000-000000000002","role":"authenticated"}';
select public.push_touch_blocks(array['b0000000-0000-4000-8000-000000000001'::uuid]);
commit;
select pg_temp.check((select sync_state from public.scheduled_blocks where id = 'b0000000-0000-4000-8000-000000000001') = 'synced',
  'another user cannot re-queue my blocks');

-- anon cannot call it at all
do $$ begin
  set local role anon;
  perform public.push_touch_blocks(array[]::uuid[]);
  raise exception 'FAIL: anon reached push_touch_blocks';
exception when insufficient_privilege then
  raise notice 'ok   anon cannot call push_touch_blocks';
end $$;
reset role;

-- deleting a task cascades to its links even for an OAuth client (FK actions skip RLS)
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-4000-8000-000000000001","role":"authenticated","client_id":"claude-client"}';
delete from public.tasks where id = '70000000-0000-4000-8000-000000000002';
commit;
select pg_temp.check((select count(*) from public.scheduled_block_tasks) = 0, 'task delete cascades to its placement');
select pg_temp.check((select sync_state from public.scheduled_blocks where id = 'b0000000-0000-4000-8000-000000000001') = 'pending',
  'and the block is re-queued for push');
\echo ALL CHECKS PASSED
