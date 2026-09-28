-- /poker/spots becomes a game tree; trainers play whole hands in it
--
-- A spot is now all or part of the game tree of one heads-up hand. Its root
-- is a setup (who plays, where the tree starts, pot and stacks) stored on the
-- spot; the nodes below are decisions (`strategy`), the options taken
-- (`action`) and the cards dealt. The state of the hand at each node is
-- computed in the app (src/lib/solver/gameState.ts), never stored.
--
-- Existing trees are converted, nothing is deleted:
--   * text nodes are merged into their parent's notes (a root one into the
--     spot's root notes) and their children move up to that parent;
--   * actions that hang from something other than a decision (free-form
--     actions) get a decision node without a grid above them, carrying them
--     as its options;
--   * the setup is guessed: seats from the strategy nodes, start street from
--     the first nodes, pot and stack from a trainer that drilled the spot.
--
-- Trainers now play a hand from an entry node until it ends, so a pot per
-- trainer is gone (the tree gives it), answers are grouped by hand, and each
-- hand played is one row of poker_trainer_hands.
--
-- Same rules as 0009 / 0010: per-user, RLS `user_id = auth.uid()`, re-runnable.

-- ---------------------------------------------------------------- spot setup

alter table public.poker_spots add column if not exists setup jsonb;

-- ------------------------------------------------ text nodes → parent notes

do $$
declare
  tid uuid;
  t record;
  merged text;
begin
  -- Deepest first is not needed: a text child's content lands in its text
  -- parent's notes, which move up with it when that parent is processed.
  for tid in
    select id from public.poker_nodes where type = 'text' order by created_at desc
  loop
    -- Re-read: an earlier iteration may have moved this node or grown its notes.
    select id, spot_id, parent_id, data into t from public.poker_nodes where id = tid;
    merged := trim(both E'\n' from concat_ws(E'\n\n',
      nullif('### ' || coalesce(nullif(trim(t.data->>'title'), ''), 'Note'), '### '),
      nullif(trim(coalesce(t.data->>'summary', '')), ''),
      nullif(trim(coalesce(t.data->>'body', '')), ''),
      nullif(trim(coalesce(t.data->>'notes', '')), '')
    ));

    if t.parent_id is not null then
      update public.poker_nodes
         set data = jsonb_set(
               data, '{notes}',
               to_jsonb(trim(both E'\n' from concat_ws(E'\n\n', nullif(data->>'notes', ''), merged))))
       where id = t.parent_id;
    else
      update public.poker_spots
         set setup = jsonb_set(
               coalesce(setup, '{}'::jsonb), '{notes}',
               to_jsonb(trim(both E'\n' from concat_ws(E'\n\n', nullif(coalesce(setup, '{}'::jsonb)->>'notes', ''), merged))))
       where id = t.spot_id;
    end if;

    update public.poker_nodes set parent_id = t.parent_id where parent_id = t.id;
    delete from public.poker_nodes where id = t.id;
  end loop;
end
$$;

-- ------------------------------- free-form actions → a decision above them

do $$
declare
  g record;
  a record;
  decision_id uuid;
  opts jsonb;
  opt_id text;
begin
  for g in
    select n.spot_id, n.parent_id, min(n.user_id::text)::uuid as user_id, min(n.position) as position
    from public.poker_nodes n
    left join public.poker_nodes p on p.id = n.parent_id
    where n.type = 'action' and (n.parent_id is null or p.type <> 'strategy')
    group by n.spot_id, n.parent_id
  loop
    insert into public.poker_nodes (user_id, spot_id, parent_id, type, position, data)
    values (g.user_id, g.spot_id, g.parent_id, 'strategy', g.position,
            jsonb_build_object('actions', '[]'::jsonb,
                               'summary', 'Added when the tree became a game tree: no grid yet.'))
    returning id into decision_id;

    opts := '[]'::jsonb;
    for a in
      select n.id, n.data
      from public.poker_nodes n
      where n.type = 'action'
        and n.spot_id = g.spot_id
        and n.parent_id is not distinct from g.parent_id
        and n.id <> decision_id
      order by n.position, n.created_at
    loop
      opt_id := gen_random_uuid()::text;
      opts := opts || jsonb_build_array(jsonb_build_object(
        'id', opt_id,
        'kind', coalesce(a.data->>'kind', 'check'),
        'sizePct', a.data->'sizePct',
        'label', coalesce(a.data->>'label', 'Action'),
        'color', coalesce(a.data->>'color', '#64748b')
      ));
      update public.poker_nodes
         set parent_id = decision_id,
             data = jsonb_set(data, '{strategyActionId}', to_jsonb(opt_id))
       where id = a.id;
    end loop;

    update public.poker_nodes set data = jsonb_set(data, '{actions}', opts) where id = decision_id;
  end loop;
