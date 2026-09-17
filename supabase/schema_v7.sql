-- ============================================================
-- Cuvori — schema v7: identifiers of users (email, bank card, IBAN, PayPal,
-- Stripe account) so a flagged or banned person is recognised when they come
-- back under a new account. Values are stored as SHA-256 hashes plus a short
-- label (e.g. "Visa ••4242"); the full card/IBAN is never stored.
-- Run AFTER schema_v6.sql. Re-runnable.
-- ============================================================

create table if not exists public.user_identifiers (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  kind        text not null check (kind in ('email','card','iban','paypal','revolut','wise','other','stripe_account')),
  value_hash  text not null,
  label       text default '',
  created_at  timestamptz not null default now(),
  unique (user_id, kind, value_hash)
);
create index if not exists user_identifiers_hash_idx on public.user_identifiers(kind, value_hash);
alter table public.user_identifiers enable row level security;   -- no policies: server-side only

alter table public.user_flags drop constraint if exists user_flags_kind_check;
alter table public.user_flags add constraint user_flags_kind_check
  check (kind in ('scam','dispute_lost','abuse','fake','match','other'));

create or replace function public.norm_identifier(v text)
returns text language sql immutable as $$
  select lower(regexp_replace(coalesce(v,''), '[\s\-\.]', '', 'g'));
$$;

-- Record an identifier for a user and, if a flagged/banned user shares it, flag this user too.
create or replace function public.record_identifier(p_uid uuid, p_kind text, p_value text, p_label text default null)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare h text; other record;
begin
  if p_uid is null or p_value is null or length(public.norm_identifier(p_value)) < 4 then return; end if;
  h := encode(digest(public.norm_identifier(p_value), 'sha256'), 'hex');
  insert into public.user_identifiers (user_id, kind, value_hash, label) values (p_uid, p_kind, h, coalesce(p_label,''))
  on conflict (user_id, kind, value_hash) do nothing;
  for other in
    select distinct p.id, coalesce(e.display_name, p.first_name, p.email) as name
    from public.user_identifiers i
    join public.profiles p on p.id = i.user_id
    left join public.editor_profiles e on e.id = p.id
    where i.kind = p_kind and i.value_hash = h and i.user_id <> p_uid
      and (p.banned or exists (select 1 from public.user_flags f where f.user_id = p.id))
  loop
    if not exists (select 1 from public.user_flags f where f.user_id = p_uid and f.kind = 'match' and f.reason like '%' || other.id::text || '%') then
      insert into public.user_flags (user_id, kind, reason)
      values (p_uid, 'match', 'Same ' || p_kind || ' (' || coalesce(p_label,'') || ') as flagged user ' || other.name || ' [' || other.id::text || ']');
    end if;
  end loop;
end $$;
revoke execute on function public.record_identifier(uuid, text, text, text) from public, anon, authenticated;

-- e-mail: recorded when the profile is created
create or replace function public.on_profile_created_identifiers()
returns trigger language plpgsql security definer set search_path = public, extensions as $$
begin
  perform public.record_identifier(new.id, 'email', new.email, new.email);
  return new;
end $$;
drop trigger if exists profiles_identifiers on public.profiles;
create trigger profiles_identifiers after insert on public.profiles for each row execute procedure public.on_profile_created_identifiers();

-- payout methods (IBAN / PayPal / Revolut / Wise) and Stripe account: recorded when saved
create or replace function public.on_payout_details_identifiers()
returns trigger language plpgsql security definer set search_path = public, extensions as $$
declare m jsonb; v text; k text;
begin
  for m in select * from jsonb_array_elements(coalesce(new.methods, '[]'::jsonb)) loop
    v := m->>'details'; k := coalesce(m->>'type', 'other');
    if k = 'bank' then k := 'iban'; end if;
    if k not in ('iban','paypal','revolut','wise') then k := 'other'; end if;
    if v is not null and length(v) >= 4 then
      perform public.record_identifier(new.id, k, v, k || ' ••' || right(regexp_replace(v, '\s', '', 'g'), 4));
    end if;
  end loop;
  if new.stripe_account_id is not null then
    perform public.record_identifier(new.id, 'stripe_account', new.stripe_account_id, new.stripe_account_id);
  end if;
  return new;
end $$;
drop trigger if exists payout_identifiers on public.payout_details;
create trigger payout_identifiers after insert or update on public.payout_details for each row execute procedure public.on_payout_details_identifiers();

-- bank card: recorded by the Stripe webhook (server) through this admin-free function
create or replace function public.record_card(uid uuid, fingerprint text, label text)
returns void language plpgsql security definer set search_path = public, extensions as $$
begin
  perform public.record_identifier(uid, 'card', fingerprint, label);
end $$;
revoke execute on function public.record_card(uuid, text, text) from public, anon, authenticated;
grant execute on function public.record_card(uuid, text, text) to service_role;

-- backfill e-mails for existing users
do $$ declare p record; begin
  for p in select id, email from public.profiles loop perform public.record_identifier(p.id, 'email', p.email, p.email); end loop;
end $$;

-- admin views: identifiers + who else shares them
create or replace function public.admin_user_identifiers(target uuid)
returns table (kind text, label text, created_at timestamptz, shared_with jsonb)
language sql stable security definer set search_path = public as $$
  select i.kind, i.label, i.created_at,
         coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'name', coalesce(e.display_name, p.first_name, p.email), 'email', p.email, 'banned', p.banned,
                                                       'flagged', exists (select 1 from public.user_flags f where f.user_id = p.id)))
                   from public.user_identifiers j join public.profiles p on p.id = j.user_id left join public.editor_profiles e on e.id = p.id
                   where j.kind = i.kind and j.value_hash = i.value_hash and j.user_id <> i.user_id), '[]'::jsonb)
  from public.user_identifiers i
  where public.is_admin() and i.user_id = target
  order by i.created_at;
