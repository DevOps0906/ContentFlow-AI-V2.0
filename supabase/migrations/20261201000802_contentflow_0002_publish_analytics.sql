-- ContentFlow-AI-V2.0 이식 · 조직형(org안) 2차. 원본: ContentFlow-AI-V2.0/supabase/migrations/0020~0027 (최종 상태로 합침)
-- 발행 큐(publish_jobs + RPC 4개) · 광고/분석 API 연결(analytics_connections · analytics_credentials · analytics_sync_runs)
-- · 동기화 저장 계약(revenue_rows/blog_metric_snapshots 출처 컬럼, tool gsc-api·ga4-api) · replace_synced_range 외 RPC.
-- workspace_id→organization_id, is_member→nomad_core.organization_role, memberships→nomad_core.memberships. 대응표: products/contentflow/existing.md
-- RPC 안에서 set_config('role')·SET ROLE 금지(caller_is_client가 role 설정을 읽는다). 숫자(5분·3개·50개·6회·15분·10분·400일)는 원본 가설값 그대로.
-- 전제: org/0001_contentflow.sql. 되돌림: 아래 객체 drop 후 revenue_rows·blog_metric_snapshots 추가 컬럼 drop, tool 검사 원복
--   (또는 drop schema nomad_contentflow cascade; — nomad_core.memberships의 contentflow_analytics_member_changed 트리거도 함께 사라진다).
begin;

-- =====================================================================
-- 발행 큐 (원본 0020 + 0021: 같은 조직 안에서만 사이트별 직렬화)
-- =====================================================================
create table nomad_contentflow.publish_jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references nomad_core.organizations(id) on delete cascade,
  article_id uuid not null,
  approved_version_id uuid not null,
  channel text not null default 'wordpress' check (channel in ('wordpress')),
  remote_key text not null check (length(btrim(remote_key)) between 1 and 500),
  idempotency_key text not null,
  status text not null default 'queued'
    check (status in ('queued', 'running', 'draft_created', 'succeeded', 'failed', 'needs_attention', 'cancelled')),
  attempts int not null default 0 check (attempts >= 0),
  max_attempts int not null default 6 check (max_attempts between 1 and 20),
  next_attempt_at timestamptz not null default now(),
  locked_at timestamptz,
  locked_by uuid references auth.users(id) on delete set null,
  last_error text check (length(last_error) <= 500),
  cancel_reason text check (length(cancel_reason) <= 100),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (organization_id, article_id) references nomad_contentflow.articles(organization_id, id) on delete cascade,
  foreign key (organization_id, approved_version_id) references nomad_contentflow.article_versions(organization_id, id) on delete cascade,
  check (status <> 'running' or locked_at is not null)
);
comment on table nomad_contentflow.publish_jobs is '발행 큐 작업. 멤버 읽기, 쓰기는 큐 RPC(security definer)만.';
comment on column nomad_contentflow.publish_jobs.idempotency_key is 'organization_id:article_id:approved_version_id. 기록용(유니크 아님).';
-- 글당 열린 작업 1개. 사이트(remote_key)당 실행 1개는 조직 안에서 claim_publish_job이 지킨다(now()를 쓰므로 인덱스 불가).
create unique index publish_jobs_article_open_uq on nomad_contentflow.publish_jobs (article_id)
  where status in ('queued', 'running', 'needs_attention');
create index publish_jobs_org_remote_running_idx on nomad_contentflow.publish_jobs (organization_id, remote_key) where status = 'running';
create index publish_jobs_status_due_idx on nomad_contentflow.publish_jobs (status, next_attempt_at);
create index publish_jobs_org_status_idx on nomad_contentflow.publish_jobs (organization_id, status);

create function nomad_contentflow.enqueue_publish_job(p_article_id uuid, p_remote_key text)
returns table (job_id uuid, status text, duplicate boolean)
language plpgsql security definer set search_path = ''
as $$
#variable_conflict use_column
declare
  org uuid;
  a nomad_contentflow.articles;
  vid uuid;
  ex nomad_contentflow.publish_jobs;
  nid uuid;
begin
  if auth.uid() is null then raise exception 'FORBIDDEN_ROLE'; end if;
  select organization_id into org from nomad_contentflow.articles where id = p_article_id;
  if not found or coalesce(nomad_core.organization_role(org), '') not in ('owner', 'admin', 'editor') then
    raise exception 'FORBIDDEN_ROLE';
  end if;
  if p_remote_key is null or length(btrim(p_remote_key)) not between 1 and 500 then
    raise exception 'REMOTE_KEY_INVALID';
  end if;
  select * into a from nomad_contentflow.articles where id = p_article_id for update;
  if a.state not in ('export_ready', 'publish_failed') then raise exception 'QUEUE_NOT_APPROVED'; end if;
  select v.id into vid from nomad_contentflow.article_versions v where v.article_id = a.id order by v.version desc limit 1;
  if vid is null then raise exception 'QUEUE_NOT_APPROVED'; end if;

  select * into ex from nomad_contentflow.publish_jobs j where j.article_id = a.id and j.status in ('queued', 'running', 'needs_attention');
  if found then
    if ex.approved_version_id = vid then
      -- 같은 버전을 다시 보내면 needs_attention에 대한 사람의 답(예: 자격 수정)이다: 큐로 되돌린다.
      if ex.status = 'needs_attention' then
        update nomad_contentflow.publish_jobs set status = 'queued', attempts = 0, next_attempt_at = now(), last_error = null,
          updated_at = now() where id = ex.id;
        return query select ex.id, 'queued'::text, true;
        return;
      end if;
      return query select ex.id, ex.status, true;
      return;
    elsif ex.status = 'running' then
      raise exception 'QUEUE_DUPLICATE';
    end if;
    update nomad_contentflow.publish_jobs set status = 'cancelled', cancel_reason = 'superseded', locked_at = null, locked_by = null,
      updated_at = now() where id = ex.id;
  end if;

  if (select count(*) from nomad_contentflow.publish_jobs j where j.organization_id = a.organization_id and j.status = 'queued') >= 50 then
    raise exception 'QUEUE_FULL';
  end if;
  insert into nomad_contentflow.publish_jobs (organization_id, article_id, approved_version_id, remote_key, idempotency_key, created_by)
    values (a.organization_id, a.id, vid, btrim(p_remote_key), a.organization_id || ':' || a.id || ':' || vid, auth.uid())
    returning id into nid;
  return query select nid, 'queued'::text, false;
end $$;

-- 호출자가 발행 권한을 가진 조직들의 p_remote_key 작업을 최대 1개 가져간다. 다른 조직에 관한 것은 아무것도 쓰지 않는다.
create function nomad_contentflow.claim_publish_job(p_remote_key text)
returns table (job_id uuid, article_id uuid, approved_version_id uuid)
language plpgsql security definer set search_path = ''
as $$
#variable_conflict use_column
declare
  uid uuid := auth.uid();
  orgs uuid[];
  w uuid;
  j nomad_contentflow.publish_jobs;
  r nomad_contentflow.publish_jobs;
  a nomad_contentflow.articles;
  latest uuid;
