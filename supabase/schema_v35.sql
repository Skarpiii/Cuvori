-- Cuvori schema v35 — deleting an account keeps the records of its Orders.
-- Run after schema_v34.sql, in the Supabase SQL editor.
--
-- A card payment can be charged back for months after an Order is finished, and a card-fee surplus or a re-payment after
-- a won chargeback can still be on its way. The payment functions find all of that only through the Order and its payment
-- lines. Deleting an account (by the person, by an admin, or in Supabase's dashboard) removed every Order the person was
-- on, with its payment lines, for the other person too. A chargeback after that was taken from Cuvori's Stripe balance and
-- nothing was pulled back from the freelancer, because the payment functions could no longer find the Order; and a
-- freelancer still owed a re-payment after a won chargeback was never paid. The privacy notice already says contract and
-- payment records are kept when an account is closed.
--
-- Now:
--  * An Order that was agreed, or that took money through Cuvori, stays, with its payment lines, its history and its chat
--    (the other person keeps seeing it, and the payment functions keep finding it). Drafts that were never agreed go.
--  * The person goes: their sign-in, e-mail, name, public profile, services, posts, portfolio, messages, reviews, bank
--    details, flags and checks. A deleted account keeps an empty profile row (no e-mail, no name, marked deleted) only
--    while it is on a kept Order, and a freelancer's Stripe account id stays with it, so a re-payment can still reach them.
--  * Deleting waits while money is still on its way for one of the person's Orders: held, a chargeback the bank is
--    deciding, a re-payment still owed after a won chargeback, or a payment being taken right now ('active_payments').
--  * A user deleted in Supabase's dashboard (Authentication -> Users -> Delete user) is treated the same way.

alter table public.profiles add column if not exists deleted_at timestamptz;

-- A profile no longer disappears with its sign-in account: the deletion below decides what goes. (The link was
-- "on delete cascade", which took every Order of the person with it.)
do $$
declare r record;
begin
  for r in select conname from pg_constraint
            where conrelid = 'public.profiles'::regclass and contype = 'f' and confrelid = 'auth.users'::regclass loop
    execute format('alter table public.profiles drop constraint %I', r.conname);
  end loop;
end $$;

-- The profile guard keeps a person from changing their own e-mail; while their account is being deleted it must let the
-- deletion clear it.
create or replace function public.profiles_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if coalesce(current_setting('cuvori.purge', true), '') = '1' then return new; end if;
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

-- Money still on its way for one of the person's Orders: held, a chargeback the bank is deciding, a re-payment still owed
-- after a won chargeback (the hourly job finds it through the Order), or a payment step running right now (its lock, the
-- same 90 seconds as the payment functions).
create or replace function public.has_money_held(target uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.contracts c where target in (c.editor, c.client)
                 and (c.status in ('funded','delivered','disputed','releasing','resolving')
                      or c.chargeback_status = 'open'
                      or coalesce(c.money_error, '') like 'chargeback won%'
                      or exists (select 1 from public.money_keys k
                                  where k.scope = 'lock:' || c.id::text and k.created_at > now() - interval '90 seconds')));
$$;
revoke execute on function public.has_money_held(uuid) from public, anon, authenticated;

-- Everything a deletion removes, and what it keeps. The sign-in account itself is removed by purge_user (or was already
-- removed, when the owner deleted the user in Supabase's dashboard). p_files: also remove the person's portfolio files, as
-- a deletion from Cuvori always did; a deletion in Supabase's dashboard never touched them and still doesn't.
create or replace function public.purge_user_data(target uuid, p_files boolean default true)
returns void language plpgsql security definer set search_path = public, storage as $$
declare was_bad boolean; kept uuid[];
begin
  perform set_config('cuvori.purge', '1', true);
  was_bad := exists (select 1 from public.user_flags f where f.user_id = target) or coalesce((select banned from public.profiles where id = target), false);
  if was_bad then
    insert into public.deleted_user_identifiers (kind, value_hash, label, note)
    select i.kind, i.value_hash, i.label, coalesce((select string_agg(f.kind || ': ' || f.reason, ' | ') from public.user_flags f where f.user_id = target), 'banned')
    from public.user_identifiers i where i.user_id = target;
  end if;
  -- the Orders that stay: agreed by both, or money went through Cuvori for them
  kept := array(select c.id from public.contracts c
                 where target in (c.editor, c.client)
                   and (c.accepted_at is not null or coalesce(c.funded_cents, 0) > 0 or c.chargeback_id is not null
                        or exists (select 1 from public.order_payments p where p.order_id = c.id)));
  if p_files then delete from storage.objects where bucket_id = 'portfolio' and name like target::text || '/%'; end if;
  delete from public.order_reviews where reviewer = target or reviewee = target;
  delete from public.contracts where (editor = target or client = target) and not (id = any(kept));
  delete from public.messages where sender = target;
  -- a chat stays only while a kept Order is in it
  delete from public.conversations v where (v.user_a = target or v.user_b = target)
     and not exists (select 1 from public.contracts k where k.conversation_id = v.id and k.id = any(kept));
  delete from public.reviews where client = target or editor = target;
  delete from public.jobs where owner = target;
  delete from public.projects where owner = target;
  delete from public.editor_profiles where id = target;
  update public.invites set used_by = null, note = coalesce(note,'') || ' [user deleted]' where used_by = target;
  if cardinality(kept) = 0 then
    delete from public.payout_details where id = target;
    delete from public.profiles where id = target;               -- the rest of the person's rows go with it
    return;
  end if;
  -- on a kept Order: an empty profile row stays for the Order to point at. A freelancer's Stripe account id stays (a
  -- re-payment after a won chargeback goes there); the bank details and the note go.
  update public.payout_details set methods = '[]'::jsonb, note = '', updated_at = now() where id = target;
  delete from public.services where profile_id = target;
  delete from public.identity_verifications where user_id = target;
  delete from public.user_identifiers where user_id = target;
  delete from public.user_flags where user_id = target;
  update public.user_flags set created_by = null where created_by = target;
  delete from public.job_reports where reporter = target;
  update public.reports set reporter = null where reporter = target;
  update public.reports set handled_by = null where handled_by = target;
  update public.profiles set email = null, first_name = null, ban_reason = null, is_admin = false, rules_version = null,
         rules_accepted_at = null, last_seen_at = null, visibility = 'hidden', deleted_at = now(), updated_at = now()
   where id = target;
end $$;
revoke execute on function public.purge_user_data(uuid, boolean) from public, anon, authenticated;

create or replace function public.purge_user(target uuid)
returns void language plpgsql security definer set search_path = public, storage as $$
begin
  perform public.purge_user_data(target, true);
  delete from auth.users where id = target;
end $$;
revoke execute on function public.purge_user(uuid) from public, anon, authenticated;

-- A user deleted in Supabase's dashboard: the same as a deletion from Cuvori (before v35 the profile went with the
-- sign-in account and took the Orders with it). A deletion from Cuvori has already done this and marked the profile.
create or replace function public.on_auth_user_deleted()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from public.profiles where id = old.id and deleted_at is null) then
    perform public.purge_user_data(old.id, false);
  end if;
  return old;
