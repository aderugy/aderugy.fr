-- Migration 0030: /projects — the invariants, and what a connected app (the
-- Claude connector) may do.
--
-- Run after stub.sql and every migration (see oauth_scope_test.sql for the
-- commands), from the repository root:
--   psql -d t -f supabase/tests/projects_test.sql   # ends with ALL CHECKS PASSED
-- It re-applies 0030 first: the migration must be re-runnable.
\set ON_ERROR_STOP 1
\i supabase/migrations/0030_projects.sql

insert into auth.users values
  ('aaaaaaaa-0000-4000-8000-0000000000a1', 'arthur@x'),
  ('bbbbbbbb-0000-4000-8000-0000000000b2', 'other@x');
insert into public.categories (id, user_id, name, position) values
  ('c0000000-0000-4000-8000-0000000000a1', 'aaaaaaaa-0000-4000-8000-0000000000a1', 'recherche', 0);

create function pg_temp.check(ok boolean, what text) returns void language plpgsql as $$
begin
  if not ok then raise exception 'FAIL: %', what; end if;
  raise notice 'ok   %', what;
end $$;
grant execute on function pg_temp.check(boolean, text) to authenticated, anon;

-- Expect a statement to fail. The statement runs in its own subtransaction.
create function pg_temp.refused(stmt text, what text) returns void language plpgsql as $$
begin
  begin
    execute stmt;
  exception when others then
    raise notice 'ok   % (%)', what, sqlerrm;
    return;
  end;
  raise exception 'FAIL: not refused: %', what;
end $$;
grant execute on function pg_temp.refused(text, text) to authenticated, anon;

-- ================================================== Arthur, in the browser
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-4000-8000-0000000000a1","role":"authenticated"}';

insert into public.research_projects (id, user_id, slug, name, objectives, category_id) values
  ('a1000000-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-0000000000a1', 'MAD',
   'market-anomaly-detection', array['Tester une hypothèse', 'Lire un carnet d''ordres'],
   'c0000000-0000-4000-8000-0000000000a1');
insert into public.research_steps (id, user_id, project_id, milestone, code, title, budget_minutes, position) values
  ('51000000-0000-4000-8000-000000000020', 'aaaaaaaa-0000-4000-8000-0000000000a1', 'a1000000-0000-4000-8000-000000000001', 'Jalon 2', '2.0', 'Cadrer', 60, 0),
  ('51000000-0000-4000-8000-000000000021', 'aaaaaaaa-0000-4000-8000-0000000000a1', 'a1000000-0000-4000-8000-000000000001', 'Jalon 2', '2.1', 'Ranger les données', 120, 1),
  ('51000000-0000-4000-8000-000000000022', 'aaaaaaaa-0000-4000-8000-0000000000a1', 'a1000000-0000-4000-8000-000000000001', 'Jalon 2', '2.2', 'Explorer', 90, 2),
  ('51000000-0000-4000-8000-000000000023', 'aaaaaaaa-0000-4000-8000-0000000000a1', 'a1000000-0000-4000-8000-000000000001', 'Jalon 2', '2.3', 'Modèle', 90, 3),
  ('51000000-0000-4000-8000-000000000024', 'aaaaaaaa-0000-4000-8000-0000000000a1', 'a1000000-0000-4000-8000-000000000001', 'Jalon 2', '2.4', 'Rapport', 90, 4);

select pg_temp.check(
  (select cut_minutes from public.research_steps where code = '2.1') = 180,
  'the cut line defaults to 1.5 × the budget');
select pg_temp.refused(
  $$update public.research_steps set cut_minutes = 100 where code = '2.1'$$,
  'a cut line below the budget');
select pg_temp.refused(
  $$insert into public.research_projects (user_id, slug, name) values ('aaaaaaaa-0000-4000-8000-0000000000a1', 'mad x', 'bad')$$,
  'a slug outside A-Z 0-9 -');
select pg_temp.refused(
  $$update public.research_projects set objectives = array['a','b','c','d','e'] where slug = 'MAD'$$,
  'more than four objectives');

select pg_temp.refused(
  $$select public.research_open_step('51000000-0000-4000-8000-000000000020')$$,
  'no step opens while the contract is a draft');