begin
  if uid is null then raise exception 'FORBIDDEN_ROLE'; end if;
  select coalesce(array_agg(m.organization_id order by m.organization_id), '{}') into orgs
    from nomad_core.memberships m join nomad_core.organizations o on o.id = m.organization_id and o.active
    where m.user_id = uid and m.role in ('owner', 'admin', 'editor');
  if cardinality(orgs) = 0 then raise exception 'FORBIDDEN_ROLE'; end if;
  if p_remote_key is null or length(btrim(p_remote_key)) not between 1 and 500 then
    raise exception 'REMOTE_KEY_INVALID';
  end if;
  -- 조직별 직렬화(어디서나 같은 순서).
  foreach w in array orgs loop
    perform pg_advisory_xact_lock(hashtextextended('publish_org:' || w::text, 21));
  end loop;

  for r in select * from nomad_contentflow.publish_jobs x where x.organization_id = any (orgs) and x.remote_key = p_remote_key
      and x.status = 'running' and x.locked_at < now() - interval '5 minutes' order by x.id for update loop
    update nomad_contentflow.publish_jobs set status = case when r.attempts >= r.max_attempts then 'failed' else 'queued' end,
      next_attempt_at = now(), locked_at = null, locked_by = null, last_error = 'stale_reclaim', updated_at = now()
      where id = r.id;
    update nomad_contentflow.articles set state = 'publish_failed' where id = r.article_id and state = 'publishing';
    insert into nomad_contentflow.audit_logs (organization_id, actor_id, action, payload)
      values (r.organization_id, uid, 'publish.stale_reclaim', jsonb_build_object('job_id', r.id, 'article_id', r.article_id));
  end loop;

  for j in select * from nomad_contentflow.publish_jobs x where x.status = 'queued' and x.next_attempt_at <= now()
      and x.remote_key = p_remote_key and x.organization_id = any (orgs)
      order by x.next_attempt_at, x.created_at for update skip locked loop
    -- 사이트당 실행 1개는 조직 안에서만(원본 0021: 한 조직이 공유 사이트를 붙잡아 다른 조직을 막지 못하게).
    if exists (select 1 from nomad_contentflow.publish_jobs x where x.organization_id = j.organization_id and x.remote_key = p_remote_key
        and x.status = 'running' and x.locked_at >= now() - interval '5 minutes') then
      continue;
    end if;
    if (select count(*) from nomad_contentflow.publish_jobs x where x.organization_id = j.organization_id and x.status = 'running'
        and x.locked_at >= now() - interval '5 minutes') >= 3 then
      continue;
    end if;
    select * into a from nomad_contentflow.articles where id = j.article_id for update;
    select v.id into latest from nomad_contentflow.article_versions v where v.article_id = j.article_id order by v.version desc limit 1;
    if latest is distinct from j.approved_version_id then
      update nomad_contentflow.publish_jobs set status = 'cancelled', cancel_reason = 'stale_version', updated_at = now() where id = j.id;
      continue;
    elsif a.state not in ('export_ready', 'publish_failed') then
      update nomad_contentflow.publish_jobs set status = 'cancelled', cancel_reason = 'article_changed', updated_at = now() where id = j.id;
      continue;
    end if;
    update nomad_contentflow.articles set state = 'publishing' where id = a.id;
    update nomad_contentflow.publish_jobs set status = 'running', attempts = attempts + 1, locked_at = now(), locked_by = uid,
      updated_at = now() where id = j.id;
    return query select j.id, j.article_id, j.approved_version_id;
    return;
  end loop;
  return;
end $$;

-- 실행 중 작업은 가져간 사람만 끝낸다. outcome: success | retry | fail | attention. 새 작업 상태를 돌려준다.
create function nomad_contentflow.finish_publish_job(p_job_id uuid, p_outcome text, p_retry_at timestamptz default null, p_error text default null)
returns text
language plpgsql security definer set search_path = ''
as $$
declare
  j nomad_contentflow.publish_jobs;
  st text;
  err text := left(p_error, 500);
begin
  if auth.uid() is null then raise exception 'FORBIDDEN_ROLE'; end if;
  if p_outcome is null or p_outcome not in ('success', 'retry', 'fail', 'attention') then
    raise exception 'OUTCOME_INVALID';
  end if;
  select * into j from nomad_contentflow.publish_jobs where id = p_job_id and status = 'running' and locked_by = auth.uid() for update;
  if not found then raise exception 'JOB_NOT_RUNNING'; end if;
  if coalesce(nomad_core.organization_role(j.organization_id), '') not in ('owner', 'admin', 'editor') then
    raise exception 'FORBIDDEN_ROLE';
  end if;

  if p_outcome = 'success' then
    st := 'draft_created'; err := null;
  elsif p_outcome = 'retry' then
    if j.attempts >= j.max_attempts then
      st := 'failed'; err := left('QUEUE_EXHAUSTED: ' || coalesce(err, ''), 500);
    elsif p_retry_at is not null and p_retry_at > now() + interval '1 hour' then
      st := 'needs_attention';
    else
      st := 'queued';
    end if;
  elsif p_outcome = 'fail' then
    st := 'failed';
  else
    st := 'needs_attention';
  end if;

  update nomad_contentflow.publish_jobs set status = st, locked_at = null, locked_by = null, last_error = err,
    next_attempt_at = case when st = 'queued' then greatest(coalesce(p_retry_at, now()), now()) else next_attempt_at end,
    updated_at = now() where id = j.id;
  update nomad_contentflow.articles
    set state = case when st = 'draft_created' then 'draft_created'::nomad_contentflow.article_state
                     else 'publish_failed'::nomad_contentflow.article_state end
    where id = j.article_id and state = 'publishing';
  return st;
end $$;

-- queued·needs_attention만 취소. 실행 중 작업은 그 시도가 끝나야 한다. 글 상태는 건드리지 않는다.
create function nomad_contentflow.cancel_publish_job(p_job_id uuid)
returns text
language plpgsql security definer set search_path = ''
as $$
declare
  org uuid;
  j nomad_contentflow.publish_jobs;
begin
  if auth.uid() is null then raise exception 'FORBIDDEN_ROLE'; end if;
  select organization_id into org from nomad_contentflow.publish_jobs where id = p_job_id;
  if not found or coalesce(nomad_core.organization_role(org), '') not in ('owner', 'admin', 'editor') then
    raise exception 'FORBIDDEN_ROLE';
  end if;
  select * into j from nomad_contentflow.publish_jobs where id = p_job_id for update;
  if j.status = 'running' then raise exception 'JOB_RUNNING'; end if;
  if j.status not in ('queued', 'needs_attention') then raise exception 'JOB_NOT_CANCELLABLE'; end if;
  update nomad_contentflow.publish_jobs set status = 'cancelled', cancel_reason = 'user_cancel', updated_at = now() where id = j.id;
  return 'cancelled';
end $$;

