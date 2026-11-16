-- ContentFlow-AI-V2.0 이식 · 조직형(org안). 원본: ContentFlow-AI-V2.0/supabase/migrations/0001~0019 (최종 상태로 합침)
-- workspaces→nomad_core.organizations, memberships·invitations→nomad_core, workspace_entitlements→plan_limits 키
-- (included_blogs · max_blogs · overage_allowed). 대응표: products/contentflow/existing.md
-- 전제: nomad_core.touch_updated_at() (core 20261119000100 예정). 되돌림: drop schema nomad_contentflow cascade; drop schema nomad_contentflow_private cascade;
begin;

create schema nomad_contentflow;
create schema nomad_contentflow_private;
revoke all on schema nomad_contentflow, nomad_contentflow_private from public, anon, authenticated;
grant usage on schema nomad_contentflow to anon, authenticated, service_role;

insert into nomad_core.products (code, name) values ('contentflow', 'ContentFlow AI') on conflict (code) do nothing;

create type nomad_contentflow.blog_platform as enum ('wordpress', 'tistory', 'blogger', 'naver');
create type nomad_contentflow.article_state as enum (
  'idea', 'researching', 'briefing', 'drafting', 'qa_pending', 'needs_revision',
  'approval_pending', 'approved', 'export_ready', 'manual_pending', 'publishing',
  'publish_failed', 'draft_created', 'published', 'monitoring', 'update_due'
);
create type nomad_contentflow.approval_decision as enum ('approved', 'rejected');

-- ---------- 권한 도우미 ----------
-- nomad_core 역할은 owner/admin/editor/viewer 뿐이라 원본의 reviewer는 제품 표(reviewers)로 둔다.
create table nomad_contentflow.reviewers (
  organization_id uuid not null,
  user_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (organization_id, user_id),
  foreign key (organization_id, user_id) references nomad_core.memberships(organization_id, user_id) on delete cascade
);
comment on table nomad_contentflow.reviewers is '검수자 지정(조직 멤버 중). nomad_core 역할에 reviewer가 없어 제품에서 보강.';

create function nomad_contentflow.is_reviewer(target_organization uuid) returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from nomad_contentflow.reviewers r
    where r.organization_id = target_organization and r.user_id = (select auth.uid())
      and nomad_core.organization_role(target_organization) is not null
  )
$$;

create function nomad_contentflow.has_role(target_organization uuid, roles text[], include_reviewer boolean default false)
returns boolean
language sql stable set search_path = ''
as $$
  select coalesce(nomad_core.organization_role(target_organization) = any (roles), false)
      or (include_reviewer and nomad_contentflow.is_reviewer(target_organization))
$$;

create function nomad_contentflow_private.caller_is_client() returns boolean
language sql stable set search_path = ''
as $$
  select case
    when coalesce(current_setting('role', true), '') in ('service_role', 'postgres', 'supabase_admin') then false
    when coalesce(current_setting('role', true), '') in ('none', '') and session_user in ('postgres', 'supabase_admin') then false
    else true
  end
$$;

create function nomad_contentflow.cf_norm_key(txt text) returns text
language sql immutable parallel safe set search_path = pg_catalog
as $$ select lower(btrim(regexp_replace(normalize(txt, NFKC), '[ \t\n\r\f\v]+', ' ', 'g'))) $$;
comment on function nomad_contentflow.cf_norm_key(text) is '중복 키 정규화. 앱 keywords.ts normalizePhrase와 동기 유지.';

create function nomad_contentflow.forbid_mutation() returns trigger
language plpgsql set search_path = ''
as $$ begin raise exception '% on % is not allowed (append-only)', tg_op, tg_table_name; end $$;

-- ---------- 테이블 ----------
create table nomad_contentflow.blogs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references nomad_core.organizations(id) on delete cascade,
  platform nomad_contentflow.blog_platform not null,
  domain text not null check (length(btrim(domain)) between 1 and 200),
  display_name text check (display_name is null or length(btrim(display_name)) between 1 and 60),
  status text not null default 'active' check (status in ('active', 'archived')),
  overage_ack boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (organization_id, id)
);
comment on table nomad_contentflow.blogs is '블로그 계정. 활성 수 한도는 plan_limits(included_blogs·max_blogs·overage_allowed).';
comment on column nomad_contentflow.blogs.overage_ack is '쓰기 전용 신호(저장 시 항상 false). 초과 과금 확인은 audit_logs blog.overage_ack에 기록.';
create index blogs_org_updated_idx on nomad_contentflow.blogs (organization_id, updated_at);

create table nomad_contentflow.keywords (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references nomad_core.organizations(id) on delete cascade,
  phrase text not null check (length(btrim(phrase)) between 1 and 120),
  phrase_key text generated always as (nomad_contentflow.cf_norm_key(phrase)) stored,
  intent text not null default '' check (length(intent) <= 200),
  priority int not null default 3 check (priority between 1 and 5),
  note text not null default '' check (length(note) <= 500),
  blog_id uuid,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (organization_id, id),
  foreign key (organization_id, blog_id) references nomad_contentflow.blogs(organization_id, id)
);
comment on table nomad_contentflow.keywords is '조직 키워드. 소프트 삭제된 행은 중복 키 검사에서 제외(부분 유니크).';
comment on column nomad_contentflow.keywords.blog_id is '소속 블로그. NULL=미분류. owner·admin만 지정.';
create unique index keywords_org_phrase_key on nomad_contentflow.keywords (organization_id, phrase_key) where deleted_at is null;
create index keywords_org_priority_idx on nomad_contentflow.keywords (organization_id, priority, created_at);
create index keywords_blog_idx on nomad_contentflow.keywords (organization_id, blog_id);
create index keywords_org_updated_idx on nomad_contentflow.keywords (organization_id, updated_at);

create table nomad_contentflow.sources (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references nomad_core.organizations(id) on delete cascade,
  url text not null check (url ~* '^https?://'),
  title text,
  checked_at timestamptz,
  license_note text,
  unique (organization_id, id),
  unique (organization_id, url)
);
comment on table nomad_contentflow.sources is '글 출처 URL과 라이선스 메모.';

create table nomad_contentflow.articles (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references nomad_core.organizations(id) on delete cascade,
  owner_id uuid not null references auth.users(id),
  blog_id uuid,
  keyword_id uuid,
  state nomad_contentflow.article_state not null default 'idea',
  title text not null default '',
  keyword text not null default '',
  template_id text not null default 'T01',
  template_version text,
  platform nomad_contentflow.blog_platform not null default 'wordpress',
  body text not null default '',
  source_url text not null default '',
  remote jsonb,
  published_url text,
  layout_profile text not null default 'L01' check (layout_profile in ('L01', 'L02')),
  ad_profile text not null default 'A00' check (ad_profile in ('A00', 'A01')),
  renderer_version text check (renderer_version is null or length(renderer_version) <= 32),
  brief_purpose text not null default '' check (length(brief_purpose) <= 1000),
  brief_audience text not null default '' check (length(brief_audience) <= 1000),
  evidence_status text not null default 'unreviewed' check (evidence_status in ('unreviewed', 'ok', 'blocked')),
  rights_status text not null default 'unreviewed' check (rights_status in ('unreviewed', 'ok', 'blocked')),
  title_evaluation jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (organization_id, id),
  foreign key (organization_id, blog_id) references nomad_contentflow.blogs(organization_id, id),
  foreign key (organization_id, keyword_id) references nomad_contentflow.keywords(organization_id, id) on delete set null (keyword_id),
  constraint articles_remote_shape check (
    remote is null or (jsonb_typeof(remote) = 'object' and remote ? 'postId' and remote ? 'url')
  ),
  constraint articles_size check (length(title) <= 300 and length(body) <= 200000 and length(source_url) <= 2000),
  constraint articles_published_url check (
    published_url is null or (length(published_url) <= 2000 and published_url ~* '^https?://[^[:space:]]+$')
  ),
  constraint articles_title_evaluation_shape check (
    title_evaluation is null or (
      case when jsonb_typeof(title_evaluation) = 'array' then jsonb_array_length(title_evaluation) = 5 else false end
      and length(title_evaluation::text) <= 10000
    )
  ),
  constraint articles_template_version_shape check (
    template_version is null or (template_version ~ '^T[0-9]{2}@[0-9]+$' and split_part(template_version, '@', 1) = template_id)
  )
);
comment on table nomad_contentflow.articles is '글 작업본과 상태. 상태 전이·승인은 트리거 enforce_article_rules가 결정.';
create index articles_org_state_idx on nomad_contentflow.articles (organization_id, state);
create index articles_keyword_idx on nomad_contentflow.articles (organization_id, keyword_id);
create index articles_blog_idx on nomad_contentflow.articles (organization_id, blog_id);
create index articles_org_updated_idx on nomad_contentflow.articles (organization_id, updated_at);

