-- 0008: article state history and delivery attempt log (P0-09).
-- State events are written only by the trigger below, so clients can read but never write them.
-- WordPress attempts are written with the caller's session: an operating reference only.
-- Both are removed with their article; append-only triggers would make every article undeletable.

create table article_state_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  article_id uuid not null,
  from_state article_state not null,
  to_state article_state not null,
  actor_id uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  foreign key (workspace_id, article_id) references articles (workspace_id, id) on delete cascade
);
comment on table article_state_events is 'Article state transitions, written only by the articles trigger.';
create index article_state_events_article_idx on article_state_events (workspace_id, article_id, created_at);

alter table article_state_events enable row level security;
-- No insert, update or delete policy: only the security definer trigger writes here.
create policy article_state_events_select on article_state_events for select to authenticated
  using (is_member(workspace_id));

create table delivery_attempts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  article_id uuid not null,
  channel text not null check (channel in ('wordpress', 'manual')),
  attempt int not null check (attempt > 0),
  -- Keep in sync with FAILURE_TYPES in apps/web/src/lib/delivery.ts (a test compares them).
  failure_type text check (failure_type in ('auth', 'not_found', 'rate_limited', 'server', 'rejected',
    'timeout', 'network', 'remote_state', 'invalid_response', 'not_sendable', 'config', 'unknown')),
  url text check (length(url) <= 2000 and url ~* '^https?://[^ ]+$'),
  duration_ms int check (duration_ms >= 0),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (article_id, channel, attempt),
  foreign key (workspace_id, article_id) references articles (workspace_id, id) on delete cascade,
  -- A manual hand-off has no outcome yet. A WordPress attempt either failed or returned a URL.
  check (case channel
    when 'manual' then failure_type is null and url is null and duration_ms is null
    else duration_ms is not null and (failure_type is null) = (url is not null)
  end)
);
comment on table delivery_attempts is 'Delivery attempts per article. Operating reference only.';
create index delivery_attempts_article_idx on delivery_attempts (workspace_id, article_id, created_at desc);

alter table delivery_attempts enable row level security;
create policy delivery_attempts_select on delivery_attempts for select to authenticated
  using (is_member(workspace_id));
-- No update or delete policy. Manual rows come only from the trigger below.
create policy delivery_attempts_insert on delivery_attempts for insert to authenticated
  with check (is_member(workspace_id, array['owner','admin','editor']::workspace_role[])
    and created_by = auth.uid() and channel = 'wordpress');

-- The attempt number is always assigned here, so a client can not choose it.
create function number_delivery_attempt() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform pg_advisory_xact_lock(hashtextextended(new.article_id::text, 8));
  select coalesce(max(attempt), 0) + 1 into new.attempt
    from delivery_attempts
    where article_id = new.article_id and channel = new.channel;
  return new;
end $$;
create trigger delivery_attempts_number before insert on delivery_attempts
  for each row execute function number_delivery_attempt();

-- AFTER the rules trigger: only transitions it accepted are recorded. Creating an article is not
-- a transition, so working time starts at the first real state change.
create function record_article_transition() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into article_state_events (workspace_id, article_id, from_state, to_state, actor_id)
    values (new.workspace_id, new.id, old.state, new.state, auth.uid());
  if new.state = 'manual_pending' then
    insert into delivery_attempts (workspace_id, article_id, channel, created_by)
      values (new.workspace_id, new.id, 'manual', auth.uid());
  end if;
  return null;
end $$;
create trigger articles_state_event after update on articles
  for each row when (old.state is distinct from new.state)
  execute function record_article_transition();
