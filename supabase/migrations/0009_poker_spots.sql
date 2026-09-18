-- /poker/spots — solver-notes tree editor
--
-- A separate, authenticated tool from the static /poker calculator. The user
-- builds "spots" (solver trees, e.g. "BTN vs BB SRP") out of nodes on a 2D
-- canvas. Every table is per-user and protected by RLS: `user_id = auth.uid()`.
-- That policy is the security boundary, not the UI.
--
-- Written to be re-runnable (the Supabase CLI keys history on the numeric
-- prefix): `if not exists` on tables/indexes, guarded policies and triggers.

create extension if not exists pgcrypto;

-- --------------------------------------------------------------------- spots

create table if not exists public.poker_spots (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  name        text not null check (length(trim(name)) between 1 and 120),
  description text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists poker_spots_user_idx on public.poker_spots (user_id);

-- --------------------------------------------------------------------- nodes

-- A node is one card in the tree. `parent_id` null is a root. `data` holds the
-- type-specific payload (see src/lib/solver/types.ts): text {title,body},
-- flop {cards}, turn/river {card}, strategy {actions[]}, action {kind,size,...}.
-- The heavy per-hand strategy matrix lives in poker_strategies, not here, so
-- the canvas can list nodes without pulling big blobs.
create table if not exists public.poker_nodes (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  spot_id    uuid not null references public.poker_spots (id) on delete cascade,
  parent_id  uuid references public.poker_nodes (id) on delete cascade,
  type       text not null
               check (type in ('text', 'flop', 'turn', 'river', 'strategy', 'action')),
  position   int not null default 0,
  data       jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists poker_nodes_spot_idx on public.poker_nodes (spot_id);
create index if not exists poker_nodes_parent_idx on public.poker_nodes (spot_id, parent_id);
create index if not exists poker_nodes_user_idx on public.poker_nodes (user_id);

-- ---------------------------------------------------------------- strategies

-- One row per strategy node, kept apart so the canvas never fetches the grid.
-- `weights` is { hands: {"AKs":[..]}, combos: {"AhKs":[..]} }; vectors align to
-- the node's `data.actions` order and are read only when the node is opened.
create table if not exists public.poker_strategies (
  node_id    uuid primary key references public.poker_nodes (id) on delete cascade,
  user_id    uuid not null references auth.users (id) on delete cascade,
  weights    jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create index if not exists poker_strategies_user_idx on public.poker_strategies (user_id);

-- ------------------------------------------------------------------ triggers

-- touch_updated_at() already exists from 0001_agenda_init.sql; reuse it.

drop trigger if exists poker_spots_touch_updated_at on public.poker_spots;
create trigger poker_spots_touch_updated_at
  before update on public.poker_spots
  for each row execute function public.touch_updated_at();

drop trigger if exists poker_nodes_touch_updated_at on public.poker_nodes;
create trigger poker_nodes_touch_updated_at
  before update on public.poker_nodes
  for each row execute function public.touch_updated_at();

drop trigger if exists poker_strategies_touch_updated_at on public.poker_strategies;
create trigger poker_strategies_touch_updated_at
  before update on public.poker_strategies
  for each row execute function public.touch_updated_at();

-- ----------------------------------------------------------------------- RLS

alter table public.poker_spots      enable row level security;
alter table public.poker_nodes      enable row level security;
alter table public.poker_strategies enable row level security;

drop policy if exists "own rows" on public.poker_spots;
create policy "own rows" on public.poker_spots
  for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own rows" on public.poker_nodes;
create policy "own rows" on public.poker_nodes
  for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own rows" on public.poker_strategies;
create policy "own rows" on public.poker_strategies
  for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