create table nomad_contentflow.article_versions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  article_id uuid not null,
  version int not null check (version > 0),
  title text not null,
  markdown text not null,
  source_id uuid,
  content_hash text not null,
  source_url text,
  template_id text,
  template_version text,
  platform nomad_contentflow.blog_platform,
  layout_profile text,
  ad_profile text,
  renderer_version text,
  hash_version int,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (article_id, version),
  foreign key (organization_id, article_id) references nomad_contentflow.articles(organization_id, id) on delete cascade,
  foreign key (organization_id, source_id) references nomad_contentflow.sources(organization_id, id)
);
comment on table nomad_contentflow.article_versions is '승인 시점 글 스냅샷(추가 전용).';
create index article_versions_org_article_idx on nomad_contentflow.article_versions (organization_id, article_id);

create table nomad_contentflow.approvals (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  article_version_id uuid not null,
  reviewer_id uuid not null references auth.users(id),
  decision nomad_contentflow.approval_decision not null,
  snapshot_hash text not null,
  decided_at timestamptz not null default now(),
  foreign key (organization_id, article_version_id) references nomad_contentflow.article_versions(organization_id, id)
);
comment on table nomad_contentflow.approvals is '승인 결정(추가 전용).';
create index approvals_org_version_idx on nomad_contentflow.approvals (organization_id, article_version_id);

create table nomad_contentflow.audit_logs (
  id bigint generated always as identity primary key,
  organization_id uuid not null references nomad_core.organizations(id) on delete cascade,
  actor_id uuid references auth.users(id),
  action text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
comment on table nomad_contentflow.audit_logs is '감사 로그(추가 전용). blog.* 행은 트리거만 기록.';
create index audit_logs_org_idx on nomad_contentflow.audit_logs (organization_id, created_at desc);

create trigger article_versions_immutable before update or delete on nomad_contentflow.article_versions
  for each row execute function nomad_contentflow.forbid_mutation();
create trigger approvals_immutable before update or delete on nomad_contentflow.approvals
  for each row execute function nomad_contentflow.forbid_mutation();
create trigger audit_logs_immutable before update or delete on nomad_contentflow.audit_logs
  for each row execute function nomad_contentflow.forbid_mutation();

create table nomad_contentflow.revenue_rows (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references nomad_core.organizations(id) on delete cascade,
  row_key text not null check (length(row_key) between 1 and 1200),
  source text not null check (length(btrim(source)) between 1 and 40),
  status text not null check (status in ('estimated', 'finalized')),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  report_date date not null check (report_date between date '2000-01-01' and date '2100-01-01'),
  page text not null default '' check (length(page) <= 500),
  revenue numeric(18, 4) check (revenue is null or revenue >= 0),
  pageviews bigint check (pageviews is null or pageviews >= 0),
  impressions bigint check (impressions is null or impressions >= 0),
  clicks bigint check (clicks is null or clicks >= 0),
  timezone text,
  period_start date,
  period_end date,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  check (revenue is not null or pageviews is not null or impressions is not null or clicks is not null),
  constraint revenue_rows_report_context check (
    timezone is not null and length(timezone) between 1 and 64 and timezone ~ '^[A-Za-z0-9_+/-]+$'
    and period_start is not null and period_end is not null and period_start <= period_end
    and report_date between period_start and period_end
  ) not valid,
  unique (organization_id, row_key)
);
comment on table nomad_contentflow.revenue_rows is '광고 수익 리포트 행(통화별 소수 금액이라 원 정수 규칙 예외). 같은 리포트 재가져오기는 row_key로 무시.';
create index revenue_rows_org_date_idx on nomad_contentflow.revenue_rows (organization_id, report_date);
create index revenue_rows_report_idx on nomad_contentflow.revenue_rows
  (organization_id, lower(btrim(source)), status, currency, timezone, period_start, period_end);

create table nomad_contentflow.agent_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references nomad_core.organizations(id) on delete cascade,
  task text not null check (task in ('draft', 'review')),
  model text not null check (length(btrim(model)) between 1 and 200),
  prompt_version text not null check (length(btrim(prompt_version)) between 1 and 50),
  status text not null check (status in ('succeeded', 'failed', 'timeout')),
  tokens_in int check (tokens_in is null or tokens_in >= 0),
  tokens_out int check (tokens_out is null or tokens_out >= 0),
  duration_ms int not null check (duration_ms >= 0),
  cost_estimate numeric(18, 8) check (cost_estimate is null or cost_estimate >= 0),
  cost_currency text check (cost_currency ~ '^[A-Z]{3}$'),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  check ((cost_estimate is null) = (cost_currency is null)),
  check (cost_estimate is null or (tokens_in is not null and tokens_out is not null))
);
comment on table nomad_contentflow.agent_runs is 'AI 초안·검수 호출 로그. 운영 참고용이며 정산 근거가 아님(크레딧 아님).';
create index agent_runs_org_created_idx on nomad_contentflow.agent_runs (organization_id, created_at desc);

create table nomad_contentflow.article_state_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  article_id uuid not null,
  from_state nomad_contentflow.article_state not null,
  to_state nomad_contentflow.article_state not null,
  actor_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  foreign key (organization_id, article_id) references nomad_contentflow.articles(organization_id, id) on delete cascade
);
comment on table nomad_contentflow.article_state_events is '글 상태 전이 이력. 트리거만 기록.';
create index article_state_events_article_idx on nomad_contentflow.article_state_events (organization_id, article_id, created_at);

create table nomad_contentflow.delivery_attempts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  article_id uuid not null,
  channel text not null check (channel in ('wordpress', 'manual')),
  attempt int not null check (attempt > 0),
  failure_type text check (failure_type in ('auth', 'not_found', 'rate_limited', 'server', 'rejected',
    'timeout', 'network', 'remote_state', 'invalid_response', 'not_sendable', 'config', 'unknown')),
  url text check (length(url) <= 2000 and url ~* '^https?://[^ ]+$'),
  duration_ms int check (duration_ms >= 0),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (article_id, channel, attempt),
  foreign key (organization_id, article_id) references nomad_contentflow.articles(organization_id, id) on delete cascade,
  check (case channel
    when 'manual' then failure_type is null and url is null and duration_ms is null
    else duration_ms is not null and (failure_type is null) = (url is not null)
  end)
);
comment on table nomad_contentflow.delivery_attempts is '글별 발행 시도 이력(운영 참고용).';
create index delivery_attempts_article_idx on nomad_contentflow.delivery_attempts (organization_id, article_id, created_at desc);