end $$;
revoke execute on function public.on_auth_user_deleted() from public, anon, authenticated;
drop trigger if exists on_auth_user_deleted on auth.users;
create trigger on_auth_user_deleted after delete on auth.users for each row execute procedure public.on_auth_user_deleted();

-- The admin panel lists people: a deleted account is not one any more.
create or replace function public.admin_list_users()
 returns table(id uuid, email text, first_name text, role text, is_admin boolean, banned boolean, ban_reason text, created_at timestamp with time zone, display_name text, is_public boolean, projects integer, reviews integer, avg_stars numeric, flags integer, visibility text)
 language sql stable security definer set search_path to 'public'
as $function$
  select p.id, p.email, p.first_name, p.role, p.is_admin, p.banned, p.ban_reason, p.created_at,
         e.display_name, e.is_public,
         (select count(*)::int from public.projects pr where pr.owner = p.id),
         (select count(*)::int from public.reviews r where r.editor = p.id),
         (select round(avg(stars),1) from public.reviews r where r.editor = p.id),
         (select count(*)::int from public.user_flags f where f.user_id = p.id),
         p.visibility
  from public.profiles p left join public.editor_profiles e on e.id = p.id
  where public.is_admin() and p.deleted_at is null
  order by p.created_at desc;
$function$;

create or replace function public.admin_list_bad_actors()
 returns table(id uuid, email text, first_name text, display_name text, role text, banned boolean, ban_reason text, created_at timestamp with time zone, flag_count integer, last_flag timestamp with time zone, disputes_lost integer, disputes_won integer, disputes_open integer, flags jsonb, identifiers jsonb)
 language sql stable security definer set search_path to 'public'
as $function$
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
  where public.is_admin() and p.deleted_at is null
    and (exists (select 1 from public.user_flags f where f.user_id = p.id) or p.banned)
  order by (select max(created_at) from public.user_flags f where f.user_id = p.id) desc nulls last;
$function$;

-- Shows whether this ran: one row that says "v35 applied". The second column only reads Supabase's own setup: whether its
-- file service refuses deletes made straight in the database (a statement-level DELETE trigger on storage.objects).
select case when exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'profiles' and column_name = 'deleted_at')
             and not exists (select 1 from pg_constraint where conrelid = 'public.profiles'::regclass and contype = 'f' and confrelid = 'auth.users'::regclass)
             and exists (select 1 from pg_trigger where tgname = 'on_auth_user_deleted' and tgrelid = 'auth.users'::regclass and not tgisinternal)
             and pg_get_functiondef('public.has_money_held(uuid)'::regprocedure) like '%chargeback won%'
            then 'v35 applied: deleting an account keeps the records of its Orders'
            else 'v35 NOT applied' end as result,
       coalesce((select string_agg(tgname, ', ') from pg_trigger
                  where tgrelid = 'storage.objects'::regclass and not tgisinternal and (tgtype & 1) = 0 and (tgtype & 8) <> 0), 'none') as file_delete_guard;
