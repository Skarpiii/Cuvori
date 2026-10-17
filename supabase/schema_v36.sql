-- Cuvori schema v36 — deleting an account works again under Supabase's file guard.
-- Run after schema_v35.sql, in the Supabase SQL editor.
--
-- Since March 2026 Supabase refuses every DELETE made straight in its file tables (a statement trigger on storage.objects,
-- protect_objects_delete) unless it comes through its file service, so that no file is left behind without its record.
-- A statement trigger runs even when nothing would be deleted. Cuvori's account deletion removed the person's portfolio
-- files that way, so every deletion from Cuvori (the person's own "Delete account" and the admin's "Delete user") stopped
-- with an error and nothing was deleted.
--
-- Now:
--  * The page removes the person's portfolio files through the file service first: their own, or, for an admin, the
--    user's (an admin may remove a user's portfolio files, nobody else's).
--  * The database deletion no longer touches the file tables. While the person still has files it answers 'files_left'
--    and changes nothing; the page then removes them and asks again. The money check comes first, so a deletion that has
--    to wait ('active_payments') never costs anyone their files.
--  * A deletion in Supabase's dashboard (Authentication -> Users -> Delete user) never touched the files and still
--    doesn't: those stay under Storage -> portfolio, in a folder named after the user's id, for the owner to remove.

-- What a deletion removes and keeps (as v35), without the file tables. v35's version took a second argument for the files;
-- it goes, so there is one version only.
drop function if exists public.purge_user_data(uuid, boolean);
create or replace function public.purge_user_data(target uuid)
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
revoke execute on function public.purge_user_data(uuid) from public, anon, authenticated;

create or replace function public.purge_user(target uuid)
returns void language plpgsql security definer set search_path = public, storage as $$
begin
  perform public.purge_user_data(target);
  delete from auth.users where id = target;
end $$;
revoke execute on function public.purge_user(uuid) from public, anon, authenticated;

create or replace function public.on_auth_user_deleted()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from public.profiles where id = old.id and deleted_at is null) then
    perform public.purge_user_data(old.id);
  end if;
  return old;
end $$;
revoke execute on function public.on_auth_user_deleted() from public, anon, authenticated;

-- files the person still has in the portfolio bucket
create or replace function public.portfolio_files_left(target uuid)
returns boolean language sql stable security definer set search_path = public, storage as $$
  select exists (select 1 from storage.objects where bucket_id = 'portfolio' and name like target::text || '/%');
$$;
revoke execute on function public.portfolio_files_left(uuid) from public, anon, authenticated;

create or replace function public.delete_my_account()
returns text language plpgsql security definer set search_path = public, storage as $$
begin
  if auth.uid() is null then return 'not_signed_in'; end if;
  if public.has_money_held(auth.uid()) then return 'active_payments'; end if;
  if public.portfolio_files_left(auth.uid()) then return 'files_left'; end if;   -- the page removes them through the file service, then asks again
  perform public.purge_user(auth.uid());
  return 'ok';
end $$;

create or replace function public.admin_delete_user(target uuid)
returns text language plpgsql security definer set search_path = public, storage as $$
begin
  if not public.is_admin() then return 'forbidden'; end if;
  if target = auth.uid() then return 'cannot_delete_self'; end if;
  if public.has_money_held(target) then return 'active_payments'; end if;
  if public.portfolio_files_left(target) then return 'files_left'; end if;
  perform public.purge_user(target);
  return 'ok';
end $$;

-- An admin may remove a user's portfolio files through the file service (the admin page does it before "Delete user").
-- Everyone else still removes only their own (the policy "editors delete own files").
drop policy if exists "admins delete portfolio files" on storage.objects;
create policy "admins delete portfolio files" on storage.objects for delete to authenticated
  using (bucket_id = 'portfolio' and public.is_admin());

-- Shows whether this ran: one row that says "v36 applied".
select case when exists (select 1 from pg_proc where proname = 'purge_user_data' and pronamespace = 'public'::regnamespace and pronargs = 1)
             and not exists (select 1 from pg_proc where proname = 'purge_user_data' and pronamespace = 'public'::regnamespace and pronargs = 2)
             and pg_get_functiondef('public.purge_user_data(uuid)'::regprocedure) not like '%storage.objects%'
             and pg_get_functiondef('public.delete_my_account()'::regprocedure) like '%files_left%'
             and pg_get_functiondef('public.admin_delete_user(uuid)'::regprocedure) like '%files_left%'
             and exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'admins delete portfolio files')
            then 'v36 applied: deleting an account works under Supabase''s file guard'
            else 'v36 NOT applied' end as result;
