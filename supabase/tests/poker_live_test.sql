-- Migration 0018: /poker/live — one running session, hand numbering, seat
-- range, references to someone else's rows, note authorship, and what a
-- connected app (the Claude connector) may touch.
--
-- Run after stub.sql and every migration (see oauth_scope_test.sql for the
-- commands), from the repository root:
--   psql -d t -f supabase/tests/poker_live_test.sql   # ends with ALL CHECKS PASSED
-- It re-applies 0018 first: the migration must be re-runnable.
\set ON_ERROR_STOP 1
\i supabase/migrations/0018_poker_live.sql

insert into auth.users values
  ('aaaaaaaa-0000-4000-8000-0000000000e1', 'p@x'),
  ('bbbbbbbb-0000-4000-8000-0000000000e2', 'q@x');
insert into public.live_players (id, user_id, name) values
  ('11000000-0000-4000-8000-0000000000e1', 'aaaaaaaa-0000-4000-8000-0000000000e1', 'Marco'),
  ('11000000-0000-4000-8000-0000000000e9', 'bbbbbbbb-0000-4000-8000-0000000000e2', 'Theirs');
insert into public.live_tags (id, user_id, name) values
  ('12000000-0000-4000-8000-0000000000e1', 'aaaaaaaa-0000-4000-8000-0000000000e1', 'fish'),
  ('12000000-0000-4000-8000-0000000000e2', 'aaaaaaaa-0000-4000-8000-0000000000e1', 'reg'),
  ('12000000-0000-4000-8000-0000000000e9', 'bbbbbbbb-0000-4000-8000-0000000000e2', 'theirs');
insert into public.live_sessions (id, user_id, venue, small_blind, big_blind, seats, hero_seat, started_at, ended_at, cash_out) values
  ('13000000-0000-4000-8000-0000000000e1', 'aaaaaaaa-0000-4000-8000-0000000000e1', 'Enghien', 1, 2, 9, 4, now() - interval '3 hours', null, null),
  ('13000000-0000-4000-8000-0000000000e2', 'aaaaaaaa-0000-4000-8000-0000000000e1', 'Aviation', 1, 2, 10, 1, now() - interval '3 days', now() - interval '3 days' + interval '4 hours', 380),
  ('13000000-0000-4000-8000-0000000000e9', 'bbbbbbbb-0000-4000-8000-0000000000e2', 'Elsewhere', 1, 2, 9, 1, now(), null, null);

create function pg_temp.check(ok boolean, what text) returns void language plpgsql as $$
begin
  if not ok then raise exception 'FAIL: %', what; end if;
  raise notice 'ok   %', what;
end $$;
grant execute on function pg_temp.check(boolean, text) to authenticated, anon;

-- ======================================================= as the owner (browser)
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-4000-8000-0000000000e1","role":"authenticated"}';

savepoint s;
do $$ begin
  insert into public.live_sessions (user_id, venue, small_blind, big_blind, hero_seat) values
    ('aaaaaaaa-0000-4000-8000-0000000000e1', 'Second', 1, 2, 3);
  raise exception 'FAIL: two sessions running at once';
exception when unique_violation then raise notice 'ok   only one session runs at a time';
end $$;
rollback to savepoint s;

savepoint s;
do $$ begin
  update public.live_sessions set ended_at = now() where id = '13000000-0000-4000-8000-0000000000e1';
  raise exception 'FAIL: ended without a cash-out';
exception when check_violation then raise notice 'ok   a session cannot end without a cash-out';
end $$;
rollback to savepoint s;

insert into public.live_session_events (user_id, session_id, kind, amount) values
  ('aaaaaaaa-0000-4000-8000-0000000000e1', '13000000-0000-4000-8000-0000000000e1', 'buy_in', 200),
  ('aaaaaaaa-0000-4000-8000-0000000000e1', '13000000-0000-4000-8000-0000000000e1', 'rebuy', 100);