update public.research_projects set status = 'active' where slug = 'MAD';
select pg_temp.check(
  (select validated_at is not null from public.research_projects where slug = 'MAD'),
  'validating the contract stamps validated_at');

select public.research_open_step('51000000-0000-4000-8000-000000000020');
select pg_temp.check(
  (select status = 'open' and opened_at is not null from public.research_steps where code = '2.0'),
  'opening a step stamps opened_at');
select pg_temp.refused(
  $$select public.research_open_step('51000000-0000-4000-8000-000000000021')$$,
  'a second open step (the function names the open one)');
select pg_temp.refused(
  $$update public.research_steps set status = 'open' where code = '2.1'$$,
  'a second open step, written directly');

-- Items: kind follows the step.
insert into public.research_items (id, user_id, project_id, title, kind, origin) values
  ('11000000-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-0000000000a1', 'a1000000-0000-4000-8000-000000000001', 'Fuseau des horodatages', 'todo', 'claude');
select pg_temp.check(
  (select kind = 'park' and created_as = 'park' and origin = 'arthur' from public.research_items where id = '11000000-0000-4000-8000-000000000001'),
  'an item with no step is parked, and its origin is whoever created it');
update public.research_items set step_id = '51000000-0000-4000-8000-000000000022', triage = 'core'
 where id = '11000000-0000-4000-8000-000000000001';
select pg_temp.check(
  (select kind = 'todo' and created_as = 'park' from public.research_items where id = '11000000-0000-4000-8000-000000000001'),
  'moving a parked item into a step turns it into a todo (it was raised as parked)');
update public.research_items set step_id = null where id = '11000000-0000-4000-8000-000000000001';
select pg_temp.check(
  (select kind = 'park' from public.research_items where id = '11000000-0000-4000-8000-000000000001'),
  'taking it out of the step parks it again');
update public.research_items set status = 'done' where id = '11000000-0000-4000-8000-000000000001';
select pg_temp.check(
  (select closed_at is not null from public.research_items where id = '11000000-0000-4000-8000-000000000001'),
  'ticking an item stamps closed_at');
select pg_temp.refused(
  $$update public.research_items set origin = 'claude' where id = '11000000-0000-4000-8000-000000000001'$$,
  'the origin of an item is fixed');

-- Work: append-only, sources by caller, never below zero.
insert into public.research_work (user_id, step_id, minutes, source) values
  ('aaaaaaaa-0000-4000-8000-0000000000a1', '51000000-0000-4000-8000-000000000020', 50, 'app'),
  ('aaaaaaaa-0000-4000-8000-0000000000a1', '51000000-0000-4000-8000-000000000020', 30, 'reported');
select pg_temp.check(
  (select project_id = 'a1000000-0000-4000-8000-000000000001' and created_by = 'arthur'
     from public.research_work limit 1),
  'a work entry takes its project from the step and is signed');
select pg_temp.check(
  (select spent = 80 and app = 50 and reported = 30 from public.research_step_totals
    where step_id = '51000000-0000-4000-8000-000000000020'),
  'research_step_totals sums the entries by source');
select pg_temp.refused(
  $$insert into public.research_work (user_id, step_id, minutes, source)
    values ('aaaaaaaa-0000-4000-8000-0000000000a1', '51000000-0000-4000-8000-000000000020', 10, 'claude_code')$$,
  'the app cannot log time as Claude');
select pg_temp.refused(
  $$update public.research_work set minutes = 5$$,
  'work entries cannot be edited');
select pg_temp.refused(
  $$insert into public.research_work (user_id, step_id, minutes, source)
    values ('aaaaaaaa-0000-4000-8000-0000000000a1', '51000000-0000-4000-8000-000000000020', -90, 'app')$$,
  'a correction cannot take a step below zero');
insert into public.research_work (user_id, step_id, minutes, source, note) values
  ('aaaaaaaa-0000-4000-8000-0000000000a1', '51000000-0000-4000-8000-000000000020', 12, 'app', null);
insert into public.research_work (user_id, step_id, minutes, source, note) values
  ('aaaaaaaa-0000-4000-8000-0000000000a1', '51000000-0000-4000-8000-000000000020', -12, 'app', 'double tap');
