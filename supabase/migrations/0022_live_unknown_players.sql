-- /poker/live — unknown players are players, the button is the next hand's,
-- and a hand can carry blinds bought back.
--
-- Unknown players. Until now someone not identified was a seat with no
-- player (`player_id` null): no tags, no description, no notes. Now they are
-- rows of live_players like anyone, marked `known = false`, so they are tagged,
-- described and noted the same way, and kept apart from the known players in
-- the lists. Naming them flips `known`; recognising them as someone already in
-- the database merges them into that player (live_merge_players below). A new
-- session seats a fresh unknown in every seat but Arthur's.
--
-- The button. `live_sessions.button_seat` used to be the button of the last
-- hand entered; it is now where the button is for the next hand. Saving a hand
-- moves it on one seat, and Arthur can move it himself. When that seat is no
-- longer dealt in, the next hand takes the first seat dealt in after it.
--
-- Blinds bought back. A player back from missing the blinds posts them before
-- the cards: the big blind live (it counts as their bet, they keep the option)
-- and the small blind dead (it goes to the pot). `live_hands.posts` holds
-- these: [{"seat": 6, "live": 2, "dead": 1}]. The rules are in hand.ts.
--
-- Every statement is re-runnable, like 0007 onwards.

-- ---------------------------------------------------------- unknown players

alter table public.live_players
  add column if not exists known boolean not null default true;

create index if not exists live_players_user_known_idx on public.live_players (user_id, known);

-- ------------------------------------------------------------- the button

comment on column public.live_sessions.button_seat is
  'Where the button is for the next hand. Saving a hand moves it to the next seat dealt in; null before the first hand (the lowest seat dealt in).';

-- ------------------------------------------------------- blinds bought back

alter table public.live_hands
  add column if not exists posts jsonb not null default '[]';

alter table public.live_hands drop constraint if exists live_hands_posts_array;
alter table public.live_hands
  add constraint live_hands_posts_array check (jsonb_typeof(posts) = 'array' and jsonb_array_length(posts) <= 10);

-- ------------------------------------------------------------------- merge

-- "That unknown is Marco": everything known about the unknown moves to Marco —
-- their seats in every session's log, their notes, their tags, the hands they
-- were dealt into, and their description when Marco has none (or appended to
-- his) — then the unknown is deleted. One transaction: all or nothing.
--
-- Security invoker: it runs as the caller, under RLS, so it can only touch the
-- caller's rows; and a connected app (Claude) may not call it, as it may not
-- write to the table's log or the hands.
create or replace function public.live_merge_players(p_from uuid, p_into uuid)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  uid    uuid := auth.uid();
  f_desc text;
  t_desc text;
begin
  if (select public.is_oauth_client()) then
    raise exception 'A connected app cannot merge players' using errcode = '42501';
  end if;
  if p_from = p_into then
    raise exception 'A player cannot be merged into themselves' using errcode = '22023';
  end if;
  select description into f_desc from public.live_players where id = p_from and user_id = uid;
  if not found then
    raise exception 'No such player' using errcode = 'P0002';
  end if;
  select description into t_desc from public.live_players where id = p_into and user_id = uid;
  if not found then
    raise exception 'No such player' using errcode = 'P0002';
  end if;

  update public.live_seat_events set player_id = p_into where user_id = uid and player_id = p_from;
  update public.live_player_notes set player_id = p_into where user_id = uid and player_id = p_from;

  insert into public.live_player_tags (user_id, player_id, tag_id)
    select uid, p_into, tag_id from public.live_player_tags where user_id = uid and player_id = p_from
    on conflict do nothing;

  update public.live_hands h
     set seats = (
       select jsonb_agg(
                case when e ->> 'player_id' = p_from::text
                     then jsonb_set(e, '{player_id}', to_jsonb(p_into::text))
                     else e end
                order by o)
         from jsonb_array_elements(h.seats) with ordinality as x(e, o))
   where h.user_id = uid
     and h.seats @> jsonb_build_array(jsonb_build_object('player_id', p_from::text));

  if f_desc is not null then
    update public.live_players
       set description = case
             when t_desc is null then f_desc
             when position(f_desc in t_desc) > 0 then t_desc
             else left(t_desc || E'\n' || f_desc, 1000)
           end
     where id = p_into and user_id = uid;
  end if;

  delete from public.live_players where id = p_from and user_id = uid;
end;
$$;

revoke execute on function public.live_merge_players(uuid, uuid) from public, anon;
grant execute on function public.live_merge_players(uuid, uuid) to authenticated;
