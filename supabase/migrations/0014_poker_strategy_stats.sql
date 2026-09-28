-- Solver data imported with a strategy (PioBridge): both players' ranges and
-- equities and the acting player's EV, per combo — the shape is
-- `StrategyStats` in src/lib/solver/pio.ts. Null for strategies imported from
-- CSV or painted by hand. Loaded on demand, like the grid itself.
alter table public.poker_strategies add column if not exists stats jsonb;
