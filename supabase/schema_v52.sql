-- Cuvori schema v52 — Supabase's own "Delete user" waits for money still on the way.
-- Run after schema_v51.sql, in the Supabase SQL editor.
--
-- The proper ways to remove a person (Settings → delete account, the admin page → Delete) refuse while money is still on
-- the way on one of their Orders (has_money_held, answer "active_payments"): held for the work, being paid right now, a
-- chargeback the bank is deciding, or a re-payment still owed. Supabase's own dashboard button (Authentication → Users →
-- Delete user) deletes the sign-in row straight away, and the trigger behind it (on_auth_user_deleted, v35) then purged
-- the person's data without that check: a client or a freelancer with EUR 100 held could be removed in the middle of it,
-- with the money still on the Order and nobody to approve, deliver or be paid.
-- Now a trigger before that delete refuses it, with a message in the dashboard saying what to finish first. Deleting on
-- purpose anyway is still possible, in one SQL-editor run:
--   select set_config('cuvori.delete_with_money_held', 'yes', true);
--   delete from auth.users where id = '<the user id>';
-- The Order and its money then stay on record as before (v35). Nothing else changes. Safe to run more than once.

create or replace function public.auth_user_delete_waits_for_money()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if coalesce(current_setting('cuvori.delete_with_money_held', true), '') = 'yes' then return old; end if;
  if public.has_money_held(old.id) then
    raise exception 'Cuvori: this person still has money on the way on an Order (held for the work, being paid right now, a chargeback the bank is deciding, or a re-payment still owed). Finish or refund those Orders first, then delete the user. To delete anyway, run in one SQL-editor run: select set_config(''cuvori.delete_with_money_held'', ''yes'', true); delete from auth.users where id = ''%'';', old.id
      using errcode = 'P0001';
  end if;
  return old;
end $$;
revoke execute on function public.auth_user_delete_waits_for_money() from public, anon, authenticated;

drop trigger if exists auth_user_delete_waits_for_money on auth.users;
create trigger auth_user_delete_waits_for_money before delete on auth.users
  for each row execute function public.auth_user_delete_waits_for_money();

-- Shows whether this ran: one row that says "v52 applied".
select case when exists (select 1 from pg_trigger where tgname = 'auth_user_delete_waits_for_money' and tgrelid = 'auth.users'::regclass and not tgisinternal)
             and not has_function_privilege('authenticated', 'public.auth_user_delete_waits_for_money()', 'execute')
            then 'v52 applied: Supabase''s own Delete user now waits for money still on the way, like the other ways of deleting an account.'
            else 'v52 NOT applied' end as result;
