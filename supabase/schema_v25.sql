-- Cuvori v25 — the processing fee: highest card rate charged up front, the surplus refunded automatically.
--
-- Cuvori keeps none of the card processing cost, and it no longer relies on a country the client declares.
-- Every client sees the same fee — the provider's highest card rate — on the payment page. After the payment,
-- the money code reads the fee the provider actually took and refunds the difference to the card (settleFee in
-- netlify/lib/cuvori.mjs). The ledger row of the payment remembers the outcome so it happens once; the hourly
-- job retries payments whose fee is not settled yet.
--
-- 1. Two columns on the ledger: what was refunded of the fee, and the provider's refund id.
-- 2. The fee table's "unknown country" row becomes the ceiling: 3.25% + €0.25 (Stripe's rate for non-European
--    cards). The page and the checkout both quote without a country, so this is the row they use.
-- Safe to run more than once.

alter table public.order_payments add column if not exists fee_refund_cents int;
alter table public.order_payments add column if not exists fee_refund_ref   text;
comment on column public.order_payments.fee_refund_cents is 'processing fee refunded to the client after the provider''s real fee was known (null = not settled yet, 0 = nothing to refund)';

create index if not exists order_payments_fee_unsettled_idx on public.order_payments (created_at)
  where kind = 'fund' and status = 'succeeded' and fee_refund_cents is null;

update public.fee_schedules
   set percent = 3.25, fixed_cents = 25,
       note = 'Ceiling: the highest card rate, charged to every client up front. The surplus over Stripe''s real fee is refunded to the card automatically after payment.'
 where region = 'ANY' and country is null and customer_kind = 'any' and method = 'any' and currency = 'EUR' and provider = 'stripe';
