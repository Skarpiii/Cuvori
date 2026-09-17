-- ============================================================
-- Cuvori — schema v3: admin panel, bans, account deletion, reviews
-- Run AFTER schema.sql and schema_v2.sql. Safe to run more than once.
-- ============================================================

-- ---------- admin + ban flags ----------
alter table public.profiles add column if not exists is_admin boolean not null default false;
alter table public.profiles add column if not exists banned   boolean not null default false;
alter table public.profiles add column if not exists ban_reason text;

-- The site owner is the first admin. Change the e-mail if your account uses another one.
update public.profiles set is_admin = true where lower(email) = lower('egidijusss159@gmail.com');

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select is_admin from public.profiles where id = auth.uid()), false);
$$;
grant execute on function public.is_admin() to authenticated;

create or replace function public.is_banned(uid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select banned from public.profiles where id = uid), false);
$$;

-- users can never change their own admin / banned flags
drop policy if exists "users update own profile" on public.profiles;
create policy "users update own profile"
  on public.profiles for update to authenticated
  using (auth.uid() = id)
  with check (auth.uid() = id
    and role     = (select role     from public.profiles where id = auth.uid())
    and is_admin = (select is_admin from public.profiles where id = auth.uid())
    and banned   = (select banned   from public.profiles where id = auth.uid()));

-- ---------- banned users cannot write anything, and are hidden ----------
drop policy if exists "public editor profiles are readable" on public.editor_profiles;
create policy "public editor profiles are readable"
  on public.editor_profiles for select to anon, authenticated
  using ((is_public = true and not public.is_banned(id)) or auth.uid() = id or public.is_admin());

drop policy if exists "editors insert own profile" on public.editor_profiles;
create policy "editors insert own profile"
  on public.editor_profiles for insert to authenticated
  with check (auth.uid() = id and public.is_editor(auth.uid()) and not public.is_banned(auth.uid()));

drop policy if exists "editors update own profile" on public.editor_profiles;
create policy "editors update own profile"
  on public.editor_profiles for update to authenticated
  using (auth.uid() = id) with check (auth.uid() = id and public.is_editor(auth.uid()) and not public.is_banned(auth.uid()));

drop policy if exists "projects of public editors are readable" on public.projects;
create policy "projects of public editors are readable"
  on public.projects for select to anon, authenticated
  using (auth.uid() = owner or public.is_admin()
         or exists (select 1 from public.editor_profiles e where e.id = owner and e.is_public and not public.is_banned(e.id)));

drop policy if exists "editors manage own projects" on public.projects;
create policy "editors manage own projects"
  on public.projects for all to authenticated
  using (auth.uid() = owner) with check (auth.uid() = owner and public.is_editor(auth.uid()) and not public.is_banned(auth.uid()));

drop policy if exists "open jobs are readable" on public.jobs;
create policy "open jobs are readable"
  on public.jobs for select to anon, authenticated
  using ((status = 'open' and not public.is_banned(owner)) or auth.uid() = owner or public.is_admin());

drop policy if exists "users manage own jobs" on public.jobs;
create policy "users manage own jobs"
  on public.jobs for all to authenticated
  using (auth.uid() = owner) with check (auth.uid() = owner and not public.is_banned(auth.uid()));

drop policy if exists "participants send messages" on public.messages;
create policy "participants send messages"
  on public.messages for insert to authenticated
  with check (sender = auth.uid() and not public.is_banned(auth.uid())
    and exists (select 1 from public.conversations c where c.id = conversation_id and auth.uid() in (c.user_a, c.user_b)));

-- ---------- reviews (client -> editor) ----------
create table if not exists public.reviews (
  id          uuid primary key default gen_random_uuid(),
  editor      uuid not null references public.profiles(id) on delete cascade,
  client      uuid not null references public.profiles(id) on delete cascade,
  stars       int  not null check (stars between 1 and 5),
  body        text not null default '',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint reviews_one_per_pair unique (editor, client),
  constraint reviews_not_self check (editor <> client)
);
create index if not exists reviews_editor_idx on public.reviews(editor, created_at desc);
alter table public.reviews enable row level security;