insert into public.live_session_events (user_id, session_id, kind) values
  ('aaaaaaaa-0000-4000-8000-0000000000e1', '13000000-0000-4000-8000-0000000000e1', 'break_start');
select pg_temp.check(
  (select count(*) from public.live_session_events where session_id = '13000000-0000-4000-8000-0000000000e1') = 3,
  'buy-in, rebuy and break are logged');

savepoint s;
do $$ begin
  insert into public.live_session_events (user_id, session_id, kind) values
    ('aaaaaaaa-0000-4000-8000-0000000000e1', '13000000-0000-4000-8000-0000000000e1', 'rebuy');
  raise exception 'FAIL: rebuy without an amount';
exception when check_violation then raise notice 'ok   a rebuy needs an amount';
end $$;
rollback to savepoint s;

insert into public.live_seat_events (user_id, session_id, seat, kind, player_id) values
  ('aaaaaaaa-0000-4000-8000-0000000000e1', '13000000-0000-4000-8000-0000000000e1', 7, 'sit', '11000000-0000-4000-8000-0000000000e1'),
  ('aaaaaaaa-0000-4000-8000-0000000000e1', '13000000-0000-4000-8000-0000000000e1', 2, 'sit', null);
select pg_temp.check(
  (select count(*) from public.live_seat_events where session_id = '13000000-0000-4000-8000-0000000000e1') = 2,
  'a known player and an unknown one sit');

savepoint s;
do $$ begin
  insert into public.live_seat_events (user_id, session_id, seat, kind) values
    ('aaaaaaaa-0000-4000-8000-0000000000e1', '13000000-0000-4000-8000-0000000000e1', 10, 'sit');
  raise exception 'FAIL: seat 10 at a 9-seat table';
exception when check_violation then raise notice 'ok   seat 10 does not exist at a 9-seat table';
end $$;
rollback to savepoint s;

insert into public.live_seat_events (user_id, session_id, seat, kind) values
  ('aaaaaaaa-0000-4000-8000-0000000000e1', '13000000-0000-4000-8000-0000000000e2', 10, 'sit');
select pg_temp.check(true, 'seat 10 exists at a 10-seat table');

savepoint s;
do $$ begin
  insert into public.live_seat_events (user_id, session_id, seat, kind, player_id) values
    ('aaaaaaaa-0000-4000-8000-0000000000e1', '13000000-0000-4000-8000-0000000000e1', 5, 'sit', '11000000-0000-4000-8000-0000000000e9');
  raise exception 'FAIL: someone else''s player was seated';
exception when insufficient_privilege then raise notice 'ok   someone else''s player cannot be seated';
end $$;
rollback to savepoint s;

savepoint s;
do $$ begin
  insert into public.live_seat_events (user_id, session_id, seat, kind) values
    ('aaaaaaaa-0000-4000-8000-0000000000e1', '13000000-0000-4000-8000-0000000000e9', 5, 'sit');
  raise exception 'FAIL: wrote into someone else''s session';
exception when insufficient_privilege then raise notice 'ok   someone else''s session cannot be written to';
end $$;
rollback to savepoint s;

insert into public.live_hands (id, user_id, session_id, button_seat, hero_seat, small_blind, big_blind, seats, actions) values
  ('14000000-0000-4000-8000-0000000000e1', 'aaaaaaaa-0000-4000-8000-0000000000e1', '13000000-0000-4000-8000-0000000000e1',
   7, 4, 1, 2, '[{"seat":4},{"seat":7,"player_id":"11000000-0000-4000-8000-0000000000e1"}]', '[]'),
  ('14000000-0000-4000-8000-0000000000e2', 'aaaaaaaa-0000-4000-8000-0000000000e1', '13000000-0000-4000-8000-0000000000e1',
   4, 4, 1, 2, '[{"seat":4},{"seat":7}]', '[]'),
  ('14000000-0000-4000-8000-0000000000e3', 'aaaaaaaa-0000-4000-8000-0000000000e1', '13000000-0000-4000-8000-0000000000e2',
   1, 1, 1, 2, '[{"seat":1},{"seat":7}]', '[]');
