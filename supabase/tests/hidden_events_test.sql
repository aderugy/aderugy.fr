-- Migration 0023: hiding events mirrored from calendars — the rules, who may
-- write them, and the week totals leaving hidden events out.
--
-- Run after stub.sql and every migration (see oauth_scope_test.sql for the
-- commands), from the repository root:
--   psql -d t -f supabase/tests/hidden_events_test.sql   # ends with ALL CHECKS PASSED
-- It re-applies 0023 first: the migration must be re-runnable.
\set ON_ERROR_STOP 1
\i supabase/migrations/0023_hidden_external_events.sql

insert into auth.users values
  ('aaaaaaaa-0000-4000-8000-0000000000d1', 'h@x'),
  ('bbbbbbbb-0000-4000-8000-0000000000d2', 'k@x');
insert into public.categories (id, user_id, name, position) values
  ('31000000-0000-4000-8000-0000000000d1', 'aaaaaaaa-0000-4000-8000-0000000000d1', 'School', 0),
  ('31000000-0000-4000-8000-0000000000d9', 'bbbbbbbb-0000-4000-8000-0000000000d2', 'Theirs', 0);
insert into public.calendar_sources (id, user_id, external_id, display_name, color, category_id, enabled) values
  ('32000000-0000-4000-8000-0000000000d1', 'aaaaaaaa-0000-4000-8000-0000000000d1', 'epita', 'EPITA', '#336699', '31000000-0000-4000-8000-0000000000d1', true),
  ('32000000-0000-4000-8000-0000000000d9', 'bbbbbbbb-0000-4000-8000-0000000000d2', 'theirs', 'Theirs', '#336699', '31000000-0000-4000-8000-0000000000d9', true);
insert into public.weeks (id, user_id, week_start) values
  ('33000000-0000-4000-8000-0000000000d1', 'aaaaaaaa-0000-4000-8000-0000000000d1', '2026-10-12');
-- Three 2-hour classes: two "Algèbre", one "Stats".
insert into public.external_events (user_id, calendar_source_id, external_event_id, title, starts_at, ends_at) values
  ('aaaaaaaa-0000-4000-8000-0000000000d1', '32000000-0000-4000-8000-0000000000d1', 'alg-1', 'Algèbre', '2026-10-12T08:00Z', '2026-10-12T10:00Z'),
  ('aaaaaaaa-0000-4000-8000-0000000000d1', '32000000-0000-4000-8000-0000000000d1', 'alg-2', 'Algèbre', '2026-10-14T08:00Z', '2026-10-14T10:00Z'),
  ('aaaaaaaa-0000-4000-8000-0000000000d1', '32000000-0000-4000-8000-0000000000d1', 'stats-1', 'Stats', '2026-10-13T08:00Z', '2026-10-13T10:00Z');

create function pg_temp.check(ok boolean, what text) returns void language plpgsql as $$
begin
  if not ok then raise exception 'FAIL: %', what; end if;
  raise notice 'ok   %', what;
end $$;
grant execute on function pg_temp.check(boolean, text) to authenticated, anon;

create function pg_temp.school_minutes() returns int language sql as $$
  select coalesce(sum(external_minutes), 0)::int from public.week_category_minutes
   where week_id = '33000000-0000-4000-8000-0000000000d1' and category_id = '31000000-0000-4000-8000-0000000000d1' $$;
grant execute on function pg_temp.school_minutes() to authenticated;

do $$ begin
  insert into public.hidden_external_events (user_id, calendar_source_id, external_event_id, title) values
    ('aaaaaaaa-0000-4000-8000-0000000000d1', '32000000-0000-4000-8000-0000000000d1', 'alg-1', 'Algèbre');
  raise exception 'FAIL: a rule with both an event and a title';
exception when check_violation then raise notice 'ok   a rule is one event or one title, not both';
end $$;

-- ============================================================ as the owner
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-4000-8000-0000000000d1","role":"authenticated"}';

select pg_temp.check(pg_temp.school_minutes() = 360, 'three classes count 6 hours');

insert into public.hidden_external_events (id, user_id, calendar_source_id, external_event_id, label) values
  ('34000000-0000-4000-8000-0000000000d1', 'aaaaaaaa-0000-4000-8000-0000000000d1', '32000000-0000-4000-8000-0000000000d1', 'stats-1', 'Stats');
select pg_temp.check(pg_temp.school_minutes() = 240, 'hiding one event takes it out of the totals');

insert into public.hidden_external_events (id, user_id, calendar_source_id, title) values
  ('34000000-0000-4000-8000-0000000000d2', 'aaaaaaaa-0000-4000-8000-0000000000d1', '32000000-0000-4000-8000-0000000000d1', 'Algèbre');
select pg_temp.check(pg_temp.school_minutes() = 0, 'hiding a title takes out every event of it');

savepoint s;
do $$ begin
  insert into public.hidden_external_events (user_id, calendar_source_id, title) values
    ('aaaaaaaa-0000-4000-8000-0000000000d1', '32000000-0000-4000-8000-0000000000d1', 'Algèbre');
  raise exception 'FAIL: the same title hidden twice';
exception when unique_violation then raise notice 'ok   a title is hidden once';
end $$;
rollback to savepoint s;

savepoint s;
do $$ begin
  insert into public.hidden_external_events (user_id, calendar_source_id, title) values
    ('aaaaaaaa-0000-4000-8000-0000000000d1', '32000000-0000-4000-8000-0000000000d9', 'Anything');
  raise exception 'FAIL: a rule on someone else''s calendar';
exception when insufficient_privilege then raise notice 'ok   a rule only points at your own calendars';
end $$;
rollback to savepoint s;

delete from public.hidden_external_events where id = '34000000-0000-4000-8000-0000000000d2';
select pg_temp.check(pg_temp.school_minutes() = 240, 'showing a title again brings its events back');
commit;

-- A resync that wipes and rebuilds the mirror does not bring a hidden event back.
delete from public.external_events where external_event_id = 'stats-1';
insert into public.external_events (user_id, calendar_source_id, external_event_id, title, starts_at, ends_at) values
  ('aaaaaaaa-0000-4000-8000-0000000000d1', '32000000-0000-4000-8000-0000000000d1', 'stats-1', 'Stats', '2026-10-13T08:00Z', '2026-10-13T10:00Z');
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-4000-8000-0000000000d1","role":"authenticated"}';
select pg_temp.check(pg_temp.school_minutes() = 240, 'a hidden event stays hidden through a rebuilt mirror');
commit;

-- ================================================ as a connected app (Claude)
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-4000-8000-0000000000d1","role":"authenticated","client_id":"claude-client"}';
select pg_temp.check((select count(*) from public.hidden_external_events) = 1, 'claude reads the hidden events');
savepoint s;
do $$ begin
  insert into public.hidden_external_events (user_id, calendar_source_id, title) values
    ('aaaaaaaa-0000-4000-8000-0000000000d1', '32000000-0000-4000-8000-0000000000d1', 'Stats');
  raise exception 'FAIL: claude hid an event';
exception when insufficient_privilege then raise notice 'ok   claude cannot hide events';
end $$;
rollback to savepoint s;
delete from public.hidden_external_events;
select pg_temp.check((select count(*) from public.hidden_external_events) = 1, 'claude cannot show them again (no row matched)');
commit;

-- ======================================================== as someone else
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"bbbbbbbb-0000-4000-8000-0000000000d2","role":"authenticated"}';
select pg_temp.check((select count(*) from public.hidden_external_events) = 0, 'another user sees none of it');
commit;

\echo ALL CHECKS PASSED
