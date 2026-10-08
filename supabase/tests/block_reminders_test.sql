-- Migration 0020: which blocks are due a reminder, and who may touch devices.
--
-- Plain Postgres 16, no Supabase needed (see oauth_scope_test.sql):
--   createdb t && psql -d t -f supabase/tests/stub.sql
--   for f in supabase/migrations/*.sql; do psql -d t -v ON_ERROR_STOP=1 -f $f; done
--   psql -d t -f supabase/tests/block_reminders_test.sql   # ends with ALL CHECKS PASSED
-- It re-applies 0020 on purpose: the migration must be re-runnable.
\set ON_ERROR_STOP 1

\ir ../migrations/0020_block_reminders.sql

create function pg_temp.check(ok boolean, label text) returns void language plpgsql as $$
begin
  if not coalesce(ok, false) then raise exception 'FAIL: %', label; end if;
  raise notice 'ok   %', label;
end $$;

insert into auth.users values
  ('aaaaaaaa-0000-4000-8000-0000000000c1', 'r@x'),
  ('bbbbbbbb-0000-4000-8000-0000000000c2', 's@x');
insert into public.weeks (id, user_id, week_start) values
  ('e0000000-0000-4000-8000-0000000000c1', 'aaaaaaaa-0000-4000-8000-0000000000c1', '2026-10-05'),
  ('e0000000-0000-4000-8000-0000000000c2', 'bbbbbbbb-0000-4000-8000-0000000000c2', '2026-10-05');

-- c1 in 5 min · c2 in 30 min · c3 started 5 min ago · c4 skipped, in 5 min
-- c5: other user, in 5 min, but no device
insert into public.scheduled_blocks (id, user_id, week_id, starts_at, ends_at, status) values
  ('b0000000-0000-4000-8000-0000000000c1', 'aaaaaaaa-0000-4000-8000-0000000000c1', 'e0000000-0000-4000-8000-0000000000c1', now() + interval '5 min',  now() + interval '65 min', 'planned'),
  ('b0000000-0000-4000-8000-0000000000c2', 'aaaaaaaa-0000-4000-8000-0000000000c1', 'e0000000-0000-4000-8000-0000000000c1', now() + interval '30 min', now() + interval '90 min', 'planned'),
  ('b0000000-0000-4000-8000-0000000000c3', 'aaaaaaaa-0000-4000-8000-0000000000c1', 'e0000000-0000-4000-8000-0000000000c1', now() - interval '5 min',  now() + interval '55 min', 'planned'),
  ('b0000000-0000-4000-8000-0000000000c4', 'aaaaaaaa-0000-4000-8000-0000000000c1', 'e0000000-0000-4000-8000-0000000000c1', now() + interval '5 min',  now() + interval '65 min', 'skipped'),
  ('b0000000-0000-4000-8000-0000000000c5', 'bbbbbbbb-0000-4000-8000-0000000000c2', 'e0000000-0000-4000-8000-0000000000c2', now() + interval '5 min',  now() + interval '65 min', 'planned');

select pg_temp.check(
  (select count(*) from public.blocks_due_for_reminder()) = 0,
  'nothing is due without a device');

insert into public.push_subscriptions (user_id, endpoint, p256dh, auth) values
  ('aaaaaaaa-0000-4000-8000-0000000000c1', 'https://push.example/1',
   'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
   'BTBZMqHH6r4Tts7J_aSIgg');

select pg_temp.check(
  array(select scheduled_block_id::text from public.blocks_due_for_reminder())
    = array['b0000000-0000-4000-8000-0000000000c1'],
  'default lead (10 min): only the planned block starting soon, not started, not skipped');

insert into public.notification_prefs (user_id, lead_minutes) values
  ('aaaaaaaa-0000-4000-8000-0000000000c1', 45);
select pg_temp.check(
  (select count(*) from public.blocks_due_for_reminder()) = 2,
  'a longer lead brings the 30-minute block in');

insert into public.block_reminders_sent (scheduled_block_id, user_id, starts_at)
  select id, user_id, starts_at from public.scheduled_blocks
   where id = 'b0000000-0000-4000-8000-0000000000c1';
select pg_temp.check(
  array(select scheduled_block_id::text from public.blocks_due_for_reminder())
    = array['b0000000-0000-4000-8000-0000000000c2'],
  'a reminded block is not due again');

update public.scheduled_blocks set starts_at = starts_at + interval '10 min'
 where id = 'b0000000-0000-4000-8000-0000000000c1';
select pg_temp.check(
  (select count(*) from public.blocks_due_for_reminder()
    where scheduled_block_id = 'b0000000-0000-4000-8000-0000000000c1') = 1,
  'moving a reminded block makes it due again');

update public.notification_prefs set block_reminders = false
 where user_id = 'aaaaaaaa-0000-4000-8000-0000000000c1';
select pg_temp.check(
  (select count(*) from public.blocks_due_for_reminder()) = 0,
  'turning reminders off silences everything');

delete from public.scheduled_blocks where id = 'b0000000-0000-4000-8000-0000000000c1';
select pg_temp.check(
  not exists (select 1 from public.block_reminders_sent
               where scheduled_block_id = 'b0000000-0000-4000-8000-0000000000c1'),
  'deleting a block deletes its reminder record');

-- ================================================================== owner
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-4000-8000-0000000000c1","role":"authenticated"}';
insert into public.push_subscriptions (user_id, endpoint, p256dh, auth) values
  ('aaaaaaaa-0000-4000-8000-0000000000c1', 'https://push.example/2',
   'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
   'BTBZMqHH6r4Tts7J_aSIgg');
select pg_temp.check(
  (select count(*) from public.push_subscriptions) = 2,
  'the owner registers and sees their devices');
select pg_temp.check(
  (select count(*) from public.block_reminders_sent) = 0,
  'the owner cannot read the sender''s bookkeeping');

savepoint s;
do $$ begin
  perform public.blocks_due_for_reminder();
  raise exception 'FAIL: a user called the sweep function';
exception when insufficient_privilege then raise notice 'ok   users cannot call blocks_due_for_reminder';
end $$;
rollback to savepoint s;
commit;

-- ============================================================= other user
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"bbbbbbbb-0000-4000-8000-0000000000c2","role":"authenticated"}';
select pg_temp.check(
  (select count(*) from public.push_subscriptions) = 0,
  'another user sees no devices');

savepoint s;
do $$ begin
  insert into public.push_subscriptions (user_id, endpoint, p256dh, auth) values
    ('aaaaaaaa-0000-4000-8000-0000000000c1', 'https://push.example/evil',
     'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
     'BTBZMqHH6r4Tts7J_aSIgg');
  raise exception 'FAIL: wrote a device for someone else';
exception when insufficient_privilege then raise notice 'ok   nobody registers a device for someone else';
end $$;
rollback to savepoint s;
commit;

-- ====================================================== connected app
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-4000-8000-0000000000c1","role":"authenticated","client_id":"claude"}';
select pg_temp.check(
  (select count(*) from public.push_subscriptions) = 0,
  'a connected app sees no devices');

savepoint s;
do $$ begin
  insert into public.notification_prefs (user_id, lead_minutes) values
    ('aaaaaaaa-0000-4000-8000-0000000000c1', 0);
  raise exception 'FAIL: a connected app changed preferences';
exception when insufficient_privilege then raise notice 'ok   a connected app cannot change preferences';
end $$;
rollback to savepoint s;
commit;

\echo ALL CHECKS PASSED
