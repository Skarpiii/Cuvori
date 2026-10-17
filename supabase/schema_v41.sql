-- Cuvori schema v41 — nothing new starts with a person who deleted their account.
-- Run after schema_v40.sql, in the Supabase SQL editor.
--
-- When one of two people deletes their account, an Order they agreed is kept, and so is its chat (v35). The other person
-- could then start a new Order in that chat with the deleted person. Nobody can ever accept it, so no money can go into
-- it, but it waits for an answer that never comes, and while it is open no other Order can be started in that chat. A
-- change (amendment) could be proposed to the deleted person too, and would also wait forever.
-- Now the database refuses a new Order, and a new change, when one of the two people has deleted their account
-- ("not_available": the page says "This person can't be contacted right now."), however it is written. Account deletion
-- itself is not affected. This file also closes the Orders started with a deleted person before it, the way v37 closes
-- them at deletion: an Order nobody can accept or pay is cancelled, with a line in its history.

create or replace function public.orders_need_both_people()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_table_name = 'contracts' then
    if exists (select 1 from public.profiles p where p.id in (new.editor, new.client) and p.deleted_at is not null) then
      raise exception 'not_available' using hint = 'one of the two people on this Order has deleted their account';
    end if;
  elsif exists (select 1 from public.contracts c join public.profiles p on p.id in (c.editor, c.client)
                 where c.id = new.order_id and p.deleted_at is not null) then
    raise exception 'not_available' using hint = 'one of the two people on this Order has deleted their account';
  end if;
  return new;
end $$;
revoke execute on function public.orders_need_both_people() from public, anon, authenticated;

drop trigger if exists contracts_need_both_people on public.contracts;
create trigger contracts_need_both_people before insert on public.contracts
  for each row execute function public.orders_need_both_people();
drop trigger if exists order_amendments_need_both_people on public.order_amendments;
create trigger order_amendments_need_both_people before insert on public.order_amendments
  for each row execute function public.orders_need_both_people();

-- Orders started with a deleted person before v41: nobody can accept or pay them, so they close (as v37 does at deletion).
do $$
declare n int;
begin
  with closed as (
    update public.contracts c set status = 'cancelled', closed_at = now()
     where c.status in ('proposed', 'accepted') and coalesce(c.funded_cents, 0) = 0
       and not exists (select 1 from public.order_payments p where p.order_id = c.id and p.kind = 'fund')
       and exists (select 1 from public.profiles d where d.id in (c.editor, c.client) and d.deleted_at is not null)
    returning c.id),
  logged as (
    insert into public.order_events (order_id, actor, event, data)
    select id, null, 'cancelled', jsonb_build_object('reason', 'account_deleted') from closed returning 1)
  select count(*) into n from logged;
  perform set_config('cuvori.v41_closed', n::text, false);
end $$;

-- Shows whether this ran: one row that says "v41 applied", and how many Orders it closed this time.
select case when exists (select 1 from pg_trigger where tgrelid = 'public.contracts'::regclass and tgname = 'contracts_need_both_people' and tgenabled <> 'D')
             and exists (select 1 from pg_trigger where tgrelid = 'public.order_amendments'::regclass and tgname = 'order_amendments_need_both_people' and tgenabled <> 'D')
             and not exists (select 1 from public.contracts c where c.status in ('proposed', 'accepted') and coalesce(c.funded_cents, 0) = 0
                              and not exists (select 1 from public.order_payments p where p.order_id = c.id and p.kind = 'fund')
                              and exists (select 1 from public.profiles d where d.id in (c.editor, c.client) and d.deleted_at is not null))
            then 'v41 applied: nothing new starts with a person who deleted their account. Orders closed now: ' || current_setting('cuvori.v41_closed') || '.'
            else 'v41 NOT applied' end as result;
