-- Cuvori schema v55 — the admin can mark an Order's note as handled.
-- Run after schema_v54.sql, in the Supabase SQL editor.
--
-- An Order's note ("Needs a hand" in the admin panel → Orders) tells the admin something needs a look: a top-up that may
-- not be recorded, a counter that could not be updated, a refund made in the Stripe dashboard, a chargeback Cuvori covered.
-- Until now such a note went away only when the next payout or refund on that Order went through, which wiped any note,
-- also one nobody had looked at yet. From this update on, a payout or refund removes only its own note, so the other notes
-- stay until a person has dealt with them. This adds the button for that: "Mark as handled" under the note.
-- It removes the note only for an admin, and only while the note still reads what the admin saw (a newer note that came in
-- meanwhile stays). The notes Cuvori's hourly run works from (a chargeback's pull-back or re-payment still owed, a payment
-- line still to add) are not removed this way: they go by themselves once that work is done. Nothing else changes. Safe to
-- run more than once.

create or replace function public.admin_clear_order_note(p_order uuid, p_note text)
returns text language plpgsql security definer set search_path = public as $$
declare v_note text;
begin
  if not public.is_admin() then return 'forbidden'; end if;
  select money_error into v_note from public.contracts where id = p_order for update;
  if not found then return 'not_found'; end if;
  if v_note is null then return 'ok'; end if;                                   -- already gone
  if v_note is distinct from p_note then return 'changed'; end if;              -- a newer note came in: the admin reads it first
  if v_note like 'chargeback:%' or v_note like 'chargeback won%'
     or v_note like 'ledger line of the first payment not saved: %' or v_note like 'ledger line of a milestone payout not saved: %'
     or v_note like 'ledger line of the re-payment not saved: %' then
    return 'automatic';
  end if;
  update public.contracts set money_error = null where id = p_order;
  return 'ok';
end $$;
revoke execute on function public.admin_clear_order_note(uuid, text) from public, anon;
grant execute on function public.admin_clear_order_note(uuid, text) to authenticated;

-- Shows whether this ran: one row that says "v55 applied".
select case when exists (select 1 from pg_proc where proname = 'admin_clear_order_note' and pronamespace = 'public'::regnamespace)
            then 'v55 applied: the admin can mark an Order''s note as handled (Admin panel → Orders → Mark as handled).'
            else 'v55 NOT applied' end as result;