select pg_temp.check(
  (select spent = 80 from public.research_step_totals where step_id = '51000000-0000-4000-8000-000000000020'),
  'a negative entry corrects the total');

-- Close and open the next one in one go.
select pg_temp.check(
  (select (public.research_close_step('51000000-0000-4000-8000-000000000020', 'cut', 'Version minimale',
           '51000000-0000-4000-8000-000000000021') ->> 'ratio')::numeric = 1.33),
  'closing returns the overrun ratio');
select pg_temp.check(
  (select status = 'cut' and closed_at is not null and close_note = 'Version minimale'
     from public.research_steps where code = '2.0'),
  'the closed step is cut, stamped and noted');
select pg_temp.check(
  (select status = 'open' from public.research_steps where code = '2.1'),
  'the next step is open');
select pg_temp.check(
  (select count(*) = 1 from public.research_messages
    where kind = 'step_closed' and author = 'arthur' and body like '2.0 Cadrer — cut · 1h20 / 1h00 · ratio 1.33%'),
  'closing writes a step_closed message');

-- Next action: stamped, and logged as a message.
update public.research_projects set next_action = 'tables matchs', next_action_minutes = 40,
       next_action_by = 'claude'
 where slug = 'MAD';
select pg_temp.check(
  (select next_action_by = 'arthur' and next_action_at is not null from public.research_projects where slug = 'MAD'),
  'the next action is stamped with who set it, whatever was sent');
select pg_temp.check(
  (select count(*) = 1 from public.research_messages
    where kind = 'next_action' and author = 'arthur' and body = 'tables matchs (≈ 40 min)'),
  'changing the next action keeps it in the thread');

insert into public.research_messages (user_id, project_id, body, author, surface) values
  ('aaaaaaaa-0000-4000-8000-0000000000a1', 'a1000000-0000-4000-8000-000000000001',
   'Commence par le test des horodatages', 'claude', 'claude_code');
select pg_temp.check(
  (select author = 'arthur' and surface = 'app' from public.research_messages where body like 'Commence%'),
  'a message from the app is Arthur''s, from the app');

-- Deleting steps.
insert into public.research_items (id, user_id, project_id, step_id, title) values
  ('11000000-0000-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-0000000000a1', 'a1000000-0000-4000-8000-000000000001',
   '51000000-0000-4000-8000-000000000024', 'Plan du rapport');
delete from public.research_steps where code = '2.4';
select pg_temp.check(
  (select kind = 'park' and step_id is null from public.research_items where id = '11000000-0000-4000-8000-000000000002'),
  'deleting a step parks its todos');
select pg_temp.refused(
  $$delete from public.research_steps where code = '2.0'$$,
  'a step with logged time cannot be deleted (drop it)');

-- Arthur moves the cut line of the open step, and puts it back to todo.
update public.research_steps set budget_minutes = 150, cut_minutes = 200 where code = '2.1';
update public.research_steps set status = 'todo' where code = '2.1';
update public.research_steps set status = 'open' where code = '2.1';
select pg_temp.check(
  (select budget_minutes = 150 and status = 'open' from public.research_steps where code = '2.1'),
  'Arthur moves an open step''s cut line, and can put it back to todo');

-- Someone else's rows.
set local request.jwt.claims = '{"sub":"bbbbbbbb-0000-4000-8000-0000000000b2","role":"authenticated"}';
select pg_temp.check((select count(*) = 0 from public.research_projects), 'another user sees no project');
select pg_temp.check((select count(*) = 0 from public.research_step_totals), 'another user sees no totals');
select pg_temp.refused(
  $$insert into public.research_steps (user_id, project_id, code, title, budget_minutes)
    values ('bbbbbbbb-0000-4000-8000-0000000000b2', 'a1000000-0000-4000-8000-000000000001', '9', 'x', 30)$$,
  'a step cannot be added to someone else''s project');
commit;

