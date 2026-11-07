-- /poker/live — cards a player said he had, apart from cards he showed.
--
-- At a live table a player often says what he had without turning it over.
-- That is worth noting, but it is not the same as seeing it: `shown` stays
-- for cards seen, and `said` holds the claims, same shape ({"5": "AhKd"}).
-- A seat is in one or the other; the app checks it (src/lib/live/validate.ts).
--
-- Every statement is re-runnable, like 0007 onwards.

alter table public.live_hands
  add column if not exists said jsonb not null default '{}';

alter table public.live_hands drop constraint if exists live_hands_said_object;
alter table public.live_hands
  add constraint live_hands_said_object check (jsonb_typeof(said) = 'object');
