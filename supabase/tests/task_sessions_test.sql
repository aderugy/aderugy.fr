-- Migration 0026: blocks become task sessions — the backfill, the triggers
-- that keep tasks and Google in step, the week's totals, the push queue,
-- reminders, and who may change what (Arthur, Claude, someone else).
--
-- Run after stub.sql and every migration (see oauth_scope_test.sql for the
-- commands), from the repository root:
--   psql -d t -f supabase/tests/task_sessions_test.sql   # ends with ALL CHECKS PASSED
-- The blocks are seeded first and 0026 is re-applied, which is also what
-- checks that it is re-runnable: its backfill picks them up.
\set ON_ERROR_STOP 1

create function pg_temp.check(ok boolean, what text) returns void language plpgsql as $$
begin
  if not ok then raise exception 'FAIL: %', what; end if;
  raise notice 'ok   %', what;
end $$;
grant execute on function pg_temp.check(boolean, text) to authenticated, anon;

-- ------------------------------------------------------------------ seed
-- U = Arthur, O = someone else. Times are relative to now(): the backfill
-- decides on "over" by the clock.

insert into auth.users values
  ('aaaaaaaa-0000-4000-8000-0000000000d1', 'sessions@x'),
  ('bbbbbbbb-0000-4000-8000-0000000000d2', 'other-sessions@x');
insert into public.categories (id, user_id, name, position) values
  ('c0000000-0000-4000-8000-0000000000d1', 'aaaaaaaa-0000-4000-8000-0000000000d1', 'poker', 0),
  ('c0000000-0000-4000-8000-0000000000d2', 'aaaaaaaa-0000-4000-8000-0000000000d1', 'maths', 1);
insert into public.weeks (id, user_id, week_start) values
  ('e0000000-0000-4000-8000-0000000000d1', 'aaaaaaaa-0000-4000-8000-0000000000d1', current_date),
  ('e0000000-0000-4000-8000-0000000000d2', 'aaaaaaaa-0000-4000-8000-0000000000d1', '2030-01-07');
insert into public.companies (id, user_id, name) values
  ('c0aa0000-0000-4000-8000-0000000000d1', 'aaaaaaaa-0000-4000-8000-0000000000d1', 'Betclic');
insert into public.applications (id, user_id, company_id, role_title) values
  ('a9900000-0000-4000-8000-0000000000d1', 'aaaaaaaa-0000-4000-8000-0000000000d1', 'c0aa0000-0000-4000-8000-0000000000d1', 'DS intern');

-- Tasks. T7 and T10 were made on the grid (ad_hoc); T10 is an interview's.
insert into public.tasks (id, user_id, category_id, description, estimated_minutes, status, ad_hoc, application_id) values
  ('7a000000-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-0000000000d1', 'c0000000-0000-4000-8000-0000000000d1', 'T1 future', 60, 'scheduled', false, null),
  ('7a000000-0000-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-0000000000d1', 'c0000000-0000-4000-8000-0000000000d1', 'T2 first of two', 30, 'scheduled', false, null),
  ('7a000000-0000-4000-8000-000000000003', 'aaaaaaaa-0000-4000-8000-0000000000d1', 'c0000000-0000-4000-8000-0000000000d2', 'T3 second of two', 45, 'scheduled', false, null),
  ('7a000000-0000-4000-8000-000000000004', 'aaaaaaaa-0000-4000-8000-0000000000d1', 'c0000000-0000-4000-8000-0000000000d1', 'T4 done block', 60, 'scheduled', false, null),
  ('7a000000-0000-4000-8000-000000000005', 'aaaaaaaa-0000-4000-8000-0000000000d1', 'c0000000-0000-4000-8000-0000000000d1', 'T5 skipped block', 60, 'backlog', false, null),
  ('7a000000-0000-4000-8000-000000000006', 'aaaaaaaa-0000-4000-8000-0000000000d1', 'c0000000-0000-4000-8000-0000000000d1', 'T6 past, from backlog', 60, 'scheduled', false, null),
  ('7a000000-0000-4000-8000-000000000007', 'aaaaaaaa-0000-4000-8000-0000000000d1', 'c0000000-0000-4000-8000-0000000000d1', 'T7 past, made on grid', 60, 'scheduled', true, null),
  ('7a000000-0000-4000-8000-000000000008', 'aaaaaaaa-0000-4000-8000-0000000000d1', 'c0000000-0000-4000-8000-0000000000d1', 'T8 dropped', 60, 'dropped', false, null),
  ('7a000000-0000-4000-8000-000000000009', 'aaaaaaaa-0000-4000-8000-0000000000d1', 'c0000000-0000-4000-8000-0000000000d1', 'T9 by Claude', 60, 'scheduled', false, null),
  ('7a000000-0000-4000-8000-000000000010', 'aaaaaaaa-0000-4000-8000-0000000000d1', 'c0000000-0000-4000-8000-0000000000d1', 'Interview · Betclic', 60, 'scheduled', true, 'a9900000-0000-4000-8000-0000000000d1');