-- A step closed two days ago, for the late-sync rule (as the owner of the DB).
insert into public.research_steps (id, user_id, project_id, code, title, budget_minutes, status) values
  ('51000000-0000-4000-8000-000000000010', 'aaaaaaaa-0000-4000-8000-0000000000a1', 'a1000000-0000-4000-8000-000000000001', '1.0', 'Ancienne', 60, 'done');
update public.research_steps set closed_at = now() - interval '2 days' where code = '1.0';

-- ======================================================= Claude (OAuth client)
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-4000-8000-0000000000a1","role":"authenticated","client_id":"claude"}';

-- Projects.
select pg_temp.refused(
  $$insert into public.research_projects (user_id, slug, name, status)
    values ('aaaaaaaa-0000-4000-8000-0000000000a1', 'THESE', 'Mémoire', 'active')$$,
  'Claude cannot create an active project');
insert into public.research_projects (id, user_id, slug, name, objectives) values
  ('a1000000-0000-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-0000000000a1', 'THESE', 'Mémoire', array['a']);
select pg_temp.check(
  (select status = 'draft' from public.research_projects where slug = 'THESE'),
  'Claude creates a draft');
update public.research_projects set objectives = array['a', 'b'] where slug = 'THESE';
select pg_temp.check(
  (select cardinality(objectives) = 2 from public.research_projects where slug = 'THESE'),
  'Claude edits the objectives of a draft');
select pg_temp.refused(
  $$update public.research_projects set status = 'active' where slug = 'THESE'$$,
  'Claude cannot validate a contract');
select pg_temp.refused(
  $$update public.research_projects set objectives = array['autre'] where slug = 'MAD'$$,
  'Claude cannot change the objectives once validated');
select pg_temp.refused(
  $$update public.research_projects set status = 'draft' where slug = 'MAD'$$,
  'Claude cannot send a project back to draft');
select pg_temp.refused(
  $$update public.research_projects set status = 'done' where slug = 'MAD'$$,
  'Claude cannot close a project');
select pg_temp.refused(
  $$update public.research_projects set validated_at = null where slug = 'MAD'$$,
  'Claude cannot touch validated_at');
savepoint p;
update public.research_projects set status = 'paused' where slug = 'MAD';
select pg_temp.refused(
  $$update public.research_projects set status = 'active' where slug = 'MAD'$$,
  'Claude may pause, not resume');
rollback to savepoint p;
update public.research_projects set question = 'Les cotes réagissent-elles en retard ?', next_action = 'test horodatages', next_action_minutes = 30
 where slug = 'MAD';
select pg_temp.check(
  (select next_action_by = 'claude' from public.research_projects where slug = 'MAD'),
  'Claude sets the next action');
select pg_temp.check(
  (select count(*) = 1 from public.research_messages where kind = 'next_action' and author = 'claude'),
  'Claude''s next action is in the thread, signed claude');

-- Steps.
select pg_temp.refused(
  $$insert into public.research_steps (user_id, project_id, code, title, budget_minutes, status)
    values ('aaaaaaaa-0000-4000-8000-0000000000a1', 'a1000000-0000-4000-8000-000000000001', '2.9', 'x', 30, 'open')$$,
  'Claude adds steps as todo only');
insert into public.research_steps (user_id, project_id, code, title, budget_minutes) values
  ('aaaaaaaa-0000-4000-8000-0000000000a1', 'a1000000-0000-4000-8000-000000000001', '2.5', 'Annexe', 30);
update public.research_steps set budget_minutes = 45, cut_minutes = 60 where code = '2.2';
select pg_temp.check(
  (select budget_minutes = 45 from public.research_steps where code = '2.2'),
  'Claude plans a todo step''s budget');
select pg_temp.refused(
  $$update public.research_steps set budget_minutes = 300, cut_minutes = 400 where code = '2.1'$$,
  'Claude cannot move the open step''s budget');
select pg_temp.refused(
  $$update public.research_steps set cut_minutes = 400 where code = '2.1'$$,
  'Claude cannot move the open step''s cut line');
select pg_temp.refused(
  $$update public.research_steps set good_enough = 'presque rien' where code = '2.1'$$,
  'Claude cannot rewrite the open step''s "good enough"');
select pg_temp.refused(
  $$update public.research_steps set status = 'todo' where code = '2.1'$$,
  'Claude cannot put the open step back to todo');
