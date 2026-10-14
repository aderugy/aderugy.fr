-- Migrations 0023 and 0025: /flashcards — ownership across tables, the rating
-- and undo RPCs, deck deletion, tag renaming, the aggregates, and what a
-- connected app (the Claude connector) may touch: everything but the review
-- journal, ratings and images (0025).
--
-- Run after stub.sql and every migration (see oauth_scope_test.sql for the
-- commands), from the repository root:
--   psql -d t -f supabase/tests/flashcards_test.sql   # ends with ALL CHECKS PASSED
-- It re-applies 0023 then 0025 first: both must be re-runnable, in that order.
\set ON_ERROR_STOP 1
\i supabase/migrations/0023_flashcards.sql
\i supabase/migrations/0025_flashcards_connector_crud.sql

insert into auth.users values
  ('aaaaaaaa-0000-4000-8000-0000000000c1', 'fa@x'),
  ('bbbbbbbb-0000-4000-8000-0000000000c2', 'fb@x');

create function pg_temp.check(ok boolean, what text) returns void language plpgsql as $$
begin
  if not ok then raise exception 'FAIL: %', what; end if;
  raise notice 'ok   %', what;
end $$;

-- True when the statement fails (optionally with a given SQLSTATE).
create function pg_temp.fails(stmt text, code text default null) returns boolean language plpgsql as $$
begin
  execute stmt;
  return false;
exception when others then
  return code is null or sqlstate = code;
end $$;

-- Rows a statement touched (0 when RLS hid them).
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

-- Fixtures, as the owner (no role switch: RLS off for the superuser).
insert into public.fc_decks (id, user_id, parent_id, name) values
  ('d0000000-0000-4000-8000-0000000000c1', 'aaaaaaaa-0000-4000-8000-0000000000c1', null, 'Maths'),
  ('d0000000-0000-4000-8000-0000000000c2', 'aaaaaaaa-0000-4000-8000-0000000000c1', 'd0000000-0000-4000-8000-0000000000c1', 'Lois'),
  ('d0000000-0000-4000-8000-0000000000c3', 'aaaaaaaa-0000-4000-8000-0000000000c1', null, 'Poker'),
  ('d0000000-0000-4000-8000-0000000000c9', 'bbbbbbbb-0000-4000-8000-0000000000c2', null, 'Theirs');
insert into public.fc_notes (id, user_id, deck_id, kind, front, back, tags) values
  ('a0000000-0000-4000-8000-0000000000c1', 'aaaaaaaa-0000-4000-8000-0000000000c1', 'd0000000-0000-4000-8000-0000000000c2',
   'reversed', 'Espérance d''une loi de Poisson', '$\lambda$', '{maths::lois,poisson}'),
  ('a0000000-0000-4000-8000-0000000000c2', 'aaaaaaaa-0000-4000-8000-0000000000c1', 'd0000000-0000-4000-8000-0000000000c3',
   'basic', 'MDF face à un pot-size bet', '50 %', '{poker::mdf}');
insert into public.fc_cards (id, user_id, note_id, ord, state, stability, difficulty, due, last_review, reps, lapses) values
  ('c0000000-0000-4000-8000-0000000000c1', 'aaaaaaaa-0000-4000-8000-0000000000c1', 'a0000000-0000-4000-8000-0000000000c1', 0,
   'review', 10, 5, '2026-10-14 02:00+00', '2026-10-04 08:00+00', 3, 7),
  ('c0000000-0000-4000-8000-0000000000c2', 'aaaaaaaa-0000-4000-8000-0000000000c1', 'a0000000-0000-4000-8000-0000000000c1', 1,
   'new', 0, 0, '2026-10-14 02:00+00', null, 0, 0),
  ('c0000000-0000-4000-8000-0000000000c3', 'aaaaaaaa-0000-4000-8000-0000000000c1', 'a0000000-0000-4000-8000-0000000000c2', 0,
   'learning', 3, 5, '2026-10-14 08:05+00', '2026-10-14 08:00+00', 1, 0);

-- ======================================================= as the owner (browser)
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-4000-8000-0000000000c1","role":"authenticated"}';

-- decks
select pg_temp.check(
  pg_temp.fails($$update public.fc_decks set parent_id = 'd0000000-0000-4000-8000-0000000000c2'
                  where id = 'd0000000-0000-4000-8000-0000000000c1'$$, '23514'),
  'a deck cannot move inside its own sub-deck');
