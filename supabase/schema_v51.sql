-- Cuvori schema v51 — switching Stripe mode or Stripe account waits for a payment being taken right now.
-- Run after schema_v50.sql, in the Supabase SQL editor.
--
-- stripe_set_mode (test <-> live) and stripe_platform_switch (moving Cuvori to another Stripe account) refuse while an
-- Order still has money on the way (orders_with_money_on_the_way): that money can only move with the keys it came in
-- with. They counted Orders by status only, and the moment a card is charged lies before the status changes: the payment
-- functions hold a fresh "lock:<order id>" row in money_keys while they charge the card and then record the payment
-- (lockOrder; the row goes stale after 90 seconds). A switch in that moment went through; the record was then refused
-- (contracts_paid_mode: stripe_mode_changed) and the money went back to the card minus Stripe's card fee — on real money
-- the client lost the card fee — or, for the account switch, the Order was recorded as funded while its money sat on the
-- old Stripe account, out of reach of the new keys. Also, stripe_platform_switch did not wait for the card-fee refunds
-- still owed to clients, which stripe_set_mode does: after the move those refunds fail every hour and never arrive
-- (about EUR 1.80 per EUR 100 paid).
-- Now both switches count a payment being taken right now as money on the way (the same lock row has_money_held already
-- looks at before an account is deleted), and the account switch handles waiting card-fee refunds exactly like the mode
-- switch: refused in live mode ("the hourly run sends them; try again later"), closed as "nothing refunded" in test mode
-- (test money). Nothing else changes. Safe to run more than once.

-- 1. Money that has not finished moving: held on an Order, a chargeback the bank is deciding, a re-payment still owed,
--    or (v51) a card being charged right now.
create or replace function public.orders_with_money_on_the_way()
returns int language sql stable security definer set search_path = public as $$
  select count(*)::int from public.contracts c
   where c.payment_mode = 'escrow'
     and (c.status in ('funded','delivered','disputed','releasing','resolving')
          or c.chargeback_status = 'open'
          or c.money_error like 'chargeback won%'
          or exists (select 1 from public.money_keys k
                      where k.scope = 'lock:' || c.id::text and k.created_at > now() - interval '90 seconds'));
$$;
revoke execute on function public.orders_with_money_on_the_way() from public, anon, authenticated;
grant execute on function public.orders_with_money_on_the_way() to service_role;

-- 2. The move to another Stripe account: as before, plus the waiting card-fee refunds, handled like stripe_set_mode.
create or replace function public.stripe_platform_switch()
returns text language plpgsql security definer set search_path = public as $$
declare held int; fees int; cur text; moved int := 0; r public.payout_details%rowtype; h jsonb; why text := 'Cuvori moved to another Stripe account';
begin
  -- hold the Orders still while deciding: a payment being recorded right now is either counted here, or refused after
  lock table public.contracts in share row exclusive mode;
  cur := public.stripe_mode();
  held := public.orders_with_money_on_the_way();
  if held > 0 then
    return 'not switched: ' || held || ' Order(s) still have money on the way through the current Stripe account (held, being '
        || 'paid right now, a chargeback the bank is deciding, or a re-payment still owed). Finish or refund them first.';
  end if;
  -- card-fee refunds still owed to clients can only be made through the account their payment came in on
  select count(*) into fees from public.order_payments
   where kind = 'fund' and status = 'succeeded' and provider = 'stripe' and fee_refund_cents is null;
  if fees > 0 and cur = 'live' then
    return 'not switched: ' || fees || ' card-fee refund(s) to clients are still waiting. The hourly run sends them; try again later.';
  end if;
  -- in test mode they are closed as "nothing refunded" (it was test money), so the hourly run does not keep trying them
  if fees > 0 then
    update public.order_payments set fee_refund_cents = 0
     where kind = 'fund' and status = 'succeeded' and provider = 'stripe' and fee_refund_cents is null;
  end if;
  for r in select * from public.payout_details where stripe_account_id is not null or stripe_live_account_id is not null for update loop
    h := coalesce(r.stripe_account_history, '[]'::jsonb);
    if r.stripe_account_id is not null then
      h := h || jsonb_build_array(jsonb_build_object('id', r.stripe_account_id, 'mode', 'test', 'why', why, 'at', now()));
    end if;
    if r.stripe_live_account_id is not null then
      h := h || jsonb_build_array(jsonb_build_object('id', r.stripe_live_account_id, 'mode', 'live', 'why', why, 'at', now()));
    end if;
    if jsonb_array_length(h) > 50 then
      h := (select jsonb_agg(x order by i) from jsonb_array_elements(h) with ordinality t(x, i) where i > jsonb_array_length(h) - 50);
    end if;
    update public.payout_details
       set stripe_account_history = h, stripe_account_id = null, stripe_payouts_enabled = false,
           stripe_live_account_id = null, stripe_live_payouts_enabled = false
     where id = r.id;
    moved := moved + 1;
  end loop;
  delete from public.site_settings where key in ('stripe_platform_test', 'stripe_platform_live');
  return 'switched: ' || moved || ' freelancer(s) will set up payouts again; the new Stripe account is remembered when the payment functions next run'
      || case when fees > 0 then ' (' || fees || ' card-fee refund(s) from test mode closed)' else '' end;
