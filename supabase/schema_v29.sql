-- Cuvori v29 — Cuvori remembers which Stripe account its keys belong to.
--
-- The payment functions now remember, the first time they run in each mode, which Stripe account the keys in Netlify
-- belong to (site_settings stripe_platform_test / stripe_platform_live). Keys of a different Stripe account — for
-- example after opening a new company Stripe account — pause every payment with a clear message: money paid in through
-- one Stripe account can only be paid out from it, and every freelancer's saved account would look gone.
--
--   * The stripe_* settings (stripe_mode and the two remembered accounts) are no longer admin-panel settings: they are
--     changed only here in Supabase.
--   * select public.stripe_platform_switch();  — the deliberate move to another Stripe account (SETUP.md, "Moving to
--     another Stripe account"). It refuses while any Order still holds money paid in through the current account. It
--     sets every freelancer's saved Stripe accounts aside in their history (never deleted) so each of them sets up
--     payouts again, and forgets the remembered accounts so the new keys are remembered on their first use.
--     Only you can run it (in the SQL Editor); members and the admin panel cannot.
-- Nothing else changes. Safe to run more than once.

create or replace function public.admin_set_setting(p_key text, p_value jsonb)
returns text language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then return 'forbidden'; end if;
  if p_key !~ '^[a-z_]{1,40}$' or p_value is null or pg_column_size(p_value) > 5000 then return 'bad_input'; end if;
  if p_key like 'stripe\_%' then return 'forbidden'; end if;     -- the Stripe mode and the remembered Stripe accounts: only in Supabase
  insert into public.site_settings (key, value, updated_by) values (p_key, p_value, auth.uid())
  on conflict (key) do update set value = excluded.value, updated_at = now(), updated_by = auth.uid();
  return 'ok';
end $$;
grant execute on function public.admin_set_setting(text, jsonb) to authenticated;

create or replace function public.stripe_platform_switch()
returns text language plpgsql security definer set search_path = public as $$
declare held int; moved int := 0; r public.payout_details%rowtype; h jsonb; why text := 'Cuvori moved to another Stripe account';
begin
  select count(*) into held from public.contracts
   where payment_mode = 'escrow' and status in ('funded','delivered','disputed','releasing','resolving');
  if held > 0 then
    return 'not switched: ' || held || ' Order(s) still hold money paid in through the current Stripe account. Finish or refund them first.';
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

-- Shows whether this ran: one row that says "v29 applied".
select case when pg_get_functiondef('public.admin_set_setting(text,jsonb)'::regprocedure) like '%remembered Stripe accounts: only in Supabase%'
             and exists (select 1 from pg_proc where proname = 'stripe_platform_switch' and pronamespace = 'public'::regnamespace)
             and not has_function_privilege('authenticated', 'public.stripe_platform_switch()', 'execute')
            then 'v29 applied: Cuvori remembers which Stripe account its keys belong to'
            else 'v29 NOT applied' end as result;
