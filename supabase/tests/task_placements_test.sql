-- Migration 0016: notes, live placements, and the skipped-block backfill.
--
-- Run after stub.sql and every migration (see oauth_scope_test.sql for the
-- commands), from the repository root:
--   psql -d t -f supabase/tests/task_placements_test.sql   # ends with ALL CHECKS PASSED
-- It re-applies 0016 on purpose: the migration must be idempotent, and the
-- backfill is checked against rows written before it runs.
\set ON_ERROR_STOP 1

insert into auth.users values
  ('aaaaaaaa-0000-4000-8000-0000000000a1', 'p@x'),
  ('bbbbbbbb-0000-4000-8000-0000000000b2', 'q@x');
insert into public.categories (id, user_id, name, position) values
  ('c0000000-0000-4000-8000-0000000000a1', 'aaaaaaaa-0000-4000-8000-0000000000a1', 'work', 0),
  ('c0000000-0000-4000-8000-0000000000b2', 'bbbbbbbb-0000-4000-8000-0000000000b2', 'work', 0);
insert into public.weeks (id, user_id, week_start) values
  ('e0000000-0000-4000-8000-0000000000a1', 'aaaaaaaa-0000-4000-8000-0000000000a1', '2026-09-28');
insert into public.scheduled_blocks (id, user_id, week_id, starts_at, ends_at, status) values
  ('b0000000-0000-4000-8000-0000000000a1', 'aaaaaaaa-0000-4000-8000-0000000000a1', 'e0000000-0000-4000-8000-0000000000a1', '2026-09-29 08:00+00', '2026-09-29 10:00+00', 'planned'),
  ('b0000000-0000-4000-8000-0000000000a2', 'aaaaaaaa-0000-4000-8000-0000000000a1', 'e0000000-0000-4000-8000-0000000000a1', '2026-09-30 08:00+00', '2026-09-30 10:00+00', 'skipped');

-- t1 planned only · t2 skipped only · t3 both · t4 "scheduled" with no link
-- t5 ad-hoc in the skipped block · t6 done, in the skipped block
insert into public.tasks (id, user_id, category_id, description, estimated_minutes, status, ad_hoc) values
  ('70000000-0000-4000-8000-0000000000a1', 'aaaaaaaa-0000-4000-8000-0000000000a1', 'c0000000-0000-4000-8000-0000000000a1', 'planned only', 60, 'scheduled', false),
  ('70000000-0000-4000-8000-0000000000a2', 'aaaaaaaa-0000-4000-8000-0000000000a1', 'c0000000-0000-4000-8000-0000000000a1', 'skipped only', 60, 'scheduled', false),
  ('70000000-0000-4000-8000-0000000000a3', 'aaaaaaaa-0000-4000-8000-0000000000a1', 'c0000000-0000-4000-8000-0000000000a1', 'both', 60, 'scheduled', false),
  ('70000000-0000-4000-8000-0000000000a4', 'aaaaaaaa-0000-4000-8000-0000000000a1', 'c0000000-0000-4000-8000-0000000000a1', 'stale', 60, 'scheduled', false),
  ('70000000-0000-4000-8000-0000000000a5', 'aaaaaaaa-0000-4000-8000-0000000000a1', 'c0000000-0000-4000-8000-0000000000a1', 'ad-hoc', 60, 'scheduled', true),
  ('70000000-0000-4000-8000-0000000000a6', 'aaaaaaaa-0000-4000-8000-0000000000a1', 'c0000000-0000-4000-8000-0000000000a1', 'done', 60, 'done', false);
insert into public.scheduled_block_tasks (user_id, scheduled_block_id, task_id, planned_minutes, position) values
  ('aaaaaaaa-0000-4000-8000-0000000000a1', 'b0000000-0000-4000-8000-0000000000a1', '70000000-0000-4000-8000-0000000000a1', 45, 0),
  ('aaaaaaaa-0000-4000-8000-0000000000a1', 'b0000000-0000-4000-8000-0000000000a2', '70000000-0000-4000-8000-0000000000a2', 60, 0),
  ('aaaaaaaa-0000-4000-8000-0000000000a1', 'b0000000-0000-4000-8000-0000000000a1', '70000000-0000-4000-8000-0000000000a3', 30, 1),
  ('aaaaaaaa-0000-4000-8000-0000000000a1', 'b0000000-0000-4000-8000-0000000000a2', '70000000-0000-4000-8000-0000000000a3', 20, 1),
  ('aaaaaaaa-0000-4000-8000-0000000000a1', 'b0000000-0000-4000-8000-0000000000a2', '70000000-0000-4000-8000-0000000000a5', 30, 2),
  ('aaaaaaaa-0000-4000-8000-0000000000a1', 'b0000000-0000-4000-8000-0000000000a2', '70000000-0000-4000-8000-0000000000a6', 10, 3);

