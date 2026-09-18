-- ============================================================
-- Cuvori — schema v16: real, demo and hidden accounts.
-- Run AFTER schema_v15.sql. Re-runnable.
--
-- Every account has a visibility: 'public' (a real person, shown to everyone),
-- 'demo' (a test account that must never look like a real professional to the public)
-- or 'hidden' (real, but kept off the marketplace by an administrator).
-- Demo and hidden accounts keep working for their owner and for admins; they simply
-- never appear in search, counts, browse pages, ratings or job lists.
-- ============================================================
alter table public.profiles add column if not exists visibility text not null default 'public';
alter table public.profiles drop constraint if exists profiles_visibility_check;
alter table public.profiles add constraint profiles_visibility_check check (visibility in ('public','demo','hidden'));
create index if not exists profiles_visibility_idx on public.profiles(visibility) where visibility <> 'public';

-- a user cannot change their own visibility
create or replace function public.profiles_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and auth.uid() = old.id then
    new.email := old.email;
    new.created_at := old.created_at;
    new.banned_at := old.banned_at;
    new.visibility := old.visibility;
    if coalesce(current_setting('cuvori.accepting_rules', true), '') <> '1' then
      new.rules_version := old.rules_version;
      new.rules_accepted_at := old.rules_accepted_at;
    end if;
    if new.first_name is distinct from old.first_name and (length(new.first_name) > 80 or new.first_name ~ '[<>]') then
      raise exception 'bad_name';
    end if;
  end if;
  return new;
end $$;

-- "may the public see this account?" — the one question every read policy asks
create or replace function public.is_listed(uid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select not banned and visibility = 'public' from public.profiles where id = uid), false);
$$;

drop policy if exists "public editor profiles are readable" on public.editor_profiles;
create policy "public editor profiles are readable"
  on public.editor_profiles for select to anon, authenticated
  using ((is_public = true and public.is_listed(id)) or auth.uid() = id or public.is_admin());

drop policy if exists "projects of public editors are readable" on public.projects;
create policy "projects of public editors are readable"
  on public.projects for select to anon, authenticated
  using (auth.uid() = owner or public.is_admin()
         or exists (select 1 from public.editor_profiles e where e.id = owner and e.is_public and public.is_listed(e.id)));

drop policy if exists "open jobs are readable" on public.jobs;
create policy "open jobs are readable"
  on public.jobs for select to anon, authenticated
  using ((status = 'open' and public.is_listed(owner)) or auth.uid() = owner or public.is_admin());

-- a review written from a demo account is not a public opinion
drop policy if exists "reviews are readable" on public.reviews;
create policy "reviews are readable"
  on public.reviews for select to anon, authenticated
  using (public.is_listed(client) or auth.uid() in (client, editor) or public.is_admin());

drop policy if exists "public services are readable" on public.services;
create policy "public services are readable" on public.services for select to anon, authenticated
  using ((is_public = true and public.is_listed(profile_id)) or auth.uid() = profile_id or public.is_admin());

-- messaging: the public cannot open a chat with someone they cannot see; demo accounts may talk to each other
create or replace function public.open_conversation(other uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); a uuid; b uuid; cid uuid; my_vis text; other_vis text;
begin
  if me is null then raise exception 'not signed in'; end if;
  if other is null or other = me then raise exception 'cannot message yourself'; end if;
  if public.is_banned(me) then raise exception 'banned'; end if;
  if me < other then a := me; b := other; else a := other; b := me; end if;
  select id into cid from public.conversations where user_a = a and user_b = b;
  if cid is not null then return cid; end if;
  select visibility into my_vis from public.profiles where id = me;
  select visibility into other_vis from public.profiles where id = other and not banned;
  if other_vis is null then raise exception 'not_available'; end if;
  if other_vis <> 'public' and not (my_vis = other_vis or public.is_admin()) then raise exception 'not_available'; end if;
  if not (public.is_admin()
          or exists (select 1 from public.editor_profiles e where e.id = other and e.is_public)
          or exists (select 1 from public.jobs j where j.owner = other and j.status = 'open')) then
    raise exception 'not_available';
  end if;
  perform public.rate_limit('conversation_hour', 30, interval '1 hour');
  insert into public.conversations (user_a, user_b) values (a, b) returning id into cid;
  return cid;
