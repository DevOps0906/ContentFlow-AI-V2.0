-- 0011: site readiness checks (P0-11). One current record per item and workspace, written by an
-- operator. Nothing here references articles: ad status never gates content state or publishing.

create table site_checks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces (id) on delete cascade,
  check_key text not null check (check_key in (
    'ownership_access', 'content_navigation', 'operator_privacy',
    'ad_connection', 'ads_txt', 'consent_management', 'post_launch', 'ad_status'
  )),
  status text not null,
  evidence_url text check (
    evidence_url is null or (length(evidence_url) <= 2000 and evidence_url ~* '^https?://[^[:space:]]+$')
  ),
  note text check (note is null or length(note) <= 1000),
  checked_by uuid not null references auth.users (id),
  checked_at timestamptz not null default now(),
  unique (workspace_id, check_key),
  -- `ad_status` holds the internal ad status; every other item holds a check result.
  constraint site_checks_status check (
    (check_key = 'ad_status' and status in (
      'not_configured', 'preparing', 'review_pending', 'active', 'limited', 'rejected', 'disabled', 'unknown'
    ))
    or (check_key <> 'ad_status' and status in ('pass', 'fail', 'unknown', 'not_applicable'))
  ),
  -- A recorded verdict needs a basis. "Not checked yet" and "not set up" have nothing to cite.
  constraint site_checks_evidence check (
    status in ('unknown', 'not_configured') or evidence_url is not null or btrim(coalesce(note, '')) <> ''
  )
);
comment on table site_checks is 'Operator-recorded site readiness and ad status per workspace. Never auto-verified; independent of article state.';

-- Who and when come from the session on every write, so a client can not backdate or reattribute.
create function stamp_site_check() returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_op = 'UPDATE' and (new.workspace_id <> old.workspace_id or new.check_key <> old.check_key) then
    raise exception 'a site check can not move to another workspace or item';
  end if;
  new.checked_by := auth.uid();
  new.checked_at := now();
  return new;
end $$;
create trigger site_checks_stamp before insert or update on site_checks
  for each row execute function stamp_site_check();

-- The unique (workspace_id, check_key) index covers the policy column. No delete policy: an item
-- is reset by recording `unknown`.
alter table site_checks enable row level security;
create policy site_checks_select on site_checks for select to authenticated using (is_member(workspace_id));
create policy site_checks_insert on site_checks for insert to authenticated
  with check (is_member(workspace_id, array['owner','admin']::workspace_role[]));
create policy site_checks_update on site_checks for update to authenticated
  using (is_member(workspace_id, array['owner','admin']::workspace_role[]))
  with check (is_member(workspace_id, array['owner','admin']::workspace_role[]));