select pg_temp.refused(
  $$update public.research_steps set status = 'dropped' where code = '2.1'$$,
  'Claude cannot drop the open step (it closes it as done or cut)');
select pg_temp.refused(
  $$update public.research_steps set cut_minutes = 999 where code = '2.0'$$,
  'Claude cannot rewrite a closed step''s cut line');
update public.research_steps set title = 'Ranger les données (DuckDB)' where code = '2.1';
select pg_temp.check(
  (select title like '%DuckDB%' from public.research_steps where code = '2.1'),
  'Claude renames the open step');

-- Work.
select pg_temp.refused(
  $$insert into public.research_work (user_id, step_id, minutes, source)
    values ('aaaaaaaa-0000-4000-8000-0000000000a1', '51000000-0000-4000-8000-000000000021', 30, 'app')$$,
  'Claude cannot log time as the app');
insert into public.research_work (user_id, step_id, minutes, source, at) values
  ('aaaaaaaa-0000-4000-8000-0000000000a1', '51000000-0000-4000-8000-000000000021', 30, 'claude_code', '2020-01-01');
select pg_temp.check(
  (select created_by = 'claude' and at > now() - interval '1 minute' from public.research_work where source = 'claude_code'),
  'Claude''s entry is signed and timed now');
insert into public.research_work (user_id, step_id, minutes, source) values
  ('aaaaaaaa-0000-4000-8000-0000000000a1', '51000000-0000-4000-8000-000000000020', 10, 'reported');
select pg_temp.check(true, 'Claude logs on a step closed less than a day ago');
select pg_temp.refused(
  $$insert into public.research_work (user_id, step_id, minutes, source)
    values ('aaaaaaaa-0000-4000-8000-0000000000a1', '51000000-0000-4000-8000-000000000010', 10, 'reported')$$,
  'Claude cannot log on a step closed days ago');
select pg_temp.refused(
  $$insert into public.research_work (user_id, step_id, minutes, source)
    values ('aaaaaaaa-0000-4000-8000-0000000000a1', '51000000-0000-4000-8000-000000000022', 10, 'claude_ai')$$,
  'Claude cannot log on a step not yet opened');
select pg_temp.refused(
  $$insert into public.research_work (user_id, step_id, minutes, source)
    values ('aaaaaaaa-0000-4000-8000-0000000000a1', '51000000-0000-4000-8000-000000000021', -10, 'claude_code')$$,
  'a Claude correction needs a note');
select pg_temp.refused(
  $$insert into public.research_work (user_id, step_id, minutes, source, note)
    values ('aaaaaaaa-0000-4000-8000-0000000000a1', '51000000-0000-4000-8000-000000000021', -40, 'claude_code', 'trop compté')$$,
  'Claude cannot correct more than it logged (no way out of closing mode)');
insert into public.research_work (user_id, step_id, minutes, source, note) values
  ('aaaaaaaa-0000-4000-8000-0000000000a1', '51000000-0000-4000-8000-000000000021', -30, 'claude_code', 'compté deux fois');
select pg_temp.check(
  (select spent = 0 from public.research_step_totals where step_id = '51000000-0000-4000-8000-000000000021'),
  'Claude corrects its own entry');
select pg_temp.refused($$update public.research_work set note = 'x'$$, 'Claude cannot edit work');
delete from public.research_work;
select pg_temp.check((select count(*) > 0 from public.research_work), 'Claude deletes no work');

-- Items.
insert into public.research_items (id, user_id, project_id, title, origin, blocks_step_id) values
  ('11000000-0000-4000-8000-000000000003', 'aaaaaaaa-0000-4000-8000-0000000000a1', 'a1000000-0000-4000-8000-000000000001',
   'Regarder Pinnacle à part', 'arthur', '51000000-0000-4000-8000-000000000023');
select pg_temp.check(
  (select origin = 'claude' and kind = 'park' from public.research_items where id = '11000000-0000-4000-8000-000000000003'),
  'Claude''s items are signed claude, whatever it sends');
