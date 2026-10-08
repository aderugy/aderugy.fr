-- Scheduled sync. Run this in the SQL editor after deploying the Edge Functions
-- (re-runnable: cron.schedule replaces a job of the same name), then add the
-- service-role key as described below.
--
-- Vercel's Hobby plan caps cron at once per day, so the safety net lives here
-- instead: pg_cron has a one-minute floor and fires on time.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Secrets the jobs need, in the Vault. The URL is filled in below; the key is
-- added by hand, once, in the SQL editor (Project Settings → API → service_role),
-- because it must never be committed:
--
--   select vault.create_secret('<service-role-key>', 'service_role_key');
--
-- Until it is there the jobs run and do nothing (see invoke_edge).
do $$
begin
  if not exists (select 1 from vault.secrets where name = 'project_url') then
    perform vault.create_secret('https://<project-ref>.supabase.co', 'project_url');
  end if;
end $$;

-- Calls an Edge Function with the service-role key from the Vault. Without the
-- key it does nothing and says so in the Postgres log, instead of failing a
-- cron run every minute.
create or replace function public.invoke_edge(fn text, payload jsonb default '{}'::jsonb)
returns bigint
language plpgsql
security definer
set search_path = public, vault, net
as $$
declare
  base text;
  key  text;
begin
  select decrypted_secret into base from vault.decrypted_secrets where name = 'project_url';
  select decrypted_secret into key  from vault.decrypted_secrets where name = 'service_role_key';
  if base is null or key is null then
    raise log 'invoke_edge(%): project_url or service_role_key missing from the Vault', fn;
    return null;
  end if;
  return net.http_post(
    url     := base || '/functions/v1/' || fn,
    headers := jsonb_build_object(
                 'Content-Type',  'application/json',
                 'Authorization', 'Bearer ' || key),
    body    := payload
  );
end;
$$;

revoke execute on function public.invoke_edge(text, jsonb) from public, authenticated, anon;

-- The freshness safety net: anything not synced in the last 5 minutes.
select cron.schedule(
  'google-sync-due',
  '*/5 * * * *',
  $$ select public.invoke_edge('google-sync', '{"due": true, "maxAgeSeconds": 300}'::jsonb) $$
);

-- Channel creation and renewal.
select cron.schedule(
  'google-channels-renew',
  '17 3 * * *',
  $$ select public.invoke_edge('google-channels') $$
);

-- Keep the mirror from growing without bound. Never touches sync tokens, and
-- never touches an archive: an archived event is one the provider has already
-- forgotten, so pruning it here would be exactly the automatic deletion the
-- archive exists to prevent. Those leave only when their owner removes them.
--
-- Already scheduled? cron.schedule on an existing job name replaces its command,
-- so re-running this one statement is enough to pick the archive clause up.
select cron.schedule(
  'google-events-prune',
  '43 4 * * *',
  $$ delete from public.external_events
      where ends_at < now() - interval '3 months'
        and archived_at is null $$
);

-- Push planned blocks to the Agenda calendar. The app already pushes right after
-- each edit; this catches whatever that missed — a kick lost to a cold start, a
-- rate limit, an edit made outside the app's actions (a rename, a SQL fix) —
-- and retries failed blocks. Once a minute, since it is what makes a move on
-- the grid show up on your phone.
select cron.schedule(
  'google-push-due',
  '* * * * *',
  -- Checked in SQL first, so an idle minute costs a query, not an invocation.
  $$ select public.invoke_edge('google-push', '{"due": true}'::jsonb)
      where exists (select 1 from public.users_due_for_push()) $$
);

-- Inspect with:  select * from cron.job;
--                select * from cron.job_run_details order by start_time desc limit 20;
