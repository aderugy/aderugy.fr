-- Past events survive the calendar that deleted them.
--
-- One connected calendar removes an event as soon as it is over. Mirroring that
-- deletion would rewrite a week already lived: the hours would disappear from
-- the grid, from the category totals, and from the objectives they had already
-- filled. So a deletion is obeyed only while the event is still ahead. Once it
-- has ended, the row is archived instead — still on the grid, still counting —
-- and the only hand that can remove it is yours.

alter table public.external_events
  add column if not exists archived_at timestamptz;

comment on column public.external_events.archived_at is
  'Set when the provider dropped an event that had already ended. The row stays '
  'visible and keeps counting; the sync engine never deletes it, and only its '
  'owner can. Null for every event the provider still knows about — an upsert '
  'clears it, so an event that reappears upstream stops being an archive.';

-- Every question asked about archives is "which ones are mine": the settings
-- page counting them, the prune job stepping around them, the owner clearing
-- one out.
create index if not exists external_events_archived_idx
  on public.external_events (user_id, archived_at)
  where archived_at is not null;

-- The one write the owner has on the mirror.
--
-- Everything else in this table belongs to the sync engine, and an edit would
-- be reverted within minutes. An archive is the exception precisely because the
-- provider has already forgotten it: no sync will restore it, and no sync will
-- remove it either, so the decision has to be the owner's.
drop policy if exists "owner deletes archives" on public.external_events;

create policy "owner deletes archives" on public.external_events
  for delete to authenticated
  using (auth.uid() = user_id and archived_at is not null);
