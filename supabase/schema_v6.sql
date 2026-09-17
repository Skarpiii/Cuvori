-- ============================================================
-- Cuvori — schema v6: bad-actor flags (admin watch list)
-- A flag is a note on a user: scam, lost dispute, abuse, other. Users never
-- see flags. Lost disputes are flagged automatically when Cuvori decides.
-- Run AFTER schema_v5.sql. Re-runnable.
-- ============================================================

create table if not exists public.user_flags (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.profiles(id) on delete cascade,
  kind         text not null default 'other' check (kind in ('scam','dispute_lost','abuse','fake','other')),
  reason       text default '',
  contract_id  uuid references public.contracts(id) on delete set null,
  created_by   uuid references public.profiles(id) on delete set null,
  created_at   timestamptz not null default now()
);
create index if not exists user_flags_user_idx on public.user_flags(user_id, created_at desc);
alter table public.user_flags enable row level security;   -- no policies: only admin functions touch it

create or replace function public.admin_flag_user(target uuid, kind text, reason text default null, contract uuid default null)
returns text language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then return 'forbidden'; end if;
  if target = auth.uid() then return 'cannot_flag_self'; end if;
  insert into public.user_flags (user_id, kind, reason, contract_id, created_by) values (target, coalesce(kind,'other'), coalesce(reason,''), contract, auth.uid());
  return 'ok';
end $$;
grant execute on function public.admin_flag_user(uuid, text, text, uuid) to authenticated;

create or replace function public.admin_unflag(flag uuid)
returns text language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then return 'forbidden'; end if;
  delete from public.user_flags where id = flag;
  return 'ok';
end $$;
grant execute on function public.admin_unflag(uuid) to authenticated;

-- one row per flagged user, with every flag and dispute history
create or replace function public.admin_list_bad_actors()
returns table (id uuid, email text, first_name text, display_name text, role text, banned boolean, ban_reason text, created_at timestamptz,
               flag_count int, last_flag timestamptz, disputes_lost int, disputes_won int, disputes_open int,
               flags jsonb)
language sql stable security definer set search_path = public as $$
  select p.id, p.email, p.first_name, e.display_name, p.role, p.banned, p.ban_reason, p.created_at,
         (select count(*)::int from public.user_flags f where f.user_id = p.id),
         (select max(created_at) from public.user_flags f where f.user_id = p.id),
         (select count(*)::int from public.contracts c where c.status in ('completed','refunded') and c.disputed_at is not null
            and ((c.editor = p.id and c.resolution = 'refund') or (c.client = p.id and c.resolution = 'release'))),
         (select count(*)::int from public.contracts c where c.status in ('completed','refunded') and c.disputed_at is not null
            and ((c.editor = p.id and c.resolution = 'release') or (c.client = p.id and c.resolution = 'refund'))),
         (select count(*)::int from public.contracts c where c.status = 'disputed' and p.id in (c.editor, c.client)),
         coalesce((select jsonb_agg(jsonb_build_object('id', f.id, 'kind', f.kind, 'reason', f.reason, 'contract_id', f.contract_id, 'created_at', f.created_at) order by f.created_at desc)
                   from public.user_flags f where f.user_id = p.id), '[]'::jsonb)
  from public.profiles p left join public.editor_profiles e on e.id = p.id
  where public.is_admin()
    and (exists (select 1 from public.user_flags f where f.user_id = p.id) or p.banned)
  order by (select max(created_at) from public.user_flags f where f.user_id = p.id) desc nulls last;
$$;
grant execute on function public.admin_list_bad_actors() to authenticated;

-- users list shows a flag count too
drop function if exists public.admin_list_users();
create or replace function public.admin_list_users()
returns table (id uuid, email text, first_name text, role text, is_admin boolean, banned boolean, ban_reason text,
               created_at timestamptz, display_name text, is_public boolean, projects int, reviews int, avg_stars numeric, flags int)
language sql stable security definer set search_path = public as $$
  select p.id, p.email, p.first_name, p.role, p.is_admin, p.banned, p.ban_reason, p.created_at,
         e.display_name, e.is_public,
         (select count(*)::int from public.projects pr where pr.owner = p.id),
         (select count(*)::int from public.reviews r where r.editor = p.id),
         (select round(avg(stars),1) from public.reviews r where r.editor = p.id),
         (select count(*)::int from public.user_flags f where f.user_id = p.id)
  from public.profiles p left join public.editor_profiles e on e.id = p.id
  where public.is_admin()
  order by p.created_at desc;
$$;
grant execute on function public.admin_list_users() to authenticated;