-- Blocks, one per case.
insert into public.scheduled_blocks (id, user_id, week_id, starts_at, ends_at, status, google_event_id, sync_state) values
  ('b1000000-0000-4000-8000-0000000000d1', 'aaaaaaaa-0000-4000-8000-0000000000d1', 'e0000000-0000-4000-8000-0000000000d1', now() + interval '1 day', now() + interval '1 day 1 hour', 'planned', 'evb1', 'synced'),
  ('b2000000-0000-4000-8000-0000000000d1', 'aaaaaaaa-0000-4000-8000-0000000000d1', 'e0000000-0000-4000-8000-0000000000d1', now() + interval '2 days', now() + interval '2 days 2 hours', 'planned', 'evb2', 'synced'),
  ('b3000000-0000-4000-8000-0000000000d1', 'aaaaaaaa-0000-4000-8000-0000000000d1', 'e0000000-0000-4000-8000-0000000000d1', now() + interval '3 days', now() + interval '3 days 1 hour', 'planned', 'evb3', 'synced'),
  ('b4000000-0000-4000-8000-0000000000d1', 'aaaaaaaa-0000-4000-8000-0000000000d1', 'e0000000-0000-4000-8000-0000000000d1', now() - interval '2 days', now() - interval '2 days' + interval '1 hour', 'done', null, 'synced'),
  ('b5000000-0000-4000-8000-0000000000d1', 'aaaaaaaa-0000-4000-8000-0000000000d1', 'e0000000-0000-4000-8000-0000000000d1', now() - interval '3 days', now() - interval '3 days' + interval '1 hour', 'skipped', null, 'synced'),
  ('b6000000-0000-4000-8000-0000000000d1', 'aaaaaaaa-0000-4000-8000-0000000000d1', 'e0000000-0000-4000-8000-0000000000d1', now() - interval '1 day', now() - interval '1 day' + interval '1 hour', 'planned', null, 'synced'),
  ('b7000000-0000-4000-8000-0000000000d1', 'aaaaaaaa-0000-4000-8000-0000000000d1', 'e0000000-0000-4000-8000-0000000000d1', now() - interval '1 day 3 hours', now() - interval '1 day 2 hours', 'planned', null, 'synced'),
  ('b8000000-0000-4000-8000-0000000000d1', 'aaaaaaaa-0000-4000-8000-0000000000d1', 'e0000000-0000-4000-8000-0000000000d1', now() + interval '4 days', now() + interval '4 days 1 hour', 'planned', null, 'synced'),
  ('b9000000-0000-4000-8000-0000000000d1', 'aaaaaaaa-0000-4000-8000-0000000000d1', 'e0000000-0000-4000-8000-0000000000d1', now() + interval '5 days', now() + interval '5 days 1 hour', 'planned', null, 'synced'),
  ('ba000000-0000-4000-8000-0000000000d1', 'aaaaaaaa-0000-4000-8000-0000000000d1', 'e0000000-0000-4000-8000-0000000000d1', now() + interval '6 days', now() + interval '6 days 1 hour', 'planned', null, 'synced');
