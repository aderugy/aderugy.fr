-- Migration 0028: what a connected app (the Claude connector) may touch in
-- /maths, and that the browser keeps working exactly as before.
--
-- Run after stub.sql and every migration (see oauth_scope_test.sql for the
-- commands), from the repository root:
--   psql -d t -f supabase/tests/maths_connector_test.sql   # ends with ALL CHECKS PASSED
-- It re-applies 0028 first: it must be re-runnable.
\set ON_ERROR_STOP 1
\i supabase/migrations/0028_maths_connector.sql

insert into auth.users values
  ('aaaaaaaa-0000-4000-8000-0000000000e1', 'ma@x'),
  ('bbbbbbbb-0000-4000-8000-0000000000e2', 'mb@x');

create function pg_temp.check(ok boolean, what text) returns void language plpgsql as $$
begin
  if not ok then raise exception 'FAIL: %', what; end if;
  raise notice 'ok   %', what;
end $$;

create function pg_temp.fails(stmt text, code text default null) returns boolean language plpgsql as $$
begin
  execute stmt;
  return false;
exception when others then
  return code is null or sqlstate = code;
end $$;

create function pg_temp.touched(stmt text) returns int language plpgsql as $$
declare n int;
begin
  execute stmt;
  get diagnostics n = row_count;
  return n;
end $$;

grant execute on function pg_temp.check(boolean, text) to authenticated, anon;
grant execute on function pg_temp.fails(text, text) to authenticated, anon;
grant execute on function pg_temp.touched(text) to authenticated, anon;

-- Fixtures, as the owner (RLS off for the superuser): Arthur's own rows.
insert into public.maths_node_progress (user_id, node_id, manual, course_read) values
  ('aaaaaaaa-0000-4000-8000-0000000000e1', 'suites-reelles', 'in-progress', true),
  ('bbbbbbbb-0000-4000-8000-0000000000e2', 'suites-reelles', 'learned', true);
insert into public.maths_session_log (user_id, node_id, minutes, note) values
  ('aaaaaaaa-0000-4000-8000-0000000000e1', 'suites-reelles', 45, 'cours §1-3');
insert into public.maths_attempt (user_id, exercise_key, node_id, difficulty, outcome, minutes_spent, note) values
  ('aaaaaaaa-0000-4000-8000-0000000000e1', 'suites-reelles/01-limites-usuelles', 'suites-reelles', 1, 'resolu-seul', 10, '');
insert into public.maths_review_state (user_id, card_key, node_id, card_id, stability, difficulty, due, last_review, reps, lapses) values
  ('aaaaaaaa-0000-4000-8000-0000000000e1', 'suites-reelles:def-limite', 'suites-reelles', 'def-limite', 4, 5, '2026-10-20', '2026-10-16 08:00+00', 2, 0);
insert into public.maths_review_log (user_id, card_key, node_id, rating, elapsed_days, stability_before, stability_after, difficulty_before) values
  ('aaaaaaaa-0000-4000-8000-0000000000e1', 'suites-reelles:def-limite', 'suites-reelles', 3, 1, 1, 4, 5);

select pg_temp.check(
  (select created_by from public.maths_session_log where note = 'cours §1-3') = 'arthur',
  'existing rows are Arthur''s');

-- ======================================================= as the browser
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-4000-8000-0000000000e1","role":"authenticated"}';

select pg_temp.check(
  pg_temp.touched($$insert into public.maths_attempt (user_id, exercise_key, node_id, difficulty, outcome, created_by)
                    values ('aaaaaaaa-0000-4000-8000-0000000000e1', 'suites-reelles/02-vrai-faux', 'suites-reelles', 2, 'echec', 'claude')$$) = 1,
  'the browser records an attempt');
select pg_temp.check(
  (select created_by from public.maths_attempt where exercise_key = 'suites-reelles/02-vrai-faux') = 'arthur',
  'a browser row is Arthur''s even when it claims otherwise');
select public.maths_save_review('suites-reelles:def-limite', 'suites-reelles', 'def-limite', 3, 4, 4, 5, 9, 5, '2026-10-29', now(), 3, 0);
select pg_temp.check(
  (select stability from public.maths_review_state where card_key = 'suites-reelles:def-limite') = 9,
  'the browser still rates cards');
select pg_temp.check(
  pg_temp.touched($$delete from public.maths_session_log where note = 'cours §1-3'$$) = 1,
  'the browser deletes its own sessions');
commit;

-- ======================================================= as the connector
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-4000-8000-0000000000e1","role":"authenticated","client_id":"claude"}';

