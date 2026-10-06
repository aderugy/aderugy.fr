-- Migration 0017: /jobs — history, applied date, the interview ↔ block link,
-- and what a connected app (the Claude connector) may touch.
--
-- Run after stub.sql and every migration (see oauth_scope_test.sql for the
-- commands), from the repository root:
--   psql -d t -f supabase/tests/jobs_test.sql   # ends with ALL CHECKS PASSED
-- It re-applies 0017 first: the migration must be re-runnable.
\set ON_ERROR_STOP 1
\i supabase/migrations/0017_jobs.sql

insert into auth.users values
  ('aaaaaaaa-0000-4000-8000-0000000000f1', 'j@x'),
  ('bbbbbbbb-0000-4000-8000-0000000000f2', 'k@x');
insert into public.categories (id, user_id, name, position) values
  ('c0000000-0000-4000-8000-0000000000f1', 'aaaaaaaa-0000-4000-8000-0000000000f1', 'stage', 0);
insert into public.weeks (id, user_id, week_start) values
  ('e0000000-0000-4000-8000-0000000000f1', 'aaaaaaaa-0000-4000-8000-0000000000f1', '2026-10-05');
insert into public.scheduled_blocks (id, user_id, week_id, starts_at, ends_at) values
  ('b0000000-0000-4000-8000-0000000000f1', 'aaaaaaaa-0000-4000-8000-0000000000f1', 'e0000000-0000-4000-8000-0000000000f1',
   '2026-10-08 12:00+00', '2026-10-08 13:00+00');
insert into public.companies (id, user_id, name) values
  ('d0000000-0000-4000-8000-0000000000f1', 'aaaaaaaa-0000-4000-8000-0000000000f1', 'Betclic'),
  ('d0000000-0000-4000-8000-0000000000f2', 'bbbbbbbb-0000-4000-8000-0000000000f2', 'Other');
insert into public.job_tags (id, user_id, name) values
  ('f0000000-0000-4000-8000-0000000000f1', 'aaaaaaaa-0000-4000-8000-0000000000f1', 'DS/ML'),
  ('f0000000-0000-4000-8000-0000000000f2', 'aaaaaaaa-0000-4000-8000-0000000000f1', 'CIFRE'),
  ('f0000000-0000-4000-8000-0000000000f9', 'bbbbbbbb-0000-4000-8000-0000000000f2', 'theirs');
insert into public.applications (id, user_id, company_id, role_title, status) values
  ('a0000000-0000-4000-8000-0000000000f1', 'aaaaaaaa-0000-4000-8000-0000000000f1', 'd0000000-0000-4000-8000-0000000000f1', 'Data Scientist intern', 'to_apply');
insert into public.interviews (id, user_id, application_id, scheduled_block_id, kind, starts_at, ends_at, debrief_notes) values
  ('10000000-0000-4000-8000-0000000000f1', 'aaaaaaaa-0000-4000-8000-0000000000f1', 'a0000000-0000-4000-8000-0000000000f1',
   'b0000000-0000-4000-8000-0000000000f1', 'technical', '2026-10-08 12:00+00', '2026-10-08 13:00+00', 'mine');

create function pg_temp.check(ok boolean, what text) returns void language plpgsql as $$
begin
  if not ok then raise exception 'FAIL: %', what; end if;
  raise notice 'ok   %', what;
end $$;
grant execute on function pg_temp.check(boolean, text) to authenticated, anon;

-- ======================================================= as the owner (browser)
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-4000-8000-0000000000f1","role":"authenticated"}';

select pg_temp.check(
  (select count(*) from public.application_events where application_id = 'a0000000-0000-4000-8000-0000000000f1') = 1,
  'creating an application logs its first status');

update public.applications set status = 'applied' where id = 'a0000000-0000-4000-8000-0000000000f1';
select pg_temp.check(
  (select applied_on is not null from public.applications where id = 'a0000000-0000-4000-8000-0000000000f1'),
  'moving to applied fills applied_on');
select pg_temp.check(
  (select count(*) from public.application_events
    where application_id = 'a0000000-0000-4000-8000-0000000000f1'
      and from_status = 'to_apply' and to_status = 'applied') = 1,
  'status change is logged from → to');

update public.applications set notes = 'x' where id = 'a0000000-0000-4000-8000-0000000000f1';
select pg_temp.check(
  (select count(*) from public.application_events where application_id = 'a0000000-0000-4000-8000-0000000000f1') = 2,
  'a change that is not the status logs nothing');

insert into public.application_tags (user_id, application_id, tag_id) values
  ('aaaaaaaa-0000-4000-8000-0000000000f1', 'a0000000-0000-4000-8000-0000000000f1', 'f0000000-0000-4000-8000-0000000000f1'),
  ('aaaaaaaa-0000-4000-8000-0000000000f1', 'a0000000-0000-4000-8000-0000000000f1', 'f0000000-0000-4000-8000-0000000000f2');
select pg_temp.check(
  (select count(*) from public.application_tags where application_id = 'a0000000-0000-4000-8000-0000000000f1') = 2,
  'an application carries several tags');

savepoint s;
do $$ begin
  insert into public.application_tags (user_id, application_id, tag_id) values
    ('aaaaaaaa-0000-4000-8000-0000000000f1', 'a0000000-0000-4000-8000-0000000000f1', 'f0000000-0000-4000-8000-0000000000f9');
  raise exception 'FAIL: someone else''s tag was attached';
exception when insufficient_privilege then raise notice 'ok   someone else''s tag cannot be attached';
end $$;
rollback to savepoint s;

select pg_temp.check(
  (select count(*) from public.companies) = 1,
  'only own companies are visible');