select pg_temp.check(
  pg_temp.fails($$insert into public.fc_decks (user_id, parent_id, name)
                  values ('aaaaaaaa-0000-4000-8000-0000000000c1', 'd0000000-0000-4000-8000-0000000000c9', 'x')$$, '23503'),
  'a deck cannot sit under someone else''s deck');
select pg_temp.check(
  pg_temp.fails($$insert into public.fc_decks (user_id, name) values ('aaaaaaaa-0000-4000-8000-0000000000c1', 'maths')$$, '23505'),
  'sibling deck names are unique, any case');
select pg_temp.check(
  pg_temp.fails($$insert into public.fc_decks (user_id, name) values ('aaaaaaaa-0000-4000-8000-0000000000c1', 'A::B')$$, '23514'),
  'a deck name cannot contain the path separator');

-- notes
select pg_temp.check(
  pg_temp.fails($$insert into public.fc_notes (user_id, deck_id, front)
                  values ('aaaaaaaa-0000-4000-8000-0000000000c1', 'd0000000-0000-4000-8000-0000000000c9', 'q')$$, '23503'),
  'a note cannot go into someone else''s deck');
select pg_temp.check(
  pg_temp.fails($$insert into public.fc_notes (user_id, deck_id, front, tags)
                  values ('aaaaaaaa-0000-4000-8000-0000000000c1', 'd0000000-0000-4000-8000-0000000000c1', 'q', '{"two words"}')$$, '23514'),
  'tags are single words');
select pg_temp.check(
  pg_temp.fails($$update public.fc_notes set created_by = 'claude' where id = 'a0000000-0000-4000-8000-0000000000c1'$$, '42501'),
  'who wrote a note cannot be changed');

insert into public.fc_notes (id, user_id, deck_id, front, inbox) values
  ('a0000000-0000-4000-8000-0000000000c3', 'aaaaaaaa-0000-4000-8000-0000000000c1', 'd0000000-0000-4000-8000-0000000000c1', 'pending', true);
select pg_temp.check(
  pg_temp.fails($$insert into public.fc_cards (user_id, note_id, ord)
                  values ('aaaaaaaa-0000-4000-8000-0000000000c1', 'a0000000-0000-4000-8000-0000000000c3', 0)$$, '23514'),
  'a note in the inbox has no cards');
update public.fc_notes set inbox = false where id = 'a0000000-0000-4000-8000-0000000000c3';
insert into public.fc_cards (user_id, note_id, ord)
  values ('aaaaaaaa-0000-4000-8000-0000000000c1', 'a0000000-0000-4000-8000-0000000000c3', 0);
select pg_temp.check(true, 'accepting the note lets its cards be created');

-- rating
select pg_temp.check(
  pg_temp.fails($$select public.fc_save_review('c0000000-0000-4000-8000-0000000000c1', 2, 'review', 3, '2026-10-14', 4000, 10,
                  'review', 0, 25, 4.8, '2026-11-08 03:00+00', '2026-10-14 08:00+00', 4, 7)$$, 'FC001'),
  'a rating computed from a stale card is refused');
select pg_temp.check(
  (select reps from public.fc_cards where id = 'c0000000-0000-4000-8000-0000000000c1') = 3,
  'and nothing was written');

select public.fc_save_review('c0000000-0000-4000-8000-0000000000c1', 3, 'review', 3, '2026-10-14', 4000, 10,
  'review', 0, 25, 4.8, '2026-11-08 03:00+00', '2026-10-14 08:00+00', 4, 7);
select pg_temp.check(
  (select stability = 25 and reps = 4 and due = '2026-11-08 03:00+00' from public.fc_cards
    where id = 'c0000000-0000-4000-8000-0000000000c1'),
  'a rating writes the card''s new state');
select pg_temp.check(
  (select count(*) = 1 and bool_and(state_before = 'review' and stability_before = 10 and stability_after = 25
                                    and deck_id = 'd0000000-0000-4000-8000-0000000000c2'
                                    and (before ->> 'reps')::int = 3)
     from public.fc_reviews where card_id = 'c0000000-0000-4000-8000-0000000000c1'),
  'and journals the card as it was, with its deck');

-- a lapse crossing the leech threshold
select public.fc_save_review('c0000000-0000-4000-8000-0000000000c1', 4, 'review', 1, '2026-10-14', 3000, 0,
  'relearning', 0, 4, 6, '2026-10-14 08:10+00', '2026-10-14 08:00+00', 5, 8, true);
select pg_temp.check(
  (select suspended from public.fc_cards where id = 'c0000000-0000-4000-8000-0000000000c1')
  and (select 'leech' = any (tags) from public.fc_notes where id = 'a0000000-0000-4000-8000-0000000000c1'),
  'a leech is suspended and its note tagged');