-- 0019's trigger keeps a block's author on update; Claude's block is seeded with triggers off.
set session_replication_role = replica;
update public.scheduled_blocks set created_by = 'claude' where id = 'b9000000-0000-4000-8000-0000000000d1';
set session_replication_role = default;
insert into public.scheduled_block_tasks (user_id, scheduled_block_id, task_id, planned_minutes, position) values
  ('aaaaaaaa-0000-4000-8000-0000000000d1', 'b1000000-0000-4000-8000-0000000000d1', '7a000000-0000-4000-8000-000000000001', 60, 0),
  ('aaaaaaaa-0000-4000-8000-0000000000d1', 'b2000000-0000-4000-8000-0000000000d1', '7a000000-0000-4000-8000-000000000003', 45, 1),
  ('aaaaaaaa-0000-4000-8000-0000000000d1', 'b2000000-0000-4000-8000-0000000000d1', '7a000000-0000-4000-8000-000000000002', 30, 0),
  ('aaaaaaaa-0000-4000-8000-0000000000d1', 'b4000000-0000-4000-8000-0000000000d1', '7a000000-0000-4000-8000-000000000004', 60, 0),
  ('aaaaaaaa-0000-4000-8000-0000000000d1', 'b5000000-0000-4000-8000-0000000000d1', '7a000000-0000-4000-8000-000000000005', 60, 0),
  ('aaaaaaaa-0000-4000-8000-0000000000d1', 'b6000000-0000-4000-8000-0000000000d1', '7a000000-0000-4000-8000-000000000006', 60, 0),
  ('aaaaaaaa-0000-4000-8000-0000000000d1', 'b7000000-0000-4000-8000-0000000000d1', '7a000000-0000-4000-8000-000000000007', 60, 0),
  ('aaaaaaaa-0000-4000-8000-0000000000d1', 'b8000000-0000-4000-8000-0000000000d1', '7a000000-0000-4000-8000-000000000008', 60, 0),
  ('aaaaaaaa-0000-4000-8000-0000000000d1', 'b9000000-0000-4000-8000-0000000000d1', '7a000000-0000-4000-8000-000000000009', 60, 0),
  ('aaaaaaaa-0000-4000-8000-0000000000d1', 'ba000000-0000-4000-8000-0000000000d1', '7a000000-0000-4000-8000-000000000010', 60, 0);
insert into public.interviews (id, user_id, application_id, scheduled_block_id, starts_at, ends_at) values
  ('1f000000-0000-4000-8000-0000000000d1', 'aaaaaaaa-0000-4000-8000-0000000000d1', 'a9900000-0000-4000-8000-0000000000d1', 'ba000000-0000-4000-8000-0000000000d1',
   now() + interval '6 days', now() + interval '6 days 1 hour');
insert into public.block_reminders_sent (scheduled_block_id, user_id, starts_at) values
  ('b1000000-0000-4000-8000-0000000000d1', 'aaaaaaaa-0000-4000-8000-0000000000d1', now() + interval '1 day');

-- ============================================================== backfill
\i supabase/migrations/0026_task_sessions.sql

create function pg_temp.s(p_task text) returns public.task_sessions language sql as $$
  select * from public.task_sessions where task_id = ('7a000000-0000-4000-8000-0000000000' || p_task)::uuid
   order by starts_at limit 1 $$;
create function pg_temp.t(p_task text) returns text language sql as $$
  select status from public.tasks where id = ('7a000000-0000-4000-8000-0000000000' || p_task)::uuid $$;

select pg_temp.check(
  (pg_temp.s('01')).id = 'b1000000-0000-4000-8000-0000000000d1'
  and (pg_temp.s('01')).status = 'planned' and pg_temp.t('01') = 'scheduled'
  and (pg_temp.s('01')).google_event_id = 'evb1' and (pg_temp.s('01')).sync_state = 'pending',
  'one-task block: same id and Google event, planned, pending a re-push');
select pg_temp.check(
  (pg_temp.s('02')).id = 'b2000000-0000-4000-8000-0000000000d1'
  and (pg_temp.s('02')).google_event_id = 'evb2'
  and (pg_temp.s('02')).ends_at - (pg_temp.s('02')).starts_at = interval '30 minutes'
  and (pg_temp.s('03')).id <> 'b2000000-0000-4000-8000-0000000000d1'
  and (pg_temp.s('03')).google_event_id is null
  and (pg_temp.s('03')).starts_at = (pg_temp.s('02')).ends_at
  and (pg_temp.s('03')).ends_at - (pg_temp.s('03')).starts_at = interval '45 minutes',
  'two-task block: back to back in block order, the first keeps the block''s id and event');
select pg_temp.check(
  not exists (select 1 from public.task_sessions where legacy_block_id = 'b3000000-0000-4000-8000-0000000000d1'),
  'empty block: not carried over');
