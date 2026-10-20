-- /maths — the Claude connector gets the parcours (Arthur's request, Oct 2026).
--
-- 0015 kept every maths_* table away from connected apps. From here a
-- connected app may read the whole state of the parcours and record what
-- Arthur tells it he did:
--
--   maths_node_progress   read, insert, update (manual status, course read);
--                         no delete
--   maths_session_log     read, insert; update and delete only the rows it
--                         wrote itself
--   maths_attempt         same as maths_session_log
--   maths_review_state    read only — the FSRS schedule moves only when
--   maths_review_log      read only   Arthur rates a card
--   maths_save_review     refused — Claude does not rate cards
--
-- Sessions and attempts are signed: `created_by` is 'claude' for a row a
-- connected app inserted, 'arthur' otherwise, and nobody can change it later.
-- Same rule as fc_notes (0023/0025).
--
-- The course, exercises and cards stay in content/maths/, in git: nothing to
-- open here for them.
--
-- Re-runnable.

-- ------------------------------------------------------- lift 0015's deny

do $$
declare
  t text;
begin
  foreach t in array array[
    'maths_attempt',
    'maths_node_progress',
    'maths_review_log',
    'maths_review_state',
    'maths_session_log'
  ] loop
    execute format('drop policy if exists "no oauth clients" on public.%I', t);
  end loop;
end;
$$;

-- ------------------------------------------------------ review: read only

do $$
declare
  t text;
begin
  foreach t in array array['maths_review_state', 'maths_review_log'] loop
    execute format('drop policy if exists "oauth clients read only: insert" on public.%I', t);
    execute format('drop policy if exists "oauth clients read only: update" on public.%I', t);
    execute format('drop policy if exists "oauth clients read only: delete" on public.%I', t);

    execute format(
      'create policy "oauth clients read only: insert" on public.%I
         as restrictive for insert to authenticated
         with check (not (select public.is_oauth_client()))',
      t);
    execute format(
      'create policy "oauth clients read only: update" on public.%I
         as restrictive for update to authenticated
         using (not (select public.is_oauth_client()))
         with check (not (select public.is_oauth_client()))',
      t);
    execute format(
      'create policy "oauth clients read only: delete" on public.%I
         as restrictive for delete to authenticated
         using (not (select public.is_oauth_client()))',
      t);
  end loop;
end;
$$;

-- ---------------------------------------------- node progress: no delete

drop policy if exists "oauth clients cannot delete" on public.maths_node_progress;
create policy "oauth clients cannot delete" on public.maths_node_progress
  as restrictive for delete to authenticated
  using (not (select public.is_oauth_client()));

-- ------------------------------------------ sessions and attempts: signed

alter table public.maths_session_log
  add column if not exists created_by text not null default 'arthur';
alter table public.maths_attempt
  add column if not exists created_by text not null default 'arthur';

do $$
declare
  t text;
begin
  foreach t in array array['maths_session_log', 'maths_attempt'] loop
    execute format('alter table public.%I drop constraint if exists %I', t, t || '_created_by_check');
    execute format(
      'alter table public.%I add constraint %I check (created_by in (''arthur'', ''claude''))',
      t, t || '_created_by_check');
  end loop;
end;
$$;

-- Insert: a connected app's row is signed `claude` whatever it sent, and a
-- browser cannot pass its own rows off as Claude's. Update: authorship is fixed.
create or replace function public.maths_sign_row()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    new.created_by := case when public.is_oauth_client() then 'claude' else 'arthur' end;
  elsif new.created_by is distinct from old.created_by then
    raise exception 'Who recorded an entry cannot be changed' using errcode = '42501';
  end if;
  return new;
end;
$$;

do $$
declare
  t text;
begin
  foreach t in array array['maths_session_log', 'maths_attempt'] loop
    execute format('drop trigger if exists maths_sign_row on public.%I', t);
    execute format(
      'create trigger maths_sign_row before insert or update on public.%I
         for each row execute function public.maths_sign_row()',
      t);

    execute format('drop policy if exists "oauth clients edit their own rows: update" on public.%I', t);
    execute format('drop policy if exists "oauth clients edit their own rows: delete" on public.%I', t);
    execute format(
      'create policy "oauth clients edit their own rows: update" on public.%I
         as restrictive for update to authenticated
         using (not (select public.is_oauth_client()) or created_by = ''claude'')
         with check (not (select public.is_oauth_client()) or created_by = ''claude'')',
      t);
    execute format(
      'create policy "oauth clients edit their own rows: delete" on public.%I
         as restrictive for delete to authenticated
         using (not (select public.is_oauth_client()) or created_by = ''claude'')',
      t);
  end loop;
end;
$$;

-- ------------------------------------------------------- ratings: refused

-- Body as in 0012, plus the guard. The read-only policies above would already
-- stop the writes; the guard turns a silent RLS failure into a clear message.
create or replace function public.maths_save_review(
  p_card_key          text,
  p_node_id           text,
  p_card_id           text,
  p_rating            int,
  p_elapsed_days      double precision,
  p_stability_before  double precision,
  p_difficulty_before double precision,
  p_stability         double precision,
  p_difficulty        double precision,
  p_due               date,
  p_last_review       timestamptz,
  p_reps              int,
  p_lapses            int
) returns void
language plpgsql
as $$
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  if public.is_oauth_client() then
    raise exception 'Rating cards is not available to connected apps' using errcode = '42501';
  end if;

  insert into public.maths_review_state (
    user_id, card_key, node_id, card_id, stability, difficulty, due,
    last_review, reps, lapses
  ) values (
    auth.uid(), p_card_key, p_node_id, p_card_id, p_stability, p_difficulty,
    p_due, p_last_review, p_reps, p_lapses
  )
  on conflict (user_id, card_key) do update
     set stability   = excluded.stability,
         difficulty  = excluded.difficulty,
         due         = excluded.due,
         last_review = excluded.last_review,
         reps        = excluded.reps,
         lapses      = excluded.lapses;

  insert into public.maths_review_log (
    user_id, card_key, node_id, rating, elapsed_days,
    stability_before, stability_after, difficulty_before
  ) values (
    auth.uid(), p_card_key, p_node_id, p_rating, p_elapsed_days,
    p_stability_before, p_stability, p_difficulty_before
  );
end;
$$;