select pg_temp.check(
  pg_temp.fails(format('select public.fc_undo_review(%s)',
    (select min(id) from public.fc_reviews where card_id = 'c0000000-0000-4000-8000-0000000000c1'))),
  'only the latest rating of a card can be undone');
select public.fc_undo_review((select max(id) from public.fc_reviews where card_id = 'c0000000-0000-4000-8000-0000000000c1'));
select pg_temp.check(
  (select not suspended and state = 'review' and stability = 25 and reps = 4 and lapses = 7
     from public.fc_cards where id = 'c0000000-0000-4000-8000-0000000000c1')
  and (select not ('leech' = any (tags)) from public.fc_notes where id = 'a0000000-0000-4000-8000-0000000000c1')
  and (select count(*) = 1 from public.fc_reviews where card_id = 'c0000000-0000-4000-8000-0000000000c1'),
  'undo restores the card, the tag and the journal');

-- cram: journalled, state untouched, reps not checked
select public.fc_save_review('c0000000-0000-4000-8000-0000000000c3', 0, 'cram', 1, '2026-10-14', 2000, 0,
  'review', 0, 99, 9, '2030-01-01 00:00+00', '2026-10-14 08:00+00', 99, 99);
select pg_temp.check(
  (select state = 'learning' and stability = 3 and reps = 1 from public.fc_cards where id = 'c0000000-0000-4000-8000-0000000000c3')
  and (select kind = 'cram' and state_after = 'learning' from public.fc_reviews
        where card_id = 'c0000000-0000-4000-8000-0000000000c3'),
  'a cram rating is journalled and changes nothing else');

-- aggregates
select pg_temp.check(
  (select reviews = 1 and cram = 1 and ms = 6000 and retention_pass = 1 and retention_total = 1
     from public.fc_daily_stats('2026-10-01', '2026-10-31') where review_day = '2026-10-14'),
  'daily stats count reviews, cram, time and the retention sample');
select pg_temp.check(
  (select learning_due = 1 from public.fc_deck_counts('2026-10-14 08:30+00', '2026-10-15 02:00+00', '2026-10-14')
    where deck_id = 'd0000000-0000-4000-8000-0000000000c3')
  and (select new_cards = 1 and review_due = 0 and cards = 2
         from public.fc_deck_counts('2026-10-14 08:30+00', '2026-10-15 02:00+00', '2026-10-14')
        where deck_id = 'd0000000-0000-4000-8000-0000000000c2'),
  'deck counts split new, learning due and review due');
select pg_temp.check(
  (select cards = 1 from public.fc_forecast('2026-10-14', 30, 'Europe/Paris', 4) where day = '2026-11-07'),
  'the forecast puts a card due at 04:00 Paris on its review day');
select pg_temp.check(
  (select count(*) = 3 from public.fc_tags()),
  'every tag in use is listed once');

-- tags
select pg_temp.check(public.fc_rename_tag('maths', 'proba') = 1, 'renaming a tag reports the notes changed');
select pg_temp.check(
  (select tags = '{poisson,proba::lois}' from public.fc_notes where id = 'a0000000-0000-4000-8000-0000000000c1'),
  'renaming a tag renames its children');
select public.fc_rename_tag('POISSON', 'proba::lois');
select pg_temp.check(
  (select tags = '{proba::lois}' from public.fc_notes where id = 'a0000000-0000-4000-8000-0000000000c1'),
  'renaming onto an existing tag merges them, any case');

-- deleting a deck
select pg_temp.check(
  pg_temp.fails($$select public.fc_delete_deck('d0000000-0000-4000-8000-0000000000c1')$$),
  'a deck with notes needs somewhere to put them');
select public.fc_delete_deck('d0000000-0000-4000-8000-0000000000c1', 'd0000000-0000-4000-8000-0000000000c3');
select pg_temp.check(
  (select deck_id = 'd0000000-0000-4000-8000-0000000000c3' from public.fc_notes where id = 'a0000000-0000-4000-8000-0000000000c3')
  and (select parent_id is null from public.fc_decks where id = 'd0000000-0000-4000-8000-0000000000c2')
  and not exists (select 1 from public.fc_decks where id = 'd0000000-0000-4000-8000-0000000000c1'),
  'deleting a deck moves its notes and lifts its sub-decks');
commit;

-- ============================================================ another user
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"bbbbbbbb-0000-4000-8000-0000000000c2","role":"authenticated"}';
select pg_temp.check(
  (select count(*) from public.fc_notes) = 0 and (select count(*) from public.fc_cards) = 0
  and (select count(*) from public.fc_reviews) = 0 and (select count(*) = 1 from public.fc_decks),
  'another user sees only their own deck');