select pg_temp.check((pg_temp.s('04')).status = 'done' and pg_temp.t('04') = 'done', 'done block: session and task done');
select pg_temp.check((pg_temp.s('05')).status = 'skipped' and pg_temp.t('05') = 'backlog', 'skipped block: skipped, task in the backlog');
select pg_temp.check((pg_temp.s('06')).status = 'skipped' and pg_temp.t('06') = 'backlog', 'past block, backlog task: skipped, back to the backlog');
select pg_temp.check((pg_temp.s('07')).status = 'done' and pg_temp.t('07') = 'done', 'past block, task made on the grid: done');
select pg_temp.check((pg_temp.s('08')).status = 'skipped' and pg_temp.t('08') = 'dropped', 'dropped task: its future slot is skipped, it stays dropped');
select pg_temp.check((pg_temp.s('09')).created_by = 'claude', 'a block Claude planned stays Claude''s');
select pg_temp.check(
  (select session_id from public.interviews where id = '1f000000-0000-4000-8000-0000000000d1') = 'ba000000-0000-4000-8000-0000000000d1',
  'the interview follows its block''s session');
select pg_temp.check(
  exists (select 1 from public.session_reminders_sent where session_id = 'b1000000-0000-4000-8000-0000000000d1'),
  'a reminder already sent for a block stays sent');

\i supabase/migrations/0026_task_sessions.sql
select pg_temp.check(
  (select count(*) from public.task_sessions where user_id = 'aaaaaaaa-0000-4000-8000-0000000000d1') = 10,
  're-running 0026 adds nothing');

-- ============================================================== triggers

do $$
begin
  insert into public.task_sessions (user_id, task_id, week_id, starts_at, ends_at)
  values ('aaaaaaaa-0000-4000-8000-0000000000d1', '7a000000-0000-4000-8000-000000000001',
          'e0000000-0000-4000-8000-0000000000d1', now() + interval '8 days', now() + interval '8 days 1 hour');
  raise exception 'FAIL: a second planned slot was accepted';
exception when unique_violation then
  raise notice 'ok   one planned slot per task';
end $$;

select public.reschedule_session('b1000000-0000-4000-8000-0000000000d1', 'e0000000-0000-4000-8000-0000000000d1',
                                 now() + interval '9 days', now() + interval '9 days 1 hour');
select pg_temp.check(
  (select status from public.task_sessions where id = 'b1000000-0000-4000-8000-0000000000d1') = 'skipped'
  and (select count(*) from public.task_sessions where task_id = '7a000000-0000-4000-8000-000000000001' and status = 'planned') = 1
  and pg_temp.t('01') = 'scheduled',
  'reschedule: the old slot stays as skipped, a new one is planned, the task stays scheduled');

update public.task_sessions set status = 'skipped'
 where task_id = '7a000000-0000-4000-8000-000000000001' and status = 'planned';
select pg_temp.check(pg_temp.t('01') = 'backlog', 'skip: the task goes back to the backlog');

insert into public.task_sessions (user_id, task_id, week_id, starts_at, ends_at)
values ('aaaaaaaa-0000-4000-8000-0000000000d1', '7a000000-0000-4000-8000-000000000001',
        'e0000000-0000-4000-8000-0000000000d1', now() + interval '10 days', now() + interval '10 days 1 hour');
select pg_temp.check(pg_temp.t('01') = 'scheduled', 'planned again: scheduled');

update public.task_sessions set status = 'done'
 where task_id = '7a000000-0000-4000-8000-000000000001' and status = 'planned';
select pg_temp.check(pg_temp.t('01') = 'done', 'done slot: task done');
update public.task_sessions set status = 'planned'
 where task_id = '7a000000-0000-4000-8000-000000000001' and status = 'done';
select pg_temp.check(pg_temp.t('01') = 'scheduled', 'undo done: the task is scheduled again');

update public.task_sessions set starts_at = starts_at + interval '1 hour', ends_at = ends_at + interval '1 hour'
 where id = 'ba000000-0000-4000-8000-0000000000d1';
select pg_temp.check(
  (select starts_at from public.interviews where id = '1f000000-0000-4000-8000-0000000000d1')
    = (select starts_at from public.task_sessions where id = 'ba000000-0000-4000-8000-0000000000d1'),
  'moving the slot moves the interview');