create table nomad_contentflow.site_checks (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references nomad_core.organizations(id) on delete cascade,
  check_key text not null check (check_key in (
    'ownership_access', 'content_navigation', 'operator_privacy',
    'ad_connection', 'ads_txt', 'consent_management', 'post_launch', 'ad_status'
  )),
  status text not null,
  evidence_url text check (evidence_url is null or (length(evidence_url) <= 2000 and evidence_url ~* '^https?://[^[:space:]]+$')),
  note text check (note is null or length(note) <= 1000),
  checked_by uuid not null references auth.users(id),
  checked_at timestamptz not null default now(),
  unique (organization_id, check_key),
  constraint site_checks_status check (
    (check_key = 'ad_status' and status in (
      'not_configured', 'preparing', 'review_pending', 'active', 'limited', 'rejected', 'disabled', 'unknown'))
    or (check_key <> 'ad_status' and status in ('pass', 'fail', 'unknown', 'not_applicable'))
  ),
  constraint site_checks_evidence check (
    status in ('unknown', 'not_configured') or evidence_url is not null or btrim(coalesce(note, '')) <> ''
  )
);
comment on table nomad_contentflow.site_checks is '운영자가 기록하는 사이트 준비·광고 상태(조직당 항목별 1건).';

create table nomad_contentflow.cost_entries (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references nomad_core.organizations(id) on delete cascade,
  category text not null check (category in ('model', 'labor', 'hosting', 'renewal', 'other')),
  amount numeric(18, 4) not null check (amount > 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  occurred_on date not null check (occurred_on between date '2000-01-01' and date '2100-01-01'),
  provenance text not null default 'manual' check (provenance = 'manual'),
  note text check (note is null or length(note) <= 500),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);
comment on table nomad_contentflow.cost_entries is '운영자가 직접 입력한 제작 비용(통화별 합산, agent_runs와 연결 없음).';
create index cost_entries_org_occurred_idx on nomad_contentflow.cost_entries (organization_id, occurred_on desc);

create table nomad_contentflow.improvement_tasks (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references nomad_core.organizations(id) on delete cascade,
  article_id uuid not null,
  target_url text not null check (length(target_url) <= 2000 and target_url ~* '^https?://[^[:space:]]+$'),
  evidence text not null check (length(btrim(evidence)) between 1 and 2000),
  observed_from date not null,
  observed_to date not null,
  assignee_id uuid,
  review_at date not null,
  state text not null default 'open' check (state in ('open', 'in_progress', 'done', 'cancelled')),
  result_version int check (result_version is null or result_version > 0),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (observed_from <= observed_to),
  constraint improvement_tasks_done_version check (state <> 'done' or result_version is not null),
  foreign key (organization_id, article_id) references nomad_contentflow.articles(organization_id, id) on delete cascade,
  foreign key (organization_id, assignee_id) references nomad_core.memberships(organization_id, user_id) on delete set null (assignee_id),
  foreign key (article_id, result_version) references nomad_contentflow.article_versions(article_id, version)
);
comment on table nomad_contentflow.improvement_tasks is '근거 기반 개선 작업 큐. 글을 바꾸거나 발행하지 않으며 성과 주장을 기록하지 않음.';
create index improvement_tasks_org_state_idx on nomad_contentflow.improvement_tasks (organization_id, state, review_at);
create index improvement_tasks_article_idx on nomad_contentflow.improvement_tasks (article_id, result_version);
create index improvement_tasks_assignee_idx on nomad_contentflow.improvement_tasks (organization_id, assignee_id);

create table nomad_contentflow.keyword_trends (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references nomad_core.organizations(id) on delete cascade,
  blog_id uuid,
  keyword text not null check (length(btrim(keyword)) between 1 and 120),
  keyword_key text generated always as (nomad_contentflow.cf_norm_key(keyword)) stored,
  category text not null default '' check (length(btrim(category)) <= 40),
  category_key text generated always as (nomad_contentflow.cf_norm_key(category)) stored,
  monthly_searches bigint check (monthly_searches >= 0),
  growth_pct numeric(12, 2) check (growth_pct between -100 and 1000000),
  document_count bigint check (document_count >= 0),
  source text not null check (length(btrim(source)) between 1 and 40),
  source_key text generated always as (nomad_contentflow.cf_norm_key(source)) stored,
  measured_on date not null check (measured_on between date '2000-01-01' and date '2100-01-01'),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  constraint keyword_trends_has_value check (num_nonnulls(monthly_searches, growth_pct, document_count) > 0),
  constraint keyword_trends_blog_fk foreign key (organization_id, blog_id) references nomad_contentflow.blogs(organization_id, id),
  constraint keyword_trends_measurement_key
    unique nulls not distinct (organization_id, blog_id, keyword_key, category_key, source_key, measured_on)
);
comment on table nomad_contentflow.keyword_trends is '운영자가 넣은 키워드 측정값(출처·날짜 포함). 가져오지도 합산하지도 않음.';
create index keyword_trends_org_measured_idx on nomad_contentflow.keyword_trends (organization_id, measured_on desc);

create table nomad_contentflow.blog_metric_snapshots (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references nomad_core.organizations(id) on delete cascade,
  blog_id uuid,
  tool text not null check (tool in ('bseupi', 'blackkiwi', 'blogai', 'gsc', 'ubersuggest', 'clarity', 'other')),
  metric text not null check (length(btrim(metric)) between 1 and 40),
  metric_key text generated always as (nomad_contentflow.cf_norm_key(metric)) stored,
  scope text not null default 'site' check (scope in ('site', 'query', 'page')),
  dimension text not null default '' check (length(dimension) <= 2000),
  dimension_key text generated always as (
    md5(case when scope = 'query' then nomad_contentflow.cf_norm_key(dimension) else btrim(dimension) end)
  ) stored,
  value numeric(20, 4) check (value between -1000000000000 and 1000000000000),
  value_label text check (value_label is null or length(btrim(value_label)) between 1 and 40),
  unit text not null default '' check (length(unit) <= 20),
  measured_on date not null check (measured_on between date '2000-01-01' and date '2100-01-01'),
  evidence_url text check (evidence_url is null or (evidence_url ~* '^https?://' and length(evidence_url) <= 2000)),
  memo text not null default '' check (length(memo) <= 500),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  constraint blog_metric_snapshots_one_value check (num_nonnulls(value, value_label) = 1),
  constraint blog_metric_snapshots_scope_dimension check ((scope = 'site') = (btrim(dimension) = '')),
  constraint blog_metric_snapshots_blog_fk foreign key (organization_id, blog_id) references nomad_contentflow.blogs(organization_id, id),
  constraint blog_metric_snapshots_measurement_key
    unique nulls not distinct (organization_id, blog_id, tool, metric_key, scope, dimension_key, measured_on)
);
comment on table nomad_contentflow.blog_metric_snapshots is '외부 도구가 보여준 블로그 지표(도구·날짜·근거 포함). 합산·환산·자체 지수 없음.';
create index blog_metric_snapshots_org_measured_idx on nomad_contentflow.blog_metric_snapshots (organization_id, measured_on desc);

create table nomad_contentflow.blog_usage_snapshots (
  organization_id uuid not null references nomad_core.organizations(id) on delete cascade,
  period_start date not null,
  period_end date not null,
  peak_active int not null,
  active_at_close int not null,
  overage_slots int not null,
  created_at timestamptz not null default now(),
  primary key (organization_id, period_start)
);
comment on table nomad_contentflow.blog_usage_snapshots is '월별(Asia/Seoul) 활성 블로그 최대치. period_end는 다음 달 1일(미포함). 금액 없음. 트리거만 기록.';

create table nomad_contentflow_private.rate_limits (
  key text primary key check (length(key) between 1 and 200),
  window_start timestamptz not null default now(),
  hits int not null default 0
);
comment on table nomad_contentflow_private.rate_limits is '공유 요청 제한 카운터(비노출). rate_limit_hit 함수만 접근.';

-- ---------- 동기화 컬럼 트리거 (core 제공 touch_updated_at) ----------
create trigger blogs_touch before update on nomad_contentflow.blogs
  for each row execute function nomad_core.touch_updated_at();
create trigger keywords_touch before update on nomad_contentflow.keywords
  for each row execute function nomad_core.touch_updated_at();
create trigger articles_touch before update on nomad_contentflow.articles
  for each row execute function nomad_core.touch_updated_at();

-- ---------- 글 규칙 ----------
create function nomad_contentflow.article_transition_allowed(a nomad_contentflow.article_state, b nomad_contentflow.article_state)
returns boolean language sql immutable set search_path = ''
as $$
  select (a::text, b::text) in (
    ('idea', 'researching'), ('researching', 'briefing'), ('briefing', 'drafting'), ('drafting', 'qa_pending'),
    ('qa_pending', 'needs_revision'), ('qa_pending', 'approval_pending'),
    ('needs_revision', 'drafting'),
    ('approval_pending', 'approved'), ('approval_pending', 'needs_revision'),
    ('approved', 'export_ready'), ('approved', 'drafting'),
    ('export_ready', 'manual_pending'), ('export_ready', 'publishing'), ('export_ready', 'drafting'),
    ('manual_pending', 'published'), ('manual_pending', 'export_ready'),
    ('publishing', 'draft_created'), ('publishing', 'publish_failed'),
    ('publish_failed', 'publishing'), ('publish_failed', 'manual_pending'), ('publish_failed', 'drafting'),
    ('draft_created', 'published'), ('draft_created', 'drafting'),
    ('published', 'monitoring'), ('published', 'update_due'),
    ('monitoring', 'update_due'),
    ('update_due', 'drafting')
  );
$$;

create function nomad_contentflow.article_review_ok(a nomad_contentflow.articles) returns boolean
language sql immutable set search_path = ''
as $$
  select btrim(a.title) <> ''
    and a.source_url ~* '^https?://[^ ]+$'
    and btrim(regexp_replace(a.body, '(^|\n)#[^\n]*', '', 'g')) <> ''
    and a.body !~ '\[(출처 )?확인 필요|\[직접 경험 작성';
$$;

create function nomad_contentflow.article_brief_ok(a nomad_contentflow.articles) returns boolean
language sql immutable set search_path = ''
as $$
  select btrim(a.brief_purpose) <> '' and btrim(a.brief_audience) <> ''
    and a.source_url ~* '^https?://[^ ]+$' and a.platform is not null;
$$;

create function nomad_contentflow.article_content_hash_v2(
  p_title text, p_body text, p_source_url text, p_template_id text, p_platform text,
  p_layout_profile text, p_ad_profile text, p_renderer_version text
) returns text language sql immutable set search_path = ''
as $$
  select encode(sha256(convert_to(jsonb_build_object(
    'hash_version', 2, 'title', p_title, 'body', p_body, 'source_url', p_source_url,
    'template_id', p_template_id, 'platform', p_platform, 'layout_profile', p_layout_profile,
    'ad_profile', p_ad_profile, 'renderer_version', p_renderer_version
  )::text, 'UTF8')), 'hex');
$$;

create function nomad_contentflow.enforce_article_rules() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  planning nomad_contentflow.article_state[] := array['idea','researching','briefing','drafting']::nomad_contentflow.article_state[];
  gated nomad_contentflow.article_state[] := array['approved','export_ready','manual_pending','publishing',
    'publish_failed','draft_created','published','monitoring','update_due']::nomad_contentflow.article_state[];
  base nomad_contentflow.article_state;
  changed boolean;
  review_changed boolean;
  ok boolean;
  ver int;
  vid uuid;
  hash text;
begin
  if tg_op = 'INSERT' then
    if not (new.state = any (planning)) then
      raise exception 'new articles must start in a planning state, not %', new.state;
    end if;
    if new.remote is not null then raise exception 'remote draft info can not be set on a new article'; end if;
    if new.published_url is not null then raise exception 'a public URL can not be set on a new article'; end if;
    if new.renderer_version is not null then raise exception 'a renderer version can not be set on a new article'; end if;
    if new.evidence_status <> 'unreviewed' or new.rights_status <> 'unreviewed' then
      raise exception 'a new article starts with evidence and rights unreviewed';
    end if;
    return new;
  end if;

  changed := (new.title, new.keyword, new.template_id, new.platform, new.body, new.source_url,
              new.layout_profile, new.ad_profile, new.brief_purpose, new.brief_audience)
    is distinct from (old.title, old.keyword, old.template_id, old.platform, old.body, old.source_url,
              old.layout_profile, old.ad_profile, old.brief_purpose, old.brief_audience);
  review_changed := (new.evidence_status, new.rights_status) is distinct from (old.evidence_status, old.rights_status);
  if (new.organization_id, new.owner_id) is distinct from (old.organization_id, old.owner_id) then
    raise exception 'organization and owner can not change';
  end if;

  if review_changed then
    if not nomad_contentflow.has_role(new.organization_id, array['owner','admin'], true) then
      raise exception 'only owner, admin or reviewer can set evidence and rights status';
    end if;
    if old.state = any (gated) then
      raise exception 'evidence and rights status can not change after approval';
    end if;
  end if;

  -- 검수자(RLS가 update를 허용)는 승인 대기 글을 승인·반려하는 일만 한다.
  if auth.uid() is not null
     and not nomad_contentflow.has_role(new.organization_id, array['owner','admin','editor']) then
    if changed or new.remote is distinct from old.remote or new.blog_id is distinct from old.blog_id
       or new.keyword_id is distinct from old.keyword_id
       or new.published_url is distinct from old.published_url
       or new.title_evaluation is distinct from old.title_evaluation
       or new.deleted_at is distinct from old.deleted_at
       or not (old.state = 'approval_pending'
               and (new.state in ('approved', 'needs_revision') or (new.state = old.state and review_changed))) then
      raise exception 'reviewers can only approve or send back articles waiting for approval';
    end if;
  end if;

  base := case when changed and not (old.state = any (planning)) then 'drafting' else old.state end;
  ok := new.state = base
    or nomad_contentflow.article_transition_allowed(base, new.state)
    or (nomad_contentflow.article_transition_allowed(base, 'qa_pending')
        and new.state in ('approval_pending', 'needs_revision'));
  if not ok then
    raise exception 'state change not allowed: % -> % (content changed: %)', old.state, new.state, changed;
  end if;

  if old.state = 'briefing' and new.state <> 'briefing' and not nomad_contentflow.article_brief_ok(new) then
    raise exception 'purpose, audience, source URL and channel are required to leave the brief';
  end if;
  if base = 'drafting' and new.state in ('qa_pending', 'approval_pending') and not nomad_contentflow.article_brief_ok(new) then
    raise exception 'purpose, audience, source URL and channel are required before review';
  end if;

  if changed then
    new.evidence_status := 'unreviewed';
    new.rights_status := 'unreviewed';
  end if;

  if new.state = any (gated) and not nomad_contentflow.article_review_ok(new) then
    raise exception 'title, body and source URL must pass review before reaching %', new.state;
  end if;
  if new.state = 'approval_pending' and not nomad_contentflow.article_review_ok(new) then
    raise exception 'review failed: article can not wait for approval';
  end if;

  if new.state = 'published' and old.state is distinct from 'published' then
    if new.published_url is null then raise exception 'a public URL is required to confirm publication'; end if;
  elsif new.published_url is distinct from old.published_url then
    raise exception 'the public URL can only be set when confirming publication';
  elsif not (new.state in ('published', 'monitoring', 'update_due')) then
    new.published_url := null;
  end if;

  if new.renderer_version is distinct from old.renderer_version
     and not (new.state = 'approved' and old.state is distinct from 'approved') then
    raise exception 'the renderer version can only be set when approving';
  end if;

  if new.template_version is distinct from old.template_version and new.template_id is not distinct from old.template_id then
    raise exception 'the template version is fixed when the template is chosen';
  end if;

  if new.state = 'approved' and old.state is distinct from 'approved' then
    if not nomad_contentflow.has_role(new.organization_id, array['owner','admin'], true) then
      raise exception 'only owner, admin or reviewer can approve';
    end if;
    if new.evidence_status <> 'ok' or new.rights_status <> 'ok' then
      raise exception 'evidence and rights must both be confirmed before approval';
    end if;
    select coalesce(max(version), 0) + 1 into ver from nomad_contentflow.article_versions where article_id = new.id;
    hash := nomad_contentflow.article_content_hash_v2(new.title, new.body, new.source_url, new.template_id, new.platform::text,
      new.layout_profile, new.ad_profile, new.renderer_version);
    insert into nomad_contentflow.article_versions (organization_id, article_id, version, title, markdown, content_hash, created_by,
        source_url, template_id, platform, layout_profile, ad_profile, renderer_version, hash_version, template_version)
      values (new.organization_id, new.id, ver, new.title, new.body, hash, auth.uid(),
        new.source_url, new.template_id, new.platform, new.layout_profile, new.ad_profile, new.renderer_version, 2, new.template_version)
      returning id into vid;
    insert into nomad_contentflow.approvals (organization_id, article_version_id, reviewer_id, decision, snapshot_hash)
      values (new.organization_id, vid, auth.uid(), 'approved', hash);
    insert into nomad_contentflow.audit_logs (organization_id, actor_id, action, payload)
      values (new.organization_id, auth.uid(), 'article.approved',
              jsonb_build_object('article_id', new.id, 'version', ver, 'hash', hash));
  end if;

  new.updated_at := now();
  return new;
end $$;
create trigger articles_rules before insert or update on nomad_contentflow.articles
  for each row execute function nomad_contentflow.enforce_article_rules();

create function nomad_contentflow.article_delivery_check(p_article_id uuid, p_renderer_version text)
returns jsonb language plpgsql stable set search_path = ''
as $$
declare
  gated nomad_contentflow.article_state[] := array['approved','export_ready','manual_pending','publishing',
    'publish_failed','draft_created','published','monitoring','update_due']::nomad_contentflow.article_state[];
  a nomad_contentflow.articles;
  v nomad_contentflow.article_versions;
begin
  select * into a from nomad_contentflow.articles where id = p_article_id;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if not (a.state = any (gated)) then return jsonb_build_object('ok', false, 'reason', 'not_approved'); end if;
  select ve.* into v from nomad_contentflow.article_versions ve
    join nomad_contentflow.approvals ap on ap.organization_id = ve.organization_id and ap.article_version_id = ve.id
    where ve.article_id = a.id and ap.decision = 'approved' and ap.snapshot_hash = ve.content_hash
    order by ve.version desc limit 1;
  if not found then return jsonb_build_object('ok', false, 'reason', 'no_approval'); end if;
  if v.hash_version is distinct from 2 then return jsonb_build_object('ok', false, 'reason', 'hash_version'); end if;
  if nomad_contentflow.article_content_hash_v2(a.title, a.body, a.source_url, a.template_id, a.platform::text,
       a.layout_profile, a.ad_profile, v.renderer_version) is distinct from v.content_hash then
    return jsonb_build_object('ok', false, 'reason', 'hash_mismatch');
  end if;
  if p_renderer_version is null or v.renderer_version is distinct from p_renderer_version then
    return jsonb_build_object('ok', false, 'reason', 'renderer_mismatch');
  end if;
  return jsonb_build_object('ok', true);
end $$;

create function nomad_contentflow.number_delivery_attempt() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended(new.article_id::text, 8));
  select coalesce(max(attempt), 0) + 1 into new.attempt
    from nomad_contentflow.delivery_attempts where article_id = new.article_id and channel = new.channel;
  return new;