select pg_temp.check(
  pg_temp.fails($$select public.fc_save_review('c0000000-0000-4000-8000-0000000000c2', 0, 'review', 3, '2026-10-14', 0, 0,
                  'review', 0, 3, 5, '2026-10-17 02:00+00', '2026-10-14 08:00+00', 1, 0)$$, 'P0002'),
  'nor rate someone else''s card');
select pg_temp.check(
  pg_temp.fails($$insert into public.fc_cards (user_id, note_id, ord)
                  values ('bbbbbbbb-0000-4000-8000-0000000000c2', 'a0000000-0000-4000-8000-0000000000c2', 5)$$, '23503'),
  'nor add a card to someone else''s note');
commit;

-- =============================================== as a connected app (Claude)
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-4000-8000-0000000000c1","role":"authenticated","client_id":"claude"}';

select pg_temp.check((select count(*) from public.fc_notes) = 3, 'Claude reads notes');
select pg_temp.check((select count(*) from public.fc_cards) = 4, 'Claude reads cards');
select pg_temp.check((select count(*) from public.fc_reviews) >= 2, 'Claude reads the history');
select pg_temp.check((select count(*) from public.fc_media) = 0, 'Claude sees no media');

-- decks
insert into public.fc_decks (id, user_id, name) values
  ('d0000000-0000-4000-8000-0000000000c7', 'aaaaaaaa-0000-4000-8000-0000000000c1', 'Entretiens');
select pg_temp.check(
  pg_temp.touched($$update public.fc_decks set name = 'Interviews' where id = 'd0000000-0000-4000-8000-0000000000c7'$$) = 1,
  'Claude creates and renames decks');
select pg_temp.check(
  pg_temp.fails($$insert into public.fc_decks (user_id, parent_id, name)
                  values ('aaaaaaaa-0000-4000-8000-0000000000c1', 'd0000000-0000-4000-8000-0000000000c9', 'x')$$, '23503'),
  'but still not under someone else''s deck');

-- notes
insert into public.fc_notes (id, user_id, deck_id, front, back, inbox, created_by) values
  ('a0000000-0000-4000-8000-0000000000c4', 'aaaaaaaa-0000-4000-8000-0000000000c1', 'd0000000-0000-4000-8000-0000000000c3',
   'Alpha face à 1/2 pot', '33 %', true, 'user'),
  ('a0000000-0000-4000-8000-0000000000c5', 'aaaaaaaa-0000-4000-8000-0000000000c1', 'd0000000-0000-4000-8000-0000000000c7',
   'Pitch en 30 s', 'PFE Cloud Temple', false, 'user');
select pg_temp.check(
  (select bool_and(created_by = 'claude') from public.fc_notes
    where id in ('a0000000-0000-4000-8000-0000000000c4', 'a0000000-0000-4000-8000-0000000000c5'))
  and (select inbox from public.fc_notes where id = 'a0000000-0000-4000-8000-0000000000c4')
  and (select not inbox from public.fc_notes where id = 'a0000000-0000-4000-8000-0000000000c5'),
  'Claude''s notes are signed, and go to the inbox or straight to a deck as asked');
insert into public.fc_cards (user_id, note_id, ord)
  values ('aaaaaaaa-0000-4000-8000-0000000000c1', 'a0000000-0000-4000-8000-0000000000c5', 0);
select pg_temp.check(true, 'Claude adds cards to an accepted note');
select pg_temp.check(
  pg_temp.touched($$update public.fc_notes set inbox = false where id = 'a0000000-0000-4000-8000-0000000000c4'$$) = 1
  and pg_temp.touched($$update public.fc_notes set back = '1/2 pot : 33 %' where id = 'a0000000-0000-4000-8000-0000000000c2'$$) = 1,
  'Claude accepts inbox notes and edits accepted ones');
select pg_temp.check(
  pg_temp.fails($$update public.fc_notes set created_by = 'user' where id = 'a0000000-0000-4000-8000-0000000000c4'$$, '42501'),
  'nobody changes who wrote a note');
select pg_temp.check(
  pg_temp.touched($$update public.fc_notes set deleted_at = now() where id = 'a0000000-0000-4000-8000-0000000000c4'$$) = 1
  and pg_temp.touched($$update public.fc_notes set deleted_at = null where id = 'a0000000-0000-4000-8000-0000000000c4'$$) = 1,
  'Claude trashes and restores notes');