select pg_temp.check(
  (select array_agg(number order by id) from public.live_hands) = array[1, 2, 1],
  'hands are numbered within their session');
select pg_temp.check(
  (select count(*) from public.live_hands where seats @> '[{"player_id":"11000000-0000-4000-8000-0000000000e1"}]') = 1,
  'a player''s hands are found through the seats');

savepoint s;
do $$ begin
  insert into public.live_hands (user_id, session_id, button_seat, small_blind, big_blind, seats, hero_cards) values
    ('aaaaaaaa-0000-4000-8000-0000000000e1', '13000000-0000-4000-8000-0000000000e1', 1, 1, 2, '[{"seat":1},{"seat":2}]', 'AhX');
  raise exception 'FAIL: bad cards accepted';
exception when check_violation then raise notice 'ok   hero cards must be two cards';
end $$;
rollback to savepoint s;

insert into public.live_player_tags (user_id, player_id, tag_id) values
  ('aaaaaaaa-0000-4000-8000-0000000000e1', '11000000-0000-4000-8000-0000000000e1', '12000000-0000-4000-8000-0000000000e1');

savepoint s;
do $$ begin
  insert into public.live_player_tags (user_id, player_id, tag_id) values
    ('aaaaaaaa-0000-4000-8000-0000000000e1', '11000000-0000-4000-8000-0000000000e1', '12000000-0000-4000-8000-0000000000e9');
  raise exception 'FAIL: someone else''s tag was put on a player';
exception when insufficient_privilege then raise notice 'ok   someone else''s tag cannot be used';
end $$;
rollback to savepoint s;

insert into public.live_player_notes (id, user_id, player_id, session_id, hand_id, body, source) values
  ('15000000-0000-4000-8000-0000000000e1', 'aaaaaaaa-0000-4000-8000-0000000000e1', '11000000-0000-4000-8000-0000000000e1',
   '13000000-0000-4000-8000-0000000000e1', '14000000-0000-4000-8000-0000000000e1', 'limps big pairs', 'claude');
select pg_temp.check(
  (select source from public.live_player_notes where id = '15000000-0000-4000-8000-0000000000e1') = 'app',
  'a note written in the app is marked as such, whatever the caller says');

delete from public.live_hands where id = '14000000-0000-4000-8000-0000000000e1';
select pg_temp.check(
  (select hand_id is null and session_id is not null from public.live_player_notes where id = '15000000-0000-4000-8000-0000000000e1'),
  'a note outlives the hand it was taken on');
commit;

-- ========================================================= as Claude (OAuth)
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-4000-8000-0000000000e1","role":"authenticated","client_id":"claude-client"}';

select pg_temp.check(
  (select count(*) from public.live_sessions) = 2
  and (select count(*) from public.live_hands) = 2
  and (select count(*) from public.live_seat_events) = 3
  and (select count(*) from public.live_session_events) = 3
  and (select count(*) from public.live_players) = 1
  and (select count(*) from public.live_tags) = 2,
  'claude reads sessions, hands, the table, money, players and tags');

insert into public.live_player_notes (id, user_id, player_id, body) values
  ('15000000-0000-4000-8000-0000000000e2', 'aaaaaaaa-0000-4000-8000-0000000000e1', '11000000-0000-4000-8000-0000000000e1', 'over-folds to 3-bets');
select pg_temp.check(
  (select source from public.live_player_notes where id = '15000000-0000-4000-8000-0000000000e2') = 'claude',
  'claude adds a note, marked as Claude''s');

update public.live_player_notes set body = 'over-folds to 3-bets OOP' where id = '15000000-0000-4000-8000-0000000000e2';
select pg_temp.check(
  (select body from public.live_player_notes where id = '15000000-0000-4000-8000-0000000000e2') = 'over-folds to 3-bets OOP',
  'claude edits its own note');