update public.task_sessions set sync_state = 'synced' where user_id = 'aaaaaaaa-0000-4000-8000-0000000000d1';
update public.tasks set description = 'T2 renamed' where id = '7a000000-0000-4000-8000-000000000002';
select pg_temp.check((pg_temp.s('02')).sync_state = 'pending', 'renaming a task marks its slots for a re-push');
update public.categories set name = 'algebra' where id = 'c0000000-0000-4000-8000-0000000000d2';
select pg_temp.check((pg_temp.s('03')).sync_state = 'pending', 'renaming a category marks its slots for a re-push');

delete from public.task_sessions where id = 'b2000000-0000-4000-8000-0000000000d1';
select pg_temp.check(
  exists (select 1 from public.google_push_tombstones where google_event_id = 'evb2'),
  'deleting a slot leaves a tombstone for its Google event');
delete from public.google_push_tombstones where user_id = 'aaaaaaaa-0000-4000-8000-0000000000d1';

-- ============================================================ push queue
insert into public.google_accounts (user_id, refresh_token_secret, push_enabled)
values ('aaaaaaaa-0000-4000-8000-0000000000d1', gen_random_uuid(), true);
update public.task_sessions set sync_state = 'synced' where user_id = 'aaaaaaaa-0000-4000-8000-0000000000d1';
update public.scheduled_blocks set sync_state = 'pending' where user_id = 'aaaaaaaa-0000-4000-8000-0000000000d1';
select pg_temp.check(
  not exists (select 1 from public.users_due_for_push() where user_id = 'aaaaaaaa-0000-4000-8000-0000000000d1'),
  'a pending block no longer wakes the pusher');
update public.task_sessions set sync_state = 'pending' where id = (pg_temp.s('03')).id;
select pg_temp.check(
  exists (select 1 from public.users_due_for_push() where user_id = 'aaaaaaaa-0000-4000-8000-0000000000d1'),
  'a pending slot does');

-- ========================================================== week totals
-- Week of 2030-01-07: 60 min planned poker, 90 min skipped poker, 30 min done maths.
insert into public.tasks (id, user_id, category_id, estimated_minutes) values
  ('7a000000-0000-4000-8000-000000000011', 'aaaaaaaa-0000-4000-8000-0000000000d1', 'c0000000-0000-4000-8000-0000000000d1', 60),
  ('7a000000-0000-4000-8000-000000000012', 'aaaaaaaa-0000-4000-8000-0000000000d1', 'c0000000-0000-4000-8000-0000000000d1', 90),
  ('7a000000-0000-4000-8000-000000000013', 'aaaaaaaa-0000-4000-8000-0000000000d1', 'c0000000-0000-4000-8000-0000000000d2', 30),
  ('7a000000-0000-4000-8000-000000000014', 'aaaaaaaa-0000-4000-8000-0000000000d1', 'c0000000-0000-4000-8000-0000000000d1', 30);
insert into public.task_sessions (id, user_id, task_id, week_id, starts_at, ends_at, status) values
  ('5e000000-0000-4000-8000-000000000011', 'aaaaaaaa-0000-4000-8000-0000000000d1', '7a000000-0000-4000-8000-000000000011', 'e0000000-0000-4000-8000-0000000000d2', '2030-01-07 08:00+00', '2030-01-07 09:00+00', 'planned'),
  ('5e000000-0000-4000-8000-000000000012', 'aaaaaaaa-0000-4000-8000-0000000000d1', '7a000000-0000-4000-8000-000000000012', 'e0000000-0000-4000-8000-0000000000d2', '2030-01-08 08:00+00', '2030-01-08 09:30+00', 'skipped'),
  ('5e000000-0000-4000-8000-000000000013', 'aaaaaaaa-0000-4000-8000-0000000000d1', '7a000000-0000-4000-8000-000000000013', 'e0000000-0000-4000-8000-0000000000d2', '2030-01-09 08:00+00', '2030-01-09 08:30+00', 'done');
select pg_temp.check(
  (select planned_minutes from public.week_category_minutes
    where week_id = 'e0000000-0000-4000-8000-0000000000d2' and category_id = 'c0000000-0000-4000-8000-0000000000d1') = 60
  and (select planned_minutes || '/' || done_minutes from public.week_category_minutes
    where week_id = 'e0000000-0000-4000-8000-0000000000d2' and category_id = 'c0000000-0000-4000-8000-0000000000d2') = '30/30',
  'week totals: a slot counts for its length; skipped ones count for nothing');