select pg_temp.check(
  pg_temp.touched($$delete from public.fc_notes where id = 'a0000000-0000-4000-8000-0000000000c4'$$) = 1,
  'Claude deletes notes');

-- cards
select pg_temp.check(
  pg_temp.touched($$update public.fc_cards set suspended = true, flagged = true where note_id = 'a0000000-0000-4000-8000-0000000000c2'$$) = 1
  and pg_temp.touched($$update public.fc_cards set state = 'new', reps = 0, lapses = 0, stability = 0, difficulty = 0,
                        last_review = null, due = now(), suspended = false
                       where note_id = 'a0000000-0000-4000-8000-0000000000c2'$$) = 1,
  'Claude suspends, flags and resets cards');

-- settings, tags, decks
insert into public.fc_settings (user_id, new_per_day) values ('aaaaaaaa-0000-4000-8000-0000000000c1', 15)
  on conflict (user_id) do update set new_per_day = excluded.new_per_day;
select pg_temp.check((select new_per_day = 15 from public.fc_settings), 'Claude writes settings');
select pg_temp.check(public.fc_rename_tag('proba', 'maths') = 1, 'Claude renames tags');
select public.fc_delete_deck('d0000000-0000-4000-8000-0000000000c7', 'd0000000-0000-4000-8000-0000000000c3');
select pg_temp.check(
  (select deck_id = 'd0000000-0000-4000-8000-0000000000c3' from public.fc_notes where id = 'a0000000-0000-4000-8000-0000000000c5')
  and not exists (select 1 from public.fc_decks where id = 'd0000000-0000-4000-8000-0000000000c7'),
  'Claude deletes decks, moving their notes');

-- what stays Arthur's
select pg_temp.check(
  pg_temp.touched($$delete from public.fc_reviews$$) = 0
  and pg_temp.fails($$insert into public.fc_reviews (user_id, card_id, note_id, deck_id, rating, review_day, before,
                        state_before, stability_before, difficulty_before, state_after, stability_after, difficulty_after, due_after)
                      select user_id, id, note_id, 'd0000000-0000-4000-8000-0000000000c3', 3, current_date, '{}',
                             'new', 0, 0, 'review', 1, 5, now() from public.fc_cards limit 1$$),
  'Claude cannot write or erase the review journal');
select pg_temp.check(
  pg_temp.fails($$insert into public.fc_media (user_id, mime, bytes) values ('aaaaaaaa-0000-4000-8000-0000000000c1', 'image/png', '\x00')$$),
  'Claude cannot upload media');
select pg_temp.check(
  pg_temp.fails($$select public.fc_save_review('c0000000-0000-4000-8000-0000000000c2', 0, 'review', 3, '2026-10-14', 0, 0,
                  'review', 0, 3, 5, '2026-10-17 02:00+00', '2026-10-14 08:00+00', 1, 0)$$, '42501')
  and pg_temp.fails($$select public.fc_undo_review(1)$$, '42501'),
  'Claude cannot rate or undo');
select pg_temp.check(
  (select count(*) >= 1 from public.fc_deck_counts(now(), now(), current_date)),
  'Claude can read the aggregates');
commit;

-- ==================================================================== purge
update public.fc_notes set deleted_at = now() - interval '31 days' where id = 'a0000000-0000-4000-8000-0000000000c2';
insert into public.fc_media (id, user_id, mime, bytes, created_at) values
  ('e0000000-0000-4000-8000-0000000000c1', 'aaaaaaaa-0000-4000-8000-0000000000c1', 'image/png', '\x01', now() - interval '2 days'),
  ('e0000000-0000-4000-8000-0000000000c2', 'aaaaaaaa-0000-4000-8000-0000000000c1', 'image/png', '\x01', now() - interval '2 days');
update public.fc_notes set extra = '![](/flashcards/media/e0000000-0000-4000-8000-0000000000c1)'
 where id = 'a0000000-0000-4000-8000-0000000000c1';
select public.fc_purge_trash();
select pg_temp.check(
  not exists (select 1 from public.fc_notes where id = 'a0000000-0000-4000-8000-0000000000c2')
  and not exists (select 1 from public.fc_cards where note_id = 'a0000000-0000-4000-8000-0000000000c2'),
  'the purge removes notes trashed over 30 days ago, with their cards');
select pg_temp.check(
  exists (select 1 from public.fc_media where id = 'e0000000-0000-4000-8000-0000000000c1')
  and not exists (select 1 from public.fc_media where id = 'e0000000-0000-4000-8000-0000000000c2'),
  'and the images no note uses any more');

\echo ALL CHECKS PASSED
