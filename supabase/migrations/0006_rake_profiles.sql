-- Rake presets for /poker.
--
-- The calculator prices every call net of rake, so the tables below are what
-- make its numbers true for a given site. They live here rather than in the
-- app so a limit that changes — and they do change — is one INSERT away from
-- being right, with no deploy.
--
-- Reference data, not user data: every visitor reads the same rows, nobody
-- writes them from the app, and the tool works signed out.

create table public.rake_profiles (
  id             uuid primary key default gen_random_uuid(),

  -- Identity of the preset, and how the menu spells it.
  platform       text not null check (platform <> 'manual'),
  platform_label text not null,
  stakes         text not null,
  stakes_label   text not null,

  -- Players dealt in. Null when the site's cap does not depend on it; the
  -- highest value of a ladder means "that many and up" (see seats_label).
  seats          smallint check (seats between 2 and 10),
  seats_label    text,

  percent        numeric not null check (percent >= 0 and percent <= 100),

  -- What the maths uses. Everything in the app is in big blinds.
  cap_bb         numeric not null check (cap_bb >= 0),

  -- How the site itself states the cap, kept for display only: Winamax caps in
  -- euros, Betclic in big blinds.
  cap_amount     numeric check (cap_amount >= 0),
  big_blind      numeric check (big_blind > 0),
  currency       text,

  is_default     boolean not null default false,
  position       integer not null default 0,
  created_at     timestamptz not null default now(),

  unique nulls not distinct (platform, stakes, seats),

  constraint rake_profiles_seats_label_needs_seats
    check ((seats is null) = (seats_label is null)),

  constraint rake_profiles_amount_needs_currency
    check (cap_amount is null or (currency is not null and big_blind is not null)),

  -- The display cap and the cap the maths uses must be the same cap. This is
  -- the one way a hand-written row can be quietly, expensively wrong.
  constraint rake_profiles_cap_matches_amount
    check (
      cap_amount is null
      or big_blind is null
      or abs(cap_bb - cap_amount / big_blind) < 0.01
    )
);

create index rake_profiles_platform_idx on public.rake_profiles (platform, position);

-- At most one preset opens by default.
create unique index rake_profiles_single_default
  on public.rake_profiles ((true))
  where is_default;

alter table public.rake_profiles enable row level security;

-- /poker has no login, so the anonymous role reads these too. There is no
-- write policy on purpose: rows change from the SQL editor or a migration.
create policy "rake presets are public" on public.rake_profiles
  for select to anon, authenticated using (true);

-- ----------------------------------------------------------------- presets

insert into public.rake_profiles
  (platform, platform_label, stakes, stakes_label, seats, seats_label,
   percent, cap_bb, cap_amount, big_blind, currency, is_default, position)