-- =====================================================================
-- 광고/분석 API 연결 (원본 0022·0023·0027)
-- =====================================================================
create table nomad_contentflow.analytics_connections (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references nomad_core.organizations(id) on delete cascade,
  blog_id uuid,   -- GSC/GA4: 속성이 속한 블로그. null = 미분류(AdSense)
  grant_id uuid,  -- revoked(권한 해제)일 때만 null
  provider text not null check (provider in ('gsc', 'adsense', 'ga4')),
  external_ref text not null check (length(btrim(external_ref)) between 1 and 500),
  scopes text[] not null default '{}' check (scopes <@ array[
    'https://www.googleapis.com/auth/webmasters.readonly',
    'https://www.googleapis.com/auth/adsense.readonly',
    'https://www.googleapis.com/auth/analytics.readonly']::text[]),
  status text not null default 'pending' check (status in ('pending', 'active', 'needs_reauth', 'revoked', 'error')),
  connected_by uuid not null references auth.users(id),
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  last_error_code text check (last_error_code is null or length(last_error_code) <= 60),
  created_at timestamptz not null default now(),
  check (status = 'revoked' or grant_id is not null),
  unique (organization_id, provider, external_ref),
  unique (organization_id, id),
  foreign key (organization_id, blog_id) references nomad_contentflow.blogs(organization_id, id)
);
comment on table nomad_contentflow.analytics_connections is '조직별 광고/분석 API 연결. 토큰 없음, 상태는 RPC로만 바뀐다. 멤버 읽기, owner/admin 쓰기, 삭제는 disconnect_connection만.';
create index analytics_connections_org_grant_idx on nomad_contentflow.analytics_connections (organization_id, grant_id);
create index analytics_connections_org_blog_idx on nomad_contentflow.analytics_connections (organization_id, blog_id);
create unique index analytics_connections_one_adsense on nomad_contentflow.analytics_connections (organization_id)
  where provider = 'adsense' and status <> 'revoked';
create unique index analytics_connections_one_per_blog on nomad_contentflow.analytics_connections
  (organization_id, provider, coalesce(blog_id, '00000000-0000-0000-0000-000000000000'::uuid))
  where provider in ('gsc', 'ga4') and status <> 'revoked';

create table nomad_contentflow.analytics_credentials (
  grant_id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references nomad_core.organizations(id) on delete cascade,
  google_sub text not null check (length(google_sub) between 1 and 255),
  client_id text not null check (length(client_id) between 1 and 255),
  ciphertext text not null check (length(ciphertext) between 1 and 8000),
  key_version int not null check (key_version >= 1),
  created_by uuid not null references auth.users(id),  -- 동의한 사람: owner/admin을 잃으면 무효
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, google_sub, client_id),
  unique (organization_id, grant_id)
);
comment on table nomad_contentflow.analytics_credentials is '암호화된 Google refresh token(ciphertext+key_version만, DB는 복호화 안 함). RLS 켬·정책 없음·클라이언트 권한 없음: 자격 RPC로만.';
create index analytics_credentials_creator_idx on nomad_contentflow.analytics_credentials (organization_id, created_by);
alter table nomad_contentflow.analytics_connections add constraint analytics_connections_grant_fk
  foreign key (organization_id, grant_id) references nomad_contentflow.analytics_credentials(organization_id, grant_id);

-- 모든 분석 RPC 공통: 로그인한 owner/admin.
create function nomad_contentflow.cf_analytics_require_admin(org uuid) returns void
language plpgsql stable security definer set search_path = ''
as $$
begin
  if auth.uid() is null or org is null or coalesce(nomad_core.organization_role(org), '') not in ('owner', 'admin') then
    raise exception 'ANALYTICS_FORBIDDEN';
  end if;
end $$;

-- 권한을 만든 사람이 아직 그 조직의 owner/admin인가. 연결 가드 트리거(클라이언트 권한으로 실행)가 부른다.
create function nomad_contentflow.cf_grant_creator_active(org uuid, g uuid) returns boolean
language sql stable security definer set search_path = ''
as $$
  select auth.uid() is not null and nomad_core.organization_role(org) is not null and exists (
    select 1 from nomad_contentflow.analytics_credentials c
      join nomad_core.memberships m on m.organization_id = c.organization_id and m.user_id = c.created_by
    where c.organization_id = org and c.grant_id = g and m.role in ('owner', 'admin'))
$$;

-- security definer 아님(의도): 클라이언트 직접 쓰기(authenticated/anon)만 막고 definer RPC(소유자 권한)는 통과.
create function nomad_contentflow.guard_analytics_connection() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if current_user not in ('authenticated', 'anon') then return new; end if;
  if tg_op = 'INSERT' then
    if new.status <> 'pending' or new.last_attempt_at is not null
       or new.last_success_at is not null or new.last_error_code is not null then
      raise exception 'CONNECTION_STATE_FORBIDDEN';
    end if;
    if new.grant_id is null or not nomad_contentflow.cf_grant_creator_active(new.organization_id, new.grant_id) then
      raise exception 'GRANT_OWNER_INACTIVE';
    end if;
  elsif (new.organization_id, new.grant_id, new.provider, new.external_ref, new.scopes, new.status,
         new.connected_by, new.last_attempt_at, new.last_success_at, new.last_error_code, new.created_at, new.id)
        is distinct from
        (old.organization_id, old.grant_id, old.provider, old.external_ref, old.scopes, old.status,
         old.connected_by, old.last_attempt_at, old.last_success_at, old.last_error_code, old.created_at, old.id) then
    raise exception 'CONNECTION_STATE_FORBIDDEN';
  elsif new.blog_id is distinct from old.blog_id
        and (exists (select 1 from nomad_contentflow.blog_metric_snapshots where connection_id = old.id)
             or exists (select 1 from nomad_contentflow.revenue_rows where connection_id = old.id)) then
    raise exception 'CONNECTION_HAS_DATA';
  end if;
  return new;
end $$;
create trigger analytics_connections_guard before insert or update on nomad_contentflow.analytics_connections
  for each row execute function nomad_contentflow.guard_analytics_connection();

-- 권한 저장(앱이 grant id를 정한다: AES-GCM AAD). 같은 (조직, google_sub, client)가 있으면 ciphertext는 두고
-- 호출자를 동의자로 바꾸고 needs_reauth 연결을 pending으로 되돌린다(암호문 교체는 rotate_credential).
create function nomad_contentflow.store_credential(p_organization uuid, p_grant_id uuid, p_google_sub text, p_client_id text, p_ciphertext text, p_key_version int)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare g uuid;
begin
  perform nomad_contentflow.cf_analytics_require_admin(p_organization);
  if p_grant_id is null then raise exception 'ANALYTICS_GRANT_ID_REQUIRED'; end if;
  insert into nomad_contentflow.analytics_credentials as c (grant_id, organization_id, google_sub, client_id, ciphertext, key_version, created_by)
    values (p_grant_id, p_organization, p_google_sub, p_client_id, p_ciphertext, p_key_version, auth.uid())
    on conflict (organization_id, google_sub, client_id) do nothing
    returning c.grant_id into g;
  if g is null then
    update nomad_contentflow.analytics_credentials set created_by = auth.uid(), updated_at = now()
      where organization_id = p_organization and google_sub = p_google_sub and client_id = p_client_id
      returning grant_id into g;
  end if;
  update nomad_contentflow.analytics_connections set status = 'pending', last_error_code = null
    where organization_id = p_organization and grant_id = g and status = 'needs_reauth';
  insert into nomad_contentflow.audit_logs (organization_id, actor_id, action, payload)
    values (p_organization, auth.uid(), 'analytics.credential_stored', jsonb_build_object('grant_id', g, 'key_version', p_key_version));
  return g;
