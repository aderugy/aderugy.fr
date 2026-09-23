-- /maths — parcours de probabilités et statistiques (ex-dépôt D:\Maths)
--
-- Le contenu (graphe, cours, exercices, cartes) reste dans content/maths/,
-- versionné dans git. La base ne porte que l'état qui change : progression
-- manuelle, journal de session, état FSRS des cartes, journal des révisions,
-- tentatives d'exercices. Ce sont les tables db/migrations/0001-0002 de
-- l'ancienne base SQLite, rendues par utilisateur.
--
-- Mêmes règles que 0009/0010 : RLS `user_id = auth.uid()`, rejouable.

-- ------------------------------------------------------------ node progress

create table if not exists public.maths_node_progress (
  user_id     uuid not null references auth.users (id) on delete cascade,
  node_id     text not null,
  manual      text not null default 'none'
              check (manual in ('none', 'in-progress', 'learned', 'mastered')),
  course_read boolean not null default false,
  -- Première fois que le nœud a atteint `mastered`. La maîtrise peut se perdre.
  mastered_at timestamptz,
  updated_at  timestamptz not null default now(),
  primary key (user_id, node_id)
);

-- --------------------------------------------------------------- session log

create table if not exists public.maths_session_log (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references auth.users (id) on delete cascade,
  node_id    text not null,
  minutes    int not null check (minutes between 0 and 1440),
  note       text not null default '',
  created_at timestamptz not null default now()
);

create index if not exists maths_session_log_node_idx
  on public.maths_session_log (user_id, node_id, created_at desc);

-- -------------------------------------------------------------- review state

-- Une ligne par carte. Le contenu des cartes vit dans content/maths/**/cards.yaml ;
-- ici il n'y a que ce qui change à chaque révision.
create table if not exists public.maths_review_state (
  user_id     uuid not null references auth.users (id) on delete cascade,
  card_key    text not null,              -- "<node_id>:<card_id>"
  node_id     text not null,
  card_id     text not null,
  stability   double precision not null default 0,
  difficulty  double precision not null default 0,
  due         date not null,              -- granularité jour
  last_review timestamptz,
  reps        int not null default 0,
  lapses      int not null default 0,
  primary key (user_id, card_key)
);

create index if not exists maths_review_state_due_idx
  on public.maths_review_state (user_id, due, node_id);

-- ---------------------------------------------------------------- review log

-- Historique complet, pour réoptimiser les poids FSRS le jour où il y aura
-- assez de données — d'où la conservation de l'état avant révision.
create table if not exists public.maths_review_log (
  id                bigint generated always as identity primary key,
  user_id           uuid not null references auth.users (id) on delete cascade,
  card_key          text not null,
  node_id           text not null,
  rating            int not null check (rating between 1 and 4),
  elapsed_days      double precision not null,
  stability_before  double precision not null,
  stability_after   double precision not null,
  difficulty_before double precision not null,
  reviewed_at       timestamptz not null default now()
);

create index if not exists maths_review_log_card_idx
  on public.maths_review_log (user_id, card_key, reviewed_at desc);

-- ------------------------------------------------------------------- attempt

-- `note` — ce qui a bloqué — est le champ le plus précieux du modèle.
-- `difficulty` est recopiée depuis le fichier de l'exercice pour que les
-- règles de progression n'aient pas à relire le contenu.
create table if not exists public.maths_attempt (
  id            bigint generated always as identity primary key,
  user_id       uuid not null references auth.users (id) on delete cascade,
  exercise_key  text not null,            -- "<node_id>/<fichier sans extension>"
  node_id       text not null,
  difficulty    int not null check (difficulty between 1 and 5),
  outcome       text not null
                check (outcome in ('resolu-seul', 'resolu-avec-indice',
                                   'echec', 'abandonne')),
  minutes_spent int not null default 0 check (minutes_spent between 0 and 1440),
  note          text not null default '',
  created_at    timestamptz not null default now()
);

create index if not exists maths_attempt_node_idx
  on public.maths_attempt (user_id, node_id, created_at desc);

-- ------------------------------------------------------------------ triggers

drop trigger if exists maths_node_progress_touch_updated_at on public.maths_node_progress;
create trigger maths_node_progress_touch_updated_at
  before update on public.maths_node_progress
  for each row execute function public.touch_updated_at();

-- ----------------------------------------------------------------------- RLS

alter table public.maths_node_progress enable row level security;
alter table public.maths_session_log   enable row level security;
alter table public.maths_review_state  enable row level security;
alter table public.maths_review_log    enable row level security;
alter table public.maths_attempt       enable row level security;

drop policy if exists "own rows" on public.maths_node_progress;
create policy "own rows" on public.maths_node_progress
  for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own rows" on public.maths_session_log;
create policy "own rows" on public.maths_session_log
  for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own rows" on public.maths_review_state;
create policy "own rows" on public.maths_review_state
  for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own rows" on public.maths_review_log;
create policy "own rows" on public.maths_review_log
  for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own rows" on public.maths_attempt;
create policy "own rows" on public.maths_attempt
  for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---------------------------------------------------------- maths_set_manual

-- Un upsert ne sait pas écrire `coalesce(mastered_at, now())` : mastered_at
-- garde la première date atteinte, la maîtrise pouvant se perdre ensuite.
create or replace function public.maths_set_manual(p_node_id text, p_manual text)
returns void
language sql
as $$
  insert into public.maths_node_progress (user_id, node_id, manual, mastered_at)
  values (
    auth.uid(), p_node_id, p_manual,
    case when p_manual = 'mastered' then now() end
  )
  on conflict (user_id, node_id) do update
     set manual      = excluded.manual,
         mastered_at = coalesce(maths_node_progress.mastered_at, excluded.mastered_at);
$$;

grant execute on function public.maths_set_manual(text, text) to authenticated;

-- --------------------------------------------------------- maths_save_review

-- Nouvel état de la carte et ligne de journal dans la même transaction.
-- SECURITY INVOKER (défaut) : la RLS décide toujours de ce qui est touché.
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

grant execute on function public.maths_save_review(
  text, text, text, int, double precision, double precision, double precision,
  double precision, double precision, date, timestamptz, int, int
) to authenticated;