end
$$;

-- --------------------------------------------------------------- guess setups

do $$
declare
  sp record;
  seat_a text;
  seat_b text;
  start_street text;
  pot numeric;
  stack numeric;
begin
  for sp in
    select id, setup from public.poker_spots
    where setup is null or not (setup ? 'street')
  loop
    select n.data->>'seat', n.data->>'vsSeat' into seat_a, seat_b
    from public.poker_nodes n
    where n.spot_id = sp.id and n.type = 'strategy'
      and n.data->>'seat' in ('UTG','HJ','CO','BTN','SB','BB')
      and n.data->>'vsSeat' in ('UTG','HJ','CO','BTN','SB','BB')
      and n.data->>'seat' <> n.data->>'vsSeat'
    order by n.created_at
    limit 1;

    start_street := case
      when exists (select 1 from public.poker_nodes where spot_id = sp.id and parent_id is null and type = 'flop') then 'flop'
      when exists (select 1 from public.poker_nodes where spot_id = sp.id and parent_id is null and type = 'turn') then 'turn'
      when exists (select 1 from public.poker_nodes where spot_id = sp.id and parent_id is null and type = 'river') then 'river'
      else 'preflop'
    end;

    pot := null;
    stack := null;
    select t.pot_bb, t.stack_bb into pot, stack
    from public.poker_trainer_nodes tn
    join public.poker_trainers t on t.id = tn.trainer_id
    where tn.spot_id = sp.id and tn.street = start_street
    order by tn.added_at
    limit 1;

    update public.poker_spots
       set setup = coalesce(sp.setup, '{}'::jsonb) || jsonb_build_object(
             'players', case when seat_a is null then null else jsonb_build_array(seat_a, seat_b) end,
             'street', start_street,
             'potBb', case when start_street = 'preflop' then null else pot end,
             'stackBb', coalesce(case when start_street = 'preflop' then null else stack end, 100))
     where id = sp.id;
  end loop;
end
$$;

-- -------------------------------------------------- text is no longer a type

alter table public.poker_nodes drop constraint if exists poker_nodes_type_check;
alter table public.poker_nodes add constraint poker_nodes_type_check
  check (type in ('flop', 'turn', 'river', 'strategy', 'action'));

-- ------------------------------------------------------------------ trainers

alter table public.poker_trainers alter column pot_bb drop not null;
alter table public.poker_trainers
  add column if not exists stop_at_street_end boolean not null default false;
alter table public.poker_trainers
  add column if not exists feedback text not null default 'each';
alter table public.poker_trainers drop constraint if exists poker_trainers_feedback_check;
alter table public.poker_trainers add constraint poker_trainers_feedback_check
  check (feedback in ('each', 'hand_end'));

comment on column public.poker_trainers.pot_bb is 'Unused since 0013: the pot comes from the tree.';
comment on column public.poker_trainers.street is 'Unused since 0013: entries can sit on any street.';
comment on table public.poker_trainer_nodes is 'Entry nodes of a trainer: a hand starts at one of them.';

-- ------------------------------------------------------------------- hands

-- One row per hand played. The id is made in the browser so the hand's
-- answers can carry it before the hand is over.
create table if not exists public.poker_trainer_hands (
  id             uuid primary key,
  user_id        uuid not null references auth.users (id) on delete cascade,
  session_id     uuid not null references public.poker_trainer_sessions (id) on delete cascade,
  entry_node_id  uuid references public.poker_nodes (id) on delete set null,
  end_node_id    uuid references public.poker_nodes (id) on delete set null,
  combo          text,
  villain_combo  text,
  board          text[] not null default '{}',
  -- The whole hand: [{street, seat, label, amountBb}]
  line           jsonb not null default '[]'::jsonb,
  end_reason     text not null check (end_reason in (
                   'fold', 'showdown', 'allin', 'end_of_solution', 'branch_not_developed',
                   'off_range', 'no_runout', 'end_of_street')),
  decisions      int not null default 0,
  correct        int not null default 0,
  ended_at       timestamptz not null default now()
);