end $$;

create function nomad_contentflow.read_credential(p_connection uuid)
returns table (grant_id uuid, ciphertext text, key_version int, provider text, organization_id uuid, google_sub text)
language plpgsql stable security definer set search_path = ''
as $$
#variable_conflict use_column
declare con nomad_contentflow.analytics_connections;
begin
  select * into con from nomad_contentflow.analytics_connections where id = p_connection;
  if not found then raise exception 'ANALYTICS_FORBIDDEN'; end if;
  perform nomad_contentflow.cf_analytics_require_admin(con.organization_id);
  if con.status not in ('pending', 'active', 'error') then raise exception 'CONNECTION_NOT_ACTIVE'; end if;
  if not nomad_contentflow.cf_grant_creator_active(con.organization_id, con.grant_id) then raise exception 'GRANT_OWNER_INACTIVE'; end if;
  return query select c.grant_id, c.ciphertext, c.key_version, con.provider, c.organization_id, c.google_sub
    from nomad_contentflow.analytics_credentials c where c.organization_id = con.organization_id and c.grant_id = con.grant_id;
end $$;

-- 키 교체: 목록 → 하나 읽기 → compare-and-set 교체.
create function nomad_contentflow.list_credential_versions(p_organization uuid)
returns table (grant_id uuid, key_version int)
language plpgsql stable security definer set search_path = ''
as $$
#variable_conflict use_column
begin
  perform nomad_contentflow.cf_analytics_require_admin(p_organization);
  return query select c.grant_id, c.key_version from nomad_contentflow.analytics_credentials c
    where c.organization_id = p_organization order by c.created_at;
end $$;

create function nomad_contentflow.read_grant_credential(p_grant uuid)
returns table (grant_id uuid, ciphertext text, key_version int, organization_id uuid, google_sub text)
language plpgsql stable security definer set search_path = ''
as $$
#variable_conflict use_column
declare org uuid;
begin
  select c.organization_id into org from nomad_contentflow.analytics_credentials c where c.grant_id = p_grant;
  if not found then raise exception 'ANALYTICS_FORBIDDEN'; end if;
  perform nomad_contentflow.cf_analytics_require_admin(org);
  if not nomad_contentflow.cf_grant_creator_active(org, p_grant) then raise exception 'GRANT_OWNER_INACTIVE'; end if;
  return query select c.grant_id, c.ciphertext, c.key_version, c.organization_id, c.google_sub
    from nomad_contentflow.analytics_credentials c where c.grant_id = p_grant;
end $$;

-- 해제 경로: 살아 있는 연결이 없는 권한의 토큰. 동의자 확인 없음(의도: 강등·탈퇴 뒤에도 Google 쪽 해제가 가능해야 한다).
create function nomad_contentflow.read_grant_for_revoke(p_grant uuid)
returns table (grant_id uuid, ciphertext text, key_version int, organization_id uuid, google_sub text)
language plpgsql stable security definer set search_path = ''
as $$
#variable_conflict use_column
declare org uuid;
begin
  select c.organization_id into org from nomad_contentflow.analytics_credentials c where c.grant_id = p_grant;
  if not found then raise exception 'ANALYTICS_FORBIDDEN'; end if;
  perform nomad_contentflow.cf_analytics_require_admin(org);
  if exists (select 1 from nomad_contentflow.analytics_connections k
             where k.organization_id = org and k.grant_id = p_grant and k.status <> 'revoked') then
    raise exception 'GRANT_IN_USE';
  end if;
  return query select c.grant_id, c.ciphertext, c.key_version, c.organization_id, c.google_sub
    from nomad_contentflow.analytics_credentials c where c.grant_id = p_grant;
end $$;

-- 바뀌었으면 true, 저장된 key_version이 이미 p_expected_version이 아니면 false.
create function nomad_contentflow.rotate_credential(p_grant uuid, p_expected_version int, p_ciphertext text, p_new_version int)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare org uuid; n int;
begin
  select organization_id into org from nomad_contentflow.analytics_credentials where grant_id = p_grant;
  if not found then raise exception 'ANALYTICS_FORBIDDEN'; end if;
  perform nomad_contentflow.cf_analytics_require_admin(org);
  update nomad_contentflow.analytics_credentials set ciphertext = p_ciphertext, key_version = p_new_version, updated_at = now()
    where grant_id = p_grant and key_version = p_expected_version;
  get diagnostics n = row_count;
  return n = 1;
end $$;

-- Google이 해제를 받아들인 뒤에만. 연결이 쓰는 권한은 지우지 않는다.
create function nomad_contentflow.delete_credential(p_grant uuid) returns void
language plpgsql security definer set search_path = ''
as $$
declare org uuid;
begin
  select organization_id into org from nomad_contentflow.analytics_credentials where grant_id = p_grant;
  if not found then raise exception 'ANALYTICS_FORBIDDEN'; end if;
  perform nomad_contentflow.cf_analytics_require_admin(org);
  if exists (select 1 from nomad_contentflow.analytics_connections where organization_id = org and grant_id = p_grant) then
    raise exception 'GRANT_IN_USE';
  end if;
  delete from nomad_contentflow.analytics_credentials where grant_id = p_grant;
  insert into nomad_contentflow.audit_logs (organization_id, actor_id, action, payload)
    values (org, auth.uid(), 'analytics.credential_deleted', jsonb_build_object('grant_id', p_grant));
end $$;

-- 멤버가 빠지거나 owner/admin을 잃으면 그 사람이 동의한 권한의 연결은 다시 동의가 필요하다(같은 트랜잭션).
-- 공통 표 nomad_core.memberships에 거는 제품 트리거(이름 접두 contentflow_). 실제 거부는 cf_grant_creator_active가 매번 한다.
create function nomad_contentflow.analytics_member_changed() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if old.role in ('owner', 'admin') and (tg_op = 'DELETE' or new.role not in ('owner', 'admin')) then
    update nomad_contentflow.analytics_connections k set status = 'needs_reauth'
      where k.organization_id = old.organization_id and k.status in ('pending', 'active', 'error')
        and k.grant_id in (select c.grant_id from nomad_contentflow.analytics_credentials c
                           where c.organization_id = old.organization_id and c.created_by = old.user_id);
  end if;
  return null;
end $$;
create trigger contentflow_analytics_member_changed after update of role or delete on nomad_core.memberships
  for each row execute function nomad_contentflow.analytics_member_changed();

