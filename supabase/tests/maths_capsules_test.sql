-- Migration 0029: finished capsules. The browser marks and reopens its own;
-- a connected app (the Claude connector) only reads them.
--
-- Run after stub.sql and every migration (see oauth_scope_test.sql for the
-- commands), from the repository root:
--   psql -d t -f supabase/tests/maths_capsules_test.sql   # ends with ALL CHECKS PASSED
-- It re-applies 0029 first: it must be re-runnable.
\set ON_ERROR_STOP 1
\i supabase/migrations/0029_maths_capsules.sql

insert into auth.users values
  ('aaaaaaaa-0000-4000-8000-0000000000c1', 'ca@x'),
  ('bbbbbbbb-0000-4000-8000-0000000000c2', 'cb@x');

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

-- Fixture, as the owner: someone else has finished a capsule.
insert into public.maths_module_progress (user_id, node_id, module_id) values
  ('bbbbbbbb-0000-4000-8000-0000000000c2', 'suites-reelles', 'probleme');

-- ======================================================= as the browser
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-4000-8000-0000000000c1","role":"authenticated"}';

select pg_temp.check((select count(*) from public.maths_module_progress) = 0, 'the browser sees only its own capsules');
select pg_temp.check(
  pg_temp.touched($$insert into public.maths_module_progress (user_id, node_id, module_id)
                    values ('aaaaaaaa-0000-4000-8000-0000000000c1', 'suites-reelles', 'probleme'),
                           ('aaaaaaaa-0000-4000-8000-0000000000c1', 'suites-reelles', 'borne-sup')$$) = 2,
  'the browser finishes capsules');
-- What the app sends (upsert, ignoreDuplicates): finishing twice keeps the first date.
update public.maths_module_progress set completed_at = '2026-10-01 08:00+00' where module_id = 'probleme';
select pg_temp.check(
  pg_temp.touched($$insert into public.maths_module_progress (user_id, node_id, module_id)
                    values ('aaaaaaaa-0000-4000-8000-0000000000c1', 'suites-reelles', 'probleme')
                    on conflict (user_id, node_id, module_id) do nothing$$) = 0,
  'finishing a capsule twice is a no-op');
select pg_temp.check(
  (select completed_at from public.maths_module_progress where module_id = 'probleme') = '2026-10-01 08:00+00',
  'and keeps the first date');
select pg_temp.check(
  pg_temp.touched($$delete from public.maths_module_progress where module_id = 'borne-sup'$$) = 1,
  'the browser reopens a capsule');
select pg_temp.check(
  pg_temp.fails($$insert into public.maths_module_progress (user_id, node_id, module_id)
                  values ('bbbbbbbb-0000-4000-8000-0000000000c2', 'suites-reelles', 'cauchy')$$),
  'the browser cannot write into another user''s parcours');
commit;

-- ======================================================= as the connector
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-4000-8000-0000000000c1","role":"authenticated","client_id":"claude"}';

select pg_temp.check((select count(*) from public.maths_module_progress) = 1, 'Claude reads finished capsules, own rows only');
select pg_temp.check(
  pg_temp.fails($$insert into public.maths_module_progress (user_id, node_id, module_id)
                  values ('aaaaaaaa-0000-4000-8000-0000000000c1', 'suites-reelles', 'cauchy')$$),
  'Claude cannot finish a capsule');
select pg_temp.check(
  pg_temp.touched($$update public.maths_module_progress set completed_at = now()$$) = 0,
  'Claude cannot change a finished capsule');
select pg_temp.check(
  pg_temp.touched($$delete from public.maths_module_progress$$) = 0,
  'Claude cannot reopen a capsule');
commit;

select 'ALL CHECKS PASSED' as result;