-- everyone can read reviews of public editors (needed for ratings on cards)
drop policy if exists "reviews are readable" on public.reviews;
create policy "reviews are readable"
  on public.reviews for select to anon, authenticated
  using (not public.is_banned(client));

-- a client can review an editor only after they have actually talked (a conversation exists)
create or replace function public.can_review(ed uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select auth.uid() is not null and auth.uid() <> ed
     and public.is_editor(ed)
     and not public.is_banned(auth.uid())
     and exists (select 1 from public.conversations c
                 where (c.user_a = auth.uid() and c.user_b = ed) or (c.user_b = auth.uid() and c.user_a = ed));
$$;
grant execute on function public.can_review(uuid) to authenticated;

drop policy if exists "clients write own review" on public.reviews;
create policy "clients write own review"
  on public.reviews for insert to authenticated
  with check (client = auth.uid() and public.can_review(editor));

drop policy if exists "clients update own review" on public.reviews;
create policy "clients update own review"
  on public.reviews for update to authenticated
  using (client = auth.uid()) with check (client = auth.uid());

drop policy if exists "clients or admins delete reviews" on public.reviews;
create policy "clients or admins delete reviews"
  on public.reviews for delete to authenticated
  using (client = auth.uid() or public.is_admin());

-- ---------- invites: keep a readable label so the admin panel can list them ----------
alter table public.invites add column if not exists label text;   -- e.g. "CUV-AB12-…" (first 8 chars + created by)
alter table public.invites add column if not exists created_by uuid references auth.users(id);

-- redeem_invite now treats a code as used when used_at is set (even if that user was deleted later)
create or replace function public.redeem_invite(code text)
returns text language plpgsql security definer set search_path = public, extensions as $$
declare
  normalized text := upper(regexp_replace(code, '\s', '', 'g'));
  h text := encode(digest(normalized, 'sha256'), 'hex');
  inv public.invites%rowtype;
begin
  if auth.uid() is null then return 'not_signed_in'; end if;
  if public.is_banned(auth.uid()) then return 'banned'; end if;
  if normalized !~ '^CUV-[A-Z0-9]{4}-[A-Z0-9]{4}$' then return 'bad_format'; end if;
  select * into inv from public.invites where code_hash = h;
  if not found then return 'invalid'; end if;
  if inv.used_at is not null or inv.used_by is not null then return 'used'; end if;
  update public.invites set used_by = auth.uid(), used_at = now() where code_hash = h;
  update public.profiles set role = 'editor', updated_at = now() where id = auth.uid();
  return 'ok';
end $$;

-- ---------- delete every trace of an account ----------
-- Used both by the admin panel and by "Delete my account" in Settings.
create or replace function public.purge_user(target uuid)
returns void language plpgsql security definer set search_path = public, storage as $$
begin
  delete from storage.objects where bucket_id = 'portfolio' and name like target::text || '/%';
  delete from public.reviews where client = target or editor = target;
  delete from public.messages where sender = target;
  delete from public.conversations where user_a = target or user_b = target;
  delete from public.jobs where owner = target;
  delete from public.projects where owner = target;
  delete from public.editor_profiles where id = target;
  -- the invite stays "used" (used_at keeps its value) but no longer points at a user
  update public.invites set used_by = null, note = coalesce(note,'') || ' [user deleted]' where used_by = target;
  delete from public.profiles where id = target;
  delete from auth.users where id = target;
end $$;
revoke execute on function public.purge_user(uuid) from public, anon, authenticated;

create or replace function public.delete_my_account()
returns text language plpgsql security definer set search_path = public, storage as $$
begin
  if auth.uid() is null then return 'not_signed_in'; end if;
  perform public.purge_user(auth.uid());
  return 'ok';
end $$;
grant execute on function public.delete_my_account() to authenticated;

-- ---------- admin RPCs (every one checks is_admin()) ----------
create or replace function public.admin_list_users()
returns table (id uuid, email text, first_name text, role text, is_admin boolean, banned boolean, ban_reason text,
               created_at timestamptz, display_name text, is_public boolean, projects int, reviews int, avg_stars numeric)
language sql stable security definer set search_path = public as $$
  select p.id, p.email, p.first_name, p.role, p.is_admin, p.banned, p.ban_reason, p.created_at,
         e.display_name, e.is_public,
         (select count(*)::int from public.projects pr where pr.owner = p.id),
         (select count(*)::int from public.reviews r where r.editor = p.id),
         (select round(avg(stars),1) from public.reviews r where r.editor = p.id)
  from public.profiles p left join public.editor_profiles e on e.id = p.id
  where public.is_admin()
  order by p.created_at desc;
$$;
grant execute on function public.admin_list_users() to authenticated;

create or replace function public.admin_set_ban(target uuid, ban boolean, reason text default null)
returns text language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then return 'forbidden'; end if;
  if target = auth.uid() then return 'cannot_ban_self'; end if;
  update public.profiles set banned = ban, ban_reason = case when ban then reason else null end, updated_at = now() where id = target;
  return 'ok';
end $$;
grant execute on function public.admin_set_ban(uuid, boolean, text) to authenticated;

create or replace function public.admin_delete_user(target uuid)
returns text language plpgsql security definer set search_path = public, storage as $$
begin
  if not public.is_admin() then return 'forbidden'; end if;
  if target = auth.uid() then return 'cannot_delete_self'; end if;
  perform public.purge_user(target);
  return 'ok';
end $$;
grant execute on function public.admin_delete_user(uuid) to authenticated;

create or replace function public.admin_set_role(target uuid, new_role text)
returns text language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then return 'forbidden'; end if;
  if new_role not in ('client','editor') then return 'bad_role'; end if;
  update public.profiles set role = new_role, updated_at = now() where id = target;
  return 'ok';
end $$;
grant execute on function public.admin_set_role(uuid, text) to authenticated;

-- create a random invite code; the plain code is returned ONCE (only the hash is stored)
create or replace function public.admin_create_invite(note text default null)
returns text language plpgsql security definer set search_path = public, extensions as $$
declare
  alphabet text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  code text := 'CUV-';
  i int;
begin
  if not public.is_admin() then raise exception 'forbidden'; end if;
  for i in 1..8 loop
    code := code || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
    if i = 4 then code := code || '-'; end if;
  end loop;
  insert into public.invites (code_hash, note, label, created_by)
  values (encode(digest(code, 'sha256'), 'hex'), note, left(code, 8) || '****', auth.uid());
  return code;
end $$;
grant execute on function public.admin_create_invite(text) to authenticated;

create or replace function public.admin_list_invites()
returns table (code_hash text, label text, note text, created_at timestamptz, used_at timestamptz, used_by uuid, used_by_email text, used_by_name text)
language sql stable security definer set search_path = public as $$
  select i.code_hash, coalesce(i.label, '(starter)'), i.note, i.created_at, i.used_at, i.used_by, p.email, p.first_name
  from public.invites i left join public.profiles p on p.id = i.used_by
  where public.is_admin()
  order by i.created_at desc;
$$;
grant execute on function public.admin_list_invites() to authenticated;

create or replace function public.admin_delete_invite(hash text)
returns text language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then return 'forbidden'; end if;
  delete from public.invites where code_hash = hash and used_by is null;
  return 'ok';
end $$;
grant execute on function public.admin_delete_invite(text) to authenticated;

create or replace function public.admin_list_reviews()
returns table (id uuid, stars int, body text, created_at timestamptz, editor uuid, editor_name text, client uuid, client_name text, client_email text)
language sql stable security definer set search_path = public as $$
  select r.id, r.stars, r.body, r.created_at, r.editor, coalesce(e.display_name, pe.first_name), r.client, pc.first_name, pc.email
  from public.reviews r
  left join public.editor_profiles e on e.id = r.editor
  left join public.profiles pe on pe.id = r.editor
  left join public.profiles pc on pc.id = r.client
  where public.is_admin()
  order by r.created_at desc;
$$;
grant execute on function public.admin_list_reviews() to authenticated;

-- admins may also delete other people's projects/jobs (moderation)
drop policy if exists "admins delete projects" on public.projects;
create policy "admins delete projects" on public.projects for delete to authenticated using (public.is_admin());
drop policy if exists "admins delete jobs" on public.jobs;
create policy "admins delete jobs" on public.jobs for delete to authenticated using (public.is_admin());