-- =====================================================================
-- 동기화 실행 기록 (원본 0024)
-- =====================================================================
create table nomad_contentflow.analytics_sync_runs (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null,
  organization_id uuid not null references nomad_core.organizations(id) on delete cascade,
  requested_by uuid not null references auth.users(id),
  range_start date not null,
  range_end date not null,
  requested_at timestamptz not null default now(),
  status text not null default 'running' check (status in ('running', 'succeeded', 'partial', 'failed', 'delayed')),
  rows_written int not null default 0 check (rows_written >= 0),
  error_code text check (error_code is null or length(error_code) <= 60),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  check (range_start <= range_end),
  unique (organization_id, id),
  foreign key (organization_id, connection_id) references nomad_contentflow.analytics_connections(organization_id, id) on delete cascade
);
comment on table nomad_contentflow.analytics_sync_runs is '동기화 시도 1건 = 1행(상태·요청 범위·행 수·오류 코드). RPC만 기록, 90일·연결당 50건 보관.';
create index analytics_sync_runs_conn_idx on nomad_contentflow.analytics_sync_runs (connection_id, requested_at desc);
create index analytics_sync_runs_org_idx on nomad_contentflow.analytics_sync_runs (organization_id, requested_at desc);
create unique index analytics_sync_runs_one_running on nomad_contentflow.analytics_sync_runs (connection_id) where status = 'running';

create function nomad_contentflow.trim_analytics_sync_runs() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  delete from nomad_contentflow.analytics_sync_runs
    where connection_id = new.connection_id and status <> 'running'
      and (requested_at < now() - interval '90 days'
           or id not in (select id from nomad_contentflow.analytics_sync_runs where connection_id = new.connection_id
                         order by requested_at desc, id limit 50));
  return null;
end $$;
create trigger analytics_sync_runs_trim after insert on nomad_contentflow.analytics_sync_runs
  for each row execute function nomad_contentflow.trim_analytics_sync_runs();

-- 실행 시작: 연결당 15분 간격, 10분 넘게 running인 실행은 STALE 실패로 닫고(간격 계산에서 제외) 판단.
create function nomad_contentflow.begin_sync_run(p_connection uuid, p_range_start date, p_range_end date) returns uuid
language plpgsql security definer set search_path = ''
as $$
declare con nomad_contentflow.analytics_connections; r uuid;
begin
  select * into con from nomad_contentflow.analytics_connections where id = p_connection for update;
  if not found then raise exception 'ANALYTICS_FORBIDDEN'; end if;
  perform nomad_contentflow.cf_analytics_require_admin(con.organization_id);
  if con.status not in ('pending', 'active', 'error') then raise exception 'CONNECTION_NOT_ACTIVE'; end if;
  if not nomad_contentflow.cf_grant_creator_active(con.organization_id, con.grant_id) then raise exception 'GRANT_OWNER_INACTIVE'; end if;
  if p_range_start is null or p_range_end is null or p_range_start > p_range_end
     or p_range_end - p_range_start > 400 then
    raise exception 'SYNC_RANGE_INVALID';
  end if;
  update nomad_contentflow.analytics_sync_runs set status = 'failed', error_code = 'STALE', finished_at = now()
    where connection_id = con.id and status = 'running' and started_at < now() - interval '10 minutes';
  if exists (select 1 from nomad_contentflow.analytics_sync_runs where connection_id = con.id and status = 'running') then
    raise exception 'SYNC_RUNNING';
  end if;
  if exists (select 1 from nomad_contentflow.analytics_sync_runs where connection_id = con.id
             and requested_at > now() - interval '15 minutes'
             and not (status = 'failed' and error_code = 'STALE')) then
    raise exception 'SYNC_COOLDOWN';
  end if;
  insert into nomad_contentflow.analytics_sync_runs (connection_id, organization_id, requested_by, range_start, range_end)
    values (con.id, con.organization_id, auth.uid(), p_range_start, p_range_end) returning id into r;
  update nomad_contentflow.analytics_connections set last_attempt_at = now() where id = con.id;
  return r;
end $$;

-- 아무것도 쓰지 않은 실행 종료(failed·delayed). 연결은 needs_reauth·error로만 옮길 수 있다.
create function nomad_contentflow.finish_sync_run(p_run uuid, p_status text, p_error_code text, p_connection_status text default null)
returns void
language plpgsql security definer set search_path = ''
as $$
declare r nomad_contentflow.analytics_sync_runs;
begin
  select * into r from nomad_contentflow.analytics_sync_runs where id = p_run for update;
  if not found then raise exception 'ANALYTICS_FORBIDDEN'; end if;
  perform nomad_contentflow.cf_analytics_require_admin(r.organization_id);
  if p_status not in ('failed', 'delayed')
     or (p_connection_status is not null and p_connection_status not in ('needs_reauth', 'error')) then
    raise exception 'SYNC_STATUS_INVALID';
  end if;
  if r.status <> 'running' or r.requested_by <> auth.uid() then raise exception 'SYNC_RUN_INVALID'; end if;
  update nomad_contentflow.analytics_sync_runs set status = p_status, error_code = left(p_error_code, 60), finished_at = now() where id = r.id;
  update nomad_contentflow.analytics_connections set last_attempt_at = now(), last_error_code = left(p_error_code, 60),
      status = coalesce(p_connection_status, status)
    where id = r.connection_id and status <> 'revoked';
  insert into nomad_contentflow.audit_logs (organization_id, actor_id, action, payload)
    values (r.organization_id, auth.uid(), 'analytics.sync_failed',
            jsonb_build_object('run_id', r.id, 'status', p_status, 'error_code', left(p_error_code, 60)));
end $$;

-- =====================================================================
-- 동기화 저장 계약 (원본 0025): 출처 컬럼 3개 + tool gsc-api·ga4-api, 클라이언트 위조 거부
-- =====================================================================
alter table nomad_contentflow.revenue_rows
  add column coverage text not null default 'complete' check (coverage in ('complete', 'partial')),
  add column sync_run_id uuid,
  add column connection_id uuid;
alter table nomad_contentflow.revenue_rows
  add constraint revenue_rows_sync_run_fk foreign key (organization_id, sync_run_id)
    references nomad_contentflow.analytics_sync_runs(organization_id, id) on delete set null (sync_run_id),
  add constraint revenue_rows_connection_fk foreign key (organization_id, connection_id)
    references nomad_contentflow.analytics_connections(organization_id, id);
create index revenue_rows_connection_idx on nomad_contentflow.revenue_rows (organization_id, connection_id, report_date)
  where connection_id is not null;
comment on column nomad_contentflow.revenue_rows.coverage is 'partial = 실행이 범위 전체를 덮지 못함. 완전한 데이터로 세지 않는다.';
comment on table nomad_contentflow.revenue_rows is '광고 수익 리포트 행(통화별 소수 금액이라 원 정수 규칙 예외). CSV·수기 행, 또는 source adsense-api 행(replace_synced_range만 기록). 출처끼리 합치지 않는다.';

alter table nomad_contentflow.blog_metric_snapshots
  add column coverage text not null default 'complete' check (coverage in ('complete', 'partial')),
  add column sync_run_id uuid,
  add column connection_id uuid;
alter table nomad_contentflow.blog_metric_snapshots
  add constraint blog_metric_snapshots_sync_run_fk foreign key (organization_id, sync_run_id)
    references nomad_contentflow.analytics_sync_runs(organization_id, id) on delete set null (sync_run_id),
  add constraint blog_metric_snapshots_connection_fk foreign key (organization_id, connection_id)
    references nomad_contentflow.analytics_connections(organization_id, id);
