-- 0015: blog accounts. Managed in settings, linked from articles and keywords. Rows that exist
-- today keep NULL (shown as "unclassified"): nothing is backfilled, because which blog an older
-- article or keyword belongs to is unknown. NOT VALID applies the new checks to new rows only.
-- articles.blog_id stays outside the approval: it is not in the approval hash nor in the `changed`
-- list of enforce_article_rules (0014), so moving an article between accounts keeps its approval.

alter table blogs add column display_name text
  check (display_name is null or length(btrim(display_name)) between 1 and 60);
-- Keep both lists in sync with apps/web/src/lib/blogs.ts (a test compares them).
alter table blogs add constraint blogs_status_known check (status in ('active', 'archived')) not valid;
alter table blogs add constraint blogs_domain_length check (length(btrim(domain)) between 1 and 200) not valid;
comment on column blogs.display_name is 'Name shown to operators. NULL on older rows, which show the domain instead.';
comment on column blogs.status is 'active or archived. An archived account stays linked to its articles and keywords and can not be chosen again.';

alter table keywords add column blog_id uuid;
-- Composite FK keeps the link inside one workspace, and a blog that is still linked can not be deleted.
alter table keywords add constraint keywords_blog_fk
  foreign key (workspace_id, blog_id) references blogs (workspace_id, id);
comment on column keywords.blog_id is 'Blog account the keyword belongs to. NULL means unclassified. Only owner and admin can set it.';

create index keywords_blog_idx on keywords (workspace_id, blog_id);
create index articles_blog_idx on articles (workspace_id, blog_id);

-- RLS lets editors update keywords, but the account link is owner/admin only.
create function enforce_keyword_blog() returns trigger
language plpgsql set search_path = public as $$
begin
  if (tg_op = 'INSERT' and new.blog_id is null)
     or (tg_op = 'UPDATE' and new.blog_id is not distinct from old.blog_id) then
    return new;
  end if;
  if auth.uid() is not null
     and not is_member(new.workspace_id, array['owner','admin']::workspace_role[]) then
    raise exception 'only owner or admin can link a keyword to a blog';
  end if;
  return new;
end $$;
create trigger keywords_blog_guard before insert or update on keywords
  for each row execute function enforce_keyword_blog();
