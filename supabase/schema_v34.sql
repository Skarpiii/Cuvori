-- Cuvori schema v34 — a change by either person waits while a payment step is running on the Order.
-- Run after schema_v33.sql, in the Supabase SQL editor.
--
-- The payment functions take a lock on an Order while they move its money (a row 'lock:<order id>' in money_keys, see
-- lockOrder in netlify/lib/cuvori.mjs): from checking a card hold until the payment is recorded, and during payouts,
-- refunds and chargebacks. The database's own Order changes did not look at that lock. A price change accepted, or the
-- freelancer cancelling, at the very moment Stripe was charging the card meant the payment no longer fitted the Order:
-- it went back to the card minus Stripe's fee, so the client lost the fee and the Order stayed unpaid.
--
-- Now, on a protected-payment Order, a change of its price or its status made by a signed-in person (accepting an
-- amendment, cancelling, delivering, asking for changes, opening a dispute) takes that same lock for the moment it is
-- saved. While a payment step holds it, the change is refused with 'payment_in_progress' (the page says "a payment for this
-- Order is being taken right now, try again in a minute"). When the change comes first, the payment step waits for it
-- to be saved and then sees the Order as it is now — a price that changed means the hold is released and nothing is
-- charged. The payment functions themselves (they work without a signed-in person) are not held back by their own lock.
-- A lock older than 90 seconds belongs to a step that died; it is cleared, as the payment functions do too.

create or replace function public.contracts_wait_for_payment()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_scope text; v_mine text;
begin
  if auth.uid() is null then return new; end if;                                   -- the payment functions, or the owner in this editor
  if old.payment_mode is distinct from 'escrow' then return new; end if;            -- no money moves through Cuvori on a direct Order
  if new.amount_cents is not distinct from old.amount_cents and new.status is not distinct from old.status then return new; end if;
  v_scope := 'lock:' || old.id::text;
  v_mine := 'change:' || gen_random_uuid()::text;
  delete from public.money_keys where scope = v_scope and created_at < now() - interval '90 seconds';
  -- taken for the length of this change only: the row is never seen by anyone else (it goes again before the change is
  -- saved), but a payment step that tries to take the lock meanwhile waits until the change is saved
  insert into public.money_keys (scope, key) values (v_scope, v_mine) on conflict (scope) do nothing;
  if not found then raise exception 'payment_in_progress'; end if;
  delete from public.money_keys where scope = v_scope and key = v_mine;
  return new;
end $$;
revoke execute on function public.contracts_wait_for_payment() from public, anon, authenticated;

drop trigger if exists contracts_wait_for_payment on public.contracts;
create trigger contracts_wait_for_payment before update on public.contracts
  for each row execute procedure public.contracts_wait_for_payment();

-- Shows whether this ran: one row that says "v34 applied".
select case when exists (select 1 from pg_trigger where tgname = 'contracts_wait_for_payment' and tgrelid = 'public.contracts'::regclass and not tgisinternal)
            then 'v34 applied: a change by either person waits while a payment is being taken'
            else 'v34 NOT applied' end as result;
