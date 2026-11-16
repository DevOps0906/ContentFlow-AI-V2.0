-- 일회용 검사 DB(cutover_contentflow)에 Supabase 플랫폼 최소 형태를 만든다(supabase_admin으로 실행).
-- auth.users·auth.uid()·auth.jwt()·auth.role(), extensions 스키마, vault. 운영 DB에는 쓰지 않는다.
create schema if not exists extensions;
grant usage on schema extensions to public;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists supabase_vault;

create schema if not exists auth;
grant usage on schema auth to anon, authenticated, service_role, postgres;
create table auth.users (
  id uuid primary key,
  email text,
  email_confirmed_at timestamptz,
  is_anonymous boolean not null default false,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
grant all on auth.users to postgres;
grant select on auth.users to service_role;
alter table auth.users owner to postgres; -- 검사용: 트리거 생성·disable을 postgres가 할 수 있게

create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(auth.jwt() ->> 'sub', '')::uuid
$$;
create function auth.role() returns text language sql stable as $$
  select nullif(auth.jwt() ->> 'role', '')
$$;
grant execute on function auth.jwt(), auth.uid(), auth.role() to public;

alter database cutover_contentflow set search_path = "$user", public, extensions;
grant all on schema public to postgres, anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all on sequences to anon, authenticated, service_role;
