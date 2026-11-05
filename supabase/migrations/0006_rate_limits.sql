-- 0006: shared rate limiting. Limits kept in process memory reset on every restart and are
-- per instance, so login/signup attempt limits live here instead. Fixed window per key.
-- Keys are opaque (the app sends a hash, never an email address).

create table rate_limits (
  key text primary key check (length(key) between 1 and 200),
  window_start timestamptz not null default now(),
  hits int not null default 0
);
alter table rate_limits enable row level security; -- no policies: only the function below touches it

-- Returns true when the caller is over the limit. Callable before login (anon).
create function rate_limit_hit(p_key text, p_max int, p_window_seconds int) returns boolean
language plpgsql security definer set search_path = public as $$
declare h int;
begin
  if p_max < 1 or p_window_seconds < 1 or p_window_seconds > 86400 then
    raise exception 'invalid rate limit';
  end if;
  if random() < 0.02 then
    delete from rate_limits where window_start < now() - interval '1 day';
  end if;
  insert into rate_limits (key, window_start, hits) values (p_key, now(), 1)
  on conflict (key) do update set
    hits = case when rate_limits.window_start < now() - make_interval(secs => p_window_seconds)
                then 1 else rate_limits.hits + 1 end,
    window_start = case when rate_limits.window_start < now() - make_interval(secs => p_window_seconds)
                        then now() else rate_limits.window_start end
  returning hits into h;
  return h > p_max;
end $$;
revoke all on function rate_limit_hit(text, int, int) from public;
grant execute on function rate_limit_hit(text, int, int) to anon, authenticated;