create index blog_metric_snapshots_connection_idx on nomad_contentflow.blog_metric_snapshots (organization_id, connection_id, measured_on)
  where connection_id is not null;
-- tool 목록은 앱 apps/web/src/lib/blog-metrics.ts(METRIC_TOOLS · SYNCED_METRIC_TOOLS)와 맞춘다.
alter table nomad_contentflow.blog_metric_snapshots drop constraint blog_metric_snapshots_tool_check;
alter table nomad_contentflow.blog_metric_snapshots add constraint blog_metric_snapshots_tool_check
  check (tool in ('bseupi', 'blackkiwi', 'blogai', 'gsc', 'ubersuggest', 'clarity', 'other', 'gsc-api', 'ga4-api'));
comment on table nomad_contentflow.blog_metric_snapshots is '외부 도구 블로그 지표(도구·날짜·근거). 수기·CSV, 또는 tool gsc-api·ga4-api(replace_synced_range만, 연결·실행 기록). 도구끼리 합산·자체 지수 없음.';
comment on column nomad_contentflow.blog_metric_snapshots.tool is 'gsc-api·ga4-api 행은 replace_synced_range만 쓴다. 나머지는 운영자가 입력·가져온 값.';

-- security definer 아님: current_user가 문장의 역할(클라이언트는 authenticated, definer RPC 안은 소유자).
create function nomad_contentflow.guard_synced_revenue_row() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if current_user in ('authenticated', 'anon')
     and (lower(btrim(new.source)) = 'adsense-api' or new.connection_id is not null
          or new.sync_run_id is not null or new.coverage <> 'complete') then
    raise exception 'SYNCED_ROW_FORBIDDEN';
  end if;
  return new;
end $$;
create trigger revenue_rows_synced_guard before insert or update on nomad_contentflow.revenue_rows
  for each row execute function nomad_contentflow.guard_synced_revenue_row();

create function nomad_contentflow.guard_synced_metric_row() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if current_user in ('authenticated', 'anon')
     and (new.tool in ('gsc-api', 'ga4-api') or new.connection_id is not null
          or new.sync_run_id is not null or new.coverage <> 'complete') then
    raise exception 'SYNCED_ROW_FORBIDDEN';
  end if;
  return new;
end $$;
create trigger blog_metric_snapshots_synced_guard before insert or update on nomad_contentflow.blog_metric_snapshots
  for each row execute function nomad_contentflow.guard_synced_metric_row();

-- =====================================================================
-- replace_synced_range · purge · disconnect · reconnect (원본 0026)
-- =====================================================================
-- 앱 apps/web/src/lib/revenue.ts의 rowKey/normalizePage와 같은 규칙(기본 포트·퍼센트 인코딩 정규화는 없음).
create function nomad_contentflow.cf_normalize_page(page text) returns text
language plpgsql immutable set search_path = ''
as $$
declare p text := btrim(page); m text[]; path text; res text;
begin
  if p = '' then return ''; end if;
  m := regexp_match(p, '^https?://(?:[^/?#@]*@)?([^/?#]*)([^?#]*)(\?[^#]*)?', 'i');
  if m is not null then
    path := case when m[2] = '' then '/' else m[2] end;
    res := lower(regexp_replace(m[1] || path, '/+$', ''));
    if path = '/' and m[3] is not null and m[3] <> '?' then res := res || m[3]; end if;
    return res;
  end if;
  res := lower(regexp_replace((regexp_split_to_array(p, '[?#]'))[1], '/+$', ''));
  return case when res = '' then '/' else res end;
end $$;

create function nomad_contentflow.cf_revenue_row_key(source text, status text, currency text, report_date date, page text, timezone text) returns text
language sql immutable set search_path = ''
as $$
  select concat_ws('|', lower(source), status, currency, report_date::text, nomad_contentflow.cf_normalize_page(page), nullif(timezone, ''))
$$;

-- p_rows(jsonb 배열) adsense: {report_date,status,currency,page,timezone,revenue,pageviews,impressions,clicks}
--   gsc/ga4: {metric,scope,dimension,value,unit,measured_on} (blog_id는 연결에서). 쓴 행 수를 돌려준다.
-- 완전 실행은 이 연결의 범위 안 API 행을 지우고 이전 행 기간을 범위 전날로 자른다. 부분 실행은 가져온 날만 바꾼다.
-- 수기·CSV 행과 다른 연결의 행은 대상이 아니다. 오류: SYNC_RUN_INVALID · SYNC_ROWS_INVALID · SYNC_ROWS_DUPLICATE · SYNC_CAP_EXCEEDED · SYNC_RANGE_BEHIND.
create function nomad_contentflow.replace_synced_range(p_connection uuid, p_run uuid, p_range_start date, p_range_end date, p_rows jsonb, p_coverage text default 'complete')
returns int
language plpgsql security definer set search_path = ''
as $$
declare
  con nomad_contentflow.analytics_connections;
  r nomad_contentflow.analytics_sync_runs;
  n int;
  t text;
  partial boolean;
