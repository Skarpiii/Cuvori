-- Cuvori — undo schema v56. Only if you decide never to use the new prices: it removes the price plans, the switch,
-- the new columns and the new checks again, and puts Accept and the agreed text back exactly as they were in v38.
-- It refuses (and changes nothing) once any Order or payment line uses the new prices, also a proposal that was
-- declined or cancelled: plan 2 is part of those Orders, and agreed ones keep their prices and their 14 days for good. It also refuses once the payment code for the new prices has written a
-- ledger line (it gives every line an entry key, also at today's prices; today's code never does): that code writes the
-- columns undo takes away, and every money step would then fail after Stripe had moved the money. Orders made after
-- v56 at today's prices only lose the note "plan 1" (no amount and no day changes: they kept today's 7 days). It also
-- deletes the switch history (pricing_switch_log).
-- Run in the Supabase SQL editor, the whole file at once.

do $$
begin
  if to_regclass('public.pricing_plans') is null then raise exception 'v56 is not in this database: nothing to undo.'; end if;
  -- nothing new comes in while this runs, and the new prices must be switched off first. Every table this file changes
  -- or removes, locked before anything changes: the tables v56 changed (in v56's order), then v56's own three. Postgres
  -- waits up to lock_timeout for EACH table, and every Order screen and payment step waits behind this file meanwhile:
  -- 8 tables x half a second stays well below the 8 seconds the payment code waits for the database. A payment being
  -- made then stops this file with a lock timeout, nothing changed.
  perform set_config('lock_timeout', '500ms', true);
  lock table public.contracts, public.order_payments, public.order_milestones, public.order_amendments, public.money_keys,
             public.pricing_plans, public.pricing_switch, public.pricing_switch_log in access exclusive mode;
  if (select version from public.pricing_switch) <> 1 then
    raise exception 'The switch is on (plan %): turn it back first with select public.pricing_switch_to(1, ''…''); Nothing was changed.', (select version from public.pricing_switch);
  end if;
  if exists (select 1 from public.contracts where pricing_version >= 2) or exists (select 1 from public.order_payments where pricing_version >= 2) then
    raise exception 'Orders use the new prices (plan 2), so v56 stays. Nothing was changed.';
  end if;
  if exists (select 1 from public.order_payments where entry_key is not null) then
    raise exception 'The payment code for the new prices has written ledger lines: undoing v56 would break every payment step, so v56 stays. Nothing was changed.';
  end if;
end $$;

drop trigger if exists contracts_pricing on public.contracts;
drop trigger if exists order_amendments_pricing on public.order_amendments;
drop trigger if exists order_payments_pricing on public.order_payments;
drop trigger if exists order_payments_pricing_totals on public.order_payments;
drop trigger if exists order_payments_pricing_frozen on public.order_payments;
drop trigger if exists order_milestones_pricing on public.order_milestones;
drop trigger if exists money_keys_pricing on public.money_keys;

-- Accept and the agreed text, as in schema_v38.sql
create or replace function public.order_accept(p_order uuid, p_version integer default null)
returns text language plpgsql security definer set search_path = public as $$
declare c public.contracts%rowtype; me uuid := auth.uid();
begin
  if me is null then return 'not_signed_in'; end if;
  select * into c from public.contracts where id = p_order and me in (editor, client) for update;
  if not found then return 'not_found'; end if;
  if public.is_banned(me) or public.is_banned(c.editor) or public.is_banned(c.client) then return 'banned'; end if;
  if c.status <> 'proposed' then return 'not_allowed'; end if;
  -- v38: only the version the person read can be accepted; a page that names none (opened before v38) must reload
  if p_version is distinct from c.terms_version then return 'order_changed'; end if;
  begin perform public.rate_limit('contract_action', 60, interval '1 hour'); exception when others then return 'rate_limited'; end;
  -- Orders made before v18 carry no acceptance columns: whoever proposed had accepted their own draft
  if c.client_accepted_version is null and c.freelancer_accepted_version is null then
    if c.proposed_by = c.client then c.client_accepted_version := c.terms_version; else c.freelancer_accepted_version := c.terms_version; end if;
  end if;
  if me = c.client then
    if c.client_accepted_version = c.terms_version then return 'already_accepted'; end if;
    c.client_accepted_version := c.terms_version; c.client_accepted_at := now();
    perform public.order_log(c.id, 'client_accepted', jsonb_build_object('version', c.terms_version));
  else
    if c.freelancer_accepted_version = c.terms_version then return 'already_accepted'; end if;
    c.freelancer_accepted_version := c.terms_version; c.freelancer_accepted_at := now();
    perform public.order_log(c.id, 'freelancer_accepted', jsonb_build_object('version', c.terms_version));
  end if;
  if c.client_accepted_version = c.terms_version and c.freelancer_accepted_version = c.terms_version then
    -- v38: what was agreed is saved here, in the same step, from the Order as it is now (never from a browser)
    c.accepted_at := now(); c.accepted_version := c.terms_version;
    update public.contracts set client_accepted_version = c.client_accepted_version, client_accepted_at = c.client_accepted_at,
           freelancer_accepted_version = c.freelancer_accepted_version, freelancer_accepted_at = c.freelancer_accepted_at,
           status = 'accepted', accepted_at = c.accepted_at, accepted_version = c.accepted_version,
           terms_doc = coalesce(terms_doc, public.order_terms_snapshot(c)) where id = c.id returning * into c;
    perform public.order_log(c.id, 'accepted', jsonb_build_object('version', c.terms_version, 'price_cents', c.amount_cents));
    perform public.contract_event(c, 'accept');
  else
    update public.contracts set client_accepted_version = c.client_accepted_version, client_accepted_at = c.client_accepted_at,
           freelancer_accepted_version = c.freelancer_accepted_version, freelancer_accepted_at = c.freelancer_accepted_at where id = c.id returning * into c;
    perform public.contract_event(c, case when me = c.client then 'client_accepted' else 'freelancer_accepted' end);
  end if;
  return 'ok';
end $$;

create or replace function public.order_terms_snapshot(c public.contracts)
returns jsonb language sql stable set search_path = public as $$
  select jsonb_build_object(
    'kind', 'facts', 'v', 1, 'version', c.terms_version, 'accepted_at', c.accepted_at, 'clauses_version', c.clauses_version,
    'language', c.language, 'contract_type', c.contract_type, 'law_country', c.law_country, 'payment_mode', c.payment_mode,
    'pricing', c.pricing, 'title', c.title, 'description', c.description, 'price', c.price, 'currency', c.currency,
    'amount_cents', c.amount_cents, 'deadline', c.deadline, 'revisions', c.revisions, 'auto_days', c.auto_days, 'terms', c.terms,
    'deliverables', c.deliverables, 'client_duties', c.client_duties, 'freelancer_duties', c.freelancer_duties, 'rights', c.rights,
    'has_milestones', c.has_milestones,
    'milestones', coalesce((select jsonb_agg(jsonb_build_object('position', m.position, 'title', m.title, 'amount_cents', m.amount_cents, 'due', m.due) order by m.position)
                              from public.order_milestones m where m.order_id = c.id), '[]'::jsonb),
    -- the names as the Order screen shows them (order_bundle)
    'client_name', coalesce((select p.first_name from public.profiles p where p.id = c.client), ''),
    'freelancer_name', coalesce((select coalesce(nullif(e.display_name, ''), p.first_name) from public.profiles p left join public.editor_profiles e on e.id = p.id where p.id = c.editor), ''));
$$;

drop index if exists public.order_payments_entry_key_uq;
drop index if exists public.order_payments_v2_object_uq;
alter table public.order_payments drop constraint if exists order_payments_pricing_ok;
alter table public.order_payments drop column if exists entry_key, drop column if exists commission_cents,
  drop column if exists payout_cents, drop column if exists payout_purpose, drop column if exists pricing_version;
alter table public.contracts drop constraint if exists contracts_pricing_ok;
alter table public.contracts drop constraint if exists contracts_pricing_plan_fk;
alter table public.contracts drop column if exists pricing_version, drop column if exists commission_bps, drop column if exists commission_cents;

drop function if exists public.contracts_pricing();
drop function if exists public.order_amendments_pricing();
drop function if exists public.order_payments_pricing();
drop function if exists public.order_payments_pricing_totals();
drop function if exists public.order_payments_pricing_frozen();
drop function if exists public.order_milestones_pricing();
drop function if exists public.money_keys_pricing();
drop function if exists public.pricing_switch_to(integer, text);
drop function if exists public.pricing_next_commission(uuid, integer);
drop function if exists public.order_price_breakdown(uuid);
drop function if exists public.order_money_summary(uuid);
drop function if exists public.admin_pricing_report(date, date);
drop function if exists public.admin_pricing_check();
drop function if exists public.pricing_staff();
drop function if exists public.order_create_at_prices(uuid, jsonb, integer);
drop function if exists public.order_update_at_prices(uuid, jsonb, integer);
drop function if exists public.pricing_now();
drop function if exists public.pricing_commission(bigint, integer);
drop function if exists public.pricing_engine();
drop table if exists public.pricing_switch_log;
drop table if exists public.pricing_switch;
drop table if exists public.pricing_plans;
drop function if exists public.pricing_switch_logged();
drop function if exists public.pricing_plans_guard();

-- Shows whether this ran
select case when to_regclass('public.pricing_plans') is null
             and not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'contracts' and column_name = 'pricing_version')
             and pg_get_functiondef('public.order_accept(uuid, integer)'::regprocedure) not like '%prices_changed%'
             and to_regprocedure('public.order_create_at_prices(uuid, jsonb, integer)') is null
             and to_regprocedure('public.order_update_at_prices(uuid, jsonb, integer)') is null
            then 'v56 undone: the database is as it was at v55.'
            else 'v56 NOT undone' end as result;
