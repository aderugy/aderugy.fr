-- Everything /agenda draws for one week, in one round trip.
--
-- The page used to make three trips in series: find or create the week, then
-- nine reads in parallel, then the interviews on the week's sessions. Each
-- trip waits on the network, and the page renders again after every action
-- that refreshes the route, so they added up on every click. This function
-- runs the same reads inside the database and hands back one JSON document
-- whose keys mirror what PostgREST used to return, so the page keeps its
-- types.
--
-- security invoker: it reads as the caller, under the same RLS as the
-- queries it replaces. It is volatile only because a week row is created the
-- first time it is opened, exactly as ensureWeek() does.

create or replace function public.agenda_week(
  p_week_start  date,
  p_range_start timestamptz,
  p_range_end   timestamptz
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public
as $$
declare
  uid uuid := (select auth.uid());
  w   public.weeks;
begin
  if uid is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;

  select * into w from weeks where user_id = uid and week_start = p_week_start;
  if not found then
    insert into weeks (user_id, week_start) values (uid, p_week_start)
    on conflict (user_id, week_start) do nothing;
    select * into w from weeks where user_id = uid and week_start = p_week_start;
  end if;

  return jsonb_build_object(
    'week', jsonb_build_object(
      'id', w.id, 'week_start', w.week_start, 'theme', w.theme, 'guidelines', w.guidelines
    ),

    'categories', coalesce((
      select jsonb_agg(to_jsonb(c) order by c.position)
      from (
        select id, parent_id, name, color, position, archived
        from categories
        where user_id = uid and archived = false
      ) c
    ), '[]'::jsonb),

    -- The rail: work waiting on a slot. An interview's own task (ad_hoc, with
    -- an application) is left out; the interview reaches the grid through
    -- its session. Same rule as LISTED_TASKS in server/agenda/tasks.ts.
    'tasks', coalesce((
      select jsonb_agg(to_jsonb(t) order by t.created_at)
      from (
        select id, category_id, description, notes, estimated_minutes, priority,
               deadline, status, splittable, ad_hoc, completed_at, created_at
        from tasks
        where user_id = uid
          and status in ('backlog', 'scheduled')
          and (ad_hoc = false or application_id is null)
      ) t
    ), '[]'::jsonb),

    -- By time range rather than week_id, so a session shows where it sits
    -- whatever week it was planned from. Its task is embedded as `tasks`, and
    -- the interview it holds, if any, as `interview` (key absent otherwise).
    'sessions', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', s.id, 'task_id', s.task_id, 'week_id', s.week_id,
          'starts_at', s.starts_at, 'ends_at', s.ends_at,
          'status', s.status, 'created_by', s.created_by,
          'tasks', case when t.id is null then null else jsonb_build_object(
            'id', t.id, 'category_id', t.category_id, 'description', t.description,
            'notes', t.notes, 'estimated_minutes', t.estimated_minutes,
            'priority', t.priority, 'deadline', t.deadline, 'status', t.status,
            'created_at', t.created_at
          ) end
        )
        || case when i.id is null then '{}'::jsonb else jsonb_build_object(
          'interview', jsonb_build_object(
            'id', i.id, 'application_id', i.application_id, 'kind', i.kind,
            'prep_notes', i.prep_notes, 'debrief_notes', i.debrief_notes,
            'role_title', coalesce(a.role_title, ''),
            'company', coalesce(co.name, '')
          )
        ) end
        order by s.starts_at
      )
      from task_sessions s
      left join tasks t on t.id = s.task_id
      left join lateral (
        select * from interviews iv where iv.session_id = s.id limit 1
      ) i on true
      left join applications a on a.id = i.application_id
      left join companies co on co.id = a.company_id
      where s.user_id = uid
        and s.starts_at >= p_range_start
        and s.starts_at <  p_range_end
    ), '[]'::jsonb),

    'objectives', coalesce((
      select jsonb_agg(to_jsonb(o) order by o.position)
      from (
        select id, week_id, title, category_id, target_minutes, done, position
        from objectives
        where week_id = w.id
      ) o
    ), '[]'::jsonb),

    -- Google's picture of the window, archives included (see 0008).
    'external_events', coalesce((
      select jsonb_agg(to_jsonb(e) order by e.starts_at)
      from (
        select calendar_source_id, external_event_id, title, starts_at, ends_at,
               all_day, status, transparency, attendee_response, archived_at
        from external_events
        where user_id = uid
          and starts_at < p_range_end
          and ends_at   > p_range_start
      ) e
    ), '[]'::jsonb),

    'calendar_sources', coalesce((
      select jsonb_agg(to_jsonb(cs) order by cs.position)
      from (
        select id, provider, external_id, display_name, color, category_id, enabled,
               include_all_day, include_free, include_declined, position
        from calendar_sources
        where user_id = uid
      ) cs
    ), '[]'::jsonb),

    'google_account', (
      select to_jsonb(g)
      from (
        select google_email, connected_at, disconnected_at, last_error, last_error_at
        from google_accounts
        where user_id = uid
        limit 1
      ) g
    ),

    'sync_state', coalesce((
      select jsonb_agg(to_jsonb(ss))
      from (
        select google_calendar_id, last_synced_at
        from google_sync_state
        where user_id = uid
      ) ss
    ), '[]'::jsonb),

    'hidden_events', coalesce((
      select jsonb_agg(to_jsonb(h))
      from (
        select id, calendar_source_id, external_event_id, title, label, starts_at, created_at
        from hidden_external_events
        where user_id = uid
      ) h
    ), '[]'::jsonb)
  );
end
$$;

revoke execute on function public.agenda_week(date, timestamptz, timestamptz) from public, anon;
grant execute on function public.agenda_week(date, timestamptz, timestamptz) to authenticated;
