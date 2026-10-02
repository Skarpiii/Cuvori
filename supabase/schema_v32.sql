-- Cuvori v32 — test money and real money can never meet, also in the last few seconds of a switch.
--
--   * Every Order remembers which mode its money was paid in (paid_mode: test or live). The database refuses to record
--     a payment on an Order when the database is in the other mode by then (the payment functions then give the
--     payment back to the card), and refuses to mix modes on one Order. The payment functions never pay out, refund or
--     pull back an Order's money with the other mode's keys. Everything paid so far was paid in test mode.
--   * Going live (stripe_set_mode) and moving to another Stripe account (stripe_platform_switch) also wait while a
--     chargeback is open or a freelancer is still owed a re-payment after a won chargeback — that money is still on the
--     way, even on a finished Order. Both now hold the Orders table still while they decide, so a payment being
--     recorded at that very moment is either counted or refused, never slipped in.
--   * stripe_set_mode compares the exact stored setting, so a stray value is put right instead of "already test".
--   * "Stripe check" notes on Orders cancelled or declined before v31 are cleared once.
-- Nothing else changes. Safe to run more than once.

-- money that has not finished moving: held on an Order, a chargeback the bank is deciding, or a re-payment still owed
create or replace function public.orders_with_money_on_the_way()
returns int language sql stable security definer set search_path = public as $$
  select count(*)::int from public.contracts
   where payment_mode = 'escrow'
     and (status in ('funded','delivered','disputed','releasing','resolving')
          or chargeback_status = 'open'
          or money_error like 'chargeback won%');
$$;
revoke execute on function public.orders_with_money_on_the_way() from public, anon, authenticated;

-- which mode an Order's money was paid in
alter table public.contracts add column if not exists paid_mode text;
alter table public.contracts drop constraint if exists contracts_paid_mode_check;
alter table public.contracts add constraint contracts_paid_mode_check check (paid_mode is null or paid_mode in ('test', 'live'));
update public.contracts set paid_mode = public.stripe_mode()
 where paid_mode is null and payment_mode = 'escrow' and coalesce(funded_cents, 0) > 0;

create or replace function public.contracts_paid_mode()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.paid_mode is null then return new; end if;
  if tg_op = 'UPDATE' then
    if old.paid_mode is not null and new.paid_mode <> old.paid_mode then
      raise exception 'stripe_mode_mixed' using hint = 'this Order was paid in ' || old.paid_mode || ' mode';
    end if;
    if new.paid_mode is not distinct from old.paid_mode and coalesce(new.funded_cents, 0) <= coalesce(old.funded_cents, 0) then
      return new;                                     -- no money coming in: nothing to check
    end if;
  end if;
  if new.paid_mode <> public.stripe_mode() then
    raise exception 'stripe_mode_changed' using hint = 'the database is in ' || public.stripe_mode() || ' mode now';
  end if;
  return new;
end $$;
drop trigger if exists contracts_paid_mode on public.contracts;
create trigger contracts_paid_mode before insert or update on public.contracts for each row execute procedure public.contracts_paid_mode();

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
    return 'not switched: ' || held || ' Order(s) still have money on the way from ' || cur || ' mode (held, a chargeback the bank '
        || 'is deciding, or a re-payment still owed). Finish or refund them first: that money can only move in ' || cur || ' mode.';
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

-- moving to another Stripe account: the same wait for money still on the way (v29 looked at held Orders only)
create or replace function public.stripe_platform_switch()
returns text language plpgsql security definer set search_path = public as $$
declare held int; moved int := 0; r public.payout_details%rowtype; h jsonb; why text := 'Cuvori moved to another Stripe account';
begin
  lock table public.contracts in share row exclusive mode;
  held := public.orders_with_money_on_the_way();
  if held > 0 then
    return 'not switched: ' || held || ' Order(s) still have money on the way through the current Stripe account (held, a '
        || 'chargeback the bank is deciding, or a re-payment still owed). Finish or refund them first.';
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
  return 'switched: ' || moved || ' freelancer(s) will set up payouts again; the new Stripe account is remembered when the payment functions next run';
end $$;
revoke execute on function public.stripe_platform_switch() from public, anon, authenticated;

-- "Stripe check" notes left on Orders cancelled or declined before v31: nothing needs doing on those
update public.contracts set money_error = null
 where status in ('cancelled', 'declined') and (money_error like 'Stripe check failed:%' or money_error like 'Stripe account check:%');

-- Shows whether this ran: one row that says "v32 applied".
select case when exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'contracts' and column_name = 'paid_mode')
             and exists (select 1 from pg_trigger where tgname = 'contracts_paid_mode' and not tgisinternal)
             and pg_get_functiondef('public.stripe_set_mode(text)'::regprocedure) like '%orders_with_money_on_the_way%'
             and pg_get_functiondef('public.stripe_platform_switch()'::regprocedure) like '%orders_with_money_on_the_way%'
             and not has_function_privilege('authenticated', 'public.stripe_set_mode(text)', 'execute')
             and not has_function_privilege('authenticated', 'public.stripe_platform_switch()', 'execute')
            then 'v32 applied: test money and real money can never meet'
            else 'v32 NOT applied' end as result;
