-- ============================================================
-- Cuvori — database schema (run once in Supabase → SQL Editor)
-- Accounts, roles (client / editor) and invite codes.
-- Security is enforced here (Row Level Security), not in the page.
-- ============================================================

-- pgcrypto provides digest() for hashing invite codes.
create extension if not exists pgcrypto with schema extensions;

-- 1. One profile row per account. role is 'client' by default;
--    it becomes 'editor' only through redeem_invite() below.
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text,
  first_name  text,
  role        text not null default 'client' check (role in ('client','editor')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- Everyone signed in can read basic profile info (needed to show editors);
-- a user can only edit their own row, and never their own role.
drop policy if exists "profiles are readable by signed-in users" on public.profiles;
create policy "profiles are readable by signed-in users"
  on public.profiles for select to authenticated using (true);

drop policy if exists "users update own profile" on public.profiles;
create policy "users update own profile"
  on public.profiles for update to authenticated
  using (auth.uid() = id)
  with check (auth.uid() = id and role = (select role from public.profiles where id = auth.uid()));

-- 2. Create the profile automatically when someone signs up.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public, extensions as $$
begin
  insert into public.profiles (id, email, first_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'first_name', ''))
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- 3. Invite codes. Only the hash is stored; nobody can read the table
--    from the app (no select policy), and only the function below can use it.
create table if not exists public.invites (
  code_hash   text primary key,
  note        text,
  created_at  timestamptz not null default now(),
  used_by     uuid references auth.users(id),
  used_at     timestamptz
);
alter table public.invites enable row level security;  -- no policies = app cannot read/write it directly

-- 4. Redeem an invite: checks the code, marks it used, upgrades the caller to editor.
--    Called from the page as: supabase.rpc('redeem_invite', { code: 'CUV-XXXX-XXXX' })
create or replace function public.redeem_invite(code text)
returns text language plpgsql security definer set search_path = public, extensions as $$
declare
  normalized text := upper(regexp_replace(code, '\s', '', 'g'));
  h text := encode(digest(normalized, 'sha256'), 'hex');
  inv public.invites%rowtype;
begin
  if auth.uid() is null then return 'not_signed_in'; end if;
  if normalized !~ '^CUV-[A-Z0-9]{4}-[A-Z0-9]{4}$' then return 'bad_format'; end if;
  select * into inv from public.invites where code_hash = h;
  if not found then return 'invalid'; end if;
  if inv.used_by is not null then return 'used'; end if;
  update public.invites set used_by = auth.uid(), used_at = now() where code_hash = h;
  update public.profiles set role = 'editor', updated_at = now() where id = auth.uid();
  return 'ok';
end $$;

grant execute on function public.redeem_invite(text) to authenticated;

-- 5. Admin helper: create invite codes. Run this yourself in the SQL editor
--    (it is NOT callable from the app). Example:
--      select public.create_invite('CUV-2026-EDIT', 'first batch');
create or replace function public.create_invite(code text, note text default null)
returns text language plpgsql security definer set search_path = public, extensions as $$
declare
  normalized text := upper(regexp_replace(code, '\s', '', 'g'));
begin
  if normalized !~ '^CUV-[A-Z0-9]{4}-[A-Z0-9]{4}$' then raise exception 'Code must look like CUV-XXXX-XXXX'; end if;
  insert into public.invites (code_hash, note) values (encode(digest(normalized, 'sha256'), 'hex'), note)
  on conflict (code_hash) do nothing;
  return normalized;
end $$;
revoke execute on function public.create_invite(text, text) from public, anon, authenticated;

-- 6. Starter invites (delete or change these as you like).
select public.create_invite('CUV-2026-EDIT', 'starter');
select public.create_invite('CUV-MAYA-0001', 'starter');
select public.create_invite('CUV-ALEX-0002', 'starter');
select public.create_invite('CUV-NINA-0003', 'starter');
select public.create_invite('CUV-TEST-0004', 'starter');
