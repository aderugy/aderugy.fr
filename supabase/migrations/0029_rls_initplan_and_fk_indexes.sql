-- Performance housekeeping flagged by the Supabase advisor (2026-10-18).
--
-- 1. RLS: `auth.uid()` -> `(select auth.uid())`.
--
--    Written bare, auth.uid() is a volatile call Postgres evaluates once per
--    row the policy looks at. Wrapped in a scalar sub-select it becomes an
--    InitPlan: evaluated once per statement, then compared like a constant.
--    Same meaning, same result; only the plan changes. (0020's tables were
--    already written this way.)
--
--    Rewritten in place rather than dropped and recreated, so each policy
--    keeps its name, command, roles and PERMISSIVE / RESTRICTIVE kind. Only
--    policies still holding a bare call are touched, which also makes the
--    block safe to run twice.
--
-- 2. Covering indexes for foreign keys that have none. Without one, deleting
--    or updating a referenced row (a user, a category, a session...) scans the
--    referencing table. Tables 0028 is to drop (blocks, block_items,
--    scheduled_blocks, scheduled_block_tasks, block_reminders_sent) are left
--    alone.
--
-- Nothing here changes what anyone can read or write.

do $$
declare
  p record;
  new_using text;
  new_check text;
  stmt text;
begin
  for p in
    select tablename, policyname, qual, with_check
    from pg_policies
    where schemaname = 'public'
      and (
        (qual is not null and qual ~ 'auth\.uid\(\)' and qual !~* 'select auth\.uid\(\)')
        or (with_check is not null and with_check ~ 'auth\.uid\(\)' and with_check !~* 'select auth\.uid\(\)')
      )
  loop
    new_using := regexp_replace(p.qual, 'auth\.uid\(\)', '(select auth.uid())', 'g');
    new_check := regexp_replace(p.with_check, 'auth\.uid\(\)', '(select auth.uid())', 'g');

    stmt := format('alter policy %I on public.%I', p.policyname, p.tablename);
    if new_using is not null then
      stmt := stmt || format(' using (%s)', new_using);
    end if;
    if new_check is not null then
      stmt := stmt || format(' with check (%s)', new_check);
    end if;
    execute stmt;
  end loop;
end
$$;

create index if not exists application_events_user_idx       on public.application_events (user_id);
create index if not exists application_tags_user_idx         on public.application_tags (user_id);
create index if not exists calendar_sources_category_idx     on public.calendar_sources (category_id);
create index if not exists fc_notes_deck_idx                 on public.fc_notes (deck_id);
create index if not exists google_sync_channels_user_idx     on public.google_sync_channels (user_id);
create index if not exists hidden_external_events_source_idx on public.hidden_external_events (calendar_source_id);
create index if not exists live_hands_user_idx               on public.live_hands (user_id);
create index if not exists live_player_notes_hand_idx        on public.live_player_notes (hand_id);
create index if not exists live_player_notes_session_idx     on public.live_player_notes (session_id);
create index if not exists live_player_notes_user_idx        on public.live_player_notes (user_id);
create index if not exists live_player_tags_user_idx         on public.live_player_tags (user_id);
create index if not exists live_seat_events_user_idx         on public.live_seat_events (user_id);
create index if not exists live_session_events_user_idx      on public.live_session_events (user_id);
create index if not exists objectives_category_idx           on public.objectives (category_id);
create index if not exists objectives_user_idx               on public.objectives (user_id);
create index if not exists poker_nodes_parent_idx            on public.poker_nodes (parent_id);
create index if not exists poker_trainer_hands_entry_node_idx on public.poker_trainer_hands (entry_node_id);
create index if not exists session_reminders_sent_user_idx   on public.session_reminders_sent (user_id);