values
  ('betclic', 'Betclic', 'NL5', 'NL5 · 6-max+', null, null, 5.5, 20, null, null, null, false, 10),
  ('betclic', 'Betclic', 'NL10', 'NL10 · 6-max+', null, null, 5.5, 15, null, null, null, false, 20),
  ('betclic', 'Betclic', 'NL25', 'NL25 · 6-max+', null, null, 5.5, 10, null, null, null, true, 30),
  ('betclic', 'Betclic', 'NL50', 'NL50 · 6-max+', null, null, 5.5, 6, null, null, null, false, 40),
  ('betclic', 'Betclic', 'NL100', 'NL100 · 6-max+', null, null, 5.5, 4, null, null, null, false, 50),
  ('winamax', 'Winamax', '0.01/0.02', '0,01 / 0,02 €', 2, '2 players', 5.75, 0.25 / 0.02, 0.25, 0.02, 'EUR', false, 60),
  ('winamax', 'Winamax', '0.01/0.02', '0,01 / 0,02 €', 3, '3 players', 5.75, 0.30 / 0.02, 0.30, 0.02, 'EUR', false, 70),
  ('winamax', 'Winamax', '0.01/0.02', '0,01 / 0,02 €', 4, '4 players', 5.75, 0.35 / 0.02, 0.35, 0.02, 'EUR', false, 80),
  ('winamax', 'Winamax', '0.01/0.02', '0,01 / 0,02 €', 5, '5+ players', 5.75, 0.40 / 0.02, 0.40, 0.02, 'EUR', false, 90),
  ('winamax', 'Winamax', '0.02/0.05', '0,02 / 0,05 €', 2, '2 players', 5.75, 0.50 / 0.05, 0.50, 0.05, 'EUR', false, 100),
  ('winamax', 'Winamax', '0.02/0.05', '0,02 / 0,05 €', 3, '3 players', 5.75, 0.65 / 0.05, 0.65, 0.05, 'EUR', false, 110),
  ('winamax', 'Winamax', '0.02/0.05', '0,02 / 0,05 €', 4, '4 players', 5.75, 0.80 / 0.05, 0.80, 0.05, 'EUR', false, 120),
  ('winamax', 'Winamax', '0.02/0.05', '0,02 / 0,05 €', 5, '5+ players', 5.75, 1.00 / 0.05, 1.00, 0.05, 'EUR', false, 130),
  ('winamax', 'Winamax', '0.05/0.10', '0,05 / 0,10 €', 2, '2 players', 5.75, 0.75 / 0.10, 0.75, 0.10, 'EUR', false, 140),
  ('winamax', 'Winamax', '0.05/0.10', '0,05 / 0,10 €', 3, '3 players', 5.75, 1.00 / 0.10, 1.00, 0.10, 'EUR', false, 150),
  ('winamax', 'Winamax', '0.05/0.10', '0,05 / 0,10 €', 4, '4 players', 5.75, 1.25 / 0.10, 1.25, 0.10, 'EUR', false, 160),
  ('winamax', 'Winamax', '0.05/0.10', '0,05 / 0,10 €', 5, '5+ players', 5.75, 1.50 / 0.10, 1.50, 0.10, 'EUR', false, 170),
  ('winamax', 'Winamax', '0.10/0.20', '0,10 / 0,20 €', 2, '2 players', 5.75, 1.50 / 0.20, 1.50, 0.20, 'EUR', false, 180),
  ('winamax', 'Winamax', '0.10/0.20', '0,10 / 0,20 €', 3, '3 players', 5.75, 1.75 / 0.20, 1.75, 0.20, 'EUR', false, 190),
  ('winamax', 'Winamax', '0.10/0.20', '0,10 / 0,20 €', 4, '4 players', 5.75, 2.00 / 0.20, 2.00, 0.20, 'EUR', false, 200),
  ('winamax', 'Winamax', '0.10/0.20', '0,10 / 0,20 €', 5, '5+ players', 5.75, 2.50 / 0.20, 2.50, 0.20, 'EUR', false, 210),
  ('winamax', 'Winamax', '0.15/0.30', '0,15 / 0,30 €', 2, '2 players', 5.75, 1.50 / 0.30, 1.50, 0.30, 'EUR', false, 220),
  ('winamax', 'Winamax', '0.15/0.30', '0,15 / 0,30 €', 3, '3 players', 5.75, 2.00 / 0.30, 2.00, 0.30, 'EUR', false, 230),
  ('winamax', 'Winamax', '0.15/0.30', '0,15 / 0,30 €', 4, '4 players', 5.75, 2.50 / 0.30, 2.50, 0.30, 'EUR', false, 240),
  ('winamax', 'Winamax', '0.15/0.30', '0,15 / 0,30 €', 5, '5+ players', 5.75, 3.00 / 0.30, 3.00, 0.30, 'EUR', false, 250),
  ('winamax', 'Winamax', '0.25/0.50', '0,25 / 0,50 €', 2, '2 players', 5.75, 1.50 / 0.50, 1.50, 0.50, 'EUR', false, 260),
  ('winamax', 'Winamax', '0.25/0.50', '0,25 / 0,50 €', 3, '3 players', 5.75, 2.00 / 0.50, 2.00, 0.50, 'EUR', false, 270),
  ('winamax', 'Winamax', '0.25/0.50', '0,25 / 0,50 €', 4, '4 players', 5.75, 2.50 / 0.50, 2.50, 0.50, 'EUR', false, 280),
  ('winamax', 'Winamax', '0.25/0.50', '0,25 / 0,50 €', 5, '5+ players', 5.75, 3.00 / 0.50, 3.00, 0.50, 'EUR', false, 290),
  ('winamax', 'Winamax', '0.50/1', '0,50 / 1 €', 2, '2 players', 5.75, 1.50 / 1.00, 1.50, 1.00, 'EUR', false, 300),
  ('winamax', 'Winamax', '0.50/1', '0,50 / 1 €', 3, '3 players', 5.75, 2.00 / 1.00, 2.00, 1.00, 'EUR', false, 310),
  ('winamax', 'Winamax', '0.50/1', '0,50 / 1 €', 4, '4 players', 5.75, 2.50 / 1.00, 2.50, 1.00, 'EUR', false, 320),
  ('winamax', 'Winamax', '0.50/1', '0,50 / 1 €', 5, '5+ players', 5.75, 3.00 / 1.00, 3.00, 1.00, 'EUR', false, 330);
