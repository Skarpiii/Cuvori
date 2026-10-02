-- Cuvori v28 — a freelancer's Stripe account is kept separately for test and live.
--
-- Test and live are two separate worlds at Stripe: an account made with test keys does not exist for live keys. Until
-- now one saved account served both, so on launch day every freelancer who set up Stripe in test mode would have been
-- stuck ("Something went wrong" in Payout details), and the "ready" flag behind the Fund button and the "verified"
-- badge would still have shown what Stripe's test data said.
--
-- Now:
--   * the test account stays where it always was (stripe_account_id, stripe_payouts_enabled), and live gets its own
--     pair (stripe_live_account_id, stripe_live_payouts_enabled). Switching the keys never changes or removes the other
--     mode's account. Everything saved so far was made with test keys, so it is the test account.
--   * stripe_account_history keeps every saved account that was ever set aside (only when Stripe confirmed it is gone,
--     and only in test mode). Nothing is deleted. Only the payment functions write these columns.
--   * site_settings.stripe_mode says which mode the database belongs to: "test" until launch day (SETUP.md). The
--     payment functions refuse to move money when their keys are for the other mode, so test and live never mix.
--     It is changed only with SQL in Supabase, never from the admin panel.
--   * editor_can_receive() (the Fund button) and is_verified() (the badge) use the flag of the current mode.
-- Live account IDs are recorded for bad-actor matching like the test ones. Nothing else changes. Safe to run more than once.

alter table public.payout_details add column if not exists stripe_live_account_id text;
alter table public.payout_details add column if not exists stripe_live_payouts_enabled boolean not null default false;
alter table public.payout_details add column if not exists stripe_account_history jsonb not null default '[]'::jsonb;
alter table public.payout_details drop constraint if exists payout_details_stripe_v28;
alter table public.payout_details add constraint payout_details_stripe_v28 check (
      (stripe_live_account_id is null or stripe_live_account_id ~ '^acct_[A-Za-z0-9]{8,64}$')
  and jsonb_typeof(stripe_account_history) = 'array' and jsonb_array_length(stripe_account_history) <= 50
  and pg_column_size(stripe_account_history) <= 20000
);
-- members still write only (id, methods, note, updated_at) — the v9 column grants — so these columns stay with the payment functions

insert into public.site_settings (key, value) values ('stripe_mode', '"test"'::jsonb) on conflict (key) do nothing;

create or replace function public.stripe_mode()
returns text language sql stable security definer set search_path = public as $$
  select case when (select value from public.site_settings where key = 'stripe_mode') = '"live"'::jsonb then 'live' else 'test' end;
$$;
grant execute on function public.stripe_mode() to anon, authenticated;

-- the Fund button: the freelancer's account of the current mode can receive money
create or replace function public.editor_can_receive(ed uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select case when public.stripe_mode() = 'live' then p.stripe_live_payouts_enabled else p.stripe_payouts_enabled end
                     from public.payout_details p where p.id = ed), false);
$$;
grant execute on function public.editor_can_receive(uuid) to anon, authenticated;

-- verified = the provider said so (Stripe Identity), or Stripe Connect checked this person as a payee in the current mode
create or replace function public.is_verified(uid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.identity_verifications v where v.user_id = uid and v.status = 'verified')
      or exists (select 1 from public.payout_details p where p.id = uid
                   and case when public.stripe_mode() = 'live' then p.stripe_live_payouts_enabled else p.stripe_payouts_enabled end);
$$;
grant execute on function public.is_verified(uuid) to anon, authenticated;

-- the launch-day switch is not an admin-panel setting: it is changed only with SQL in Supabase (SETUP.md)
create or replace function public.admin_set_setting(p_key text, p_value jsonb)
returns text language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then return 'forbidden'; end if;
  if p_key !~ '^[a-z_]{1,40}$' or p_value is null or pg_column_size(p_value) > 5000 then return 'bad_input'; end if;
  if p_key = 'stripe_mode' then return 'forbidden'; end if;
  insert into public.site_settings (key, value, updated_by) values (p_key, p_value, auth.uid())
  on conflict (key) do update set value = excluded.value, updated_at = now(), updated_by = auth.uid();
  return 'ok';
end $$;
grant execute on function public.admin_set_setting(text, jsonb) to authenticated;

-- payout methods (IBAN / PayPal / Revolut / Wise) and Stripe accounts (test and live): recorded when saved
create or replace function public.on_payout_details_identifiers()
returns trigger language plpgsql security definer set search_path = public, extensions as $$
declare m jsonb; v text; k text;
begin
  for m in select * from jsonb_array_elements(coalesce(new.methods, '[]'::jsonb)) loop
    v := m->>'details'; k := coalesce(m->>'type', 'other');
    if k = 'bank' then k := 'iban'; end if;
    if k not in ('iban','paypal','revolut','wise') then k := 'other'; end if;
    if v is not null and length(v) >= 4 then
      perform public.record_identifier(new.id, k, v, k || ' ••' || right(regexp_replace(v, '\s', '', 'g'), 4));
    end if;
  end loop;
  if new.stripe_account_id is not null then
    perform public.record_identifier(new.id, 'stripe_account', new.stripe_account_id, new.stripe_account_id);
  end if;
  if new.stripe_live_account_id is not null then
    perform public.record_identifier(new.id, 'stripe_account', new.stripe_live_account_id, new.stripe_live_account_id);
  end if;
  return new;
end $$;
drop trigger if exists payout_identifiers on public.payout_details;
create trigger payout_identifiers after insert or update on public.payout_details for each row execute procedure public.on_payout_details_identifiers();

-- Shows whether this ran: one row that says "v28 applied".
select case when exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'payout_details' and column_name = 'stripe_live_account_id')
             and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'payout_details' and column_name = 'stripe_account_history')
             and (select value from public.site_settings where key = 'stripe_mode') is not null
             and pg_get_functiondef('public.editor_can_receive(uuid)'::regprocedure) like '%stripe_live_payouts_enabled%'
             and pg_get_functiondef('public.admin_set_setting(text,jsonb)'::regprocedure) like '%stripe_mode%'
            then 'v28 applied: Stripe accounts are kept separately for test and live; mode is ' || public.stripe_mode()
            else 'v28 NOT applied' end as result;