\ir ../migrations/0016_task_notes_and_skipped.sql

create function pg_temp.check(ok boolean, what text) returns void language plpgsql as $$
begin
  if not ok then raise exception 'FAIL: %', what; end if;
  raise notice 'ok   %', what;
end $$;
grant execute on function pg_temp.check(boolean, text) to authenticated;
create function pg_temp.status(n text) returns text language sql as $$
  select status from public.tasks where id = ('70000000-0000-4000-8000-0000000000' || n)::uuid $$;
grant execute on function pg_temp.status(text) to authenticated;

select pg_temp.check(pg_temp.status('a1') = 'scheduled', 'backfill: planned placement stays scheduled');
select pg_temp.check(pg_temp.status('a2') = 'backlog',   'backfill: skipped-only task back in the backlog');
select pg_temp.check(pg_temp.status('a3') = 'scheduled', 'backfill: one live placement is enough');
select pg_temp.check(pg_temp.status('a4') = 'backlog',   'backfill: "scheduled" with no placement at all fixed');
select pg_temp.check(pg_temp.status('a5') = 'scheduled', 'backfill: ad-hoc task left to its block');
select pg_temp.check(pg_temp.status('a6') = 'done',      'backfill: done stays done');

-- live placements, as the owner — browser session and OAuth client alike
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-4000-8000-0000000000a1","role":"authenticated","client_id":"claude"}';
create temp table p on commit drop as
  select * from public.task_placements(array[
    '70000000-0000-4000-8000-0000000000a1', '70000000-0000-4000-8000-0000000000a2',
    '70000000-0000-4000-8000-0000000000a3', '70000000-0000-4000-8000-0000000000a4']::uuid[]);
select pg_temp.check((select (live_count, live_minutes, total_count) = (1, 45, 1) from p where task_id = '70000000-0000-4000-8000-0000000000a1'), 'placements: planned → live');
select pg_temp.check((select (live_count, live_minutes, total_count) = (0, 0, 1)  from p where task_id = '70000000-0000-4000-8000-0000000000a2'), 'placements: skipped → not live, still counted in total');
select pg_temp.check((select (live_count, live_minutes, total_count) = (1, 30, 2) from p where task_id = '70000000-0000-4000-8000-0000000000a3'), 'placements: skipped minutes excluded');
select pg_temp.check(not exists (select 1 from p where task_id = '70000000-0000-4000-8000-0000000000a4'), 'placements: no row for an unplaced task');
select pg_temp.check((select count(*) from public.scheduled_blocks) = 0, 'OAuth client still cannot read blocks themselves');

update public.tasks set notes = E'# Plan\n- [ ] read\n- [x] write' where id = '70000000-0000-4000-8000-0000000000a4';
select pg_temp.check((select notes like '# Plan%' from public.tasks where id = '70000000-0000-4000-8000-0000000000a4'), 'OAuth client can write notes');
commit;

-- another user learns nothing about my tasks
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"bbbbbbbb-0000-4000-8000-0000000000b2","role":"authenticated"}';
select pg_temp.check((select count(*) from public.task_placements(array['70000000-0000-4000-8000-0000000000a1']::uuid[])) = 0, 'placements: other users see nothing');
commit;

do $$ begin
  set local role anon;
  perform public.task_placements(array[]::uuid[]);
  raise exception 'FAIL: anon reached task_placements';
exception when insufficient_privilege then
  raise notice 'ok   anon cannot call task_placements';
end $$;
reset role;

do $$ begin
  update public.tasks set notes = repeat('x', 20001) where id = '70000000-0000-4000-8000-0000000000a1';
  raise exception 'FAIL: 20001-char notes accepted';
exception when check_violation then
  raise notice 'ok   notes capped at 20000 characters';
end $$;
\echo ALL CHECKS PASSED