create index if not exists poker_trainer_hands_session_idx
  on public.poker_trainer_hands (session_id, ended_at);
create index if not exists poker_trainer_hands_user_idx on public.poker_trainer_hands (user_id);
create index if not exists poker_trainer_hands_end_node_idx on public.poker_trainer_hands (end_node_id);

alter table public.poker_trainer_hands enable row level security;
drop policy if exists "own rows" on public.poker_trainer_hands;
create policy "own rows" on public.poker_trainer_hands
  for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

alter table public.poker_trainer_answers add column if not exists hand_id uuid;
alter table public.poker_trainer_answers add column if not exists step int;
alter table public.poker_trainer_answers add column if not exists line jsonb;
alter table public.poker_trainer_answers add column if not exists pot_bb numeric;
create index if not exists poker_trainer_answers_hand_idx on public.poker_trainer_answers (hand_id);

-- `hands` keeps counting answers (decisions); these count hands played.
alter table public.poker_trainer_sessions add column if not exists played_hands int not null default 0;
alter table public.poker_trainer_sessions add column if not exists perfect_hands int not null default 0;

-- ------------------------------------------------------------ record_answer

drop function if exists public.record_answer(
  uuid, uuid, text, text[], jsonb, numeric[], int, text, text, numeric, text, int
);

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
  p_answered_ms        int,
  p_hand_id            uuid default null,
  p_step               int default null,
  p_line               jsonb default null,
  p_pot_bb             numeric default null
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
    expected_action_id, chosen_action_id, chosen_freq, grade, answered_ms,
    hand_id, step, line, pot_bb
  ) values (
    auth.uid(), p_session_id, p_node_id, p_combo, coalesce(p_board, '{}'), p_actions, p_freqs, p_rng,
    p_expected_action_id, p_chosen_action_id, p_chosen_freq, p_grade, p_answered_ms,
    p_hand_id, p_step, p_line, p_pot_bb
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
  uuid, uuid, text, text[], jsonb, numeric[], int, text, text, numeric, text, int, uuid, int, jsonb, numeric
) to authenticated;

-- -------------------------------------------------------------- record_hand

-- Written when a hand ends, after its answers. A hand with no decision (the
-- tree ended before hero had to act) is still a hand: it says where the tree
-- is missing a solution.
create or replace function public.record_hand(
  p_id             uuid,
  p_session_id     uuid,
  p_entry_node_id  uuid,
  p_end_node_id    uuid,
  p_combo          text,
  p_villain_combo  text,
  p_board          text[],
  p_line           jsonb,
  p_end_reason     text,
  p_decisions      int,
  p_correct        int
) returns uuid
language plpgsql
as $$
begin
  if not exists (
    select 1 from public.poker_trainer_sessions
    where id = p_session_id and user_id = auth.uid() and ended_at is null
  ) then
    raise exception 'session not found or already ended';
  end if;

  insert into public.poker_trainer_hands (
    id, user_id, session_id, entry_node_id, end_node_id, combo, villain_combo,
    board, line, end_reason, decisions, correct
  ) values (
    p_id, auth.uid(), p_session_id, p_entry_node_id, p_end_node_id, p_combo, p_villain_combo,
    coalesce(p_board, '{}'), coalesce(p_line, '[]'::jsonb), p_end_reason, p_decisions, p_correct
  );

  update public.poker_trainer_sessions
     set played_hands   = played_hands + 1,
         perfect_hands  = perfect_hands + (p_decisions > 0 and p_correct = p_decisions)::int,
         last_answer_at = now()
   where id = p_session_id;

  return p_id;
end;
$$;

grant execute on function public.record_hand(
  uuid, uuid, uuid, uuid, text, text, text[], jsonb, text, int, int
) to authenticated;
