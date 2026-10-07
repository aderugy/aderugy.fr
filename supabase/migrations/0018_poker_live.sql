-- /poker/live — live cash sessions, the table, the players, the hands.
--
-- A session is one sitting at one table in a card room: where, the stakes,
-- money in (buy-in, rebuys) and out (cash-out), breaks. While it runs, the
-- table is rebuilt from a log of seat events (who sat where, sat out, came
-- back, left), so the session keeps the table's history and not just its
-- last state. Players are a database of their own, reused across sessions,
-- with tags and timestamped notes. Hands are entered action by action and
-- can be replayed.
--
--   live_players            the people Arthur plays against
--   live_tags               his flat list of player tags (fish, reg, nit…)
--   live_player_tags        many tags per player
--   live_player_notes       timestamped notes on a player, tied to a session
--                           or hand when taken during one
--   live_sessions           one sitting; at most one running at a time
--   live_session_events     buy-in, rebuys, breaks
--   live_seat_events        the table's log: sit, sit_out, back, leave, hero_move
--   live_hands              one hand: seats dealt in, button, blinds, the
--                           action sequence, board, shown cards, who won each pot
--
-- Amounts are in the session's currency (chips), not big blinds: that is what
-- is on the table and in the cash-out. Big blinds are computed for display.
--
-- The hand's action sequence is validated by replaying it in the app
-- (src/lib/live/hand.ts); here only its shape is checked.
--
-- Every statement is re-runnable, like 0007 onwards.

-- ------------------------------------------------------------------ players

