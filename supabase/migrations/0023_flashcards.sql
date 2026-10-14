-- /flashcards — spaced-repetition flash cards.
--
-- Notes are what Arthur writes; each note generates one or more cards (a
-- reversed note two, a cloze note one per gap), and each card carries its own
-- FSRS state. Every rating is journalled with the card's full state before it,
-- which is what makes undo possible and what a later FSRS optimisation needs.
--
--   fc_settings   one row per user: retention, daily limits, steps, day start
--   fc_decks      a tree of decks
--   fc_notes      the content: deck, kind, fields, tags, inbox, trash
--   fc_cards      one card per note side / gap, with its scheduling state
--   fc_reviews    one row per rating (review or cram)
--   fc_media      images pasted into notes, served by /flashcards/media/[id]
--
-- The scheduler itself is application code (src/lib/flashcards/scheduler.ts,
-- on top of the FSRS of /maths); the database stores its output and keeps the
-- invariants: ownership across tables, one transaction per rating, and what
-- the Claude connector may touch (bottom of the file).
--
-- Same rules as the rest of the schema: per-user rows, RLS `user_id = auth.uid()`,
-- every statement re-runnable.

-- ----------------------------------------------------------------- settings

create table if not exists public.fc_settings (
  user_id           uuid primary key references auth.users (id) on delete cascade,
  -- Probability of recall the scheduler aims for when a card comes back.
  retention         numeric(4, 3) not null default 0.900 check (retention between 0.700 and 0.970),
  new_per_day       int not null default 20 check (new_per_day between 0 and 9999),
  reviews_per_day   int not null default 200 check (reviews_per_day between 0 and 99999),
  -- Minutes. A new card goes through every learning step before its first
  -- interval in days; a forgotten one through the relearning steps.
  learning_steps    int[] not null default '{1,10}'
                      check (cardinality(learning_steps) between 1 and 8
                             and 0 < all (learning_steps) and 1440 >= all (learning_steps)),
  relearning_steps  int[] not null default '{10}'
                      check (cardinality(relearning_steps) <= 8
                             and 0 < all (relearning_steps) and 1440 >= all (relearning_steps)),
  -- A review day starts at this hour in `time_zone`, so a session after
  -- midnight still counts for the day before.
  day_starts_hour   smallint not null default 4 check (day_starts_hour between 0 and 23),
  time_zone         text not null default 'Europe/Paris' check (length(time_zone) between 1 and 64),
  leech_threshold   int not null default 8 check (leech_threshold between 2 and 99),
  swipe_gestures    boolean not null default true,
  updated_at        timestamptz not null default now()
);

-- -------------------------------------------------------------------- decks