-- reading
select pg_temp.check((select count(*) from public.maths_node_progress) = 1, 'Claude reads progress, own rows only');
select pg_temp.check((select count(*) from public.maths_attempt) = 2, 'Claude reads attempts');
select pg_temp.check((select count(*) from public.maths_review_state) = 1, 'Claude reads the review schedule');
select pg_temp.check((select count(*) from public.maths_review_log) = 2, 'Claude reads the review journal');

-- progress
select public.maths_set_manual('suites-reelles', 'learned');
select pg_temp.check(
  (select manual from public.maths_node_progress where node_id = 'suites-reelles') = 'learned',
  'Claude sets a node''s manual status');
select public.maths_set_manual('limites-continuite', 'in-progress');
select pg_temp.check(
  (select count(*) from public.maths_node_progress) = 2,
  'Claude marks a node it had no row for');
select pg_temp.check(
  pg_temp.touched($$insert into public.maths_node_progress (user_id, node_id, course_read)
                    values ('aaaaaaaa-0000-4000-8000-0000000000e1', 'limites-continuite', true)
                    on conflict (user_id, node_id) do update set course_read = excluded.course_read$$) = 1,
  'Claude marks a course read');
select pg_temp.check(
  pg_temp.touched($$delete from public.maths_node_progress$$) = 0,
  'Claude cannot delete progress');

-- sessions and attempts
select pg_temp.check(
  pg_temp.touched($$insert into public.maths_session_log (user_id, node_id, minutes, note, created_by)
                    values ('aaaaaaaa-0000-4000-8000-0000000000e1', 'suites-reelles', 30, 'via Claude', 'arthur')$$) = 1,
  'Claude logs a session');
select pg_temp.check(
  (select created_by from public.maths_session_log where note = 'via Claude') = 'claude',
  'a session Claude logs is signed claude, whatever it sent');
select pg_temp.check(
  pg_temp.touched($$insert into public.maths_attempt (user_id, exercise_key, node_id, difficulty, outcome, note)
                    values ('aaaaaaaa-0000-4000-8000-0000000000e1', 'suites-reelles/05-trois-adherences', 'suites-reelles', 3, 'resolu-avec-indice', 'bloqué sur la sous-suite')$$) = 1,
  'Claude logs an attempt');
select pg_temp.check(
  pg_temp.touched($$update public.maths_attempt set outcome = 'resolu-seul' where exercise_key = 'suites-reelles/05-trois-adherences'$$) = 1,
  'Claude edits an attempt it logged');
select pg_temp.check(
  pg_temp.touched($$update public.maths_attempt set note = 'x' where created_by = 'arthur'$$) = 0,
  'Claude cannot edit Arthur''s attempts');
select pg_temp.check(
  pg_temp.touched($$delete from public.maths_attempt where created_by = 'arthur'$$) = 0,
  'Claude cannot delete Arthur''s attempts');
select pg_temp.check(
  pg_temp.fails($$update public.maths_attempt set created_by = 'arthur' where exercise_key = 'suites-reelles/05-trois-adherences'$$, '42501'),
  'authorship cannot be changed');
select pg_temp.check(
  pg_temp.touched($$delete from public.maths_session_log where note = 'via Claude'$$) = 1,
  'Claude deletes a session it logged');

-- ratings
select pg_temp.check(
  pg_temp.fails($$select public.maths_save_review('suites-reelles:def-limite', 'suites-reelles', 'def-limite', 4, 1, 9, 5, 30, 4, '2026-12-01', now(), 4, 0)$$, '42501'),
  'Claude cannot rate a card');
select pg_temp.check(
  pg_temp.touched($$update public.maths_review_state set stability = 99$$) = 0,
  'Claude cannot touch the schedule');
select pg_temp.check(
  pg_temp.fails($$insert into public.maths_review_state (user_id, card_key, node_id, card_id, due)
                  values ('aaaaaaaa-0000-4000-8000-0000000000e1', 'x:y', 'x', 'y', '2026-10-20')$$),
  'Claude cannot insert into the schedule');
select pg_temp.check(
  pg_temp.touched($$delete from public.maths_review_log$$) = 0,
  'Claude cannot delete the review journal');

-- someone else's data
select pg_temp.check(
  pg_temp.fails($$insert into public.maths_attempt (user_id, exercise_key, node_id, difficulty, outcome)
                  values ('bbbbbbbb-0000-4000-8000-0000000000e2', 'x/y', 'x', 1, 'echec')$$),
  'Claude cannot write into another user''s parcours');
commit;

select 'ALL CHECKS PASSED' as result;