$$;
grant execute on function public.admin_user_identifiers(uuid) to authenticated;

-- bad actors list now includes identifiers inline
drop function if exists public.admin_list_bad_actors();
create or replace function public.admin_list_bad_actors()
returns table (id uuid, email text, first_name text, display_name text, role text, banned boolean, ban_reason text, created_at timestamptz,
               flag_count int, last_flag timestamptz, disputes_lost int, disputes_won int, disputes_open int,
               flags jsonb, identifiers jsonb)
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
                   from public.user_flags f where f.user_id = p.id), '[]'::jsonb),
         coalesce((select jsonb_agg(jsonb_build_object('kind', i.kind, 'label', i.label,
                    'shared', (select count(*) from public.user_identifiers j where j.kind = i.kind and j.value_hash = i.value_hash and j.user_id <> i.user_id)) order by i.created_at)
                   from public.user_identifiers i where i.user_id = p.id), '[]'::jsonb)
  from public.profiles p left join public.editor_profiles e on e.id = p.id
  where public.is_admin()
    and (exists (select 1 from public.user_flags f where f.user_id = p.id) or p.banned)
  order by (select max(created_at) from public.user_flags f where f.user_id = p.id) desc nulls last;
$$;
grant execute on function public.admin_list_bad_actors() to authenticated;

-- identifiers survive account deletion: keep a copy on a "ghost" row so a returning scammer is still recognised
create table if not exists public.deleted_user_identifiers (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null,
  value_hash  text not null,
  label       text default '',
  note        text default '',
  deleted_at  timestamptz not null default now()
);
create index if not exists deleted_user_identifiers_hash_idx on public.deleted_user_identifiers(kind, value_hash);
alter table public.deleted_user_identifiers enable row level security;

create or replace function public.purge_user(target uuid)
returns void language plpgsql security definer set search_path = public, storage as $$
declare was_bad boolean;
begin
  was_bad := exists (select 1 from public.user_flags f where f.user_id = target) or coalesce((select banned from public.profiles where id = target), false);
  if was_bad then
    insert into public.deleted_user_identifiers (kind, value_hash, label, note)
    select i.kind, i.value_hash, i.label, coalesce((select string_agg(f.kind || ': ' || f.reason, ' | ') from public.user_flags f where f.user_id = target), 'banned')
    from public.user_identifiers i where i.user_id = target;
  end if;
  delete from storage.objects where bucket_id = 'portfolio' and name like target::text || '/%';
  delete from public.contracts where editor = target or client = target;
  delete from public.payout_details where id = target;
  delete from public.reviews where client = target or editor = target;
  delete from public.messages where sender = target;
  delete from public.conversations where user_a = target or user_b = target;
  delete from public.jobs where owner = target;
  delete from public.projects where owner = target;
  delete from public.editor_profiles where id = target;
  update public.invites set used_by = null, note = coalesce(note,'') || ' [user deleted]' where used_by = target;
  delete from public.profiles where id = target;
  delete from auth.users where id = target;
end $$;
revoke execute on function public.purge_user(uuid) from public, anon, authenticated;

-- record_identifier also checks the ghost list
create or replace function public.record_identifier(p_uid uuid, p_kind text, p_value text, p_label text default null)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare h text; other record; ghost record;
begin
  if p_uid is null or p_value is null or length(public.norm_identifier(p_value)) < 4 then return; end if;
  h := encode(digest(public.norm_identifier(p_value), 'sha256'), 'hex');
  insert into public.user_identifiers (user_id, kind, value_hash, label) values (p_uid, p_kind, h, coalesce(p_label,''))
  on conflict (user_id, kind, value_hash) do nothing;
  for other in
    select distinct p.id, coalesce(e.display_name, p.first_name, p.email) as name
    from public.user_identifiers i
    join public.profiles p on p.id = i.user_id
    left join public.editor_profiles e on e.id = p.id
    where i.kind = p_kind and i.value_hash = h and i.user_id <> p_uid
      and (p.banned or exists (select 1 from public.user_flags f where f.user_id = p.id))
  loop
    if not exists (select 1 from public.user_flags f where f.user_id = p_uid and f.kind = 'match' and f.reason like '%' || other.id::text || '%') then
      insert into public.user_flags (user_id, kind, reason)
      values (p_uid, 'match', 'Same ' || p_kind || ' (' || coalesce(p_label,'') || ') as flagged user ' || other.name || ' [' || other.id::text || ']');
    end if;
  end loop;
  for ghost in select * from public.deleted_user_identifiers g where g.kind = p_kind and g.value_hash = h loop
    if not exists (select 1 from public.user_flags f where f.user_id = p_uid and f.kind = 'match' and f.reason like '%deleted account%' || ghost.id::text || '%') then
      insert into public.user_flags (user_id, kind, reason)
      values (p_uid, 'match', 'Same ' || p_kind || ' (' || coalesce(p_label,'') || ') as a deleted account that was flagged: ' || ghost.note || ' [deleted account ' || ghost.id::text || ']');
    end if;
  end loop;
end $$;
revoke execute on function public.record_identifier(uuid, text, text, text) from public, anon, authenticated;
