-- /agenda — initial schema
--
-- Every table is per-user and protected by RLS: `user_id = auth.uid()`. That
-- policy is the security boundary, not the UI.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- categories

create table public.categories (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  parent_id   uuid references public.categories (id) on delete cascade,
  name        text not null check (length(trim(name)) between 1 and 80),
  color       text check (color ~ '^#[0-9a-fA-F]{6}$'),
  position    int not null default 0,
  archived    boolean not null default false,
  created_at  timestamptz not null default now()
);

create index categories_user_idx on public.categories (user_id);
create index categories_parent_idx on public.categories (parent_id);

-- Siblings must have distinct names. Root-level rows have a null parent, which
-- would defeat a plain unique constraint, hence the coalesce.
create unique index categories_sibling_name_idx
  on public.categories (
    user_id,
    coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid),
    lower(name)
  );

-- --------------------------------------------------------------------- tasks

create table public.tasks (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users (id) on delete cascade,
  category_id       uuid references public.categories (id) on delete set null,
  title             text not null check (length(trim(title)) between 1 and 200),
  notes             text,
  estimated_minutes int not null default 30 check (estimated_minutes between 5 and 1440),
  priority          smallint not null default 3 check (priority between 1 and 4),
  deadline          timestamptz,
  status            text not null default 'backlog'
                      check (status in ('backlog', 'scheduled', 'done', 'dropped')),
  splittable        boolean not null default true,
  completed_at      timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index tasks_user_status_idx on public.tasks (user_id, status);
create index tasks_category_idx on public.tasks (category_id);

-- -------------------------------------------------------------------- blocks

-- A block is a reusable template. With no items it is a *shape* ("Deep work,
-- 2h, mornings"); with items it is a *bundle* ("Morning routine").
create table public.blocks (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references auth.users (id) on delete cascade,
  name                text not null check (length(trim(name)) between 1 and 80),
  color               text check (color ~ '^#[0-9a-fA-F]{6}$'),
  default_minutes     int not null default 60 check (default_minutes between 5 and 1440),
  default_category_id uuid references public.categories (id) on delete set null,
  preferred_daypart   text check (preferred_daypart in ('morning', 'afternoon', 'evening')),
  archived            boolean not null default false,
  created_at          timestamptz not null default now()
);

create index blocks_user_idx on public.blocks (user_id);

-- Bundle contents are *templates*, not tasks: a morning routine recurs weekly
-- and must not pile up permanent backlog rows.
create table public.block_items (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users (id) on delete cascade,
  block_id          uuid not null references public.blocks (id) on delete cascade,
  position          int not null default 0,
  label             text not null check (length(trim(label)) between 1 and 200),
  estimated_minutes int not null default 15 check (estimated_minutes between 5 and 1440),
  category_id       uuid references public.categories (id) on delete set null
);

create index block_items_block_idx on public.block_items (block_id);

-- --------------------------------------------------------------------- weeks

create table public.weeks (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  week_start  date not null,
  theme       text,
  guidelines  text,
  created_at  timestamptz not null default now(),
  unique (user_id, week_start)
);

create table public.objectives (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users (id) on delete cascade,
  week_id        uuid not null references public.weeks (id) on delete cascade,
  title          text not null check (length(trim(title)) between 1 and 200),
  category_id    uuid references public.categories (id) on delete set null,
  target_minutes int check (target_minutes > 0),
  done           boolean not null default false,
  position       int not null default 0
);

create index objectives_week_idx on public.objectives (week_id);

-- ---------------------------------------------------------- scheduled blocks

create table public.scheduled_blocks (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users (id) on delete cascade,
  week_id         uuid not null references public.weeks (id) on delete cascade,
  starts_at       timestamptz not null,
  ends_at         timestamptz not null,
  title           text not null check (length(trim(title)) between 1 and 200),
  category_id     uuid references public.categories (id) on delete set null,
  source_block_id uuid references public.blocks (id) on delete set null,
  status          text not null default 'planned'
                    check (status in ('planned', 'done', 'skipped')),
  actual_minutes  int check (actual_minutes >= 0),
  -- Google Calendar columns are here from day one so the later sync is a
  -- feature, not a migration of live planning data.
  google_event_id text,
  google_synced_at timestamptz,
  sync_state      text not null default 'pending'
                    check (sync_state in ('pending', 'synced', 'failed')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  check (ends_at > starts_at)
);

create index scheduled_blocks_week_idx on public.scheduled_blocks (week_id);
create index scheduled_blocks_range_idx on public.scheduled_blocks (user_id, starts_at);

-- One task can span several sessions; one session can carry several tasks.
create table public.scheduled_block_tasks (
  user_id            uuid not null references auth.users (id) on delete cascade,
  scheduled_block_id uuid not null references public.scheduled_blocks (id) on delete cascade,
  task_id            uuid not null references public.tasks (id) on delete cascade,
  planned_minutes    int not null default 0 check (planned_minutes >= 0),
  primary key (scheduled_block_id, task_id)
);

create index scheduled_block_tasks_task_idx on public.scheduled_block_tasks (task_id);

-- ------------------------------------------------------------------ triggers

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger tasks_touch_updated_at
  before update on public.tasks
  for each row execute function public.touch_updated_at();

create trigger scheduled_blocks_touch_updated_at
  before update on public.scheduled_blocks
  for each row execute function public.touch_updated_at();

-- ----------------------------------------------------------------------- RLS

alter table public.categories            enable row level security;
alter table public.tasks                 enable row level security;
alter table public.blocks                enable row level security;
alter table public.block_items           enable row level security;
alter table public.weeks                 enable row level security;
alter table public.objectives            enable row level security;
alter table public.scheduled_blocks      enable row level security;
alter table public.scheduled_block_tasks enable row level security;

create policy "own rows" on public.categories
  for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own rows" on public.tasks
  for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own rows" on public.blocks
  for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own rows" on public.block_items
  for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own rows" on public.weeks
  for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own rows" on public.objectives
  for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own rows" on public.scheduled_blocks
  for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own rows" on public.scheduled_block_tasks
  for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ------------------------------------------------------------ derived views

-- Full category paths and inherited colors, for rollups and pickers.
-- security_invoker makes the view respect the caller's RLS instead of the
-- owner's — without it this would leak every user's tree.
create or replace view public.categories_with_path
with (security_invoker = true)
as
with recursive tree as (
  select
    c.id, c.user_id, c.parent_id, c.name, c.position, c.archived,
    c.name::text as path,
    1 as depth,
    coalesce(c.color, '#64748b') as effective_color,
    c.id as root_id
  from public.categories c
  where c.parent_id is null
  union all
  select
    c.id, c.user_id, c.parent_id, c.name, c.position, c.archived,
    t.path || ' > ' || c.name,
    t.depth + 1,
    coalesce(c.color, t.effective_color),
    t.root_id
  from public.categories c
  join tree t on c.parent_id = t.id
)
select * from tree;

-- Minutes planned per category per week — the base for the insights view.
create or replace view public.week_category_minutes
with (security_invoker = true)
as
select
  sb.user_id,
  sb.week_id,
  sb.category_id,
  sum(extract(epoch from (sb.ends_at - sb.starts_at)) / 60)::int as planned_minutes,
  sum(
    case when sb.status = 'done'
    then extract(epoch from (sb.ends_at - sb.starts_at)) / 60
    else 0 end
  )::int as done_minutes
from public.scheduled_blocks sb
group by sb.user_id, sb.week_id, sb.category_id;