begin
  select * into con from nomad_contentflow.analytics_connections where id = p_connection for update;
  if not found then raise exception 'ANALYTICS_FORBIDDEN'; end if;
  perform nomad_contentflow.cf_analytics_require_admin(con.organization_id);
  if con.status not in ('pending', 'active', 'error') then raise exception 'CONNECTION_NOT_ACTIVE'; end if;
  select * into r from nomad_contentflow.analytics_sync_runs where id = p_run and connection_id = con.id for update;
  if not found or r.status <> 'running' or r.requested_by <> auth.uid()
     or r.range_start is distinct from p_range_start or r.range_end is distinct from p_range_end then
    raise exception 'SYNC_RUN_INVALID';
  end if;
  if p_coverage is null or p_coverage not in ('complete', 'partial')
     or p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 50000 then
    raise exception 'SYNC_ROWS_INVALID';
  end if;
  partial := p_coverage = 'partial';

  if con.provider = 'adsense' then
    t := 'adsense-api';
    if exists (select 1 from jsonb_to_recordset(p_rows) x(report_date date)
               where x.report_date is null or x.report_date not between p_range_start and p_range_end) then
      raise exception 'SYNC_ROWS_INVALID';
    end if;
    if exists (select 1 from jsonb_to_recordset(p_rows) as x(report_date date, status text, currency text, page text, timezone text)
               group by nomad_contentflow.cf_revenue_row_key(t, x.status, x.currency, x.report_date, coalesce(x.page, ''), x.timezone)
               having count(*) > 1) then
      raise exception 'SYNC_ROWS_DUPLICATE';
    end if;
    if exists (select 1 from nomad_contentflow.revenue_rows where organization_id = con.organization_id and connection_id = con.id
               and source = t and report_date > p_range_end) then
      raise exception 'SYNC_RANGE_BEHIND';
    end if;
    if partial then
      delete from nomad_contentflow.revenue_rows
        where organization_id = con.organization_id and connection_id = con.id and source = t
          and report_date in (select x.report_date from jsonb_to_recordset(p_rows) x(report_date date));
      update nomad_contentflow.revenue_rows set period_start = report_date, period_end = report_date
        where organization_id = con.organization_id and connection_id = con.id and source = t and period_end >= p_range_start;
    else
      delete from nomad_contentflow.revenue_rows
        where organization_id = con.organization_id and connection_id = con.id and source = t
          and report_date between p_range_start and p_range_end;
      update nomad_contentflow.revenue_rows set period_end = p_range_start - 1
        where organization_id = con.organization_id and connection_id = con.id and source = t and period_end >= p_range_start;
    end if;
    if (select count(*) from nomad_contentflow.revenue_rows where organization_id = con.organization_id) + jsonb_array_length(p_rows) > 20000 then
      raise exception 'SYNC_CAP_EXCEEDED';
    end if;
    insert into nomad_contentflow.revenue_rows (organization_id, row_key, source, status, currency, report_date, page, revenue,
                              pageviews, impressions, clicks, created_by, timezone, period_start, period_end,
                              coverage, sync_run_id, connection_id)
      select con.organization_id,
             nomad_contentflow.cf_revenue_row_key(t, x.status, x.currency, x.report_date, coalesce(x.page, ''), x.timezone),
             t, x.status, x.currency, x.report_date, coalesce(x.page, ''), x.revenue,
             x.pageviews, x.impressions, x.clicks, auth.uid(), x.timezone,
             case when partial then x.report_date else p_range_start end,
             case when partial then x.report_date else p_range_end end,
             p_coverage, r.id, con.id
      from jsonb_to_recordset(p_rows) as x(report_date date, status text, currency text, page text, timezone text,
                                           revenue numeric, pageviews bigint, impressions bigint, clicks bigint);
  elsif con.provider in ('gsc', 'ga4') then
    t := con.provider || '-api';
    if exists (select 1 from jsonb_to_recordset(p_rows) x(measured_on date)
               where x.measured_on is null or x.measured_on not between p_range_start and p_range_end) then
      raise exception 'SYNC_ROWS_INVALID';
    end if;
    -- 0001 측정 키(metric_key, scope, dimension_key, 날짜)와 같은 기준으로 중복 확인.
    if exists (select 1 from jsonb_to_recordset(p_rows) as x(metric text, scope text, dimension text, measured_on date)
               group by nomad_contentflow.cf_norm_key(x.metric), coalesce(x.scope, 'page'),
                        md5(case when coalesce(x.scope, 'page') = 'query'
                                 then nomad_contentflow.cf_norm_key(coalesce(x.dimension, ''))
                                 else btrim(coalesce(x.dimension, '')) end),
                        x.measured_on
               having count(*) > 1) then
      raise exception 'SYNC_ROWS_DUPLICATE';
    end if;
    if partial then
      delete from nomad_contentflow.blog_metric_snapshots
        where organization_id = con.organization_id and connection_id = con.id and tool = t
          and measured_on in (select x.measured_on from jsonb_to_recordset(p_rows) x(measured_on date));
    else
      delete from nomad_contentflow.blog_metric_snapshots
        where organization_id = con.organization_id and connection_id = con.id and tool = t
          and measured_on between p_range_start and p_range_end;
    end if;
    if (select count(*) from nomad_contentflow.blog_metric_snapshots where organization_id = con.organization_id) + jsonb_array_length(p_rows) > 30000 then
      raise exception 'SYNC_CAP_EXCEEDED';
    end if;
    insert into nomad_contentflow.blog_metric_snapshots (organization_id, blog_id, tool, metric, scope, dimension, value, unit,
                                       measured_on, created_by, coverage, sync_run_id, connection_id)
      select con.organization_id, con.blog_id, t, x.metric, coalesce(x.scope, 'page'), coalesce(x.dimension, ''),
             x.value, coalesce(x.unit, ''), x.measured_on, auth.uid(), p_coverage, r.id, con.id
      from jsonb_to_recordset(p_rows) as x(metric text, scope text, dimension text, value numeric, unit text, measured_on date);
  else
    raise exception 'SYNC_ROWS_INVALID';
  end if;
  get diagnostics n = row_count;

  update nomad_contentflow.analytics_sync_runs
    set status = case when partial then 'partial' else 'succeeded' end,
        rows_written = n, error_code = null, finished_at = now()
    where id = r.id;
  update nomad_contentflow.analytics_connections
    set status = 'active', last_attempt_at = now(), last_success_at = now(), last_error_code = null
    where id = con.id;
  insert into nomad_contentflow.audit_logs (organization_id, actor_id, action, payload)
    values (con.organization_id, auth.uid(), 'analytics.sync',
            jsonb_build_object('run_id', r.id, 'connection_id', con.id, 'provider', con.provider,
                               'rows', n, 'coverage', p_coverage));
  return n;
end $$;

-- 이 연결의 동기화 행만 지운다(revenue_rows source adsense-api, 지표 tool gsc-api·ga4-api).
create function nomad_contentflow.cf_delete_synced_rows(con nomad_contentflow.analytics_connections) returns int
language plpgsql security definer set search_path = ''
as $$
declare a int := 0; b int := 0;
begin
  delete from nomad_contentflow.revenue_rows
    where organization_id = con.organization_id and connection_id = con.id and source = 'adsense-api';
  get diagnostics a = row_count;
  delete from nomad_contentflow.blog_metric_snapshots
    where organization_id = con.organization_id and connection_id = con.id and tool in ('gsc-api', 'ga4-api');
  get diagnostics b = row_count;
  return a + b;
end $$;

create function nomad_contentflow.purge_synced_rows(p_connection uuid) returns int
language plpgsql security definer set search_path = ''
as $$
declare con nomad_contentflow.analytics_connections; n int;
begin
  select * into con from nomad_contentflow.analytics_connections where id = p_connection for update;
  if not found then raise exception 'ANALYTICS_FORBIDDEN'; end if;
  perform nomad_contentflow.cf_analytics_require_admin(con.organization_id);
  n := nomad_contentflow.cf_delete_synced_rows(con);
  insert into nomad_contentflow.audit_logs (organization_id, actor_id, action, payload)
    values (con.organization_id, auth.uid(), 'analytics.purge',
            jsonb_build_object('connection_id', con.id, 'provider', con.provider, 'rows', n));
  return n;
end $$;

-- 연결 끝내기(클라이언트 DELETE 정책 없음, 유일한 경로). 보존(기본): revoked로 두고 권한 해제.
-- 삭제(p_purge): 동기화 행과 연결을 지운다. 같은 권한을 아직 쓰는 연결 수를 돌려준다(0이면 앱이 Google 해제 후 delete_credential).
create function nomad_contentflow.disconnect_connection(p_connection uuid, p_purge boolean default false) returns int
language plpgsql security definer set search_path = ''
as $$
declare con nomad_contentflow.analytics_connections; n int := 0; left_over int;
begin
  select * into con from nomad_contentflow.analytics_connections where id = p_connection for update;
  if not found then raise exception 'ANALYTICS_FORBIDDEN'; end if;
  perform nomad_contentflow.cf_analytics_require_admin(con.organization_id);
  if p_purge then
    n := nomad_contentflow.cf_delete_synced_rows(con);
    delete from nomad_contentflow.analytics_connections where id = con.id;
  else
    update nomad_contentflow.analytics_connections set status = 'revoked', grant_id = null, last_error_code = null where id = con.id;
  end if;
  insert into nomad_contentflow.audit_logs (organization_id, actor_id, action, payload)
    values (con.organization_id, auth.uid(), 'analytics.disconnect',
            jsonb_build_object('connection_id', con.id, 'provider', con.provider, 'purged', coalesce(p_purge, false), 'rows', n));
  select count(*) into left_over from nomad_contentflow.analytics_connections
    where organization_id = con.organization_id and grant_id is not null and grant_id = con.grant_id and id <> con.id;
  return left_over;
