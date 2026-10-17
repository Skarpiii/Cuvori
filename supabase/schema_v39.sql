-- Cuvori schema v39 — an agreed or paid Order can no longer be deleted by removing a row in the Table Editor.
-- Run after schema_v38.sql, in the Supabase SQL editor.
--
-- Deleting an account keeps the person's agreed and paid Orders with their payment lines, history and chat (v35): a
-- chargeback can come months later, and the payment functions find it only through the Order. But deleting a row by hand
-- in Supabase's Table Editor still took all of that with it, for the other person too: the person's row in "profiles", the
-- chat in "conversations", or the Order in "contracts" (the tables are linked "on delete cascade"). A chargeback after that
-- was paid from Cuvori's Stripe balance with nothing pulled back from the freelancer, and a re-payment still owed to the
-- freelancer had no Order and no payout row left to go to.
-- Now the database refuses to delete an Order that account deletion would keep (agreed by both, or money went through
-- Cuvori for it), however the delete comes: the whole delete is undone, with a message saying where people are deleted
-- (Authentication -> Users -> Delete user, or the admin page). Drafts that were never agreed are deleted as before, and
-- account deletion works as before.
-- To remove a test Order on purpose (with its payment lines and history), run both lines together in the SQL editor:
--   select set_config('cuvori.remove_kept_order', 'yes', true);
--   delete from public.contracts where id = '<the Order id>';

-- An Order account deletion keeps: the same rule purge_user_data() uses (agreed, or money went through Cuvori for it).
create or replace function public.order_must_stay(c public.contracts)
returns boolean language sql stable set search_path = public as $$
  select c.accepted_at is not null or coalesce(c.funded_cents, 0) > 0 or c.chargeback_id is not null
      or exists (select 1 from public.order_payments p where p.order_id = c.id);
$$;
revoke execute on function public.order_must_stay(public.contracts) from public, anon, authenticated;

create or replace function public.contracts_keep_records()
returns trigger language plpgsql set search_path = public as $$
begin
  -- on purpose, by the owner in the SQL editor (never by a visitor or a signed-in person)
  if coalesce(current_setting('cuvori.remove_kept_order', true), '') = 'yes' and current_user not in ('anon', 'authenticated') then return old; end if;
  if public.order_must_stay(old) then
    raise exception 'Order % (%) was agreed or took money, so it is kept with its payment lines, history and chat: a chargeback months later is answered from them. To delete a person, use Authentication -> Users -> Delete user, or the admin page: their kept Orders stay and everything else goes.', old.id, old.title;
  end if;
  return old;
end $$;
revoke execute on function public.contracts_keep_records() from public, anon, authenticated;

drop trigger if exists contracts_keep_records on public.contracts;
create trigger contracts_keep_records before delete on public.contracts
  for each row execute function public.contracts_keep_records();

-- Shows whether this ran: one row that says "v39 applied", and how many Orders are now kept this way.
select case when exists (select 1 from pg_trigger where tgrelid = 'public.contracts'::regclass and tgname = 'contracts_keep_records' and tgenabled <> 'D')
             and not exists (select 1 from pg_proc p cross join (values ('anon'), ('authenticated')) r(r)
                              where p.pronamespace = 'public'::regnamespace and p.proname in ('order_must_stay', 'contracts_keep_records')
                                and has_function_privilege(r.r, p.oid, 'execute'))
            then 'v39 applied: an agreed or paid Order can no longer be deleted by removing a row by hand. Orders kept this way: '
                 || (select count(*) from public.contracts c where public.order_must_stay(c))
                 || ' of ' || (select count(*) from public.contracts)
            else 'v39 NOT applied' end as result;
