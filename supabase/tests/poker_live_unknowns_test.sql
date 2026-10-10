-- Migration 0022: unknown players, merging an unknown into a known player,
-- stacks on the session, blinds bought back on a hand.
--
-- Run after stub.sql and every migration (see oauth_scope_test.sql for the
-- commands), from the repository root:
--   psql -d t -f supabase/tests/poker_live_unknowns_test.sql   # ends with ALL CHECKS PASSED
-- It re-applies 0022 first: the migration must be re-runnable.
\set ON_ERROR_STOP 1
\i supabase/migrations/0022_live_unknown_players.sql

insert into auth.users values
  ('aaaaaaaa-0000-4000-8000-0000000000f1', 'u@x'),
  ('bbbbbbbb-0000-4000-8000-0000000000f2', 'v@x');
insert into public.live_players (id, user_id, name, description) values
  ('21000000-0000-4000-8000-0000000000f1', 'aaaaaaaa-0000-4000-8000-0000000000f1', 'Marco', 'bald, glasses');
insert into public.live_players (id, user_id, name, description, known) values
  ('21000000-0000-4000-8000-0000000000f2', 'aaaaaaaa-0000-4000-8000-0000000000f1', 'Unknown 4', 'red cap', false),
  ('21000000-0000-4000-8000-0000000000f3', 'aaaaaaaa-0000-4000-8000-0000000000f1', 'Unknown 6', null, false),
  ('21000000-0000-4000-8000-0000000000f9', 'bbbbbbbb-0000-4000-8000-0000000000f2', 'Theirs', null, false);
insert into public.live_tags (id, user_id, name) values
  ('22000000-0000-4000-8000-0000000000f1', 'aaaaaaaa-0000-4000-8000-0000000000f1', 'fish-u'),
  ('22000000-0000-4000-8000-0000000000f2', 'aaaaaaaa-0000-4000-8000-0000000000f1', 'reg-u');
insert into public.live_player_tags (user_id, player_id, tag_id) values
  ('aaaaaaaa-0000-4000-8000-0000000000f1', '21000000-0000-4000-8000-0000000000f1', '22000000-0000-4000-8000-0000000000f1'),
  ('aaaaaaaa-0000-4000-8000-0000000000f1', '21000000-0000-4000-8000-0000000000f2', '22000000-0000-4000-8000-0000000000f1'),
  ('aaaaaaaa-0000-4000-8000-0000000000f1', '21000000-0000-4000-8000-0000000000f2', '22000000-0000-4000-8000-0000000000f2');
insert into public.live_sessions (id, user_id, venue, small_blind, big_blind, seats, hero_seat, button_seat, started_at, ended_at, cash_out) values
  ('23000000-0000-4000-8000-0000000000f1', 'aaaaaaaa-0000-4000-8000-0000000000f1', 'Barrière', 1, 2, 9, 1, 4, now() - interval '5 days', now() - interval '5 days' + interval '3 hours', 250);
insert into public.live_seat_events (user_id, session_id, seat, kind, player_id, at) values
  ('aaaaaaaa-0000-4000-8000-0000000000f1', '23000000-0000-4000-8000-0000000000f1', 4, 'sit', '21000000-0000-4000-8000-0000000000f2', now() - interval '5 days');
insert into public.live_hands (id, user_id, session_id, button_seat, small_blind, big_blind, seats, played_at) values
  ('24000000-0000-4000-8000-0000000000f1', 'aaaaaaaa-0000-4000-8000-0000000000f1', '23000000-0000-4000-8000-0000000000f1', 1, 1, 2,
   '[{"seat":1,"player_id":null,"stack":null},{"seat":4,"player_id":"21000000-0000-4000-8000-0000000000f2","stack":300}]', now() - interval '5 days');
insert into public.live_player_notes (id, user_id, player_id, session_id, body) values
  ('25000000-0000-4000-8000-0000000000f1', 'aaaaaaaa-0000-4000-8000-0000000000f1', '21000000-0000-4000-8000-0000000000f2',
   '23000000-0000-4000-8000-0000000000f1', 'calls three streets with any pair');

create function pg_temp.check(ok boolean, what text) returns void language plpgsql as $$
begin
  if not ok then raise exception 'FAIL: %', what; end if;
  raise notice 'ok   %', what;
end $$;
grant execute on function pg_temp.check(boolean, text) to authenticated, anon;

select pg_temp.check(
  (select known from public.live_players where id = '21000000-0000-4000-8000-0000000000f1'),
  'players are known unless said otherwise');

select pg_temp.check(
  (select posts from public.live_hands where id = '24000000-0000-4000-8000-0000000000f1') = '[]'::jsonb,
  'a hand has no blinds bought back by default');

