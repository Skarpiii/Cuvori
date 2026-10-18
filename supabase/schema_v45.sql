-- Cuvori schema v45 — kept Orders can't be wiped by emptying a whole table (TRUNCATE).
-- Run after schema_v44.sql, in the Supabase SQL editor.
--
-- An Order that was agreed or took money is kept with its payment lines and history: a chargeback months later is
-- answered from them (v35). v39 stops deleting such an Order, and the payment lines and history refuse to be deleted.
-- TRUNCATE, which empties a whole table in one go (the Table Editor's "Truncate table", or the word in the SQL editor),
-- skipped all of those checks: one click could wipe every kept Order with its payment lines, and "truncate ... cascade"
-- on profiles, chats or job posts emptied the Orders with them.
-- Also, visitors and signed-in people (the anon and authenticated roles) held the right to empty, link to and add
-- triggers to the tables, from Supabase's defaults. The site never uses those rights, and the API has no way to use them
-- today, so nobody should hold them.
-- Now:
--  * Emptying the Orders is refused while a kept Order exists, and emptying the payment lines or the history is refused
--    while they hold anything, however it is reached (a cascade from another table too).
--  * Those three rights are taken from visitors and signed-in people on every table, also on tables made later in the
--    SQL editor. Reading and writing rows is not affected: the row rules decide those, as before.
-- To empty the Orders on purpose (a test project), run both lines together in the SQL editor, the same way out as v39:
--   select set_config('cuvori.remove_kept_order', 'yes', true);
--   truncate public.contracts cascade;

create or replace function public.orders_keep_records_on_truncate()
returns trigger language plpgsql set search_path = public as $$
declare kept boolean;
begin
  -- on purpose, by the owner in the SQL editor (never by a visitor or a signed-in person)
  if coalesce(current_setting('cuvori.remove_kept_order', true), '') = 'yes' and current_user not in ('anon', 'authenticated') then return null; end if;
  if tg_table_name = 'contracts' then
    kept := exists (select 1 from public.contracts c where public.order_must_stay(c));
  elsif tg_table_name = 'order_payments' then
    kept := exists (select 1 from public.order_payments);
  else
    kept := exists (select 1 from public.order_events);
  end if;
  if kept then
    raise exception 'The table % holds the records of agreed or paid Orders (a chargeback months later is answered from them), so it can''t be emptied. To delete a person, use Authentication -> Users -> Delete user, or the admin page: their kept Orders stay and everything else goes.', tg_table_name;
  end if;
  return null;
end $$;
revoke execute on function public.orders_keep_records_on_truncate() from public, anon, authenticated;

drop trigger if exists orders_keep_records_truncate on public.contracts;
create trigger orders_keep_records_truncate before truncate on public.contracts
  for each statement execute function public.orders_keep_records_on_truncate();
drop trigger if exists orders_keep_records_truncate on public.order_payments;
create trigger orders_keep_records_truncate before truncate on public.order_payments
  for each statement execute function public.orders_keep_records_on_truncate();
drop trigger if exists orders_keep_records_truncate on public.order_events;
create trigger orders_keep_records_truncate before truncate on public.order_events
  for each statement execute function public.orders_keep_records_on_truncate();

-- The rights the site never uses: emptying a table, linking to it, adding triggers to it. Counted first, for the result.
do $$
declare n int;
begin
  select count(distinct c.oid) into n from pg_class c cross join (values ('anon'), ('authenticated')) r(n)
   where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p', 'v', 'm', 'f')
     and (has_table_privilege(r.n, c.oid, 'TRUNCATE') or has_table_privilege(r.n, c.oid, 'TRIGGER') or has_table_privilege(r.n, c.oid, 'REFERENCES'));
  perform set_config('cuvori.v45_rights', n::text, false);
end $$;
revoke truncate, trigger, references on all tables in schema public from public, anon, authenticated;
alter default privileges in schema public revoke truncate, trigger, references on tables from public, anon, authenticated;

-- Shows whether this ran: one row that says "v45 applied", and how many tables the rights were taken from this time.
select case when (select count(*) from pg_trigger where tgname = 'orders_keep_records_truncate' and tgenabled <> 'D'
                    and tgrelid in ('public.contracts'::regclass, 'public.order_payments'::regclass, 'public.order_events'::regclass)) = 3
             and not exists (select 1 from pg_class c cross join (values ('anon'), ('authenticated')) r(n)
                              where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p', 'v', 'm', 'f')
                                and (has_table_privilege(r.n, c.oid, 'TRUNCATE') or has_table_privilege(r.n, c.oid, 'TRIGGER') or has_table_privilege(r.n, c.oid, 'REFERENCES')))
            then 'v45 applied: kept Orders, their payment lines and history can''t be emptied in one go, and visitors and signed-in people no longer hold rights the site never uses. Those rights taken from ' || current_setting('cuvori.v45_rights') || ' tables.'
            else 'v45 NOT applied' end as result;