savepoint s;
do $$ begin
  insert into public.companies (user_id, name) values ('aaaaaaaa-0000-4000-8000-0000000000f1', ' betclic ');
  raise exception 'FAIL: duplicate company name accepted';
exception when unique_violation then raise notice 'ok   company names are unique per user, case and spaces aside';
end $$;
rollback to savepoint s;

update public.scheduled_blocks
   set starts_at = '2026-10-09 08:00+00', ends_at = '2026-10-09 09:30+00'
 where id = 'b0000000-0000-4000-8000-0000000000f1';
select pg_temp.check(
  (select starts_at = '2026-10-09 08:00+00' and ends_at = '2026-10-09 09:30+00'
     from public.interviews where id = '10000000-0000-4000-8000-0000000000f1'),
  'moving the block moves the interview');

delete from public.scheduled_blocks where id = 'b0000000-0000-4000-8000-0000000000f1';
select pg_temp.check(
  (select scheduled_block_id is null and debrief_notes = 'mine'
     from public.interviews where id = '10000000-0000-4000-8000-0000000000f1'),
  'deleting the block keeps the interview and its notes');

savepoint s;
do $$ begin
  delete from public.companies where id = 'd0000000-0000-4000-8000-0000000000f1';
  raise exception 'FAIL: company with applications deleted';
exception when foreign_key_violation then raise notice 'ok   a company with applications cannot be deleted';
end $$;
rollback to savepoint s;
commit;

-- ================================================ as Claude (OAuth client)
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-4000-8000-0000000000f1","role":"authenticated","client_id":"claude-client"}';

select pg_temp.check((select count(*) from public.applications) = 1, 'claude reads applications');
select pg_temp.check((select count(*) from public.job_tags) = 2, 'claude reads own tags');
select pg_temp.check((select count(*) from public.interviews) = 1, 'claude reads interviews');
select pg_temp.check((select count(*) from public.application_events) >= 2, 'claude reads the history');

insert into public.companies (id, user_id, name) values
  ('d0000000-0000-4000-8000-0000000000f3', 'aaaaaaaa-0000-4000-8000-0000000000f1', 'Siemens Healthineers');
insert into public.applications (id, user_id, company_id, role_title) values
  ('a0000000-0000-4000-8000-0000000000f3', 'aaaaaaaa-0000-4000-8000-0000000000f1', 'd0000000-0000-4000-8000-0000000000f3', 'Research intern');
select pg_temp.check(
  (select count(*) from public.application_events where application_id = 'a0000000-0000-4000-8000-0000000000f3') = 1,
  'claude creates a company and an application; history still written');
update public.applications set status = 'withdrawn' where id = 'a0000000-0000-4000-8000-0000000000f3';
select pg_temp.check(
  (select count(*) from public.application_events where application_id = 'a0000000-0000-4000-8000-0000000000f3') = 2,
  'claude changes a status; history still written');
insert into public.application_tags (user_id, application_id, tag_id) values
  ('aaaaaaaa-0000-4000-8000-0000000000f1', 'a0000000-0000-4000-8000-0000000000f3', 'f0000000-0000-4000-8000-0000000000f1');
select pg_temp.check(true, 'claude tags an application');

update public.interviews set prep_notes = 'prep' where id = '10000000-0000-4000-8000-0000000000f1';
select pg_temp.check(
  (select prep_notes = 'prep' from public.interviews where id = '10000000-0000-4000-8000-0000000000f1'),
  'claude writes interview prep');

savepoint s;
do $$ begin
  update public.interviews set debrief_notes = 'overwritten' where id = '10000000-0000-4000-8000-0000000000f1';
  raise exception 'FAIL: claude overwrote the debrief';
exception when insufficient_privilege then raise notice 'ok   claude cannot write the debrief';
end $$;
rollback to savepoint s;

savepoint s;
do $$ begin
  update public.interviews set starts_at = starts_at + interval '1 day' where id = '10000000-0000-4000-8000-0000000000f1';
  raise exception 'FAIL: claude moved an interview';
exception when insufficient_privilege then raise notice 'ok   claude cannot move an interview';
end $$;
rollback to savepoint s;

savepoint s;
do $$ begin
  insert into public.interviews (user_id, application_id, starts_at, ends_at) values
    ('aaaaaaaa-0000-4000-8000-0000000000f1', 'a0000000-0000-4000-8000-0000000000f1', now(), now() + interval '1 hour');
  raise exception 'FAIL: claude added an interview';
exception when insufficient_privilege then raise notice 'ok   claude cannot add an interview';
end $$;
rollback to savepoint s;

delete from public.interviews where id = '10000000-0000-4000-8000-0000000000f1';
select pg_temp.check(
  (select count(*) from public.interviews) = 1,
  'claude cannot delete an interview (no row matched)');

savepoint s;
do $$ begin
  insert into public.job_tags (user_id, name) values ('aaaaaaaa-0000-4000-8000-0000000000f1', 'quant');
  raise exception 'FAIL: claude created a tag';
exception when insufficient_privilege then raise notice 'ok   claude cannot create tags';
end $$;
rollback to savepoint s;

savepoint s;
do $$ begin
  insert into public.application_events (user_id, application_id, to_status) values
    ('aaaaaaaa-0000-4000-8000-0000000000f1', 'a0000000-0000-4000-8000-0000000000f1', 'offer');
  raise exception 'FAIL: claude wrote history';
exception when insufficient_privilege then raise notice 'ok   claude cannot write history directly';
end $$;
rollback to savepoint s;
commit;

-- ============================================================= other user
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"bbbbbbbb-0000-4000-8000-0000000000f2","role":"authenticated"}';
select pg_temp.check(
  (select count(*) from public.applications) = 0 and (select count(*) from public.interviews) = 0,
  'another user sees none of it');
commit;

\echo ALL CHECKS PASSED
