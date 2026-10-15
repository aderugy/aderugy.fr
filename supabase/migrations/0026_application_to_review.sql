-- /jobs: a "to_review" status ahead of "to_apply" — offers saved but not yet
-- read through. Open, like to_apply; the constraint just gains the value.

alter table public.applications drop constraint if exists applications_status_check;
alter table public.applications
  add constraint applications_status_check
  check (status in ('to_review', 'to_apply', 'applied', 'interviewing', 'offer',
                    'accepted', 'rejected', 'withdrawn'));
