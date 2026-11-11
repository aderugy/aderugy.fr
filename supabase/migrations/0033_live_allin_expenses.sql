-- /poker/live — all-in EV on hands, food and drinks on sessions.
--
-- live_hands.allin: what a hand was worth when the money went in
--   {"street": "flop", "equity": 0.3133, "ev": -39.69, "runouts": 990}
-- set by the server when the hand is saved (src/lib/live/allin.ts) for a hand
-- where betting stopped with someone all-in before the river, Arthur still in
-- and every other seat still in showing its cards; null otherwise. `ev` is
-- after rake: Σ over pots of equity × (pot − rake) − what Arthur put in.
--
-- live_session_events gains `expense` (food, drinks) with an amount and a
-- `label` ("rice"). Not poker money: the result stays cash-out − buy-ins.
--
-- Every statement is re-runnable, like 0007 onwards.

alter table public.live_hands add column if not exists allin jsonb;

alter table public.live_hands drop constraint if exists live_hands_allin_shape;
alter table public.live_hands
  add constraint live_hands_allin_shape check (
    allin is null or (
      jsonb_typeof(allin) = 'object'
      and jsonb_typeof(allin -> 'ev') = 'number'
      and jsonb_typeof(allin -> 'equity') = 'number'
      and (allin ->> 'equity')::numeric between 0 and 1
    )
  );

alter table public.live_session_events add column if not exists label text;

alter table public.live_session_events drop constraint if exists live_session_events_label_check;
alter table public.live_session_events
  add constraint live_session_events_label_check check (
    label is null or (kind = 'expense' and length(trim(label)) between 1 and 80)
  );

alter table public.live_session_events drop constraint if exists live_session_events_kind_check;
alter table public.live_session_events
  add constraint live_session_events_kind_check
  check (kind in ('buy_in', 'rebuy', 'break_start', 'break_end', 'expense'));

-- Money kinds carry an amount; breaks do not.
alter table public.live_session_events drop constraint if exists live_session_events_check;
alter table public.live_session_events
  add constraint live_session_events_check
  check ((kind in ('buy_in', 'rebuy', 'expense')) = (amount is not null));