create table if not exists public.fc_decks (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  -- Restrict: deleting a deck goes through fc_delete_deck, which moves its
  -- notes and sub-decks first.
  parent_id    uuid references public.fc_decks (id) on delete restrict,
  -- "::" is the path separator in the UI and the connector ("Maths::Lois").
  name         text not null check (length(trim(name)) between 1 and 80 and position('::' in name) = 0),
  position     int not null default 0,
  archived_at  timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create unique index if not exists fc_decks_sibling_name_idx
  on public.fc_decks (user_id, coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(trim(name)));
create index if not exists fc_decks_parent_idx on public.fc_decks (parent_id);

-- -------------------------------------------------------------------- notes

create table if not exists public.fc_notes (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  deck_id     uuid not null references public.fc_decks (id) on delete restrict,
  kind        text not null default 'basic'
                check (kind in ('basic', 'reversed', 'cloze', 'type_answer')),
  front       text not null check (length(trim(front)) between 1 and 20000),
  back        text not null default '' check (length(back) <= 20000),
  extra       text check (extra is null or length(extra) <= 20000),
  -- A URL or a path on the site (/maths/n/…): where the note comes from.
  source      text check (source is null or length(source) <= 2000),
  -- Free tags, hierarchical with "::" (poker::mdf). No spaces.
  tags        text[] not null default '{}' check (cardinality(tags) <= 50),
  -- Notes written by Claude wait here, without cards, until Arthur accepts them.
  inbox       boolean not null default false,
  created_by  text not null default 'user' check (created_by in ('user', 'claude')),
  -- Trash: kept 30 days, then purged by fc_purge_trash (cron.sql).
  deleted_at  timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists fc_notes_deck_idx on public.fc_notes (user_id, deck_id);
create index if not exists fc_notes_tags_idx on public.fc_notes using gin (tags);
create index if not exists fc_notes_inbox_idx on public.fc_notes (user_id) where inbox;

-- -------------------------------------------------------------------- cards

create table if not exists public.fc_cards (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  note_id      uuid not null references public.fc_notes (id) on delete cascade,
  -- 0 = front → back, 1 = back → front (reversed notes), n = gap cn (cloze).
  ord          smallint not null check (ord between 0 and 99),
  state        text not null default 'new' check (state in ('new', 'learning', 'review', 'relearning')),
  -- Index into the learning or relearning steps while in those states.
  step         smallint not null default 0 check (step between 0 and 7),
  stability    double precision not null default 0,
  difficulty   double precision not null default 0,
  -- To the minute while learning; the start of the review day once in review.
  due          timestamptz not null default now(),
  last_review  timestamptz,
  reps         int not null default 0,
  lapses       int not null default 0,
  suspended    boolean not null default false,
  -- Buried by hand: out of the queue until the review day after this date.
  buried_until date,
  flagged      boolean not null default false,
  created_at   timestamptz not null default now(),
  unique (note_id, ord)
);

create index if not exists fc_cards_due_idx on public.fc_cards (user_id, due) where not suspended;

-- ------------------------------------------------------------------ reviews

create table if not exists public.fc_reviews (
  id                 bigint generated always as identity primary key,
  user_id            uuid not null references auth.users (id) on delete cascade,
  card_id            uuid not null references public.fc_cards (id) on delete cascade,
  -- Copied, not referenced: history keeps the deck the card was in.
  note_id            uuid not null,
  deck_id            uuid not null,
  -- 'cram' sessions are journalled for time spent and nothing else.
  kind               text not null default 'review' check (kind in ('review', 'cram')),
  rating             smallint not null check (rating between 1 and 4),
  -- The review day in the user's zone and day start, computed by the app.
  review_day         date not null,
  duration_ms        int not null default 0 check (duration_ms between 0 and 600000),
  elapsed_days       double precision not null default 0,
  -- The card exactly as it was, for undo and for re-fitting FSRS later.
  before             jsonb not null,
  state_before       text not null,
  stability_before   double precision not null,
  difficulty_before  double precision not null,
  state_after        text not null,
  stability_after    double precision not null,
  difficulty_after   double precision not null,
  due_after          timestamptz not null,
  -- This rating crossed the leech threshold: the card was suspended and the
  -- note tagged. Undo reverses both.
  leech              boolean not null default false,
  reviewed_at        timestamptz not null default now()
);

create index if not exists fc_reviews_day_idx on public.fc_reviews (user_id, review_day);
create index if not exists fc_reviews_card_idx on public.fc_reviews (card_id, id desc);

-- -------------------------------------------------------------------- media

create table if not exists public.fc_media (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  mime        text not null check (mime in ('image/png', 'image/jpeg', 'image/webp', 'image/gif')),
  bytes       bytea not null check (octet_length(bytes) between 1 and 1048576),
  created_at  timestamptz not null default now()
);

create index if not exists fc_media_user_idx on public.fc_media (user_id, created_at);

-- ----------------------------------------------------------------- triggers

drop trigger if exists fc_settings_touch_updated_at on public.fc_settings;
create trigger fc_settings_touch_updated_at
  before update on public.fc_settings
  for each row execute function public.touch_updated_at();

drop trigger if exists fc_decks_touch_updated_at on public.fc_decks;
create trigger fc_decks_touch_updated_at
  before update on public.fc_decks
  for each row execute function public.touch_updated_at();

drop trigger if exists fc_notes_touch_updated_at on public.fc_notes;
create trigger fc_notes_touch_updated_at
  before update on public.fc_notes
  for each row execute function public.touch_updated_at();

-- A deck's parent must be the caller's own deck and not one of its
-- descendants. A policy on fc_decks cannot read fc_decks (recursion), so this
-- is a trigger; under RLS someone else's deck is simply not found.
create or replace function public.fc_decks_check_parent()
returns trigger
language plpgsql
as $$
declare
  owner uuid;
begin
  if new.parent_id is null then
    return new;
  end if;
  select user_id into owner from public.fc_decks where id = new.parent_id;
  if owner is distinct from new.user_id then
    raise exception 'Parent deck not found' using errcode = '23503';
  end if;
  if tg_op = 'UPDATE' and new.parent_id is distinct from old.parent_id then
    if exists (
      with recursive up(id, parent_id) as (
        select id, parent_id from public.fc_decks where id = new.parent_id
        union all
        select d.id, d.parent_id from public.fc_decks d join up on d.id = up.parent_id
      )
      select 1 from up where id = new.id
    ) then
      raise exception 'A deck cannot be moved inside itself' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists fc_decks_check_parent on public.fc_decks;
create trigger fc_decks_check_parent
  before insert or update of parent_id, user_id on public.fc_decks
  for each row execute function public.fc_decks_check_parent();

-- A note's deck must be the caller's; tags are single words; Claude's notes
-- always land in the inbox and say who wrote them, and what Claude may change
-- on a note is limited (see the connector rules below).
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

  if public.is_oauth_client() then
    if tg_op = 'INSERT' then
      new.inbox := true;
      new.created_by := 'claude';
      new.deleted_at := null;
    elsif new.deleted_at is distinct from old.deleted_at
       or new.created_by is distinct from old.created_by
       or new.user_id    is distinct from old.user_id then
      raise exception 'Connected apps may only edit notes waiting in the inbox'
        using errcode = '42501';
    end if;
  elsif tg_op = 'UPDATE' and new.created_by is distinct from old.created_by then
    raise exception 'Who wrote a note cannot be changed' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists fc_notes_check on public.fc_notes;
create trigger fc_notes_check
  before insert or update on public.fc_notes
  for each row execute function public.fc_notes_check();

-- A card belongs to the note's owner, and a note in the inbox has no cards
-- yet: accepting it is what generates them.
create or replace function public.fc_cards_check()
returns trigger
language plpgsql
as $$
declare
  n record;
begin
  if tg_op = 'UPDATE' and new.note_id is not distinct from old.note_id
     and new.user_id is not distinct from old.user_id then
    return new;
  end if;
  select user_id, inbox into n from public.fc_notes where id = new.note_id;
  if n.user_id is distinct from new.user_id then
    raise exception 'Note not found' using errcode = '23503';
  end if;
  if n.inbox then
    raise exception 'Accept the note before reviewing it' using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists fc_cards_check on public.fc_cards;
create trigger fc_cards_check
  before insert or update on public.fc_cards
  for each row execute function public.fc_cards_check();

-- ---------------------------------------------------------------------- RLS

alter table public.fc_settings enable row level security;
alter table public.fc_decks    enable row level security;
alter table public.fc_notes    enable row level security;
alter table public.fc_cards    enable row level security;
alter table public.fc_reviews  enable row level security;
alter table public.fc_media    enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array['fc_settings', 'fc_decks', 'fc_notes', 'fc_cards', 'fc_reviews', 'fc_media'] loop
    execute format('drop policy if exists "own rows" on public.%I', t);
    execute format(
      'create policy "own rows" on public.%I
         for all to authenticated
         using (auth.uid() = user_id) with check (auth.uid() = user_id)',
      t);
  end loop;
end;
$$;

-- ------------------------------------------------------------------- RPCs
--
-- Security invoker (the default): RLS decides what each one touches. Those
-- that write are refused to connected apps outright, like the definer
-- functions of 0015 — Claude never rates, undoes, deletes or renames.

-- One rating: the card's new state and its journal line in one transaction.
-- p_expected_reps is the card's `reps` when the app computed the new state;
-- if another device rated it in between, nothing is written and the error
-- code FC001 tells the app to drop the card from its queue.
create or replace function public.fc_save_review(
  p_card_id        uuid,
  p_expected_reps  int,
  p_kind           text,
  p_rating         int,
  p_review_day     date,
  p_duration_ms    int,
  p_elapsed_days   double precision,
  p_state          text,
  p_step           int,
  p_stability      double precision,
  p_difficulty     double precision,
  p_due            timestamptz,
  p_last_review    timestamptz,
  p_reps           int,
  p_lapses         int,
  p_leech          boolean default false
) returns bigint
language plpgsql
as $$
declare
  c   public.fc_cards%rowtype;
  dk  uuid;
  lid bigint;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  if public.is_oauth_client() then
    raise exception 'Not available to connected apps' using errcode = '42501';
  end if;
  if p_kind not in ('review', 'cram') then
    raise exception 'Unknown review kind %', p_kind;
  end if;

  select * into c from public.fc_cards where id = p_card_id and user_id = auth.uid() for update;
  if not found then
    raise exception 'Card not found' using errcode = 'P0002';
  end if;
  if p_kind = 'review' and c.reps <> p_expected_reps then
    raise exception 'This card was already reviewed elsewhere' using errcode = 'FC001';
  end if;

  select deck_id into dk from public.fc_notes where id = c.note_id;

  if p_kind = 'review' then
    update public.fc_cards
       set state        = p_state,
           step         = p_step,
           stability    = p_stability,
           difficulty   = p_difficulty,
           due          = p_due,
           last_review  = p_last_review,
           reps         = p_reps,
           lapses       = p_lapses,
           buried_until = null,
           suspended    = suspended or coalesce(p_leech, false)
     where id = c.id;
    if coalesce(p_leech, false) then
      update public.fc_notes
         set tags = array_append(tags, 'leech')
       where id = c.note_id and not ('leech' = any (tags));
    end if;
  end if;

  insert into public.fc_reviews (
    user_id, card_id, note_id, deck_id, kind, rating, review_day, duration_ms,
    elapsed_days, before, state_before, stability_before, difficulty_before,
    state_after, stability_after, difficulty_after, due_after, leech
  ) values (
    auth.uid(), c.id, c.note_id, dk, p_kind, p_rating, p_review_day,
    least(greatest(coalesce(p_duration_ms, 0), 0), 600000),
    coalesce(p_elapsed_days, 0),
    jsonb_build_object(
      'state', c.state, 'step', c.step, 'stability', c.stability,
      'difficulty', c.difficulty, 'due', c.due, 'last_review', c.last_review,
      'reps', c.reps, 'lapses', c.lapses, 'suspended', c.suspended,
      'buried_until', c.buried_until),
    c.state, c.stability, c.difficulty,
    case when p_kind = 'review' then p_state else c.state end,
    case when p_kind = 'review' then p_stability else c.stability end,
    case when p_kind = 'review' then p_difficulty else c.difficulty end,
    case when p_kind = 'review' then p_due else c.due end,
    p_kind = 'review' and coalesce(p_leech, false)
  ) returning id into lid;

  return lid;
end;
$$;

-- Undo a rating: only the card's latest one, which puts the card back exactly
-- as it was (and takes the leech tag off if that rating put it on).
create or replace function public.fc_undo_review(p_review_id bigint)
returns uuid
language plpgsql
as $$
declare
  r public.fc_reviews%rowtype;
  b jsonb;
begin
  if public.is_oauth_client() then
    raise exception 'Not available to connected apps' using errcode = '42501';
  end if;

  select * into r from public.fc_reviews where id = p_review_id and user_id = auth.uid();
  if not found then
    raise exception 'Review not found' using errcode = 'P0002';
  end if;
  if exists (select 1 from public.fc_reviews where card_id = r.card_id and id > r.id) then
    raise exception 'Only the last review of a card can be undone';
  end if;

  if r.kind = 'review' then
    b := r.before;
    update public.fc_cards
       set state        = b ->> 'state',
           step         = (b ->> 'step')::smallint,
           stability    = (b ->> 'stability')::double precision,
           difficulty   = (b ->> 'difficulty')::double precision,
           due          = (b ->> 'due')::timestamptz,
           last_review  = (b ->> 'last_review')::timestamptz,
           reps         = (b ->> 'reps')::int,
           lapses       = (b ->> 'lapses')::int,
           suspended    = (b ->> 'suspended')::boolean,
           buried_until = (b ->> 'buried_until')::date
     where id = r.card_id;
    if r.leech then
      update public.fc_notes set tags = array_remove(tags, 'leech') where id = r.note_id;
    end if;
  end if;

  delete from public.fc_reviews where id = r.id;
  return r.card_id;
end;
$$;

-- Delete a deck: its notes (trash included) go to p_move_to, its sub-decks
-- move up to its parent. A deck with notes needs somewhere to put them.
create or replace function public.fc_delete_deck(p_id uuid, p_move_to uuid default null)
returns void
language plpgsql
as $$
declare
  d public.fc_decks%rowtype;
begin
  if public.is_oauth_client() then
    raise exception 'Not available to connected apps' using errcode = '42501';
  end if;

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

-- Rename a tag everywhere, its children with it (poker → cash renames
-- poker::mdf to cash::mdf). Renaming onto an existing tag merges the two.
-- Tags compare case-insensitively; the result is de-duplicated and sorted.
create or replace function public.fc_rename_tag(p_from text, p_to text)
returns int
language plpgsql
as $$
declare
  changed_count int;
begin
  if public.is_oauth_client() then
    raise exception 'Not available to connected apps' using errcode = '42501';
  end if;
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

-- Every tag in use, with how many notes carry it (trash excluded).
create or replace function public.fc_tags()
returns table (tag text, notes bigint)
language sql
stable
as $$
  select min(t) as tag, count(*) as notes
    from public.fc_notes n, unnest(n.tags) t
   where n.user_id = auth.uid() and n.deleted_at is null
   group by lower(t)
   order by lower(min(t));
$$;

-- Per deck (own notes only, no subtree roll-up — the app does that):
-- how many cards, how many new, how many learning cards due by p_learn_cutoff,
-- how many review cards due before p_day_end, how many suspended.
create or replace function public.fc_deck_counts(
  p_learn_cutoff timestamptz,
  p_day_end      timestamptz,
  p_today        date
)
returns table (deck_id uuid, cards bigint, new_cards bigint, learning_due bigint, review_due bigint, suspended bigint)
language sql
stable
as $$
  select n.deck_id,
         count(c.id),
         count(c.id) filter (where c.state = 'new' and not c.suspended
                               and (c.buried_until is null or c.buried_until < p_today)),
         count(c.id) filter (where c.state in ('learning', 'relearning') and not c.suspended
                               and c.due <= p_learn_cutoff),
         count(c.id) filter (where c.state = 'review' and not c.suspended and c.due < p_day_end
                               and (c.buried_until is null or c.buried_until < p_today)),
         count(c.id) filter (where c.suspended)
    from public.fc_notes n
    join public.fc_cards c on c.note_id = n.id
   where n.user_id = auth.uid() and n.deleted_at is null and not n.inbox
   group by n.deck_id;
$$;

-- One row per review day between p_from and p_to: ratings, cram ratings,
-- time spent, cards seen for the first time, and the retention sample — the
-- first rating of the day of each card that was in review, passed or not.
create or replace function public.fc_daily_stats(
  p_from     date,
  p_to       date,
  p_deck_ids uuid[] default null
)
returns table (
  review_day      date,
  reviews         bigint,
  cram            bigint,
  ms              bigint,
  new_cards       bigint,
  retention_pass  bigint,
  retention_total bigint
)
language sql
stable
as $$
  with r as (
    select v.*,
           row_number() over (partition by v.card_id, v.review_day, v.kind order by v.id) as nth
      from public.fc_reviews v
     where v.user_id = auth.uid()
       and v.review_day between p_from and p_to
       and (p_deck_ids is null or v.deck_id = any (p_deck_ids))
  )
  select review_day,
         count(*) filter (where kind = 'review'),
         count(*) filter (where kind = 'cram'),
         coalesce(sum(duration_ms), 0)::bigint,
         count(*) filter (where kind = 'review' and state_before = 'new' and nth = 1),
         count(*) filter (where kind = 'review' and state_before = 'review' and nth = 1 and rating > 1),
         count(*) filter (where kind = 'review' and state_before = 'review' and nth = 1)
    from r
   group by review_day
   order by review_day;
$$;

-- Cards due per review day for the next p_days days, overdue ones counted
-- today. A review day starts at p_day_start o'clock in p_tz.
create or replace function public.fc_forecast(
  p_today     date,
  p_days      int,
  p_tz        text,
  p_day_start int,
  p_deck_ids  uuid[] default null
)
returns table (day date, cards bigint)
language sql
stable
as $$
  select greatest(((c.due at time zone p_tz) - make_interval(hours => p_day_start))::date, p_today) as day,
         count(*)
    from public.fc_cards c
    join public.fc_notes n on n.id = c.note_id
   where c.user_id = auth.uid()
     and c.state <> 'new' and not c.suspended
     and n.deleted_at is null
     and (p_deck_ids is null or n.deck_id = any (p_deck_ids))
     and ((c.due at time zone p_tz) - make_interval(hours => p_day_start))::date < p_today + p_days
   group by 1
   order by 1;
$$;

revoke execute on function public.fc_save_review(uuid, int, text, int, date, int, double precision, text, int,
  double precision, double precision, timestamptz, timestamptz, int, int, boolean) from public, anon;
revoke execute on function public.fc_undo_review(bigint) from public, anon;
revoke execute on function public.fc_delete_deck(uuid, uuid) from public, anon;
revoke execute on function public.fc_rename_tag(text, text) from public, anon;
revoke execute on function public.fc_tags() from public, anon;
revoke execute on function public.fc_deck_counts(timestamptz, timestamptz, date) from public, anon;
revoke execute on function public.fc_daily_stats(date, date, uuid[]) from public, anon;
revoke execute on function public.fc_forecast(date, int, text, int, uuid[]) from public, anon;

grant execute on function public.fc_save_review(uuid, int, text, int, date, int, double precision, text, int,
  double precision, double precision, timestamptz, timestamptz, int, int, boolean) to authenticated;
grant execute on function public.fc_undo_review(bigint) to authenticated;
grant execute on function public.fc_delete_deck(uuid, uuid) to authenticated;
grant execute on function public.fc_rename_tag(text, text) to authenticated;
grant execute on function public.fc_tags() to authenticated;
grant execute on function public.fc_deck_counts(timestamptz, timestamptz, date) to authenticated;
grant execute on function public.fc_daily_stats(date, date, uuid[]) to authenticated;
grant execute on function public.fc_forecast(date, int, text, int, uuid[]) to authenticated;

-- ------------------------------------------------------------------ trash

-- Run daily from cron.sql: notes in the trash for 30 days go for good (their
-- cards and history with them), and so do images no note mentions any more.
create or replace function public.fc_purge_trash()
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.fc_notes where deleted_at < now() - interval '30 days';
  delete from public.fc_media m
   where m.created_at < now() - interval '1 day'
     and not exists (
       select 1 from public.fc_notes n
        where n.user_id = m.user_id
          and (n.front like '%' || m.id::text || '%'
               or n.back like '%' || m.id::text || '%'
               or coalesce(n.extra, '') like '%' || m.id::text || '%'));
$$;

revoke execute on function public.fc_purge_trash() from public, anon, authenticated;

-- ------------------------------------------------- what Claude may touch
--
-- Same model as 0015 and 0017: a connector token can reach PostgREST
-- directly, so these policies are the boundary, not the MCP tool list.
--
--   fc_notes                                read; insert (forced into the inbox
--                                           by fc_notes_check); update only
--                                           while in the inbox, and never out
--                                           of it; no delete
--   fc_decks, fc_cards, fc_reviews,
--   fc_settings                             read only
--   fc_media                                nothing
--   write RPCs                              refused in their bodies

do $$
declare
  t text;
begin
  foreach t in array array['fc_decks', 'fc_cards', 'fc_reviews', 'fc_settings'] loop
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

drop policy if exists "no oauth clients" on public.fc_media;
create policy "no oauth clients" on public.fc_media
  as restrictive for all to authenticated
  using (not (select public.is_oauth_client()))
  with check (not (select public.is_oauth_client()));

drop policy if exists "oauth clients edit the inbox only" on public.fc_notes;
create policy "oauth clients edit the inbox only" on public.fc_notes
  as restrictive for update to authenticated
  using (not (select public.is_oauth_client()) or inbox)
  with check (not (select public.is_oauth_client()) or inbox);

drop policy if exists "oauth clients cannot delete notes" on public.fc_notes;
create policy "oauth clients cannot delete notes" on public.fc_notes
  as restrictive for delete to authenticated
  using (not (select public.is_oauth_client()));