end $$;
create trigger delivery_attempts_number before insert on nomad_contentflow.delivery_attempts
  for each row execute function nomad_contentflow.number_delivery_attempt();

create function nomad_contentflow.record_article_transition() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  insert into nomad_contentflow.article_state_events (organization_id, article_id, from_state, to_state, actor_id)
    values (new.organization_id, new.id, old.state, new.state, auth.uid());
  if new.state = 'manual_pending' then
    insert into nomad_contentflow.delivery_attempts (organization_id, article_id, channel, created_by)
      values (new.organization_id, new.id, 'manual', auth.uid());
  end if;
  return null;
end $$;
create trigger articles_state_event after update on nomad_contentflow.articles
  for each row when (old.state is distinct from new.state)
  execute function nomad_contentflow.record_article_transition();

-- ---------- 블로그 연결·한도 ----------
create function nomad_contentflow.assert_blog_active(org uuid, blog uuid) returns void
language plpgsql security definer set search_path = ''
as $$
declare st text;
begin
  select status into st from nomad_contentflow.blogs where organization_id = org and id = blog for share;
  if found and st is distinct from 'active' then
    raise exception 'blog account is archived: choose an active account';
  end if;
end $$;
revoke all on function nomad_contentflow.assert_blog_active(uuid, uuid) from public, anon, authenticated;