end $$;
revoke execute on function public.stripe_platform_switch() from public, anon, authenticated;
grant execute on function public.stripe_platform_switch() to service_role;

-- 3. The test <-> live switch: unchanged except its refusal now also names a payment being taken right now.
create or replace function public.stripe_set_mode(p_mode text)
returns text language plpgsql security definer set search_path = public as $$
declare raw text; cur text; held int; fees int;
begin
  if p_mode is null or p_mode not in ('test', 'live') then return 'not switched: the mode must be ''test'' or ''live'''; end if;
  -- hold the Orders still while deciding: a payment being recorded right now is either counted here, or refused after
  lock table public.contracts in share row exclusive mode;
  raw := (select value #>> '{}' from public.site_settings where key = 'stripe_mode');
  cur := public.stripe_mode();
  if raw = p_mode then return 'already ' || p_mode || ' mode: nothing changed'; end if;
  held := public.orders_with_money_on_the_way();
  if held > 0 then
    return 'not switched: ' || held || ' Order(s) still have money on the way from ' || cur || ' mode (held, being paid right now, a chargeback '
        || 'the bank is deciding, or a re-payment still owed). Finish or refund them first: that money can only move in ' || cur || ' mode.';
  end if;
  select count(*) into fees from public.order_payments
   where kind = 'fund' and status = 'succeeded' and provider = 'stripe' and fee_refund_cents is null;
  if fees > 0 and cur = 'live' then
    return 'not switched: ' || fees || ' card-fee refund(s) to clients are still waiting. The hourly run sends them; try again later.';
  end if;
  -- going live: card-fee refunds still waiting from test mode can never be made with live keys. They are closed as
  -- "nothing refunded" (it was test money), so the hourly run does not keep trying them.
  if fees > 0 then
    update public.order_payments set fee_refund_cents = 0
     where kind = 'fund' and status = 'succeeded' and provider = 'stripe' and fee_refund_cents is null;
  end if;
  insert into public.site_settings (key, value) values ('stripe_mode', to_jsonb(p_mode))
  on conflict (key) do update set value = excluded.value, updated_at = now();
  return 'switched to ' || p_mode || ' mode' || case when fees > 0 then ' (' || fees || ' card-fee refund(s) from test mode closed)' else '' end;
end $$;
revoke execute on function public.stripe_set_mode(text) from public, anon, authenticated;
grant execute on function public.stripe_set_mode(text) to service_role;

-- Shows whether this ran: one row that says "v51 applied".
select case when pg_get_functiondef('public.orders_with_money_on_the_way()'::regprocedure) like '%money_keys%'
             and pg_get_functiondef('public.stripe_platform_switch()'::regprocedure) like '%fee_refund_cents%'
             and pg_get_functiondef('public.stripe_set_mode(text)'::regprocedure) like '%being paid right now%'
             and not has_function_privilege('authenticated', 'public.stripe_platform_switch()', 'execute')
             and not has_function_privilege('authenticated', 'public.stripe_set_mode(text)', 'execute')
             and not has_function_privilege('anon', 'public.orders_with_money_on_the_way()', 'execute')
            then 'v51 applied: switching Stripe mode or Stripe account waits for a payment being taken right now, and the account switch handles waiting card-fee refunds like the mode switch.'
            else 'v51 NOT applied' end as result;