end $$;

-- revoked 연결을 새 동의의 권한으로 되살린다(보존된 행은 그대로 붙어 있다). 다음 성공 동기화에서 active.
create function nomad_contentflow.reconnect_connection(p_connection uuid, p_grant uuid) returns void
language plpgsql security definer set search_path = ''
as $$
declare con nomad_contentflow.analytics_connections;
begin
  select * into con from nomad_contentflow.analytics_connections where id = p_connection for update;
  if not found then raise exception 'ANALYTICS_FORBIDDEN'; end if;
  perform nomad_contentflow.cf_analytics_require_admin(con.organization_id);
  if con.status <> 'revoked' then raise exception 'CONNECTION_NOT_REVOKED'; end if;
  if p_grant is null or not nomad_contentflow.cf_grant_creator_active(con.organization_id, p_grant) then
    raise exception 'GRANT_OWNER_INACTIVE';
  end if;
  update nomad_contentflow.analytics_connections set grant_id = p_grant, status = 'pending', connected_by = auth.uid(), last_error_code = null
    where id = con.id;
  insert into nomad_contentflow.audit_logs (organization_id, actor_id, action, payload)
    values (con.organization_id, auth.uid(), 'analytics.reconnect', jsonb_build_object('connection_id', con.id, 'provider', con.provider));
end $$;

-- =====================================================================
-- RLS · 권한 (필요한 만큼만)
-- =====================================================================
alter table nomad_contentflow.publish_jobs enable row level security;
alter table nomad_contentflow.analytics_connections enable row level security;
alter table nomad_contentflow.analytics_credentials enable row level security;
alter table nomad_contentflow.analytics_sync_runs enable row level security;

create policy publish_jobs_select on nomad_contentflow.publish_jobs for select to authenticated
  using (nomad_core.organization_role(organization_id) is not null);
create policy analytics_connections_select on nomad_contentflow.analytics_connections for select to authenticated
  using (nomad_core.organization_role(organization_id) is not null);
create policy analytics_connections_insert on nomad_contentflow.analytics_connections for insert to authenticated
  with check (nomad_core.organization_role(organization_id) in ('owner', 'admin') and connected_by = (select auth.uid()));
create policy analytics_connections_update on nomad_contentflow.analytics_connections for update to authenticated
  using (nomad_core.organization_role(organization_id) in ('owner', 'admin'))
  with check (nomad_core.organization_role(organization_id) in ('owner', 'admin'));
create policy analytics_sync_runs_select on nomad_contentflow.analytics_sync_runs for select to authenticated
  using (nomad_core.organization_role(organization_id) is not null);
-- analytics_credentials: 정책 없음(자격 RPC 전용)

revoke all on nomad_contentflow.publish_jobs, nomad_contentflow.analytics_connections,
  nomad_contentflow.analytics_credentials, nomad_contentflow.analytics_sync_runs from public, anon, authenticated;
grant select on nomad_contentflow.publish_jobs, nomad_contentflow.analytics_sync_runs to authenticated;
grant select, insert, update on nomad_contentflow.analytics_connections to authenticated;
grant select, insert, update, delete on nomad_contentflow.publish_jobs, nomad_contentflow.analytics_connections,
  nomad_contentflow.analytics_sync_runs to service_role;

revoke all on function
  nomad_contentflow.enqueue_publish_job(uuid, text), nomad_contentflow.claim_publish_job(text),
  nomad_contentflow.finish_publish_job(uuid, text, timestamptz, text), nomad_contentflow.cancel_publish_job(uuid),
  nomad_contentflow.cf_analytics_require_admin(uuid), nomad_contentflow.cf_grant_creator_active(uuid, uuid),
  nomad_contentflow.guard_analytics_connection(), nomad_contentflow.analytics_member_changed(),
  nomad_contentflow.store_credential(uuid, uuid, text, text, text, int), nomad_contentflow.read_credential(uuid),
  nomad_contentflow.list_credential_versions(uuid), nomad_contentflow.read_grant_credential(uuid),
  nomad_contentflow.read_grant_for_revoke(uuid), nomad_contentflow.rotate_credential(uuid, int, text, int),
  nomad_contentflow.delete_credential(uuid), nomad_contentflow.trim_analytics_sync_runs(),
  nomad_contentflow.begin_sync_run(uuid, date, date), nomad_contentflow.finish_sync_run(uuid, text, text, text),
  nomad_contentflow.guard_synced_revenue_row(), nomad_contentflow.guard_synced_metric_row(),
  nomad_contentflow.cf_normalize_page(text), nomad_contentflow.cf_revenue_row_key(text, text, text, date, text, text),
  nomad_contentflow.replace_synced_range(uuid, uuid, date, date, jsonb, text),
  nomad_contentflow.cf_delete_synced_rows(nomad_contentflow.analytics_connections),
  nomad_contentflow.purge_synced_rows(uuid), nomad_contentflow.disconnect_connection(uuid, boolean),
  nomad_contentflow.reconnect_connection(uuid, uuid)
  from public, anon, authenticated;
-- 트리거 함수는 실행 권한과 무관하게 동작한다. 연결 가드 트리거가 클라이언트 권한으로 cf_grant_creator_active를 부른다.
grant execute on function
  nomad_contentflow.enqueue_publish_job(uuid, text), nomad_contentflow.claim_publish_job(text),
  nomad_contentflow.finish_publish_job(uuid, text, timestamptz, text), nomad_contentflow.cancel_publish_job(uuid),
  nomad_contentflow.cf_grant_creator_active(uuid, uuid),
  nomad_contentflow.store_credential(uuid, uuid, text, text, text, int), nomad_contentflow.read_credential(uuid),
  nomad_contentflow.list_credential_versions(uuid), nomad_contentflow.read_grant_credential(uuid),
  nomad_contentflow.read_grant_for_revoke(uuid), nomad_contentflow.rotate_credential(uuid, int, text, int),
  nomad_contentflow.delete_credential(uuid),
  nomad_contentflow.begin_sync_run(uuid, date, date), nomad_contentflow.finish_sync_run(uuid, text, text, text),
  nomad_contentflow.replace_synced_range(uuid, uuid, date, date, jsonb, text),
  nomad_contentflow.purge_synced_rows(uuid), nomad_contentflow.disconnect_connection(uuid, boolean),
  nomad_contentflow.reconnect_connection(uuid, uuid)
  to authenticated;

commit;
