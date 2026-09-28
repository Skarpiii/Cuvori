-- Cuvori v26 — the admin sees every Order where the card cost came out higher than what the client paid for it.
--
-- Cuvori never pays the card cost: the client pays the payment provider's highest card rate and the surplus is
-- refunded to the card. If the provider ever takes more than was collected (the "unknown country" row in Payment
-- costs set too low, or the provider raising its prices), the difference comes out of Cuvori's balance. The payment
-- ledger already records both numbers for every payment: fee_cents (what the client paid for processing) and
-- provider_fee_cents (what the provider actually took). admin_list_contracts() now also returns, per Order,
-- fee_short_cents = the total of those differences, and lists such Orders right after the ones that need a hand.
-- Nothing is written anywhere, so no other money step can erase it. Nothing else changes. Safe to run more than once.

drop function if exists public.admin_list_contracts();
create or replace function public.admin_list_contracts()
returns table (id uuid, title text, price numeric, currency text, pricing text, status text, payment_mode text, created_at timestamptz,
               delivered_at timestamptz, disputed_at timestamptz, dispute_by uuid, dispute_reason text, delivery_note text, delivery_url text,
               auto_release_at timestamptz, resolution text, conversation_id uuid,
               editor uuid, editor_name text, editor_email text, client uuid, client_name text, client_email text,
               profession_slug text, amount_cents int, funded_cents int, released_cents int, refunded_cents int, has_milestones boolean, amendments int,
               money_error text, chargeback_status text, chargeback_cents int, chargeback_id text, stripe_payment_intent text, stripe_transfer_id text, stripe_refund_id text,
               fee_short_cents int)
language sql stable security definer set search_path = public as $$
  select c.id, c.title, c.price, c.currency, c.pricing, c.status, c.payment_mode, c.created_at,
         c.delivered_at, c.disputed_at, c.dispute_by, c.dispute_reason, c.delivery_note, c.delivery_url, c.auto_release_at, c.resolution, c.conversation_id,
         c.editor, coalesce(e.display_name, pe.first_name), pe.email, c.client, pc.first_name, pc.email,
         c.profession_slug, c.amount_cents, c.funded_cents, c.released_cents, c.refunded_cents, c.has_milestones, c.amendments,
         c.money_error, c.chargeback_status, c.chargeback_cents, c.chargeback_id, c.stripe_payment_intent, c.stripe_transfer_id, c.stripe_refund_id,
         fs.short_cents
  from public.contracts c
  left join public.editor_profiles e on e.id = c.editor
  left join public.profiles pe on pe.id = c.editor
  left join public.profiles pc on pc.id = c.client
  left join lateral (
    select coalesce(sum(greatest(p.provider_fee_cents - p.fee_cents, 0)), 0)::int as short_cents
    from public.order_payments p
    where p.order_id = c.id and p.kind = 'fund' and p.status = 'succeeded' and p.provider_fee_cents is not null
  ) fs on true
  where public.is_admin()
  order by (c.chargeback_status = 'open' or c.money_error is not null) desc nulls last, (c.status = 'disputed') desc, (fs.short_cents > 0) desc, c.created_at desc;
$$;
grant execute on function public.admin_list_contracts() to authenticated;