update public.live_player_notes set body = 'rewritten' where id = '15000000-0000-4000-8000-0000000000e1';
select pg_temp.check(
  (select body from public.live_player_notes where id = '15000000-0000-4000-8000-0000000000e1') = 'limps big pairs',
  'claude cannot edit Arthur''s note (no row matched)');

delete from public.live_player_notes where id = '15000000-0000-4000-8000-0000000000e1';
select pg_temp.check(
  (select count(*) from public.live_player_notes where id = '15000000-0000-4000-8000-0000000000e1') = 1,
  'claude cannot delete Arthur''s note (no row matched)');

insert into public.live_player_tags (user_id, player_id, tag_id) values
  ('aaaaaaaa-0000-4000-8000-0000000000e1', '11000000-0000-4000-8000-0000000000e1', '12000000-0000-4000-8000-0000000000e2');
delete from public.live_player_tags where tag_id = '12000000-0000-4000-8000-0000000000e1';
select pg_temp.check(
  (select array_agg(tag_id) from public.live_player_tags) = array['12000000-0000-4000-8000-0000000000e2'::uuid],
  'claude tags and untags a player');

savepoint s;
do $$ begin
  insert into public.live_tags (user_id, name) values ('aaaaaaaa-0000-4000-8000-0000000000e1', 'maniac');
  raise exception 'FAIL: claude created a tag';
exception when insufficient_privilege then raise notice 'ok   claude cannot create tags';
end $$;
rollback to savepoint s;

savepoint s;
do $$ begin
  insert into public.live_players (user_id, name) values ('aaaaaaaa-0000-4000-8000-0000000000e1', 'New guy');
  raise exception 'FAIL: claude created a player';
exception when insufficient_privilege then raise notice 'ok   claude cannot create players';
end $$;
rollback to savepoint s;

update public.live_players set name = 'renamed';
select pg_temp.check((select name from public.live_players) = 'Marco', 'claude cannot rename a player (no row matched)');

update public.live_sessions set cash_out = 9999 where id = '13000000-0000-4000-8000-0000000000e2';
select pg_temp.check(
  (select cash_out from public.live_sessions where id = '13000000-0000-4000-8000-0000000000e2') = 380,
  'claude cannot change a session (no row matched)');

savepoint s;
do $$ begin
  insert into public.live_seat_events (user_id, session_id, seat, kind) values
    ('aaaaaaaa-0000-4000-8000-0000000000e1', '13000000-0000-4000-8000-0000000000e1', 3, 'sit');
  raise exception 'FAIL: claude wrote to the table';
exception when insufficient_privilege then raise notice 'ok   claude cannot write to the table';
end $$;
rollback to savepoint s;

savepoint s;
do $$ begin
  insert into public.live_hands (user_id, session_id, button_seat, small_blind, big_blind, seats) values
    ('aaaaaaaa-0000-4000-8000-0000000000e1', '13000000-0000-4000-8000-0000000000e1', 1, 1, 2, '[{"seat":1},{"seat":2}]');
  raise exception 'FAIL: claude added a hand';
exception when insufficient_privilege then raise notice 'ok   claude cannot add hands';
end $$;
rollback to savepoint s;

delete from public.live_hands;
delete from public.live_session_events;
select pg_temp.check(
  (select count(*) from public.live_hands) = 2 and (select count(*) from public.live_session_events) = 3,
  'claude cannot delete hands or money events (no row matched)');
commit;

-- ============================================================= other user
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"bbbbbbbb-0000-4000-8000-0000000000e2","role":"authenticated"}';
select pg_temp.check(
  (select count(*) from public.live_hands) = 0
  and (select count(*) from public.live_player_notes) = 0
  and (select count(*) from public.live_sessions) = 1,
  'another user sees none of it');
commit;

\echo ALL CHECKS PASSED
