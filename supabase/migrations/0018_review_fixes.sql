-- 0018: review fixes for W9~W11.
-- 1. One key normalization (NFKC, the six ASCII whitespace characters collapsed to one space, trim,
--    lower case) shared by every key column. It matches normalizePhrase in keywords.ts. Before this,
--    the SQL side used \s, which differs from the app on tabs and line breaks. U+FEFF, U+2028, U+2029
--    and U+1680 are left alone on both sides; NBSP and ideographic space become a space through NFKC.
-- 2. An archived blog account can not be chosen for a new link or a new record. Values that already
--    point at it stay, can be read, and a re-import of an existing row is ignored as a duplicate.
-- 3. Trends and snapshots: a duplicate key passes before any limit or account check (ON CONFLICT DO
--    NOTHING skips it afterwards), and the per-workspace limit is counted under an advisory lock.
-- 4. Snapshot evidence URLs accept the scheme in any case, like the app does.
--
-- The generated columns are dropped and added again instead of ALTER ... SET EXPRESSION, which needs
-- Postgres 17 while the RLS test container is 16. Their unique constraints go with them and are
-- created again under the same names.

create function cf_norm_key(txt text) returns text
language sql immutable parallel safe set search_path = pg_catalog as $$
  select lower(btrim(regexp_replace(normalize(txt, NFKC), '[ \t\n\r\f\v]+', ' ', 'g')))
$$;
comment on function cf_norm_key(text) is 'Duplicate key of a phrase. Keep in sync with normalizePhrase in apps/web/src/lib/keywords.ts.';

-- Stop if the new keys would make two existing rows collide.
do $$
begin
  if exists (select 1 from keywords group by workspace_id, cf_norm_key(phrase) having count(*) > 1) then
    raise exception '0018: keywords would collide under the new key; merge them first';
  end if;
  if exists (select 1 from keyword_trends
             group by workspace_id, blog_id, cf_norm_key(keyword), cf_norm_key(category), cf_norm_key(source), measured_on
             having count(*) > 1) then
    raise exception '0018: keyword_trends would collide under the new key; merge them first';
  end if;
  if exists (select 1 from blog_metric_snapshots
             group by workspace_id, blog_id, tool, cf_norm_key(metric), scope,
               md5(case when scope = 'query' then cf_norm_key(dimension) else btrim(dimension) end), measured_on
             having count(*) > 1) then
    raise exception '0018: blog_metric_snapshots would collide under the new key; merge them first';
  end if;
end $$;

-- keywords (0003)
alter table keywords drop column phrase_key;
alter table keywords add column phrase_key text generated always as (cf_norm_key(phrase)) stored;
alter table keywords add constraint keywords_workspace_id_phrase_key_key unique (workspace_id, phrase_key);

-- keyword_trends (0016)
alter table keyword_trends drop column keyword_key, drop column category_key, drop column source_key;
alter table keyword_trends
  add column keyword_key text generated always as (cf_norm_key(keyword)) stored,
  add column category_key text generated always as (cf_norm_key(category)) stored,
  add column source_key text generated always as (cf_norm_key(source)) stored;
alter table keyword_trends add constraint keyword_trends_measurement_key
  unique nulls not distinct (workspace_id, blog_id, keyword_key, category_key, source_key, measured_on);

-- blog_metric_snapshots (0017)
alter table blog_metric_snapshots drop column metric_key, drop column dimension_key;
alter table blog_metric_snapshots
  add column metric_key text generated always as (cf_norm_key(metric)) stored,
  add column dimension_key text generated always as (
    md5(case when scope = 'query' then cf_norm_key(dimension) else btrim(dimension) end)
  ) stored;
alter table blog_metric_snapshots add constraint blog_metric_snapshots_measurement_key
  unique nulls not distinct (workspace_id, blog_id, tool, metric_key, scope, dimension_key, measured_on);