end $$;

-- search and counts only ever see listed accounts, and ratings only count listed reviewers
create or replace function public.profession_config()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'groups', (select coalesce(jsonb_agg(jsonb_build_object('slug', g.slug, 'labels', g.labels, 'sort_order', g.sort_order) order by g.sort_order, g.slug), '[]'::jsonb) from public.profession_groups g),
    'professions', (select coalesce(jsonb_agg(jsonb_build_object(
        'slug', p.slug, 'group_slug', p.group_slug, 'sort_order', p.sort_order, 'active', p.active, 'invite_only', p.invite_only,
        'pricing_units', to_jsonb(p.pricing_units), 'portfolio_kind', p.portfolio_kind, 'labels', p.labels, 'synonyms', to_jsonb(p.synonyms),
        'professional_count', (select count(*) from public.services s join public.editor_profiles e on e.id = s.profile_id
                               where s.profession_slug = p.slug and s.is_public and e.is_public and public.is_listed(e.id))
      ) order by p.sort_order, p.slug), '[]'::jsonb) from public.professions p),
    'filters', (select coalesce(jsonb_agg(jsonb_build_object('key', f.key, 'kind', f.kind, 'match', f.match, 'options', f.options,
        'min_value', f.min_value, 'max_value', f.max_value, 'unit', f.unit, 'labels', f.labels) order by f.sort_order, f.key), '[]'::jsonb) from public.filters f),
    'profession_filters', (select coalesce(jsonb_agg(jsonb_build_object('profession_slug', pf.profession_slug, 'filter_key', pf.filter_key,
        'sort_order', pf.sort_order, 'primary_filter', pf.primary_filter, 'profile_field', pf.profile_field) order by pf.profession_slug, pf.sort_order), '[]'::jsonb) from public.profession_filters pf),
    'units', (select coalesce(jsonb_object_agg(u.key, u.labels), '{}'::jsonb) from public.price_units u)
  );
$$;

create or replace function public.admin_set_visibility(target uuid, v text)
returns text language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then return 'not_allowed'; end if;
  if v not in ('public','demo','hidden') then return 'bad_value'; end if;
  update public.profiles set visibility = v, updated_at = now() where id = target;
  if not found then return 'not_found'; end if;
  return 'ok';
end $$;
revoke execute on function public.admin_set_visibility(uuid, text) from public, anon;
grant   execute on function public.admin_set_visibility(uuid, text) to authenticated;

drop function if exists public.admin_list_users();
create or replace function public.admin_list_users()
returns table (id uuid, email text, first_name text, role text, is_admin boolean, banned boolean, ban_reason text,
               created_at timestamptz, display_name text, is_public boolean, projects int, reviews int, avg_stars numeric, flags int, visibility text)
language sql stable security definer set search_path = public as $$
  select p.id, p.email, p.first_name, p.role, p.is_admin, p.banned, p.ban_reason, p.created_at,
         e.display_name, e.is_public,
         (select count(*)::int from public.projects pr where pr.owner = p.id),
         (select count(*)::int from public.reviews r where r.editor = p.id),
         (select round(avg(stars),1) from public.reviews r where r.editor = p.id),
         (select count(*)::int from public.user_flags f where f.user_id = p.id),
         p.visibility
  from public.profiles p left join public.editor_profiles e on e.id = p.id
  where public.is_admin()
  order by p.created_at desc;
$$;
revoke execute on function public.admin_list_users() from public, anon;
grant execute on function public.admin_list_users() to authenticated;
