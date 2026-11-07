-- /poker/live — the card room's rake.
--
-- A session carries the room's rake rule (src/lib/live/rake.ts):
--   {"percent": 4, "step": 0.5, "cap": null, "preflop": true}
-- percent of the pot, rounded up to the next `step` (and at least one step),
-- capped at `cap` when the room caps, preflop pots raked or not. The rule is
-- kept per session so a room changing its rake does not rewrite old hands; a
-- new session copies the rule of the last session at the same venue.
--
-- A hand records what the room took (`rake`). When it is set, `hero_net` is
-- after rake; when it is null (no rule), `hero_net` is before rake, as before.
--
-- Pierre Charron: 4 %, in 0,50 € steps rounded up, 0,50 € minimum, no cap,
-- preflop raked. Its sessions get the rule; hands already entered keep their
-- before-rake net until they are saved again.
--
-- Every statement is re-runnable, like 0007 onwards.

alter table public.live_sessions add column if not exists rake jsonb;

alter table public.live_sessions drop constraint if exists live_sessions_rake_shape;
alter table public.live_sessions
  add constraint live_sessions_rake_shape check (
    rake is null or (
      jsonb_typeof(rake) = 'object'
      and jsonb_typeof(rake -> 'percent') = 'number'
      and (rake ->> 'percent')::numeric between 0 and 100
      and jsonb_typeof(rake -> 'step') = 'number'
      and (rake ->> 'step')::numeric >= 0
      and (rake -> 'cap' is null or jsonb_typeof(rake -> 'cap') = 'null'
           or (jsonb_typeof(rake -> 'cap') = 'number' and (rake ->> 'cap')::numeric >= 0))
      and jsonb_typeof(rake -> 'preflop') = 'boolean'
    )
  );

alter table public.live_hands add column if not exists rake numeric(12, 2);

alter table public.live_hands drop constraint if exists live_hands_rake_nonneg;
alter table public.live_hands
  add constraint live_hands_rake_nonneg check (rake is null or rake >= 0);

update public.live_sessions
   set rake = '{"percent": 4, "step": 0.5, "cap": null, "preflop": true}'::jsonb
 where lower(trim(venue)) = 'pierre charron'
   and rake is null;