-- Snapshot evidence URL: scheme in any case.
alter table blog_metric_snapshots drop constraint blog_metric_snapshots_evidence_url_check;
alter table blog_metric_snapshots add constraint blog_metric_snapshots_evidence_url_check
  check (evidence_url is null or (evidence_url ~* '^https?://' and length(evidence_url) <= 2000));

-- Only an active blog can be linked. security definer: a plain editor can not lock rows of blogs.
create function assert_blog_active(ws uuid, blog uuid) returns void
language plpgsql security definer set search_path = public as $$
declare st text;
begin
  select status into st from blogs where workspace_id = ws and id = blog for share;
  -- Not found: the composite foreign key reports it.
  if found and st is distinct from 'active' then
    raise exception 'blog account is archived: choose an active account';
  end if;
end $$;
revoke all on function assert_blog_active(uuid, uuid) from public, anon, authenticated;

-- keywords: owner/admin only (0015) and active accounts only, when the link is new or changed.
create or replace function enforce_keyword_blog() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if (tg_op = 'INSERT' and new.blog_id is null)
     or (tg_op = 'UPDATE' and new.blog_id is not distinct from old.blog_id) then
    return new;
  end if;
  if auth.uid() is not null
     and not is_member(new.workspace_id, array['owner','admin']::workspace_role[]) then
    raise exception 'only owner or admin can link a keyword to a blog';
  end if;
  if new.blog_id is not null then
    perform assert_blog_active(new.workspace_id, new.blog_id);
  end if;
  return new;
end $$;

-- articles: a separate trigger, enforce_article_rules (0014) stays as it is.
create function enforce_article_blog_active() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.blog_id is not null
     and (tg_op = 'INSERT' or new.blog_id is distinct from old.blog_id) then
    perform assert_blog_active(new.workspace_id, new.blog_id);
  end if;
  return new;
end $$;
create trigger articles_blog_active before insert or update of blog_id on articles
  for each row execute function enforce_article_blog_active();

-- Stored generated columns are not filled yet in a BEFORE trigger, so the keys are computed again.
create or replace function enforce_keyword_trend_cap() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if exists (
    select 1 from keyword_trends t
    where t.workspace_id = new.workspace_id and t.blog_id is not distinct from new.blog_id
      and t.keyword_key = cf_norm_key(new.keyword) and t.category_key = cf_norm_key(new.category)
      and t.source_key = cf_norm_key(new.source) and t.measured_on = new.measured_on
  ) then
    return new; -- a duplicate: ON CONFLICT DO NOTHING drops it, a plain insert hits the unique key
  end if;
  if new.blog_id is not null then
    perform assert_blog_active(new.workspace_id, new.blog_id);
  end if;
  perform pg_advisory_xact_lock(hashtextextended('keyword_trends:' || new.workspace_id, 0));
  if (select count(*) from keyword_trends where workspace_id = new.workspace_id) >= 20000 then
    raise exception 'keyword trend limit reached (20000 per workspace)';
  end if;
  return new;
end $$;

create or replace function enforce_blog_metric_cap() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if exists (
    select 1 from blog_metric_snapshots s
    where s.workspace_id = new.workspace_id and s.blog_id is not distinct from new.blog_id
      and s.tool = new.tool and s.metric_key = cf_norm_key(new.metric) and s.scope = new.scope
      and s.dimension_key = md5(case when new.scope = 'query' then cf_norm_key(new.dimension) else btrim(new.dimension) end)
      and s.measured_on = new.measured_on
  ) then
    return new;
  end if;
  if new.blog_id is not null then
    perform assert_blog_active(new.workspace_id, new.blog_id);
  end if;
  perform pg_advisory_xact_lock(hashtextextended('blog_metric_snapshots:' || new.workspace_id, 0));
  if (select count(*) from blog_metric_snapshots where workspace_id = new.workspace_id) >= 30000 then
    raise exception 'blog metric limit reached (30000 per workspace)';
  end if;
  return new;
end $$;