select pg_temp.refused(
  $$update public.research_items set origin = 'arthur' where id = '11000000-0000-4000-8000-000000000003'$$,
  'Claude cannot pass an item off as Arthur''s');
update public.research_items set step_id = '51000000-0000-4000-8000-000000000021', triage = 'support'
 where id = '11000000-0000-4000-8000-000000000003';
select pg_temp.check(
  (select kind = 'todo' from public.research_items where id = '11000000-0000-4000-8000-000000000003'),
  'Claude moves a parked item into a step');
delete from public.research_items;
select pg_temp.check((select count(*) = 3 from public.research_items), 'Claude deletes no item');

-- Messages.
insert into public.research_messages (user_id, project_id, body, author, kind, surface, read_at) values
  ('aaaaaaaa-0000-4000-8000-0000000000a1', 'a1000000-0000-4000-8000-000000000001', 'Handoff', 'arthur', 'handoff', 'claude_code', now());
select pg_temp.check(
  (select author = 'claude' and read_at is null from public.research_messages where body = 'Handoff'),
  'Claude''s messages are signed claude and start unread');
select pg_temp.refused(
  $$insert into public.research_messages (user_id, project_id, body, surface)
    values ('aaaaaaaa-0000-4000-8000-0000000000a1', 'a1000000-0000-4000-8000-000000000001', 'x', 'app')$$,
  'Claude does not write from the app');
update public.research_messages set read_at = now() where body like 'Commence%';
select pg_temp.check(
  (select read_at is not null from public.research_messages where body like 'Commence%'),
  'Claude marks Arthur''s message read');
select pg_temp.refused(
  $$update public.research_messages set read_at = now() where body = 'Handoff'$$,
  'Claude cannot mark its own message read');
select pg_temp.refused(
  $$update public.research_messages set body = 'autre chose' where body like 'Commence%'$$,
  'Claude cannot rewrite Arthur''s message');
delete from public.research_messages;
delete from public.research_steps where code = '2.5';
delete from public.research_projects where slug = 'THESE';
select pg_temp.check(
  (select count(*) > 0 from public.research_messages)
  and exists (select 1 from public.research_steps where code = '2.5')
  and exists (select 1 from public.research_projects where slug = 'THESE'),
  'Claude deletes no message, step or project');

-- Close as Claude, then try to reopen.
select public.research_close_step('51000000-0000-4000-8000-000000000021', 'done', 'Tables prêtes', null, 'claude_code');
select pg_temp.check(
  (select count(*) = 1 from public.research_messages where kind = 'step_closed' and author = 'claude' and surface = 'claude_code'),
  'Claude''s close writes a step_closed message signed claude');
select pg_temp.refused(
  $$select public.research_open_step('51000000-0000-4000-8000-000000000021')$$,
  'Claude cannot reopen a closed step');
update public.research_steps set status = 'dropped' where code = '2.3';
select pg_temp.check((select status = 'dropped' from public.research_steps where code = '2.3'), 'Claude drops a todo step');
select public.research_open_step('51000000-0000-4000-8000-000000000022');
select pg_temp.check((select status = 'open' from public.research_steps where code = '2.2'), 'Claude opens the next step');
commit;

-- ============================================== Arthur can do all of it
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-4000-8000-0000000000a1","role":"authenticated"}';
update public.research_steps set status = 'todo' where code = '2.2';
select public.research_open_step('51000000-0000-4000-8000-000000000021');
select pg_temp.check((select status = 'open' and closed_at is null from public.research_steps where code = '2.1'), 'Arthur reopens a closed step');
update public.research_projects set objectives = array['autre'], status = 'done' where slug = 'MAD';
select pg_temp.check((select status = 'done' from public.research_projects where slug = 'MAD'), 'Arthur changes objectives and closes the project');
update public.research_messages set read_at = now() where author = 'claude';
delete from public.research_projects where slug = 'MAD';
select pg_temp.check(
  (select count(*) = 0 from public.research_steps where project_id = 'a1000000-0000-4000-8000-000000000001')
  and (select count(*) = 0 from public.research_work where project_id = 'a1000000-0000-4000-8000-000000000001'),
  'Arthur deletes a project with its steps and history');
commit;

\echo ALL CHECKS PASSED
