-- Cuvori v31 — launch day can't mix test money with real money, tries are limited per day too, and "Stripe check" notes
-- on Orders clean up after themselves.
--
--   * select public.stripe_set_mode('live');  is now how the database is switched between test and live (SETUP.md,
--     Part 5 step 9). It refuses while any Order still holds money. Money paid in with test cards can only be paid out or
--     refunded in test mode; in live mode Cuvori would otherwise pay such an Order out of the real Stripe balance, which
--     is other clients' money. Card-fee refunds still waiting from test mode are closed when going live (they can never
--     be made with live keys); going back to test waits until the real ones are done. Only you can run it (SQL Editor).
--   * public.rate_limit_tries(): the payment functions count each person's tries per minute and per day, so one person
--     can't use up Stripe's monthly allowance of checks either (v30 counted per minute only).
--   * Order notes get the time they were written (money_error_at). A "Stripe check" note on an Order that is cancelled or
--     declined goes away at once, and on an unpaid Order after a day (the hourly job): nothing needs doing on those, no
--     money was taken.
-- Nothing else changes. Safe to run more than once.

create or replace function public.stripe_set_mode(p_mode text)
returns text language plpgsql security definer set search_path = public as $$
declare cur text := public.stripe_mode(); held int; fees int;
begin
  if p_mode is null or p_mode not in ('test', 'live') then return 'not switched: the mode must be ''test'' or ''live'''; end if;
  if p_mode = cur then return 'already ' || cur || ' mode: nothing changed'; end if;
  select count(*) into held from public.contracts
   where payment_mode = 'escrow' and status in ('funded','delivered','disputed','releasing','resolving');
  if held > 0 then
    return 'not switched: ' || held || ' Order(s) still hold money paid in ' || cur || ' mode. Finish or refund them first: '
        || 'that money can only be paid out or refunded in ' || cur || ' mode.';
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

-- each person's tries of one payment button: at most p_per_minute in a minute and p_per_day in a day
create or replace function public.rate_limit_tries(p_user uuid, p_kind text, p_per_minute int, p_per_day int)
returns text language plpgsql security definer set search_path = public as $$
declare m int; d int;
begin
  if p_user is null or p_kind is null or p_kind !~ '^[a-z_]{1,40}$' or p_per_minute is null or p_per_minute < 1 or p_per_minute > 1000
     or p_per_day is null or p_per_day < p_per_minute or p_per_day > 100000 then
    raise exception 'bad_input';
  end if;
  -- one count at a time for each person and button, so two tries at the same moment cannot both slip past the limit
  perform pg_advisory_xact_lock(hashtextextended('rate:' || p_user::text || ':' || p_kind, 0));
  delete from public.rate_events where user_id = p_user and kind = p_kind and at < now() - interval '1 day';
  select count(*) filter (where at >= now() - interval '1 minute'), count(*) into m, d
    from public.rate_events where user_id = p_user and kind = p_kind;
  if m >= p_per_minute then return 'minute'; end if;
  if d >= p_per_day then return 'day'; end if;
  insert into public.rate_events (user_id, kind) values (p_user, p_kind);
  return 'ok';
end $$;
revoke execute on function public.rate_limit_tries(uuid, text, int, int) from public, anon, authenticated;
grant execute on function public.rate_limit_tries(uuid, text, int, int) to service_role;

-- Order notes: when they were written, and "Stripe check" notes go away when an unpaid Order is cancelled or declined
alter table public.contracts add column if not exists money_error_at timestamptz;
create or replace function public.contracts_money_note()
returns trigger language plpgsql set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    new.money_error_at := case when new.money_error is null then null else now() end;
    return new;
  end if;
  if new.status in ('cancelled', 'declined') and new.status is distinct from old.status
     and (new.money_error like 'Stripe check failed:%' or new.money_error like 'Stripe account check:%') then
    new.money_error := null;
  end if;
  if new.money_error is distinct from old.money_error then
    new.money_error_at := case when new.money_error is null then null else now() end;
  end if;
  return new;
end $$;
drop trigger if exists contracts_money_note on public.contracts;
create trigger contracts_money_note before insert or update on public.contracts for each row execute procedure public.contracts_money_note();

-- Shows whether this ran: one row that says "v31 applied".
select case when exists (select 1 from pg_proc where proname = 'stripe_set_mode' and pronamespace = 'public'::regnamespace)
             and not has_function_privilege('authenticated', 'public.stripe_set_mode(text)', 'execute')
             and not has_function_privilege('anon', 'public.stripe_set_mode(text)', 'execute')
             and exists (select 1 from pg_proc where proname = 'rate_limit_tries' and pronamespace = 'public'::regnamespace)
             and not has_function_privilege('authenticated', 'public.rate_limit_tries(uuid,text,int,int)', 'execute')
             and has_function_privilege('service_role', 'public.rate_limit_tries(uuid,text,int,int)', 'execute')
             and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'contracts' and column_name = 'money_error_at')
             and exists (select 1 from pg_trigger where tgname = 'contracts_money_note' and not tgisinternal)
            then 'v31 applied: going live is guarded, tries are limited per day too, and Stripe check notes clean up after themselves'
            else 'v31 NOT applied' end as result;