-- ============================================================ reminders
insert into public.push_subscriptions (user_id, endpoint, p256dh, auth)
values ('aaaaaaaa-0000-4000-8000-0000000000d1', 'https://push.example/d1', repeat('k', 87), repeat('a', 22));
insert into public.task_sessions (id, user_id, task_id, week_id, starts_at, ends_at)
values ('5e000000-0000-4000-8000-000000000014', 'aaaaaaaa-0000-4000-8000-0000000000d1', '7a000000-0000-4000-8000-000000000014',
        'e0000000-0000-4000-8000-0000000000d1', now() + interval '5 minutes', now() + interval '35 minutes');
select pg_temp.check(
  exists (select 1 from public.sessions_due_for_reminder() where session_id = '5e000000-0000-4000-8000-000000000014'),
  'a slot starting within the lead time is due a reminder');
insert into public.session_reminders_sent (session_id, user_id, starts_at)
select id, user_id, starts_at from public.task_sessions where id = '5e000000-0000-4000-8000-000000000014';
select pg_temp.check(
  not exists (select 1 from public.sessions_due_for_reminder() where session_id = '5e000000-0000-4000-8000-000000000014'),
  'not twice');
update public.task_sessions set starts_at = starts_at + interval '2 minutes', ends_at = ends_at + interval '2 minutes'
 where id = '5e000000-0000-4000-8000-000000000014';
select pg_temp.check(
  exists (select 1 from public.sessions_due_for_reminder() where session_id = '5e000000-0000-4000-8000-000000000014'),
  'moved: due again');

-- ========================================================= as Claude (OAuth)
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-4000-8000-0000000000d1","role":"authenticated","client_id":"claude-client"}';

select pg_temp.check((select count(*) from public.task_sessions) >= 10, 'Claude reads Arthur''s slots');

insert into public.task_sessions (id, user_id, task_id, week_id, starts_at, ends_at, created_by)
values ('5e000000-0000-4000-8000-0000000000c1', 'aaaaaaaa-0000-4000-8000-0000000000d1', '7a000000-0000-4000-8000-000000000012',
        'e0000000-0000-4000-8000-0000000000d2', '2030-01-10 08:00+00', '2030-01-10 09:00+00', 'app');
select pg_temp.check(
  (select created_by from public.task_sessions where id = '5e000000-0000-4000-8000-0000000000c1') = 'claude',
  'Claude plans a slot, which is Claude''s whatever it claims');

with u as (update public.task_sessions set starts_at = starts_at + interval '1 hour', ends_at = ends_at + interval '1 hour'
            where id = '5e000000-0000-4000-8000-000000000011' returning 1)
select pg_temp.check((select count(*) from u) = 0, 'Claude cannot move Arthur''s slot');
with d as (delete from public.task_sessions where id = '5e000000-0000-4000-8000-000000000011' returning 1)
select pg_temp.check((select count(*) from d) = 0, 'Claude cannot delete Arthur''s slot');
with u as (update public.task_sessions set status = 'skipped'
            where id = '5e000000-0000-4000-8000-0000000000c1' returning 1)
select pg_temp.check((select count(*) from u) = 1, 'Claude skips its own slot');

do $$
begin
  perform public.reschedule_session('5e000000-0000-4000-8000-000000000011', 'e0000000-0000-4000-8000-0000000000d2',
                                    '2030-01-11 08:00+00', '2030-01-11 09:00+00');
  raise exception 'FAIL: Claude rescheduled Arthur''s slot';
exception when insufficient_privilege then
  raise notice 'ok   Claude cannot reschedule Arthur''s slot, and is told so';
end $$;
commit;

-- ======================================================== someone else
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"bbbbbbbb-0000-4000-8000-0000000000d2","role":"authenticated"}';
select pg_temp.check((select count(*) from public.task_sessions) = 0, 'another user sees none of Arthur''s slots');
do $$
begin
  insert into public.task_sessions (user_id, task_id, week_id, starts_at, ends_at)
  values ('bbbbbbbb-0000-4000-8000-0000000000d2', '7a000000-0000-4000-8000-000000000014',
          'e0000000-0000-4000-8000-0000000000d1', now() + interval '1 day', now() + interval '1 day 1 hour');
  raise exception 'FAIL: a slot was planned in someone else''s week, on their task';
exception when insufficient_privilege then
  raise notice 'ok   nobody plans in someone else''s week or task';
end $$;
commit;

\echo ALL CHECKS PASSED