create function nomad_contentflow.enforce_keyword_blog() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if (tg_op = 'INSERT' and new.blog_id is null)
     or (tg_op = 'UPDATE' and new.blog_id is not distinct from old.blog_id) then
    return new;
  end if;
  if auth.uid() is not null
     and not nomad_contentflow.has_role(new.organization_id, array['owner','admin']) then
    raise exception 'only owner or admin can link a keyword to a blog';
  end if;
  if new.blog_id is not null then perform nomad_contentflow.assert_blog_active(new.organization_id, new.blog_id); end if;
  return new;
end $$;
create trigger keywords_blog_guard before insert or update on nomad_contentflow.keywords
  for each row execute function nomad_contentflow.enforce_keyword_blog();

create function nomad_contentflow.enforce_article_blog_active() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.blog_id is not null and (tg_op = 'INSERT' or new.blog_id is distinct from old.blog_id) then
    perform nomad_contentflow.assert_blog_active(new.organization_id, new.blog_id);
  end if;
  return new;
end $$;
create trigger articles_blog_active before insert or update of blog_id on nomad_contentflow.articles
  for each row execute function nomad_contentflow.enforce_article_blog_active();

-- 활성 블로그 한도: plan_limits 키 included_blogs · max_blogs · overage_allowed(0/1). 정의가 없으면(null) 클라이언트 생성 거부.
create function nomad_contentflow.enforce_blog_limits() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  client boolean := nomad_contentflow_private.caller_is_client();
  ack boolean := coalesce(new.overage_ack, false);
  inc int; mx int; ovg int; before_n int; next_n int;