select pg_temp.check(
  (select stacks from public.live_sessions where id = '23000000-0000-4000-8000-0000000000f1') = '{}'::jsonb,
  'a session starts with no stacks');

do $$ begin
  update public.live_sessions set stacks = '[250]' where id = '23000000-0000-4000-8000-0000000000f1';
  raise exception 'FAIL: stacks that are not seat → chips';
exception when check_violation then raise notice 'ok   stacks are an object, seat → chips';
end $$;

do $$ begin
  update public.live_hands set posts = '{"seat": 2}' where id = '24000000-0000-4000-8000-0000000000f1';
  raise exception 'FAIL: posts that are not a list';
exception when check_violation then raise notice 'ok   posts must be a list';
end $$;

-- ================================================ as a connected app (Claude)
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-4000-8000-0000000000f1","role":"authenticated","client_id":"claude-client"}';
savepoint s;
do $$ begin
  perform public.live_merge_players('21000000-0000-4000-8000-0000000000f2', '21000000-0000-4000-8000-0000000000f1');
  raise exception 'FAIL: claude merged players';
exception when insufficient_privilege then raise notice 'ok   claude cannot merge players';
end $$;
rollback to savepoint s;
commit;

-- ======================================================== as someone else
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"bbbbbbbb-0000-4000-8000-0000000000f2","role":"authenticated"}';
savepoint s;
do $$ begin
  perform public.live_merge_players('21000000-0000-4000-8000-0000000000f9', '21000000-0000-4000-8000-0000000000f1');
  raise exception 'FAIL: merged into someone else''s player';
exception when no_data_found then raise notice 'ok   another user''s player cannot be merged into';
end $$;
rollback to savepoint s;
commit;

-- ======================================================= anonymous callers
begin;
set local role anon;
do $$ begin
  perform public.live_merge_players('21000000-0000-4000-8000-0000000000f2', '21000000-0000-4000-8000-0000000000f1');
  raise exception 'FAIL: anon called the merge';
exception when insufficient_privilege then raise notice 'ok   anon cannot call the merge';
end $$;
commit;

-- ============================================================ as the owner
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-4000-8000-0000000000f1","role":"authenticated"}';

savepoint s;
do $$ begin
  perform public.live_merge_players('21000000-0000-4000-8000-0000000000f1', '21000000-0000-4000-8000-0000000000f1');
  raise exception 'FAIL: merged a player into themselves';
exception when invalid_parameter_value then raise notice 'ok   a player is not merged into themselves';
end $$;
rollback to savepoint s;

update public.live_players set name = 'Red cap', known = true where id = '21000000-0000-4000-8000-0000000000f3';
select pg_temp.check(
  (select known and name = 'Red cap' from public.live_players where id = '21000000-0000-4000-8000-0000000000f3'),
  'an unknown is named and becomes known');

select public.live_merge_players('21000000-0000-4000-8000-0000000000f2', '21000000-0000-4000-8000-0000000000f1');

select pg_temp.check(
  not exists (select 1 from public.live_players where id = '21000000-0000-4000-8000-0000000000f2'),
  'the unknown is gone after the merge');
select pg_temp.check(
  (select player_id from public.live_seat_events where session_id = '23000000-0000-4000-8000-0000000000f1' and seat = 4)
    = '21000000-0000-4000-8000-0000000000f1',
  'their seat in the log is Marco''s');
select pg_temp.check(
  (select player_id from public.live_player_notes where id = '25000000-0000-4000-8000-0000000000f1')
    = '21000000-0000-4000-8000-0000000000f1'
  and (select source from public.live_player_notes where id = '25000000-0000-4000-8000-0000000000f1') = 'app',
  'their notes are Marco''s, still written by Arthur');
select pg_temp.check(
  (select count(*) from public.live_player_tags where player_id = '21000000-0000-4000-8000-0000000000f1') = 2,
  'their tags join Marco''s, without doubles');
select pg_temp.check(
  (select seats -> 1 ->> 'player_id' from public.live_hands where id = '24000000-0000-4000-8000-0000000000f1')
    = '21000000-0000-4000-8000-0000000000f1'
  and (select (seats -> 1 ->> 'stack')::int from public.live_hands where id = '24000000-0000-4000-8000-0000000000f1') = 300
  and (select seats -> 0 ->> 'seat' from public.live_hands where id = '24000000-0000-4000-8000-0000000000f1') = '1',
  'their hands name Marco, in the same seat order, stacks kept');
select pg_temp.check(
  (select description from public.live_players where id = '21000000-0000-4000-8000-0000000000f1') = E'bald, glasses\nred cap',
  'their description is added to Marco''s');
commit;

\echo ALL CHECKS PASSED
