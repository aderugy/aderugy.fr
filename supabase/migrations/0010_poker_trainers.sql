-- /poker/trainers — drills built from Solver notes strategy nodes
--
-- A trainer fixes a matchup (hero seat vs villain seat), a pot and a street,
-- and holds strategy nodes picked in the Solver notes tree. Each node keeps the
-- context read from its ancestors (board, action line) so the trainer never
-- has to walk trees to render. Practising writes one answer per hand; every
-- answer carries a snapshot of what it was scored against, so re-importing a
-- strategy or deleting a node never rewrites past results.
--
-- Same rules as 0009: per-user, RLS `user_id = auth.uid()`, re-runnable.

-- ------------------------------------------------------------------ trainers

create table if not exists public.poker_trainers (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  name         text not null check (length(trim(name)) between 1 and 120),
  hero_seat    text not null check (hero_seat in ('UTG','HJ','CO','BTN','SB','BB')),
  villain_seat text not null check (villain_seat in ('UTG','HJ','CO','BTN','SB','BB')),
  pot_bb       numeric not null check (pot_bb > 0),
  stack_bb     numeric not null default 100 check (stack_bb > 0),
  -- Set by the first node added; every node of a trainer is on this street.
  street       text check (street in ('preflop','flop','turn','river')),
  archived     boolean not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  check (hero_seat <> villain_seat)
);

create index if not exists poker_trainers_user_idx on public.poker_trainers (user_id);

-- ------------------------------------------------------------- trainer nodes

create table if not exists public.poker_trainer_nodes (
  trainer_id   uuid not null references public.poker_trainers (id) on delete cascade,
  node_id      uuid not null references public.poker_nodes (id) on delete cascade,
  user_id      uuid not null references auth.users (id) on delete cascade,
  spot_id      uuid not null references public.poker_spots (id) on delete cascade,
  street       text not null check (street in ('preflop','flop','turn','river')),
  board        text[] not null default '{}',
  -- Actions on this street before the node: [{seat, kind, sizePct, label}]
  line         jsonb not null default '[]'::jsonb,
  hero_seat    text not null,
  villain_seat text not null,
  weight       numeric not null default 1 check (weight > 0),
  resolved_at  timestamptz not null default now(),
  added_at     timestamptz not null default now(),
  primary key (trainer_id, node_id)
);

create index if not exists poker_trainer_nodes_node_idx on public.poker_trainer_nodes (node_id);
create index if not exists poker_trainer_nodes_spot_idx on public.poker_trainer_nodes (spot_id);
create index if not exists poker_trainer_nodes_user_idx on public.poker_trainer_nodes (user_id);

-- ------------------------------------------------------------------ sessions

create table if not exists public.poker_trainer_sessions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  trainer_id  uuid not null references public.poker_trainers (id) on delete cascade,
  started_at  timestamptz not null default now(),
  ended_at    timestamptz,                   -- null = still open
  hands       int not null default 0,
  correct     int not null default 0,
  blunders    int not null default 0,
  last_answer_at timestamptz
);

create index if not exists poker_trainer_sessions_trainer_idx
  on public.poker_trainer_sessions (trainer_id, started_at desc);
create index if not exists poker_trainer_sessions_user_idx
  on public.poker_trainer_sessions (user_id);

-- ------------------------------------------------------------------- answers

create table if not exists public.poker_trainer_answers (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users (id) on delete cascade,
  session_id         uuid not null references public.poker_trainer_sessions (id) on delete cascade,
  node_id            uuid references public.poker_nodes (id) on delete set null,
  combo              text not null,
  board              text[] not null default '{}',
  actions            jsonb not null,          -- [{id,label,kind,sizePct,color}]
  freqs              numeric[] not null,      -- raw combo vector, aligned to actions
  rng                int not null check (rng between 0 and 99),
  expected_action_id text not null,
  chosen_action_id   text not null,
  chosen_freq        numeric not null,        -- after the noise cut, rescaled to 100
  grade              text not null check (grade in ('correct','wrong_band','mistake','blunder')),
  answered_ms        int,
  answered_at        timestamptz not null default now()
);

create index if not exists poker_trainer_answers_session_idx
  on public.poker_trainer_answers (session_id, answered_at);
create index if not exists poker_trainer_answers_node_idx
  on public.poker_trainer_answers (node_id);
create index if not exists poker_trainer_answers_user_idx
  on public.poker_trainer_answers (user_id);

-- ------------------------------------------------------------------ triggers

drop trigger if exists poker_trainers_touch_updated_at on public.poker_trainers;
create trigger poker_trainers_touch_updated_at
  before update on public.poker_trainers
  for each row execute function public.touch_updated_at();

-- ----------------------------------------------------------------------- RLS

alter table public.poker_trainers         enable row level security;
alter table public.poker_trainer_nodes    enable row level security;
alter table public.poker_trainer_sessions enable row level security;
alter table public.poker_trainer_answers  enable row level security;

drop policy if exists "own rows" on public.poker_trainers;
create policy "own rows" on public.poker_trainers
  for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own rows" on public.poker_trainer_nodes;
create policy "own rows" on public.poker_trainer_nodes
  for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own rows" on public.poker_trainer_sessions;
create policy "own rows" on public.poker_trainer_sessions
  for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own rows" on public.poker_trainer_answers;
create policy "own rows" on public.poker_trainer_answers
  for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ------------------------------------------------------------ record_answer

-- One round trip per hand: insert the answer and bump the session counters in
-- the same transaction. SECURITY INVOKER (the default), so RLS still decides
-- what the caller may touch; the explicit ownership check makes a foreign
-- session id fail loudly instead of inserting nothing.
create or replace function public.record_answer(
  p_session_id         uuid,
  p_node_id            uuid,
  p_combo              text,
  p_board              text[],
  p_actions            jsonb,
  p_freqs              numeric[],
  p_rng                int,
  p_expected_action_id text,
  p_chosen_action_id   text,
  p_chosen_freq        numeric,
  p_grade              text,
  p_answered_ms        int
) returns uuid
language plpgsql
as $$
declare
  v_id uuid;
begin
  if not exists (
    select 1 from public.poker_trainer_sessions
    where id = p_session_id and user_id = auth.uid() and ended_at is null
  ) then
    raise exception 'session not found or already ended';
  end if;

  insert into public.poker_trainer_answers (
    user_id, session_id, node_id, combo, board, actions, freqs, rng,
    expected_action_id, chosen_action_id, chosen_freq, grade, answered_ms
  ) values (
    auth.uid(), p_session_id, p_node_id, p_combo, coalesce(p_board, '{}'), p_actions, p_freqs, p_rng,
    p_expected_action_id, p_chosen_action_id, p_chosen_freq, p_grade, p_answered_ms
  ) returning id into v_id;

  update public.poker_trainer_sessions
     set hands          = hands + 1,
         correct        = correct + (p_grade = 'correct')::int,
         blunders       = blunders + (p_grade = 'blunder')::int,
         last_answer_at = now()
   where id = p_session_id;

  return v_id;
end;
$$;

grant execute on function public.record_answer(
  uuid, uuid, text, text[], jsonb, numeric[], int, text, text, numeric, text, int
) to authenticated;