begin
  new.overage_ack := false;
  if tg_op = 'UPDATE' and client and new.organization_id is distinct from old.organization_id then
    raise exception 'BLOG_ORGANIZATION_IMMUTABLE';
  end if;
  if not (new.status = 'active' and new.deleted_at is null
          and (tg_op = 'INSERT' or old.status is distinct from 'active' or old.deleted_at is not null)) then
    return new;
  end if;
  perform 1 from nomad_core.organizations where id = new.organization_id for update;
  if not client then return new; end if;
  inc := nomad_core.org_plan_limit(new.organization_id, 'contentflow', 'included_blogs');
  mx := nomad_core.org_plan_limit(new.organization_id, 'contentflow', 'max_blogs');
  ovg := nomad_core.org_plan_limit(new.organization_id, 'contentflow', 'overage_allowed');
  if inc is null or mx is null then raise exception 'ENTITLEMENT_MISSING'; end if;
  select count(*) into before_n from nomad_contentflow.blogs
    where organization_id = new.organization_id and status = 'active' and deleted_at is null and id <> new.id;
  next_n := before_n + 1;
  if coalesce(ovg, 0) = 0 and next_n > inc then raise exception 'PLAN_NOT_ALLOWED'; end if;
  if next_n > mx then raise exception 'BLOG_LIMIT_REACHED'; end if;
  if next_n > inc then
    if coalesce(nomad_core.organization_role(new.organization_id), '') <> 'owner' then raise exception 'FORBIDDEN_ROLE'; end if;
    if not ack then raise exception 'BLOG_LIMIT_CONFIRM_REQUIRED'; end if;
    insert into nomad_contentflow.audit_logs (organization_id, actor_id, action, payload)
      values (new.organization_id, auth.uid(), 'blog.overage_ack', jsonb_build_object(
        'active_before', before_n, 'active_after', next_n, 'included', inc, 'notice_version', 'v1'));
  end if;
  return new;
end $$;
create trigger blogs_limits before insert or update on nomad_contentflow.blogs
  for each row execute function nomad_contentflow.enforce_blog_limits();

create function nomad_contentflow.meter_blog_organization(org uuid, was_active boolean, is_active boolean) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  inc int; cur int; prior int; peak int;
  ps date := date_trunc('month', now() at time zone 'Asia/Seoul')::date;
begin
  if not exists (select 1 from nomad_core.organizations where id = org) then return; end if;
  inc := nomad_core.org_plan_limit(org, 'contentflow', 'included_blogs');
  if inc is null then return; end if;
  select count(*) into cur from nomad_contentflow.blogs where organization_id = org and status = 'active' and deleted_at is null;
  prior := cur + case when was_active then 1 else 0 end - case when is_active then 1 else 0 end;
  peak := greatest(cur, prior);
  insert into nomad_contentflow.blog_usage_snapshots as s (organization_id, period_start, period_end, peak_active, active_at_close, overage_slots)
    values (org, ps, (ps + interval '1 month')::date, peak, cur, greatest(0, peak - inc))
    on conflict (organization_id, period_start) do update set
      peak_active = greatest(s.peak_active, excluded.peak_active),
      active_at_close = excluded.active_at_close,
      overage_slots = greatest(0, greatest(s.peak_active, excluded.peak_active) - inc);
end $$;
revoke all on function nomad_contentflow.meter_blog_organization(uuid, boolean, boolean) from public, anon, authenticated;

create function nomad_contentflow.meter_blog_usage() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and old.status = new.status and old.organization_id = new.organization_id
     and (old.deleted_at is null) = (new.deleted_at is null) then
    return null;
  end if;
  if tg_op <> 'INSERT' then
    perform nomad_contentflow.meter_blog_organization(old.organization_id, old.status = 'active' and old.deleted_at is null,
      tg_op = 'UPDATE' and new.organization_id = old.organization_id and new.status = 'active' and new.deleted_at is null);
  end if;
  if tg_op <> 'DELETE' and (tg_op = 'INSERT' or new.organization_id <> old.organization_id) then
    perform nomad_contentflow.meter_blog_organization(new.organization_id, false, new.status = 'active' and new.deleted_at is null);
  end if;
  return null;
end $$;
create trigger blogs_usage after insert or update or delete on nomad_contentflow.blogs
  for each row execute function nomad_contentflow.meter_blog_usage();

-- ---------- 입력 한도·스탬프 ----------
create function nomad_contentflow.enforce_keyword_cap() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if (select count(*) from nomad_contentflow.keywords where organization_id = new.organization_id and deleted_at is null) >= 5000 then
    raise exception 'keyword limit reached (5000 per organization)';
  end if;
  return new;
end $$;
create trigger keywords_cap before insert on nomad_contentflow.keywords
  for each row execute function nomad_contentflow.enforce_keyword_cap();

create function nomad_contentflow.enforce_revenue_cap() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if (select count(*) from nomad_contentflow.revenue_rows where organization_id = new.organization_id) >= 20000 then
    raise exception 'revenue row limit reached (20000 per organization)';
  end if;
  return new;
end $$;
create trigger revenue_cap before insert on nomad_contentflow.revenue_rows
  for each row execute function nomad_contentflow.enforce_revenue_cap();

create function nomad_contentflow.enforce_revenue_period() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('revenue_rows:' || w::text, 0))
    from (select distinct organization_id w from new_rows order by 1) d;
  if exists (
    select 1
    from (
      select distinct organization_id, lower(btrim(source)) src, status, currency, (page = '') site,
        timezone, period_start, period_end
      from new_rows
    ) n
    join nomad_contentflow.revenue_rows r
      on r.organization_id = n.organization_id and lower(btrim(r.source)) = n.src
      and r.status = n.status and r.currency = n.currency and (r.page = '') = n.site
    where (r.timezone is null and r.report_date between n.period_start and n.period_end)
      or (r.timezone = n.timezone
          and not (r.period_start = n.period_start and r.period_end = n.period_end)
          and r.period_start <= n.period_end and n.period_start <= r.period_end)
  ) then
    raise exception 'revenue report period overlap';
  end if;
  return null;
end $$;
create trigger revenue_period after insert on nomad_contentflow.revenue_rows
  referencing new table as new_rows
  for each statement execute function nomad_contentflow.enforce_revenue_period();

create function nomad_contentflow.enforce_keyword_trend_cap() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if exists (
    select 1 from nomad_contentflow.keyword_trends t
    where t.organization_id = new.organization_id and t.blog_id is not distinct from new.blog_id
      and t.keyword_key = nomad_contentflow.cf_norm_key(new.keyword) and t.category_key = nomad_contentflow.cf_norm_key(new.category)
      and t.source_key = nomad_contentflow.cf_norm_key(new.source) and t.measured_on = new.measured_on
  ) then
    return new;
  end if;
  if new.blog_id is not null then perform nomad_contentflow.assert_blog_active(new.organization_id, new.blog_id); end if;
  perform pg_advisory_xact_lock(hashtextextended('keyword_trends:' || new.organization_id, 0));
  if (select count(*) from nomad_contentflow.keyword_trends where organization_id = new.organization_id) >= 20000 then
    raise exception 'keyword trend limit reached (20000 per organization)';
  end if;
  return new;
end $$;
create trigger keyword_trends_cap before insert on nomad_contentflow.keyword_trends
  for each row execute function nomad_contentflow.enforce_keyword_trend_cap();

