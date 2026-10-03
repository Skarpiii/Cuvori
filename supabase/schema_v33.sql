-- Cuvori schema v33 — the fee quote only ever uses Stripe's rows.
-- Run after schema_v32.sql, in the Supabase SQL editor.
--
-- The fee table keeps a provider on every row (schema v18), but the quote picked the best-matching active row without
-- looking at it. The admin panel only ever makes Stripe rows, so this changes nothing today; it makes sure a row for
-- another provider — added by hand, by mistake, or on the day Cuvori adds one — can never be charged while payments go
-- through Stripe. Everything else about the quote stays exactly as it was (v18): the most specific row wins, no row at all
-- means "Cuvori would pay", which the payment functions refuse.

create or replace function public.order_quote(p_price_cents int, p_currency text default 'EUR', p_country text default null,
                                              p_customer text default 'any', p_method text default 'any')
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare s public.fee_schedules%rowtype; reg text; total int; cur text := upper(coalesce(p_currency, 'EUR'));
begin
  if p_price_cents is null or p_price_cents < 0 or p_price_cents > 100000000 then raise exception 'bad_price'; end if;
  reg := case when p_country is null or p_country = '' then 'ANY' when public.is_eea(p_country) then 'EEA' else 'INTL' end;
  select * into s from public.fee_schedules f
   where f.active and f.provider = 'stripe' and f.currency = cur
     and (f.country = upper(p_country) or (f.country is null and f.region in (reg, 'ANY')))
     and f.customer_kind in (coalesce(p_customer, 'any'), 'any')
     and f.method in (coalesce(p_method, 'any'), 'any')
   order by (f.country is not null) desc, (f.region = reg) desc, (f.customer_kind <> 'any') desc, (f.method <> 'any') desc, f.id
   limit 1;
  if not found then
    return jsonb_build_object('price_cents', p_price_cents, 'processing_cents', 0, 'cuvori_cents', 0, 'total_cents', p_price_cents,
                              'currency', cur, 'payer', 'platform', 'percent', 0, 'fixed_cents', 0, 'schedule_id', null, 'region', reg);
  end if;
  if s.payer = 'platform' or p_price_cents = 0 then total := p_price_cents;
  else total := ceil((p_price_cents + s.fixed_cents)::numeric / (1 - s.percent / 100))::int; end if;
  return jsonb_build_object('price_cents', p_price_cents, 'processing_cents', total - p_price_cents, 'cuvori_cents', 0, 'total_cents', total,
                            'currency', cur, 'payer', s.payer, 'percent', s.percent, 'fixed_cents', s.fixed_cents, 'schedule_id', s.id, 'region', reg, 'provider', s.provider);
end $$;
grant execute on function public.order_quote(int, text, text, text, text) to anon, authenticated, service_role;

-- Shows whether this ran: one row that says "v33 applied".
select case when pg_get_functiondef('public.order_quote(int, text, text, text, text)'::regprocedure) like '%f.provider = ''stripe''%'
            then 'v33 applied: the fee quote only ever uses Stripe''s rows'
            else 'v33 NOT applied' end as result;
