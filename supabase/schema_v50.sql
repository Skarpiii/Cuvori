-- Cuvori schema v50 — the client pays Stripe's payout fees too, shown as their own line.
-- Run after schema_v49.sql, in the Supabase SQL editor.
--
-- Freelancers are paid through Stripe Express accounts, with separate charges and transfers. For that set-up Stripe
-- charges the platform (Cuvori) for paying out: EUR 2 for each freelancer account that gets a payout in a month, plus
-- 0.25% + EUR 0.10 for each payout to the freelancer's bank (Stripe's Connect pricing; confirmed with Stripe support,
-- 2026-10-20). Nothing passed that on, so once live Cuvori would have paid it on every Order. Cuvori covers no fees and
-- takes no commission, so the client pays it, as the client pays the card fee.
-- Now the quote (order_quote) has a third line, "connect_cents": 0.25% of the price plus a fixed part, from one new row
-- of the fee table (method "connect"; the admin can change it under Payment costs, never a number in code). A top-up
-- (an agreed price increase paid later into the same Order) pays only the 0.25%: the fixed part was paid with the first
-- payment. The card fee is then worked out on the price plus this line, since the card's percentage applies to everything
-- charged, so Cuvori is still never short. The total is price + card fee + payout fee. The Order and its payment line
-- keep the payout fee in their own field (connect_cents), never mixed into the card fee, so the card-fee refund (the
-- surplus above what the card really cost) stays exactly as it is and never touches it.
-- Stripe bills these fees to Cuvori monthly and in one sum, not per Order, so there is no exact per-Order cost to settle
-- against: this fee is not refunded afterwards (the owner's decision, 2026-10-22), and like the card fee it is not
-- given back when an Order is cancelled; the price is. A payment that arrives after its Order could no longer take it
-- is still refunded in full, this fee included (refundOrphan in the payment functions).

-- 1. The fee row. The same unique key as the other rows (provider, region, country, customer kind, method, currency).
insert into public.fee_schedules (provider, region, country, customer_kind, method, percent, fixed_cents, currency, payer, note)
values ('stripe', 'ANY', null, 'any', 'connect', 0.25, 210, 'EUR', 'client',
        'Stripe Connect, per Order: EUR 2 a month per freelancer account paid out + 0.25% + EUR 0.10 per payout. A top-up pays the 0.25% only. Passed on to the client at cost; not refunded.')
on conflict do nothing;

-- 2. Where the Order and its payment line keep it.
alter table public.contracts add column if not exists connect_cents integer;
alter table public.order_payments add column if not exists connect_cents integer;

-- 3. The quote. The old function is replaced (a second version next to it would make the page's calls ambiguous).
drop function if exists public.order_quote(integer, text, text, text, text);

create or replace function public.order_quote(p_price_cents integer, p_currency text default 'EUR', p_country text default null,
                                              p_customer text default 'any', p_method text default 'any', p_topup boolean default false)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare s public.fee_schedules%rowtype; k public.fee_schedules%rowtype; reg text; total int; base int; connect int := 0;
        cur text := upper(coalesce(p_currency, 'EUR'));
begin
  if p_price_cents is null or p_price_cents < 0 or p_price_cents > 100000000 then raise exception 'bad_price'; end if;
  reg := case when p_country is null or p_country = '' then 'ANY' when public.is_eea(p_country) then 'EEA' else 'INTL' end;
  -- the payout fee (v50): the "connect" row; a top-up pays its percentage only
  select * into k from public.fee_schedules f
   where f.active and f.provider = 'stripe' and f.method = 'connect' and f.currency = cur and f.payer = 'client'
   order by f.id limit 1;
  if found and p_price_cents > 0 then
    connect := ceil(p_price_cents * k.percent / 100)::int + case when coalesce(p_topup, false) then 0 else k.fixed_cents end;
  end if;
  base := p_price_cents + connect;
  -- the card fee: the most specific row for this card; never the payout-fee row
  select * into s from public.fee_schedules f
   where f.active and f.provider = 'stripe' and f.currency = cur and f.method <> 'connect'
     and (f.country = upper(p_country) or (f.country is null and f.region in (reg, 'ANY')))
     and f.customer_kind in (coalesce(p_customer, 'any'), 'any')
     and f.method in (coalesce(p_method, 'any'), 'any')
   order by (f.country is not null) desc, (f.region = reg) desc, (f.customer_kind <> 'any') desc, (f.method <> 'any') desc, f.id
   limit 1;
  if not found then
    return jsonb_build_object('price_cents', p_price_cents, 'processing_cents', 0, 'connect_cents', connect, 'cuvori_cents', 0, 'total_cents', base,
                              'currency', cur, 'payer', 'platform', 'percent', 0, 'fixed_cents', 0, 'schedule_id', null, 'region', reg,
                              'connect_schedule_id', k.id, 'connect_percent', k.percent, 'connect_fixed_cents', k.fixed_cents, 'topup', coalesce(p_topup, false));
  end if;
  -- the card's percentage is taken on everything charged (price, payout fee and the card fee itself), so the card fee is
  -- worked out on price + payout fee
  if s.payer = 'platform' or base = 0 then total := base;
  else total := ceil((base + s.fixed_cents)::numeric / (1 - s.percent / 100))::int; end if;
  return jsonb_build_object('price_cents', p_price_cents, 'processing_cents', total - base, 'connect_cents', connect, 'cuvori_cents', 0, 'total_cents', total,
                            'currency', cur, 'payer', s.payer, 'percent', s.percent, 'fixed_cents', s.fixed_cents, 'schedule_id', s.id, 'region', reg, 'provider', s.provider,
                            'connect_schedule_id', k.id, 'connect_percent', k.percent, 'connect_fixed_cents', k.fixed_cents, 'topup', coalesce(p_topup, false));
end $$;
grant execute on function public.order_quote(integer, text, text, text, text, boolean) to anon, authenticated, service_role;

-- Shows whether this ran: one row that says "v50 applied", with today's quote for a EUR 100 Order (the payout fee reads 0.00 if the
-- admin has switched the connect row off under Payment costs).
select case when exists (select 1 from public.fee_schedules where provider = 'stripe' and method = 'connect')
             and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'contracts' and column_name = 'connect_cents')
             and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'order_payments' and column_name = 'connect_cents')
             and exists (select 1 from pg_proc where proname = 'order_quote' and pronamespace = 'public'::regnamespace
                           and pg_get_function_identity_arguments(oid) like '%p_topup boolean')
             and (public.order_quote(10000, 'EUR', null, 'any', 'card') ? 'connect_cents')
            then 'v50 applied: the client pays Stripe''s payout fees as their own line. A EUR 100 Order today: card fee '
                 || round((public.order_quote(10000, 'EUR', null, 'any', 'card')->>'processing_cents')::numeric / 100, 2) || ', payout fee '
                 || round((public.order_quote(10000, 'EUR', null, 'any', 'card')->>'connect_cents')::numeric / 100, 2) || ', total '
                 || round((public.order_quote(10000, 'EUR', null, 'any', 'card')->>'total_cents')::numeric / 100, 2) || '.'
            else 'v50 NOT applied' end as result;