create function nomad_contentflow.enforce_blog_metric_cap() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if exists (
    select 1 from nomad_contentflow.blog_metric_snapshots s
    where s.organization_id = new.organization_id and s.blog_id is not distinct from new.blog_id
      and s.tool = new.tool and s.metric_key = nomad_contentflow.cf_norm_key(new.metric) and s.scope = new.scope
      and s.dimension_key = md5(case when new.scope = 'query' then nomad_contentflow.cf_norm_key(new.dimension) else btrim(new.dimension) end)
      and s.measured_on = new.measured_on
  ) then
    return new;
  end if;
  if new.blog_id is not null then perform nomad_contentflow.assert_blog_active(new.organization_id, new.blog_id); end if;
  perform pg_advisory_xact_lock(hashtextextended('blog_metric_snapshots:' || new.organization_id, 0));
  if (select count(*) from nomad_contentflow.blog_metric_snapshots where organization_id = new.organization_id) >= 30000 then
    raise exception 'blog metric limit reached (30000 per organization)';
  end if;
  return new;
end $$;
create trigger blog_metric_snapshots_cap before insert on nomad_contentflow.blog_metric_snapshots
  for each row execute function nomad_contentflow.enforce_blog_metric_cap();

create function nomad_contentflow.stamp_site_check() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and (new.organization_id <> old.organization_id or new.check_key <> old.check_key) then
    raise exception 'a site check can not move to another organization or item';
  end if;
  new.checked_by := auth.uid();
  new.checked_at := now();
  return new;
end $$;
create trigger site_checks_stamp before insert or update on nomad_contentflow.site_checks
  for each row execute function nomad_contentflow.stamp_site_check();

create function nomad_contentflow.stamp_improvement_task() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.assignee_id is null then raise exception 'an improvement task needs an assignee'; end if;
  elsif new.organization_id <> old.organization_id or new.article_id <> old.article_id
    or new.created_by <> old.created_by or new.created_at <> old.created_at then
    raise exception 'an improvement task can not move or change its author';
  end if;
  new.updated_at := now();
  return new;
end $$;
create trigger improvement_tasks_stamp before insert or update on nomad_contentflow.improvement_tasks
  for each row execute function nomad_contentflow.stamp_improvement_task();

-- ---------- RPC ----------
create function nomad_contentflow.rate_limit_hit(p_key text, p_max int, p_window_seconds int) returns boolean
language plpgsql security definer set search_path = ''
as $$
declare h int;
begin
  if p_max < 1 or p_window_seconds < 1 or p_window_seconds > 86400 then raise exception 'invalid rate limit'; end if;
  if random() < 0.02 then
    delete from nomad_contentflow_private.rate_limits where window_start < now() - interval '1 day';
  end if;
  insert into nomad_contentflow_private.rate_limits as r (key, window_start, hits) values (p_key, now(), 1)
  on conflict (key) do update set
    hits = case when r.window_start < now() - make_interval(secs => p_window_seconds) then 1 else r.hits + 1 end,
    window_start = case when r.window_start < now() - make_interval(secs => p_window_seconds) then now() else r.window_start end
  returning hits into h;
  return h > p_max;
end $$;

create function nomad_contentflow.workspace_members(ws uuid)
returns table (user_id uuid, email text, role text, is_reviewer boolean)
language sql stable security definer set search_path = ''
as $$
  select m.user_id, u.email::text, m.role,
    exists (select 1 from nomad_contentflow.reviewers r where r.organization_id = ws and r.user_id = m.user_id)
  from nomad_core.memberships m join auth.users u on u.id = m.user_id
  where m.organization_id = ws and nomad_core.organization_role(ws) is not null
  order by case m.role when 'owner' then 0 when 'admin' then 1 when 'editor' then 2 else 3 end, u.email
$$;

revoke all on function
  nomad_contentflow.is_reviewer(uuid), nomad_contentflow.has_role(uuid, text[], boolean),
  nomad_contentflow.article_delivery_check(uuid, text), nomad_contentflow.rate_limit_hit(text, int, int),
  nomad_contentflow.workspace_members(uuid), nomad_contentflow.cf_norm_key(text),
  nomad_contentflow.article_transition_allowed(nomad_contentflow.article_state, nomad_contentflow.article_state),
  nomad_contentflow.article_review_ok(nomad_contentflow.articles), nomad_contentflow.article_brief_ok(nomad_contentflow.articles),
  nomad_contentflow.article_content_hash_v2(text, text, text, text, text, text, text, text)
  from public, anon, authenticated;
grant execute on function
  nomad_contentflow.is_reviewer(uuid), nomad_contentflow.has_role(uuid, text[], boolean),
  nomad_contentflow.article_delivery_check(uuid, text), nomad_contentflow.workspace_members(uuid),
  nomad_contentflow.cf_norm_key(text),
  nomad_contentflow.article_transition_allowed(nomad_contentflow.article_state, nomad_contentflow.article_state),
  nomad_contentflow.article_review_ok(nomad_contentflow.articles), nomad_contentflow.article_brief_ok(nomad_contentflow.articles),
  nomad_contentflow.article_content_hash_v2(text, text, text, text, text, text, text, text)
  to authenticated, service_role;
grant execute on function nomad_contentflow.rate_limit_hit(text, int, int) to anon, authenticated, service_role;

-- ---------- RLS ----------
do $$
declare t text;
begin
  for t in select tablename from pg_catalog.pg_tables where schemaname in ('nomad_contentflow', 'nomad_contentflow_private') loop
    execute format('alter table %s enable row level security',
      case when t = 'rate_limits' then 'nomad_contentflow_private.rate_limits' else 'nomad_contentflow.' || quote_ident(t) end);
  end loop;
end $$;

-- reviewers: 멤버가 보고, owner/admin이 지정·해제
create policy reviewers_select on nomad_contentflow.reviewers for select to authenticated
  using (nomad_core.organization_role(organization_id) is not null);
create policy reviewers_insert on nomad_contentflow.reviewers for insert to authenticated
  with check (nomad_core.organization_role(organization_id) in ('owner', 'admin'));
create policy reviewers_delete on nomad_contentflow.reviewers for delete to authenticated
  using (nomad_core.organization_role(organization_id) in ('owner', 'admin'));

-- blogs: 멤버 읽기, owner/admin 관리
create policy blogs_select on nomad_contentflow.blogs for select to authenticated
  using (nomad_core.organization_role(organization_id) is not null);
create policy blogs_write on nomad_contentflow.blogs for all to authenticated
  using (nomad_core.organization_role(organization_id) in ('owner', 'admin'))
  with check (nomad_core.organization_role(organization_id) in ('owner', 'admin'));

-- keywords / sources / articles: editor 이상 쓰기
create policy keywords_select on nomad_contentflow.keywords for select to authenticated
  using (nomad_core.organization_role(organization_id) is not null);
create policy keywords_insert on nomad_contentflow.keywords for insert to authenticated
  with check (nomad_core.organization_role(organization_id) in ('owner', 'admin', 'editor') and created_by = (select auth.uid()));
create policy keywords_update on nomad_contentflow.keywords for update to authenticated
  using (nomad_core.organization_role(organization_id) in ('owner', 'admin', 'editor'))
  with check (nomad_core.organization_role(organization_id) in ('owner', 'admin', 'editor'));
create policy keywords_delete on nomad_contentflow.keywords for delete to authenticated
  using (nomad_core.organization_role(organization_id) in ('owner', 'admin', 'editor'));

create policy sources_select on nomad_contentflow.sources for select to authenticated
  using (nomad_core.organization_role(organization_id) is not null);
create policy sources_write on nomad_contentflow.sources for all to authenticated
  using (nomad_core.organization_role(organization_id) in ('owner', 'admin', 'editor'))
  with check (nomad_core.organization_role(organization_id) in ('owner', 'admin', 'editor'));

create policy articles_select on nomad_contentflow.articles for select to authenticated
  using (nomad_core.organization_role(organization_id) is not null);