create table if not exists public.live_players (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  name         text not null check (length(trim(name)) between 1 and 80),
  -- How to recognise them at the next session: looks, age, accent, seat habits.
  description  text check (description is null or length(description) <= 1000),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists live_players_user_name_idx on public.live_players (user_id, lower(name));

create table if not exists public.live_tags (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  name        text not null check (length(trim(name)) between 1 and 40),
  color       text check (color ~ '^#[0-9a-fA-F]{6}$'),
  position    int not null default 0,
  created_at  timestamptz not null default now()
);

create unique index if not exists live_tags_user_name_idx
  on public.live_tags (user_id, lower(trim(name)));

create table if not exists public.live_player_tags (
  user_id    uuid not null references auth.users (id) on delete cascade,
  player_id  uuid not null references public.live_players (id) on delete cascade,
  tag_id     uuid not null references public.live_tags (id) on delete cascade,
  primary key (player_id, tag_id)
);

create index if not exists live_player_tags_tag_idx on public.live_player_tags (tag_id);

-- ----------------------------------------------------------------- sessions

create table if not exists public.live_sessions (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  venue        text not null check (length(trim(venue)) between 1 and 120),
  game         text not null default 'NLHE' check (length(trim(game)) between 1 and 40),
  small_blind  numeric(12, 2) not null check (small_blind > 0),
  big_blind    numeric(12, 2) not null,
  currency     text not null default '€' check (length(currency) between 1 and 4),
  seats        int not null default 9 check (seats in (9, 10)),
  -- Where Arthur sits now. Moving seat logs a hero_move seat event.
  hero_seat    int not null,
  -- The button of the last hand entered; the next hand starts one seat on.
  button_seat  int,
  started_at   timestamptz not null default now(),
  ended_at     timestamptz,
  cash_out     numeric(12, 2) check (cash_out is null or cash_out >= 0),
  notes        text check (notes is null or length(notes) <= 20000),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  check (big_blind >= small_blind),
  check (hero_seat between 1 and seats),
  check (button_seat is null or button_seat between 1 and seats),
  check (ended_at is null or ended_at >= started_at),
  -- A finished session has a cash-out (zero when busted).
  check (ended_at is null or cash_out is not null)
);

create index if not exists live_sessions_user_started_idx on public.live_sessions (user_id, started_at desc);

-- One table at a time: the page always knows which session "now" is.
create unique index if not exists live_sessions_one_running_idx
  on public.live_sessions (user_id) where ended_at is null;

create table if not exists public.live_session_events (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  session_id  uuid not null references public.live_sessions (id) on delete cascade,
  kind        text not null check (kind in ('buy_in', 'rebuy', 'break_start', 'break_end')),
  amount      numeric(12, 2),
  at          timestamptz not null default now(),
  created_at  timestamptz not null default now(),
  check ((kind in ('buy_in', 'rebuy')) = (amount is not null)),
  check (amount is null or amount > 0)
);

create index if not exists live_session_events_session_idx on public.live_session_events (session_id, at);

-- -------------------------------------------------------------- the table

-- The table is a fold over this log, in `at` order: a seat is empty until a
-- `sit`, then occupied until a `leave`; `sit_out`/`back` toggle whether the
-- occupant is dealt in. `player_id` is null for someone not identified yet;
-- identifying them later fills it on their whole stay. `hero_move` records
-- Arthur changing seat (the session's hero_seat holds where he is now).
create table if not exists public.live_seat_events (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  session_id  uuid not null references public.live_sessions (id) on delete cascade,
  seat        int not null check (seat between 1 and 10),
  kind        text not null check (kind in ('sit', 'sit_out', 'back', 'leave', 'hero_move')),
  player_id   uuid references public.live_players (id) on delete set null,
  at          timestamptz not null default now(),
  created_at  timestamptz not null default now(),
  check (kind <> 'hero_move' or player_id is null)
);

create index if not exists live_seat_events_session_idx on public.live_seat_events (session_id, at, created_at);
create index if not exists live_seat_events_player_idx on public.live_seat_events (player_id) where player_id is not null;

-- ------------------------------------------------------------------- hands

create table if not exists public.live_hands (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  session_id   uuid not null references public.live_sessions (id) on delete cascade,
  -- 1, 2, 3… within the session, set on insert.
  number       int not null default 0,
  played_at    timestamptz not null default now(),
  button_seat  int not null check (button_seat between 1 and 10),
  hero_seat    int check (hero_seat is null or hero_seat between 1 and 10),
  small_blind  numeric(12, 2) not null check (small_blind > 0),
  big_blind    numeric(12, 2) not null check (big_blind >= small_blind),
  straddle     numeric(12, 2) check (straddle is null or straddle > big_blind),
  -- Who was dealt in: [{"seat": 3, "player_id": "…" | null, "stack": 412.5 | null}]
  seats        jsonb not null check (jsonb_typeof(seats) = 'array' and jsonb_array_length(seats) between 2 and 10),
  -- [{"seat": 3, "kind": "raise", "to": 15, "all_in": false}] — see hand.ts.
  actions      jsonb not null default '[]' check (jsonb_typeof(actions) = 'array'),
  hero_cards   text check (hero_cards is null or hero_cards ~ '^([2-9TJQKA][shdc]){2}$'),
  board        text[] not null default '{}' check (cardinality(board) <= 5),
  -- Cards shown at showdown: {"5": "AhKd"}
  shown        jsonb not null default '{}' check (jsonb_typeof(shown) = 'object'),
  -- Who took each pot, main pot first: [[5]], or [[3], [5, 8]] when a side
  -- pot was split. One entry per pot as the app splits them (hand.ts).
  winners      jsonb not null default '[]' check (jsonb_typeof(winners) = 'array'),
  -- Arthur's net on the hand, before rake. Computed by the app from the
  -- action and the winners, and editable for what it cannot know.
  hero_net     numeric(12, 2),
  starred      boolean not null default false,
  notes        text check (notes is null or length(notes) <= 10000),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists live_hands_session_idx on public.live_hands (session_id, number);
create index if not exists live_hands_seats_idx on public.live_hands using gin (seats jsonb_path_ops);

-- ------------------------------------------------------------ player notes

create table if not exists public.live_player_notes (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  player_id   uuid not null references public.live_players (id) on delete cascade,
  -- Where the note was taken; the note outlives both.
  session_id  uuid references public.live_sessions (id) on delete set null,
  hand_id     uuid references public.live_hands (id) on delete set null,
  body        text not null check (length(trim(body)) between 1 and 4000),
  -- Who wrote it: Arthur in the app, or Claude through the connector. Set by
  -- trigger from the token, never by the caller.
  source      text not null default 'app' check (source in ('app', 'claude')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists live_player_notes_player_idx on public.live_player_notes (player_id, created_at desc);

-- ------------------------------------------------------------------ triggers

do $$
declare
  t text;
begin
  foreach t in array array['live_players', 'live_sessions', 'live_hands', 'live_player_notes'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_touch_updated_at', t);
    execute format(
      'create trigger %I before update on public.%I
         for each row execute function public.touch_updated_at()',
      t || '_touch_updated_at', t);
  end loop;
end;
$$;

-- Hands are numbered within their session in the order they were entered.
create or replace function public.live_hands_number()
returns trigger
language plpgsql
as $$
begin
  select coalesce(max(number), 0) + 1 into new.number
    from public.live_hands
   where session_id = new.session_id;
  return new;
end;
$$;

drop trigger if exists live_hands_number on public.live_hands;
create trigger live_hands_number
  before insert on public.live_hands
  for each row execute function public.live_hands_number();

-- A seat must exist at the session's table.
create or replace function public.live_seat_in_range()
returns trigger
language plpgsql
as $$
declare
  n int;
begin
  select seats into n from public.live_sessions where id = new.session_id;
  if n is not null and new.seat > n then
    raise exception 'Seat % does not exist at a % -seat table', new.seat, n
      using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists live_seat_events_in_range on public.live_seat_events;
create trigger live_seat_events_in_range
  before insert or update of seat, session_id on public.live_seat_events
  for each row execute function public.live_seat_in_range();

-- Who wrote a note comes from the token, and does not change afterwards.
create or replace function public.live_player_notes_source()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    new.source := case when public.is_oauth_client() then 'claude' else 'app' end;
  else
    new.source := old.source;
  end if;
  return new;
end;
$$;

drop trigger if exists live_player_notes_source on public.live_player_notes;
create trigger live_player_notes_source
  before insert or update on public.live_player_notes
  for each row execute function public.live_player_notes_source();

-- ----------------------------------------------------------------------- RLS

alter table public.live_players        enable row level security;
alter table public.live_tags           enable row level security;
alter table public.live_player_tags    enable row level security;
alter table public.live_player_notes   enable row level security;
alter table public.live_sessions       enable row level security;
alter table public.live_session_events enable row level security;
alter table public.live_seat_events    enable row level security;
alter table public.live_hands          enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array[
    'live_players', 'live_tags', 'live_player_tags', 'live_player_notes',
    'live_sessions', 'live_session_events', 'live_seat_events', 'live_hands'
  ] loop
    execute format('drop policy if exists "own rows" on public.%I', t);
    execute format(
      'create policy "own rows" on public.%I
         for all to authenticated
         using (auth.uid() = user_id) with check (auth.uid() = user_id)',
      t);
  end loop;
end;
$$;

-- A row may only point at the caller's own parents. "own rows" checks the
-- row's user_id, not the ids it references, so an id guessed from someone
-- else would otherwise get through. Restrictive, on insert and update alike.

drop policy if exists "own session" on public.live_session_events;
create policy "own session" on public.live_session_events
  as restrictive for all to authenticated
  using (true)
  with check (exists (select 1 from public.live_sessions s where s.id = session_id and s.user_id = auth.uid()));

drop policy if exists "own session" on public.live_seat_events;
create policy "own session" on public.live_seat_events
  as restrictive for all to authenticated
  using (true)
  with check (exists (select 1 from public.live_sessions s where s.id = session_id and s.user_id = auth.uid()));

drop policy if exists "own player" on public.live_seat_events;
create policy "own player" on public.live_seat_events
  as restrictive for all to authenticated
  using (true)
  with check (player_id is null
              or exists (select 1 from public.live_players p where p.id = player_id and p.user_id = auth.uid()));

drop policy if exists "own session" on public.live_hands;
create policy "own session" on public.live_hands
  as restrictive for all to authenticated
  using (true)
  with check (exists (select 1 from public.live_sessions s where s.id = session_id and s.user_id = auth.uid()));

drop policy if exists "own player" on public.live_player_tags;
create policy "own player" on public.live_player_tags
  as restrictive for all to authenticated
  using (true)
  with check (exists (select 1 from public.live_players p where p.id = player_id and p.user_id = auth.uid()));

drop policy if exists "own tag" on public.live_player_tags;
create policy "own tag" on public.live_player_tags
  as restrictive for all to authenticated
  using (true)
  with check (exists (select 1 from public.live_tags g where g.id = tag_id and g.user_id = auth.uid()));

drop policy if exists "own refs" on public.live_player_notes;
create policy "own refs" on public.live_player_notes
  as restrictive for all to authenticated
  using (true)
  with check (
    exists (select 1 from public.live_players p where p.id = player_id and p.user_id = auth.uid())
    and (session_id is null or exists (select 1 from public.live_sessions s where s.id = session_id and s.user_id = auth.uid()))
    and (hand_id is null or exists (select 1 from public.live_hands h where h.id = hand_id and h.user_id = auth.uid()))
  );

-- ------------------------------------------------- what Claude may touch
--
-- Same model as 0015 and 0017: the connector's tokens can reach PostgREST
-- directly, so these policies are the boundary, not the MCP tool list.
--
--   live_player_notes     read; add notes; edit or delete only its own
--                         (source = 'claude'), never Arthur's
--   live_player_tags      read; put a tag on a player or take it off
--   everything else       read only: sessions, money, the table's log,
--                         hands, players, the tag list

do $$
declare
  t text;
begin
  foreach t in array array[
    'live_players', 'live_tags', 'live_sessions', 'live_session_events',
    'live_seat_events', 'live_hands'
  ] loop
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

drop policy if exists "oauth clients edit their own notes" on public.live_player_notes;
create policy "oauth clients edit their own notes" on public.live_player_notes
  as restrictive for update to authenticated
  using (not (select public.is_oauth_client()) or source = 'claude');

drop policy if exists "oauth clients delete their own notes" on public.live_player_notes;
create policy "oauth clients delete their own notes" on public.live_player_notes
  as restrictive for delete to authenticated
  using (not (select public.is_oauth_client()) or source = 'claude');
