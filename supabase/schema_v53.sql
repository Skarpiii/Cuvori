-- Cuvori schema v53 — the card-fee row can no longer be set below what cards really cost.
-- Run after schema_v52.sql, in the Supabase SQL editor.
--
-- The client pays the card fee from the fee table (Admin panel → Payment costs). The checkout quotes with no country, so the
-- ANY row (region ANY, no country, any customer, method any/card) is the ceiling every client pays up front; after the
-- payment, whatever was collected above Stripe's real card cost goes back to the client (settleFee). If the admin set that
-- row below Stripe's real rate (a typo, or Stripe raised its prices), the refund simply had nothing to give back and
-- Cuvori paid the difference on every payment; the admin page showed it only afterwards ("Card cost not covered", v26).
-- Now admin_set_fee_schedule refuses to save a client-paid Stripe card row that decides the checkout price when that row
-- would have collected less than Stripe really took on any payment settled in the last 12 months, and says which
-- payment and by how much. No rate is written in code: the floor is what cards actually cost on Cuvori's own payments.
-- Rows that never decide the card fee at checkout (a country or region row, a consumer/business row, the payout-fee row),
-- and rows set to payer = platform or switched off (those pause payments instead), are saved as before. (This comment was
-- corrected on 2026-10-24, after v53 was run; the SQL is unchanged.) Nothing else changes. Safe to run more than once.

create or replace function public.admin_set_fee_schedule(p jsonb)
returns text language plpgsql security definer set search_path = public as $$
declare v_id int := nullif(p->>'id', '')::int; r public.fee_schedules%rowtype; short record;
begin
  if not public.is_admin() then return 'forbidden'; end if;
  -- the row as it would be saved
  if v_id is null then
    r.provider := coalesce(p->>'provider', 'stripe'); r.region := coalesce(p->>'region', 'ANY'); r.country := nullif(upper(p->>'country'), '');
    r.customer_kind := coalesce(p->>'customer_kind', 'any'); r.method := coalesce(p->>'method', 'any');
    r.percent := coalesce((p->>'percent')::numeric, 0); r.fixed_cents := coalesce((p->>'fixed_cents')::int, 0);
    r.currency := upper(coalesce(p->>'currency', 'EUR')); r.payer := coalesce(p->>'payer', 'client'); r.active := coalesce((p->>'active')::boolean, true);
  else
    select * into r from public.fee_schedules where id = v_id;
    if not found then return 'not_found'; end if;
    r.percent := coalesce((p->>'percent')::numeric, r.percent); r.fixed_cents := coalesce((p->>'fixed_cents')::int, r.fixed_cents);
    r.payer := coalesce(p->>'payer', r.payer); r.active := coalesce((p->>'active')::boolean, r.active);
    r.customer_kind := coalesce(p->>'customer_kind', r.customer_kind); r.method := coalesce(p->>'method', r.method); r.region := coalesce(p->>'region', r.region);
    r.country := case when p ? 'country' then nullif(upper(p->>'country'), '') else r.country end;
  end if;
  -- v53: a client-paid Stripe card row that decides the checkout price may not collect less than cards really cost.
  -- Checked against every payment settled in the last 12 months: the card fee this row would have quoted on that payment
  -- (on price + payout fee, as order_quote does) must be at least what Stripe took.
  if r.active and r.payer = 'client' and r.provider = 'stripe' and r.currency = 'EUR' and r.region = 'ANY' and r.country is null
     and r.customer_kind = 'any' and r.method in ('any', 'card') and r.percent >= 0 and r.percent < 100 then
    select x.amount_cents, x.base, x.provider_fee_cents, x.created_at, x.would_collect into short
      from (select q.amount_cents, q.provider_fee_cents, q.created_at, q.amount_cents + coalesce(q.connect_cents, 0) as base,
                   ceil((q.amount_cents + coalesce(q.connect_cents, 0) + r.fixed_cents)::numeric / (1 - r.percent / 100))::int
                     - (q.amount_cents + coalesce(q.connect_cents, 0)) as would_collect
              from public.order_payments q
             where q.kind = 'fund' and q.status = 'succeeded' and q.provider = 'stripe' and q.provider_fee_cents is not null
               and q.amount_cents > 0 and q.created_at > now() - interval '12 months') x
     where x.would_collect < x.provider_fee_cents
     order by x.provider_fee_cents - x.would_collect desc, x.created_at desc
     limit 1;
    if found then
      return format('not saved: at %s%% + %s cents this row would have collected EUR %s for the card fee on a payment of EUR %s on %s, but Stripe took EUR %s. Cuvori covers no fees: keep the ANY row at or above what cards really cost (checked against the payments of the last 12 months).',
                    trim(trailing '.' from trim(trailing '0' from r.percent::text)), r.fixed_cents,
                    to_char(short.would_collect / 100.0, 'FM9999990.00'), to_char(short.base / 100.0, 'FM9999990.00'),
                    to_char(short.created_at, 'YYYY-MM-DD'), to_char(short.provider_fee_cents / 100.0, 'FM9999990.00'));
    end if;
  end if;
  if v_id is null then
    insert into public.fee_schedules (provider, region, country, customer_kind, method, percent, fixed_cents, currency, payer, active, note, updated_by)
    values (r.provider, r.region, r.country, r.customer_kind, r.method, r.percent, r.fixed_cents, r.currency, r.payer, r.active, left(coalesce(p->>'note', ''), 300), auth.uid());
  else
    update public.fee_schedules set percent = r.percent, fixed_cents = r.fixed_cents, payer = r.payer, active = r.active,
           note = left(coalesce(p->>'note', note), 300), customer_kind = r.customer_kind, method = r.method, region = r.region, country = r.country,
           updated_at = now(), updated_by = auth.uid()
     where id = v_id;
    if not found then return 'not_found'; end if;
  end if;
  return 'ok';
end $$;

-- Shows whether this ran: one row that says "v53 applied".
select case when pg_get_functiondef('public.admin_set_fee_schedule(jsonb)'::regprocedure) like '%provider_fee_cents%'
            then 'v53 applied: the card-fee row can no longer be set below what cards really cost on Cuvori''s own payments of the last 12 months.'
            else 'v53 NOT applied' end as result;