create policy articles_insert on nomad_contentflow.articles for insert to authenticated
  with check (nomad_core.organization_role(organization_id) in ('owner', 'admin', 'editor') and owner_id = (select auth.uid()));
create policy articles_update on nomad_contentflow.articles for update to authenticated
  using (nomad_core.organization_role(organization_id) in ('owner', 'admin', 'editor'))
  with check (nomad_core.organization_role(organization_id) in ('owner', 'admin', 'editor'));
create policy articles_review on nomad_contentflow.articles for update to authenticated
  using (nomad_contentflow.is_reviewer(organization_id))
  with check (nomad_contentflow.is_reviewer(organization_id));
create policy articles_delete on nomad_contentflow.articles for delete to authenticated
  using (nomad_core.organization_role(organization_id) in ('owner', 'admin'));

create policy versions_select on nomad_contentflow.article_versions for select to authenticated
  using (nomad_core.organization_role(organization_id) is not null);
create policy versions_insert on nomad_contentflow.article_versions for insert to authenticated
  with check (nomad_core.organization_role(organization_id) in ('owner', 'admin', 'editor') and created_by = (select auth.uid()));

create policy approvals_select on nomad_contentflow.approvals for select to authenticated
  using (nomad_core.organization_role(organization_id) is not null);
create policy approvals_insert on nomad_contentflow.approvals for insert to authenticated
  with check (nomad_contentflow.has_role(organization_id, array['owner', 'admin'], true) and reviewer_id = (select auth.uid()));

create policy audit_select on nomad_contentflow.audit_logs for select to authenticated
  using (nomad_core.organization_role(organization_id) in ('owner', 'admin'));
create policy audit_insert on nomad_contentflow.audit_logs for insert to authenticated
  with check (nomad_core.organization_role(organization_id) is not null and actor_id = (select auth.uid()) and action not like 'blog.%');

create policy revenue_select on nomad_contentflow.revenue_rows for select to authenticated
  using (nomad_core.organization_role(organization_id) is not null);
create policy revenue_insert on nomad_contentflow.revenue_rows for insert to authenticated
  with check (nomad_core.organization_role(organization_id) in ('owner', 'admin') and created_by = (select auth.uid()));
create policy revenue_delete on nomad_contentflow.revenue_rows for delete to authenticated
  using (nomad_core.organization_role(organization_id) in ('owner', 'admin'));

create policy agent_runs_select on nomad_contentflow.agent_runs for select to authenticated
  using (nomad_core.organization_role(organization_id) is not null);
create policy agent_runs_insert on nomad_contentflow.agent_runs for insert to authenticated
  with check (nomad_contentflow.has_role(organization_id, array['owner', 'admin', 'editor'], true) and created_by = (select auth.uid()));

create policy article_state_events_select on nomad_contentflow.article_state_events for select to authenticated
  using (nomad_core.organization_role(organization_id) is not null);

create policy delivery_attempts_select on nomad_contentflow.delivery_attempts for select to authenticated
  using (nomad_core.organization_role(organization_id) is not null);
create policy delivery_attempts_insert on nomad_contentflow.delivery_attempts for insert to authenticated
  with check (nomad_core.organization_role(organization_id) in ('owner', 'admin', 'editor')
    and created_by = (select auth.uid()) and channel = 'wordpress');

create policy site_checks_select on nomad_contentflow.site_checks for select to authenticated
  using (nomad_core.organization_role(organization_id) is not null);
create policy site_checks_insert on nomad_contentflow.site_checks for insert to authenticated
  with check (nomad_core.organization_role(organization_id) in ('owner', 'admin'));
create policy site_checks_update on nomad_contentflow.site_checks for update to authenticated
  using (nomad_core.organization_role(organization_id) in ('owner', 'admin'))
  with check (nomad_core.organization_role(organization_id) in ('owner', 'admin'));

create policy cost_entries_select on nomad_contentflow.cost_entries for select to authenticated
  using (nomad_core.organization_role(organization_id) is not null);
create policy cost_entries_insert on nomad_contentflow.cost_entries for insert to authenticated
  with check (nomad_core.organization_role(organization_id) in ('owner', 'admin') and created_by = (select auth.uid()));
create policy cost_entries_delete on nomad_contentflow.cost_entries for delete to authenticated
  using (nomad_core.organization_role(organization_id) in ('owner', 'admin'));

create policy improvement_tasks_select on nomad_contentflow.improvement_tasks for select to authenticated
  using (nomad_core.organization_role(organization_id) is not null);
create policy improvement_tasks_insert on nomad_contentflow.improvement_tasks for insert to authenticated
  with check (nomad_contentflow.has_role(organization_id, array['owner', 'admin', 'editor'], true) and created_by = (select auth.uid()));
create policy improvement_tasks_update on nomad_contentflow.improvement_tasks for update to authenticated
  using (nomad_contentflow.has_role(organization_id, array['owner', 'admin', 'editor'], true))
  with check (nomad_contentflow.has_role(organization_id, array['owner', 'admin', 'editor'], true));

create policy keyword_trends_select on nomad_contentflow.keyword_trends for select to authenticated
  using (nomad_core.organization_role(organization_id) is not null);
create policy keyword_trends_insert on nomad_contentflow.keyword_trends for insert to authenticated
  with check (nomad_core.organization_role(organization_id) in ('owner', 'admin', 'editor') and created_by = (select auth.uid()));
create policy keyword_trends_delete on nomad_contentflow.keyword_trends for delete to authenticated
  using (nomad_core.organization_role(organization_id) in ('owner', 'admin', 'editor'));

create policy blog_metric_snapshots_select on nomad_contentflow.blog_metric_snapshots for select to authenticated
  using (nomad_core.organization_role(organization_id) is not null);
create policy blog_metric_snapshots_insert on nomad_contentflow.blog_metric_snapshots for insert to authenticated
  with check (nomad_core.organization_role(organization_id) in ('owner', 'admin', 'editor') and created_by = (select auth.uid()));
create policy blog_metric_snapshots_delete on nomad_contentflow.blog_metric_snapshots for delete to authenticated
  using (nomad_core.organization_role(organization_id) in ('owner', 'admin', 'editor'));

create policy blog_usage_snapshots_select on nomad_contentflow.blog_usage_snapshots for select to authenticated
  using (nomad_core.organization_role(organization_id) is not null);
-- rate_limits: 정책 없음(함수 전용)

-- ---------- 권한 (필요한 만큼만) ----------
grant select, insert, delete on nomad_contentflow.reviewers to authenticated;
grant select, insert, update, delete on nomad_contentflow.blogs, nomad_contentflow.keywords,
  nomad_contentflow.sources, nomad_contentflow.articles to authenticated;
grant select, insert on nomad_contentflow.article_versions, nomad_contentflow.approvals, nomad_contentflow.audit_logs,
  nomad_contentflow.agent_runs, nomad_contentflow.delivery_attempts to authenticated;
grant select, insert, delete on nomad_contentflow.revenue_rows, nomad_contentflow.cost_entries,
  nomad_contentflow.keyword_trends, nomad_contentflow.blog_metric_snapshots to authenticated;
grant select, insert, update on nomad_contentflow.site_checks, nomad_contentflow.improvement_tasks to authenticated;
grant select on nomad_contentflow.article_state_events, nomad_contentflow.blog_usage_snapshots to authenticated;
grant select, insert, update, delete on all tables in schema nomad_contentflow to service_role;
grant usage on schema nomad_contentflow_private to service_role;
grant select, insert, update, delete on nomad_contentflow_private.rate_limits to service_role;

commit;
