-- /flashcards — the Claude connector gets full CRUD (Arthur's decision, Oct 2026).
--
-- 0023 kept Claude to reading and to writing notes into the inbox. From here a
-- connected app may create, read, update and delete everything Arthur edits
-- himself in /flashcards:
--
--   fc_decks      full access (create, rename, move, delete via fc_delete_deck)
--   fc_notes      full access: insert straight into a deck or into the inbox,
--                 edit any note, accept or reject inbox notes, trash, restore,
--                 delete for good. Still signed: a note Claude inserts is
--                 `created_by = 'claude'`, and nobody can change that later.
--   fc_cards      full access (suspend, flag, bury, reset, reschedule)
--   fc_settings   full access
--   fc_rename_tag, fc_delete_deck   allowed
--
-- What stays Arthur's:
--   fc_reviews                       read only — the review journal is his own
--   fc_save_review, fc_undo_review   refused — Claude does not rate or undo
--   fc_media                         nothing — images are pasted in the app
--
-- Re-runnable, and safe to run after re-running 0023 (the tests do).

-- ------------------------------------------------------ lift the old rules

do $$
declare
  t text;
begin
  foreach t in array array['fc_decks', 'fc_cards', 'fc_settings'] loop
    execute format('drop policy if exists "oauth clients read only: insert" on public.%I', t);
    execute format('drop policy if exists "oauth clients read only: update" on public.%I', t);
    execute format('drop policy if exists "oauth clients read only: delete" on public.%I', t);
  end loop;
end;
$$;

drop policy if exists "oauth clients edit the inbox only" on public.fc_notes;
drop policy if exists "oauth clients cannot delete notes" on public.fc_notes;

-- --------------------------------------------------------- note checks

-- As in 0023, minus the inbox rules: a connected app's insert is signed
-- `claude` but lands wherever it asks (inbox or deck), and it may edit, trash
-- and restore any note. Authorship stays fixed for everyone.
create or replace function public.fc_notes_check()
returns trigger
language plpgsql
as $$
declare
  owner uuid;
begin
  if tg_op = 'INSERT' or new.deck_id is distinct from old.deck_id then
    select user_id into owner from public.fc_decks where id = new.deck_id;
    if owner is distinct from new.user_id then
      raise exception 'Deck not found' using errcode = '23503';
    end if;
  end if;

  if exists (select 1 from unnest(new.tags) t where t !~ '^[^[:space:]]{1,60}$') then
    raise exception 'Tags are single words of at most 60 characters' using errcode = '23514';
  end if;

  if tg_op = 'INSERT' then
    if public.is_oauth_client() then
      new.created_by := 'claude';
    end if;
  elsif new.created_by is distinct from old.created_by then
    raise exception 'Who wrote a note cannot be changed' using errcode = '42501';
  end if;
  return new;
end;
$$;

-- ------------------------------------------------------------- RPCs

-- Same bodies as 0023, without the connected-app refusal.

create or replace function public.fc_delete_deck(p_id uuid, p_move_to uuid default null)
returns void
language plpgsql
as $$
declare
  d public.fc_decks%rowtype;
begin
  select * into d from public.fc_decks where id = p_id and user_id = auth.uid();
  if not found then
    raise exception 'Deck not found' using errcode = 'P0002';
  end if;

  if exists (select 1 from public.fc_notes where deck_id = p_id) then
    if p_move_to is null then
      raise exception 'Pick a deck to move its notes to';
    end if;
    if p_move_to = p_id then
      raise exception 'Notes cannot be moved to the deck being deleted';
    end if;
    update public.fc_notes set deck_id = p_move_to where deck_id = p_id;
  end if;

  update public.fc_decks set parent_id = d.parent_id where parent_id = p_id;
  delete from public.fc_decks where id = p_id;
exception
  when unique_violation then
    raise exception 'A sub-deck has the same name as a deck it would move next to; rename it first';
end;
$$;

create or replace function public.fc_rename_tag(p_from text, p_to text)
returns int
language plpgsql
as $$
declare
  changed_count int;
begin
  p_from := trim(p_from);
  p_to := trim(p_to);
  if p_to !~ '^[^[:space:]]{1,60}$' then
    raise exception 'Tags are single words of at most 60 characters';
  end if;

  with changed as (
    select n.id,
           array(
             select x from (
               select distinct on (lower(x)) x
                 from (
                   select case
                            when lower(t) = lower(p_from) then p_to
                            when lower(t) like lower(p_from) || '::%' then p_to || substr(t, length(p_from) + 1)
                            else t
                          end as x
                     from unnest(n.tags) t
                 ) s
                order by lower(x), x
             ) u order by lower(x)
           ) as tags
      from public.fc_notes n
     where n.user_id = auth.uid()
       and exists (select 1 from unnest(n.tags) t
                    where lower(t) = lower(p_from) or lower(t) like lower(p_from) || '::%')
  )
  update public.fc_notes n set tags = c.tags from changed c where n.id = c.id;
  get diagnostics changed_count = row_count;
  return changed_count;
end;
$$;

revoke execute on function public.fc_delete_deck(uuid, uuid) from public, anon;
revoke execute on function public.fc_rename_tag(text, text) from public, anon;
grant execute on function public.fc_delete_deck(uuid, uuid) to authenticated;
grant execute on function public.fc_rename_tag(text, text) to authenticated;
