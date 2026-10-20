-- Cuvori schema v49 — a card chargeback flags the client.
-- Run after schema_v48.sql, in the Supabase SQL editor.
--
-- When a client's bank takes a payment back (a chargeback), the payment functions (netlify/lib/cuvori.mjs,
-- onDisputeCreated) put a flag on the client: kind "chargeback". A flag puts the person on the admin page's Bad actors
-- list, makes a later account with the same e-mail, card or bank account show up as a match, and makes deleting the
-- account keep their details on the list new accounts are checked against. The table only allowed the kinds scam,
-- dispute_lost, abuse, fake, match and other (v7), so that flag was refused every time, and the payment functions ignore a
-- failed flag: a client who charged back was never flagged, and could do it again from a new account unnoticed.
-- Now "chargeback" is an allowed kind, and this file adds the flag for every Order that already had a chargeback.

alter table public.user_flags drop constraint if exists user_flags_kind_check;
alter table public.user_flags add constraint user_flags_kind_check
  check (kind in ('scam', 'dispute_lost', 'abuse', 'fake', 'match', 'chargeback', 'other'));

-- Orders that had a chargeback before v49: their client gets the flag the payment functions could not save.
do $$
declare n int;
begin
  with added as (
    insert into public.user_flags (user_id, kind, reason, contract_id)
    select c.client, 'chargeback', 'Chargeback ' || c.chargeback_id || ' on "' || left(c.title, 120) || '" (flag added by v49)', c.id
      from public.contracts c
     where c.chargeback_id is not null
       and not exists (select 1 from public.user_flags f where f.user_id = c.client and f.contract_id = c.id and f.kind = 'chargeback')
    returning 1)
  select count(*) into n from added;
  perform set_config('cuvori.v49_flagged', n::text, false);
end $$;

-- Shows whether this ran: one row that says "v49 applied", and how many clients of earlier chargebacks it flagged now.
select case when pg_get_constraintdef((select oid from pg_constraint where conrelid = 'public.user_flags'::regclass and conname = 'user_flags_kind_check')) like '%chargeback%'
            then 'v49 applied: a card chargeback flags the client. Clients of earlier chargebacks flagged now: ' || current_setting('cuvori.v49_flagged') || '.'
            else 'v49 NOT applied' end as result;
