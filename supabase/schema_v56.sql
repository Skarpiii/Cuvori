-- Cuvori schema v56 — the new prices in the database, switched OFF: a 5% commission on the freelancer's paid projects,
-- no client fees, Cuvori pays the card costs, and 14 days to review a delivery.
-- Run after schema_v55.sql, in the Supabase SQL editor. Run it only when you have approved it: it changes no Order and
-- no payment that exists, and new Orders keep today's prices (and today's 7 days) until you turn the switch (SETUP.md,
-- Part 20).
--
-- What this adds:
--   1. Price plans (pricing_plans). Plan 1 is today's prices: the client pays the card costs on top, no commission,
--      Orders from €1, 7 days to review a delivery. Plan 2 is the new model: clients pay only the agreed price (job posts,
--      matching help and the account are free, no client fee, no subscription); 5% of every amount paid out to the
--      freelancer is kept as commission (€100 paid out: €5 kept, €95 sent), rounded half up to the cent, top-ups the same;
--      Cuvori pays the card costs; protected-payment Orders from €2; 14 days to review a delivery.
--      A plan can no longer be changed once an Order uses it; new prices are a new plan.
--   2. The switch (pricing_switch): which plan new Orders get. It starts at plan 1 and only you change it, here in
--      Supabase: select public.pricing_switch_to(2, 'why'); Every change is logged (pricing_switch_log).
--   3. Every Order records its plan and the commission rate it was proposed under, and under plan 2 its 14 days
--      (contracts.auto_days). Once both sides accept, those never change, and under the new prices neither does the way
--      it is paid; an Order agreed after v56 never becomes a proposal again. If the switch moved while an Order was still a proposal, Accept answers "order_changed": the Order now
--      shows the prices in force, its chat card says Cuvori's prices changed, and both sides read and accept it again.
--      Under plan 2 both sides must have accepted the plan's site rules first (a rules version from after this month
--      counts only when it is a price plan's own). A proposal sent or changed from the page names the plan its form
--      showed (order_create_at_prices, order_update_at_prices): if the switch moved in between, nothing is written.
--      Orders from before v56 are left exactly as they are: their new columns stay empty and agreed ones keep today's
--      prices and their 7 days. (One still only proposed records the plan in force when it is next changed or accepted:
--      plan 1 while the switch is off; after the switch, plan 2, and both sides accept it again.)
--   4. Plan 2 Orders paid through Cuvori can't be made, given a lower price (by a change or an amendment) or accepted
--      below €2. The €0.50 rule for top-ups stays as it is, separately.
--   5. The ledger (order_payments) under plan 2. A line is written after its money has moved at Stripe, so the
--      database never refuses one for its amounts: that could not stop the money, only hide it. It refuses only a
--      badly written line: not marked succeeded, not from Stripe, no unique entry key, not exactly one Stripe object
--      (of the line's own kind: a payment pi_, a payout tr_, a refund re_ or pyr_, a pull-back trr_, a chargeback dp_
--      or du_), a payout that does not say what it kept and sent, a re-payment or pull-back that does not name its
--      chargeback. Each Stripe payment, payout, refund and chargeback is written once. Everything else is recorded as it happened, and the ledger check lists the Order for the admin: a
--      payment above the agreed price or with card costs for the client, a payout that did not keep exactly 5% of the
--      running total, more paid out than came in, a refund made in the Stripe dashboard after the payout, a re-payment
--      without a won chargeback, and a line the Order counts but that was never written.
--      The Order's commission total is kept by the database from those lines, never written by hand. A plan 2 line can no
--      longer be changed: only Stripe's real fee and the charge id are written in once, and the refund of a card fee charged
--      by mistake once (at most that fee, with the refund's own Stripe id).
--      No ledger line of any plan, also from before v56, can be moved to another Order or have its kind, amounts,
--      card fee, status or Stripe reference changed afterwards; the payment code never did that (it only adds Stripe's
--      real fee and the card-fee refund).
--      A refund that fails at Stripe after its line was written gets a line of its own, at any prices (refund_failed,
--      naming the failed refund re_ or pyr_, for the money that came back): the checks count refunds minus failed refunds.
--   6. The 14 days and disputes. Under plan 2 the 14 days start with a valid delivery: a delivery (or a part handed in)
--      needs a link to the work. On every Order paid through Cuvori, nothing is paid out of the held payment for a part
--      while the Order is in dispute (or no longer being worked on) or the bank has a chargeback open; Cuvori's decision
--      on a dispute goes through as before.
--   7. Payment code that does not know plan 2 (the 13 October hourly job on Netlify production, and today's code)
--      cannot move the Order's money on a plan 2 Order: it is stopped at the Order's lock and money keys, which it
--      takes before it moves that money at Stripe (two refunds take a key naming the payment instead, and neither can
--      happen on a plan 2 Order: today's code never takes a plan 2 payment), and at every write. That also stops it from charging or letting go of
--      a card hold when a payment page is paid, or sending back a late payment, on a plan 2 Order: those steps wait for
--      the new code (SETUP.md, Part 20: the new code is live before the switch). A cancel or a dispute decision on such
--      an Order can still let go of a card hold that is waiting (it names the payment, not the Order): nothing is
--      charged, and the client pays again later. The new code identifies itself with a request header. Plan 1 Orders
--      work exactly as before, and so do people's own steps that move no money (deliver, ask for changes, dispute);
--      approving a plan 2 Order paid through Cuvori, or a part of it, pays money out and is refused until the new code is live.
--   8. Reading: the price breakdown and the money summary of an Order (both sides, the admin and you), the commission
--      report over the dates you give, in German dates (totals, and by freelancer, with what was pulled back after
--      chargebacks), and a ledger check that lists problems and what is left for you to decide (the admin and you).
--   9. More rules that start as soon as v56 runs, from the payment audit of 31 October (section 10). On every Order paid
--      through Cuvori: the work is delivered only once every price increase both sides accepted is paid in, and a part
--      is handed in only while the money paid in covers it ("increase_not_paid"); an Order already delivered whose
--      price goes up is back to being worked on, its automatic payout stopped, and the freelancer delivers again once
--      the increase is paid. The payment code can't
--      start paying out a whole Order that is in dispute (or no longer being worked on) or has a chargeback open
--      ("release_paused"); Cuvori's decision on a dispute goes through as before. Each Stripe payment has one payment
--      line, also at today's prices (a payment written twice before v56 stays as it is, and the ledger check lists it).
--      The ledger check also looks at every Order paid through Cuvori, at any prices: an Order that counts less money
--      than its lines show, a part paid out twice, a payment written twice. The two sides of an Order no longer read a
--      payment line's Stripe ids, entry key or note (its amounts, Stripe's fee included, they still read). On every
--      Order: a part's buttons wait for the Order first, as the Order's own buttons do, so two clicks at the same moment
--      can't block each other; and an Order paid directly records as paid out what was confirmed as paid in. An
--      automatic payout of a whole Order starts only once its review period is over ("release_too_early").
--  10. The admin log (section 11): every change an admin makes through the site is written by the database itself (who,
--      when, what, before and after), and Cuvori's dispute decisions by the payment code before money moves. Nobody
--      can change or delete a line; admins can read it. And what Cuvori reviews to decide a dispute or answer a
--      chargeback (the agreed text, the work handed in, the history and the two sides' chat), for an admin who is not on
--      the Order, only while there is something to decide; every look is in the admin log.
-- Safe to run more than once.

-- ---------- 0. this file needs v55, and replaces the earlier draft of v56 ----------
do $$
begin
  if not exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace and proname = 'admin_clear_order_note') then
    raise exception 'Run schema_v55.sql first: this database is not at v55 yet. Nothing was changed.';
  end if;
  -- the draft in update 33 (with a €2 client fee) was never meant to run; if it did, it must be undone first
  if exists (select 1 from information_schema.columns where table_schema = 'public' and column_name like 'client_fee%') then
    raise exception 'Stop and ask for help: the earlier draft of v56 (update 33, with a client fee) was run on this database and has to be undone with its own undo file first. Nothing was changed.';
  end if;
  -- every existing table this file changes, locked one after another in one order before anything changes: a payment
  -- that arrives while it runs waits a moment, or this file stops (when a table stays busy for half a second) with
  -- nothing changed, instead of meeting it halfway. It waits for each table less than Postgres's deadlock timer (1
  -- second), so in a deadlock this file is almost always the one that gives up, not the other side (a person's click, or a payment
  -- step's database write after Stripe has moved the money, which the payment code tries again; a line still missing
  -- then has to be added by hand, as the hourly job on production, the 13 October code, adds only the lines of the steps it retries,
  -- and the copy of a refund made in the Stripe dashboard is not tried again: SETUP Part 20). Postgres waits up to
  -- lock_timeout for EACH table, and every Order screen and payment step waits behind this file meanwhile: 5 tables x
  -- half a second stays well below the 8 seconds the payment code waits for the database before it reports a step as
  -- failed. The SQL editor runs the whole file as one transaction, so the locks hold to its end.
  perform set_config('lock_timeout', '500ms', true);
  lock table public.contracts, public.order_payments, public.order_milestones, public.order_amendments, public.money_keys in access exclusive mode;
end $$;

-- ---------- 1. price plans ----------
create table if not exists public.pricing_plans (
  version            int primary key check (version between 1 and 1000),
  name               text not null check (length(name) between 1 and 120),
  commission_bps     int not null check (commission_bps between 0 and 3000),          -- basis points: 500 = 5%, at most 30%
  min_project_cents  int not null check (min_project_cents between 50 and 100000),    -- the smallest Order paid through Cuvori
  card_costs_paid_by text not null check (card_costs_paid_by in ('client', 'platform')),
  review_days        int not null check (review_days between 1 and 60),              -- days to review a delivery before it is paid out
  rounding           text not null default 'half_up' check (rounding = 'half_up'),     -- half a cent and up rounds up
  currency           text not null default 'EUR' check (currency = 'EUR'),
  rules_version      text check (rules_version ~ '^[0-9]{4}-[0-9]{2}$'),              -- the site rules both sides must have accepted
  created_at         timestamptz not null default now()
);
insert into public.pricing_plans (version, name, commission_bps, min_project_cents, card_costs_paid_by, review_days) values
  (1, 'today''s prices: the client pays the card costs on top, no commission, 7 days to review a delivery', 0, 100, 'client', 7),
  (2, 'the new prices: no client fees, 5% commission on paid projects, Cuvori pays the card costs, 14 days to review a delivery', 500, 200, 'platform', 14)
on conflict (version) do nothing;

-- a plan that Orders use is part of their agreement: it is never changed or removed afterwards
create or replace function public.pricing_plans_guard()
returns trigger language plpgsql set search_path = public as $$
begin
  -- an Order being written at this moment under the plan can't be seen yet: every write of Orders finishes first (and
  -- new ones wait the moment this takes), so a plan is never changed under an Order that has just taken it. At most 2
  -- seconds (payments wait behind it meanwhile): then it stops with a lock timeout, nothing changed, and is run again
  if current_setting('lock_timeout') in ('0', '') then perform set_config('lock_timeout', '2s', true); end if;
  lock table public.contracts in share mode;
  if exists (select 1 from public.contracts where pricing_version = old.version) then
    raise exception 'pricing_plan_in_use' using hint = 'Orders use plan ' || old.version || '; new prices need a new plan';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  if new.version <> old.version then raise exception 'pricing_plan_in_use' using hint = 'a plan keeps its number'; end if;
  return new;
end $$;
drop trigger if exists pricing_plans_guard on public.pricing_plans;
create trigger pricing_plans_guard before update or delete on public.pricing_plans for each row execute function public.pricing_plans_guard();

-- ---------- 2. the switch: which plan new Orders get ----------
create table if not exists public.pricing_switch (
  id         boolean primary key default true check (id),                 -- one row only
  version    int not null references public.pricing_plans(version),
  changed_at timestamptz not null default now(),
  note       text not null default '' check (length(note) <= 500)
);
insert into public.pricing_switch (id, version, note) values (true, 1, 'v56: the new prices are off') on conflict (id) do nothing;
create table if not exists public.pricing_switch_log (
  id           bigserial primary key,
  from_version int,
  to_version   int not null,
  note         text not null default '',
  changed_by   text not null default current_user,
  changed_at   timestamptz not null default now()
);
create or replace function public.pricing_switch_logged()
returns trigger language plpgsql set search_path = public as $$
begin
  if tg_op = 'DELETE' then raise exception 'pricing_switch_must_stay'; end if;
  if tg_op = 'UPDATE' and new.id is distinct from old.id then raise exception 'pricing_switch_must_stay'; end if;
  if tg_op = 'UPDATE' and new.version is not distinct from old.version and new.note is not distinct from old.note then return new; end if;
  new.changed_at := now();
  insert into public.pricing_switch_log (from_version, to_version, note) values (case when tg_op = 'UPDATE' then old.version end, new.version, new.note);
  return new;
end $$;
drop trigger if exists pricing_switch_logged on public.pricing_switch;
create trigger pricing_switch_logged before update or delete on public.pricing_switch for each row execute function public.pricing_switch_logged();

-- Only you, in this editor: select public.pricing_switch_to(2, 'the new prices from 1 December');
-- New prices are refused while their plan names no site-rules version (both sides must have accepted those rules).
create or replace function public.pricing_switch_to(p_version integer, p_note text)
returns text language plpgsql set search_path = public as $$
declare p public.pricing_plans%rowtype; cur int;
begin
  select * into p from public.pricing_plans where version = p_version;
  if not found then return 'no_such_plan'; end if;
  if (p.commission_bps > 0 or p.card_costs_paid_by = 'platform' or p.review_days <> 7) and p.rules_version is null then
    return 'rules_version_missing';
  end if;
  -- queued in turn behind the proposals being written right now (they hold the switch until they are written), and
  -- ahead of any that arrive after: proposals arriving one after another can't keep the switch from moving. The prices
  -- can still be read meanwhile (pricing_now)
  lock table public.pricing_switch in exclusive mode;
  select version into cur from public.pricing_switch where id for update;
  if cur = p_version then return 'already'; end if;
  update public.pricing_switch set version = p_version, note = left(coalesce(p_note, ''), 500) where id;
  return 'ok';
end $$;

-- the prices in force, for the page (anyone may read them)
create or replace function public.pricing_now()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('version', p.version, 'commission_bps', p.commission_bps, 'min_project_cents', p.min_project_cents,
                            'card_costs_paid_by', p.card_costs_paid_by, 'review_days', p.review_days,
                            'rounding', p.rounding, 'currency', p.currency, 'rules_version', p.rules_version)
    from public.pricing_plans p join public.pricing_switch s on s.version = p.version;
$$;

-- ---------- 3. the commission and the new code's header ----------
-- The rounding policy: the commission on an amount is rounded half up to the whole cent. Over several payouts it is
-- taken on the running total (pricing_next_commission), so the whole is always exactly the commission on the total.
create or replace function public.pricing_commission(p_cents bigint, p_bps integer)
returns bigint language plpgsql immutable set search_path = public as $$
begin
  if p_cents is null or p_bps is null then return null; end if;
  if p_cents < 0 or p_bps < 0 or p_bps > 10000 then raise exception 'bad_amount'; end if;
  return (p_cents * p_bps + 5000) / 10000;
end $$;

-- The payment code sends the highest price plan it knows in the header "x-cuvori-pricing" with every database request
-- ("x-cuvori-pricing: 2" for plan 2); Supabase passes request headers on as request.headers. No header (older code, or
-- this editor) reads as 0. A plan's Orders accept money steps only from code that knows that plan.
create or replace function public.pricing_engine()
returns integer language plpgsql stable set search_path = public as $$
declare h text := current_setting('request.headers', true); v text;
begin
  if h is null or h = '' then return 0; end if;
  begin v := (h::jsonb)->>'x-cuvori-pricing'; exception when others then return 0; end;
  if v ~ '^[0-9]{1,3}$' then return v::int; end if;
  return 0;
end $$;

-- ---------- 4. every Order records its prices ----------
alter table public.contracts add column if not exists pricing_version int;
alter table public.contracts add column if not exists commission_bps int;              -- the agreed commission (500 = 5%)
alter table public.contracts add column if not exists commission_cents int;            -- commission kept so far (from the ledger)
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'contracts_pricing_plan_fk') then
    alter table public.contracts add constraint contracts_pricing_plan_fk foreign key (pricing_version) references public.pricing_plans(version);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'contracts_pricing_ok') then
    -- Orders from before v56: everything empty. Every other Order: a plan and both numbers, each within its limits.
    alter table public.contracts add constraint contracts_pricing_ok check (
      (pricing_version is null and commission_bps is null and commission_cents is null)
      or (pricing_version is not null and commission_bps is not null and commission_cents is not null
         and commission_bps between 0 and 3000 and commission_cents >= 0));
  end if;
end $$;

create or replace function public.contracts_pricing()
returns trigger language plpgsql set search_path = public as $$
declare cur public.pricing_plans%rowtype; plan_min int;
begin
  select p.* into cur from public.pricing_plans p join public.pricing_switch s on s.version = p.version;
  if tg_op = 'INSERT' then
    -- a new Order gets the plan in force; whatever was written into these columns is not used. Under the new prices
    -- the review days are the plan's too (today's Orders keep the column's own 7 days, exactly as before v56).
    new.pricing_version := cur.version;
    new.commission_bps := case when new.payment_mode = 'escrow' then cur.commission_bps else 0 end;
    new.commission_cents := 0;
    if cur.version >= 2 then new.auto_days := cur.review_days; end if;
  else
    -- the commission total comes only from the ledger (order_payments_pricing_totals)
    if new.commission_cents is distinct from old.commission_cents and coalesce(current_setting('cuvori.pricing_ledger', true), '') <> 'on' then
      raise exception 'pricing_counters_from_ledger_only';
    end if;
    -- an agreed (or closed) Order never becomes a proposal again: its prices would be stamped anew
    if old.status <> 'proposed' and new.status = 'proposed' and old.pricing_version is not null then
      raise exception 'pricing_frozen' using hint = 'an agreed Order cannot become a proposal again';
    end if;
    if old.status = 'proposed' and new.status = 'proposed' and old.accepted_at is null
       and (new.terms_version is distinct from old.terms_version or new.payment_mode is distinct from old.payment_mode) then
      -- a proposal that changed (a new version both sides must accept) takes the prices in force
      new.pricing_version := cur.version;
      new.commission_bps := case when new.payment_mode = 'escrow' then cur.commission_bps else 0 end;
      new.commission_cents := coalesce(old.commission_cents, 0);
      if cur.version >= 2 or old.pricing_version >= 2 then new.auto_days := cur.review_days; end if;
    elsif old.status = 'proposed' and new.status = 'accepted' and old.pricing_version is null and new.pricing_version is null
          and new.commission_bps is null and cur.version = 1 then
      -- a proposal from before v56, accepted while today's prices are in force: it records them now
      new.pricing_version := 1; new.commission_bps := 0; new.commission_cents := 0;
    elsif (new.pricing_version, new.commission_bps) is distinct from (old.pricing_version, old.commission_bps)
          or (old.pricing_version >= 2 and new.auto_days is distinct from old.auto_days) then
      raise exception 'pricing_frozen' using hint = 'an Order''s prices and review days are set by the price plan and never changed';
    end if;
    -- how an Order is paid is part of its prices: fixed once it is more than a proposal
    if old.pricing_version >= 2 and old.status <> 'proposed' and new.payment_mode is distinct from old.payment_mode then
      raise exception 'pricing_frozen' using hint = 'an agreed Order keeps its way of payment';
    end if;
    -- an Order becomes an agreement only under the prices in force (order_accept asks both sides to read it again)
    if old.status = 'proposed' and new.status = 'accepted' and new.pricing_version is distinct from cur.version then
      raise exception 'pricing_changed' using hint = 'the prices changed since this version was proposed';
    end if;
    -- under the new prices the review days start with a valid delivery: a link to the work (order_action checks the
    -- link is a safe https address)
    if new.pricing_version >= 2 and new.payment_mode = 'escrow' and new.status = 'delivered' and old.status is distinct from 'delivered'
       and coalesce(btrim(new.delivery_url), '') = '' then
      raise exception 'link_required' using hint = 'a delivery under the new prices needs a link to the work';
    end if;
  end if;
  -- the smallest Order paid through Cuvori under the new prices (plan 1 keeps today's rules, checked where they are)
  if new.pricing_version >= 2 and new.payment_mode = 'escrow'
     and (tg_op = 'INSERT' or new.amount_cents is distinct from old.amount_cents or (old.status = 'proposed' and new.status = 'accepted')) then
    select min_project_cents into plan_min from public.pricing_plans where version = new.pricing_version;
    if new.amount_cents is null or new.amount_cents < plan_min then raise exception 'bad_price' using hint = 'the smallest Order is ' || plan_min || ' cents'; end if;
  end if;
  -- payment code that does not know the new prices moves no money on a plan 2 Order
  if tg_op = 'UPDATE' and old.pricing_version >= 2 and old.payment_mode = 'escrow' and current_user = 'service_role' then
    if public.pricing_engine() < old.pricing_version
       and (new.status, new.funded_cents, new.released_cents, new.refunded_cents, new.split_editor_cents, new.refund_cents, new.resolution,
            new.stripe_checkout_id, new.stripe_payment_intent, new.stripe_charge_id, new.stripe_transfer_id, new.stripe_refund_id,
            new.stripe_reversal_id, new.quote, new.fee_cents, new.connect_cents, new.paid_mode, new.funded_at,
            new.chargeback_id, new.chargeback_status, new.chargeback_cents)
           is distinct from
           (old.status, old.funded_cents, old.released_cents, old.refunded_cents, old.split_editor_cents, old.refund_cents, old.resolution,
            old.stripe_checkout_id, old.stripe_payment_intent, old.stripe_charge_id, old.stripe_transfer_id, old.stripe_refund_id,
            old.stripe_reversal_id, old.quote, old.fee_cents, old.connect_cents, old.paid_mode, old.funded_at,
            old.chargeback_id, old.chargeback_status, old.chargeback_cents) then
      raise exception 'pricing_engine_too_old' using hint = 'this Order uses price plan ' || new.pricing_version || ', which this payment code does not know';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists contracts_pricing on public.contracts;
create trigger contracts_pricing before insert or update on public.contracts for each row execute function public.contracts_pricing();

-- an amendment can never take a plan 2 Order below its minimum (the top-up rule in order_amend stays as it is)
create or replace function public.order_amendments_pricing()
returns trigger language plpgsql set search_path = public as $$
declare c public.contracts%rowtype; plan_min int;
begin
  select * into c from public.contracts where id = new.order_id;
  if c.pricing_version >= 2 and c.payment_mode = 'escrow' then
    select min_project_cents into plan_min from public.pricing_plans where version = c.pricing_version;
    if coalesce(c.amount_cents, 0) + coalesce(new.price_delta_cents, 0) < plan_min then
      raise exception 'bad_price' using hint = 'the smallest Order is ' || plan_min || ' cents';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists order_amendments_pricing on public.order_amendments;
create trigger order_amendments_pricing before insert on public.order_amendments for each row execute function public.order_amendments_pricing();

-- ---------- 5. the ledger ----------
alter table public.order_payments add column if not exists entry_key text;           -- one line per money move ('fund:pi_…', 'release:tr_…')
alter table public.order_payments add column if not exists commission_cents int;     -- commission kept on this payout (release)
alter table public.order_payments add column if not exists payout_cents int;         -- what was sent to the freelancer (release) = amount - commission
alter table public.order_payments add column if not exists payout_purpose text;      -- release | release_late (written afterwards from Stripe's record) | repay (after a won chargeback)
alter table public.order_payments add column if not exists pricing_version int;      -- the Order's plan, written by the database
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'order_payments_pricing_ok') then
    alter table public.order_payments add constraint order_payments_pricing_ok check (
      (entry_key is null or entry_key ~ '^[a-z_]{2,40}:[A-Za-z0-9_:.,-]{1,240}$')
      and (commission_cents is null or (kind = 'release' and commission_cents >= 0 and commission_cents <= amount_cents))
      and (payout_cents is null or (kind = 'release' and commission_cents is not null and payout_cents = amount_cents - commission_cents))
      and (payout_purpose is null or (kind = 'release' and payout_purpose in ('release', 'release_late', 'repay'))));
  end if;
end $$;
-- A refund that fails at Stripe after its line was written (Stripe's refund.failed, or charge.refund.updated with status
-- failed): its money comes back to Cuvori. The refund's line is never changed, so a line of its own records the money
-- that came back: kind refund_failed, naming the failed refund (re_… or pyr_…), entry key 'refund_failed:<refund id>',
-- note 'refund_failed'; the payment code lowers the Order's refunded total by it. Every check and report counts refunds
-- minus failed refunds. A kind of the ledger's own list (v21's, with this one added), so at any prices; undo_v56.sql
-- puts v21's list back.
do $$
begin
  if coalesce((select pg_get_constraintdef(oid) from pg_constraint where conrelid = 'public.order_payments'::regclass and conname = 'order_payments_kind_check'), '') not like '%''refund_failed''%' then
    alter table public.order_payments drop constraint if exists order_payments_kind_check;
    alter table public.order_payments add constraint order_payments_kind_check check (kind in ('fund','release','refund','reversal','chargeback','refund_failed'));
  end if;
end $$;
create unique index if not exists order_payments_entry_key_uq on public.order_payments (entry_key) where entry_key is not null;
create unique index if not exists order_payments_v2_object_uq on public.order_payments (kind, provider_ref)
  where pricing_version >= 2 and provider_ref is not null and kind in ('fund', 'release', 'refund', 'chargeback', 'reversal', 'refund_failed');
-- one card-fee refund is written on one payment line only
create unique index if not exists order_payments_v2_fee_refund_uq on public.order_payments (fee_refund_ref)
  where pricing_version >= 2 and fee_refund_ref is not null;
-- Every Order, at any prices (the payment audit of 31 October): one payment line per Stripe payment. The payment code
-- never writes one twice (it looks a line up before it writes it again), so this refuses only a second copy. A payment
-- that was written twice before v56 does not stop v56: its later copies stay out of the rule and its first copy is in
-- it, so no further copy can ever be written, and the ledger check lists it (payment_line_twice). Later copies are
-- named by their id, so no line written after v56 can be out of the rule.
do $$
declare later uuid[];
begin
  if to_regclass('public.order_payments_fund_ref_uq') is null then
    select coalesce(array_agg(id order by id), '{}') into later
      from (select id, row_number() over (partition by provider_ref order by created_at, id) as n
              from public.order_payments where kind = 'fund' and provider = 'stripe' and provider_ref is not null) x
     where n > 1;
    execute 'create unique index order_payments_fund_ref_uq on public.order_payments (provider_ref)'
         || ' where kind = ''fund'' and provider = ''stripe'' and provider_ref is not null'
         || case when cardinality(later) > 0 then format(' and id <> all (%L::uuid[])', later::text) else '' end;
  end if;
end $$;

create or replace function public.order_payments_pricing()
returns trigger language plpgsql set search_path = public as $$
declare c public.contracts%rowtype;
begin
  select * into c from public.contracts where id = new.order_id;
  new.pricing_version := c.pricing_version;
  if c.pricing_version is null or c.pricing_version < 2 or c.payment_mode is distinct from 'escrow' then
    -- today's prices: the line is written exactly as before; the new fields are for plan 2
    if new.commission_cents is not null or new.payout_cents is not null or new.payout_purpose is not null then
      raise exception 'pricing_fields_need_new_prices';
    end if;
    return new;
  end if;
  if current_user = 'service_role' then
    if public.pricing_engine() < c.pricing_version then
      raise exception 'pricing_engine_too_old' using hint = 'this Order uses price plan ' || c.pricing_version || ', which this payment code does not know';
    end if;
  end if;
  select * into c from public.contracts where id = new.order_id for update;     -- one money line at a time per Order
  -- A ledger line is written after its money has moved at Stripe, so refusing it could not stop the money: it would
  -- only hide it. A plan 2 line is therefore refused only when it is badly written, which the payment code does the
  -- same way every time (found in testing): no entry key, not one Stripe object, a payout that does not say what it
  -- kept and sent. Whether its amounts are right (the agreed price, no card costs for the client, exactly 5%, never
  -- more out than in, a re-payment only after a won chargeback) depends on the other lines and on what happened at
  -- Stripe: such a line is always recorded as it happened, and admin_pricing_check lists the Order for the admin.
  if new.status is distinct from 'succeeded' then raise exception 'ledger_line_must_be_succeeded'; end if;
  if new.entry_key is null then raise exception 'entry_key_missing'; end if;
  if new.provider is distinct from 'stripe' then raise exception 'ledger_provider_stripe_only'; end if;
  if coalesce(new.provider_ref, '') = '' then
    raise exception 'provider_ref_missing' using hint = 'a payment, payout, refund, pull-back or chargeback line names its Stripe object';
  end if;
  -- exactly one Stripe object per line ("re_…", "tr_…", "trr_…", "dp_…", "pi_…"): a list of ids would let the same
  -- refund be recorded twice ("re_A", then "re_A,re_B") past the rule that each Stripe object is written once
  if new.provider_ref !~ '^[A-Za-z0-9_]{1,255}$' then
    raise exception 'provider_ref_one_id' using hint = 'one line per Stripe object: write one line for each refund, payout or pull-back';
  end if;
  -- and the Stripe object of the line's own kind: a payout naming its payment, or a pull-back naming its transfer, would
  -- pass once and be refused at the second payout from that payment (or pull-back from that transfer), after Stripe had
  -- moved the money; refused every time instead, testing finds it. A failed refund names the refund that failed.
  -- (a kind the ledger doesn't have is refused by the table's own list of kinds)
  if new.kind in ('fund', 'release', 'refund', 'reversal', 'chargeback', 'refund_failed')
     and not (new.kind = 'fund' and new.provider_ref ~ '^pi_' or new.kind = 'release' and new.provider_ref ~ '^tr_'
              or new.kind in ('refund', 'refund_failed') and new.provider_ref ~ '^(re|pyr)_' or new.kind = 'reversal' and new.provider_ref ~ '^trr_'
              or new.kind = 'chargeback' and new.provider_ref ~ '^(dp|du)_') then
    raise exception 'provider_ref_wrong_kind' using hint = 'a payment line names its payment (pi_), a payout its transfer (tr_), a refund and a failed refund the refund (re_, pyr_), a pull-back its reversal (trr_), a chargeback its dispute (dp_, du_)';
  end if;
  if new.kind = 'fund' then
    -- the agreed price (or the agreed top-up), and under the new prices no card costs for the client. A payment that
    -- charged them anyway is recorded as it happened (client_charged_card_fee), never written as 0
    new.fee_cents := coalesce(new.fee_cents, 0); new.connect_cents := coalesce(new.connect_cents, 0);
    new.fee_refund_cents := coalesce(new.fee_refund_cents, 0);
    -- a card fee refunded already (a line added afterwards from Stripe's record): at most that fee, with the refund's own
    -- Stripe id, as when it is written on the line later (order_payments_pricing_frozen); no id without an amount
    if (new.fee_refund_cents <> 0 or new.fee_refund_ref is not null)
       and not (new.fee_refund_cents between 1 and new.fee_cents + new.connect_cents and coalesce(new.fee_refund_ref, '') ~ '^(re|pyr)_[A-Za-z0-9_]{1,250}$') then
      raise exception 'fee_refund_badly_written' using hint = 'a card-fee refund is at most the fee, with its own Stripe refund id';
    end if;
  elsif coalesce(new.fee_refund_cents, 0) <> 0 or new.fee_refund_ref is not null then
    raise exception 'fee_refund_badly_written' using hint = 'a card-fee refund belongs on its payment line';
  elsif new.kind = 'release' then
    -- a payout says what it kept and what it sent (the table's own check: sent = paid out - kept); the commission is
    -- worked out by the payment code with pricing_next_commission before it pays out
    if new.commission_cents is null or new.payout_cents is null or new.payout_purpose is null then raise exception 'commission_missing'; end if;
    -- a re-payment after a won chargeback names that chargeback: 'chargeback_won <dispute id>'
    if new.payout_purpose = 'repay' and coalesce(new.note, '') !~ '^chargeback_won [A-Za-z0-9_]{1,255}$' then
      raise exception 'repay_line_names_chargeback' using hint = 'a re-payment line reads ''chargeback_won <dispute id>''';
    end if;
  elsif new.kind = 'reversal' then
    -- a pull-back names its chargeback, as today's code writes it: the ledger check finds each dispute's pull-backs by it
    if coalesce(new.note, '') !~ '^chargeback [A-Za-z0-9_]{1,255}$' then
      raise exception 'reversal_line_names_chargeback' using hint = 'a pull-back line reads ''chargeback <dispute id>''';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists order_payments_pricing on public.order_payments;
create trigger order_payments_pricing before insert on public.order_payments for each row execute function public.order_payments_pricing();

-- the Order's commission total follows its plan 2 payout lines (and nothing else may write it)
create or replace function public.order_payments_pricing_totals()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.pricing_version is null or new.pricing_version < 2 or new.status <> 'succeeded' or new.kind <> 'release' or coalesce(new.commission_cents, 0) = 0 then
    return null;
  end if;
  perform set_config('cuvori.pricing_ledger', 'on', true);
  update public.contracts set commission_cents = commission_cents + new.commission_cents where id = new.order_id;
  perform set_config('cuvori.pricing_ledger', '', true);
  return null;
end $$;
drop trigger if exists order_payments_pricing_totals on public.order_payments;
create trigger order_payments_pricing_totals after insert on public.order_payments for each row execute function public.order_payments_pricing_totals();

-- a plan 2 ledger line stays as it was written; only Stripe's real fee (once), the charge id (once) and the refund of a card
-- fee charged by mistake (once) are added later
create or replace function public.order_payments_pricing_frozen()
returns trigger language plpgsql set search_path = public as $$
begin
  -- every line, of any plan: what it is about and what it says is never changed afterwards (the payment code only ever
  -- adds Stripe's fee and the card-fee refund to a line of today's prices)
  if (new.order_id, new.kind, new.amount_cents, new.fee_cents, new.connect_cents, new.status, new.provider, new.provider_ref, new.pricing_version,
      new.entry_key, new.commission_cents, new.payout_cents, new.payout_purpose)
     is distinct from (old.order_id, old.kind, old.amount_cents, old.fee_cents, old.connect_cents, old.status, old.provider, old.provider_ref, old.pricing_version,
      old.entry_key, old.commission_cents, old.payout_cents, old.payout_purpose) then
    raise exception 'ledger_line_frozen' using hint = 'a ledger line keeps its Order, kind and amounts; record a new line instead';
  end if;
  if old.pricing_version is null or old.pricing_version < 2 then return new; end if;
  if (new.id, new.order_id, new.kind, new.amount_cents, new.fee_cents, new.provider, new.provider_ref, new.status, new.note, new.created_at,
      new.connect_cents, new.entry_key, new.commission_cents,
      new.payout_cents, new.payout_purpose, new.pricing_version)
     is distinct from
     (old.id, old.order_id, old.kind, old.amount_cents, old.fee_cents, old.provider, old.provider_ref, old.status, old.note, old.created_at,
      old.connect_cents, old.entry_key, old.commission_cents,
      old.payout_cents, old.payout_purpose, old.pricing_version)
     -- a card fee charged by mistake (client_charged_card_fee) can be refunded and written on its payment line once:
     -- at most the fee, with the refund's own Stripe id; never changed after that
     or (new.fee_refund_cents is distinct from old.fee_refund_cents
         and not (old.kind = 'fund' and coalesce(old.fee_refund_cents, 0) = 0 and old.fee_refund_ref is null
                  and new.fee_refund_cents between 1 and coalesce(old.fee_cents, 0) + coalesce(old.connect_cents, 0)
                  and coalesce(new.fee_refund_ref, '') ~ '^(re|pyr)_[A-Za-z0-9_]{1,250}$'))
     or (new.fee_refund_ref is distinct from old.fee_refund_ref
         and not (old.kind = 'fund' and old.fee_refund_ref is null and coalesce(old.fee_refund_cents, 0) = 0
                  and coalesce(new.fee_refund_ref, '') ~ '^(re|pyr)_[A-Za-z0-9_]{1,250}$' and coalesce(new.fee_refund_cents, 0) > 0))
     or (new.milestone_id is distinct from old.milestone_id and new.milestone_id is not null)          -- a deleted milestone may clear it
     or (new.provider_fee_cents is distinct from old.provider_fee_cents and (old.provider_fee_cents is not null or new.provider_fee_cents is null or new.provider_fee_cents < 0))
     or (new.charge_ref is distinct from old.charge_ref and old.charge_ref is not null) then
    raise exception 'ledger_line_frozen' using hint = 'a ledger line under the new prices is never changed; record a new line instead';
  end if;
  return new;
end $$;
drop trigger if exists order_payments_pricing_frozen on public.order_payments;
create trigger order_payments_pricing_frozen before update on public.order_payments for each row execute function public.order_payments_pricing_frozen();

-- ---------- 6. the old payment code, the 14 days and disputes on milestones ----------
create or replace function public.order_milestones_pricing()
returns trigger language plpgsql set search_path = public as $$
declare c public.contracts%rowtype;
begin
  select * into c from public.contracts where id = new.order_id;
  if current_user = 'service_role' then
    if (new.status, new.transfer_ref, new.released_at) is distinct from (old.status, old.transfer_ref, old.released_at)
       and c.pricing_version >= 2 and c.payment_mode = 'escrow' and public.pricing_engine() < c.pricing_version then
      raise exception 'pricing_engine_too_old' using hint = 'this Order uses the new prices, which this payment code does not know';
    end if;
  end if;
  -- Every Order paid through Cuvori: a part is paid out of the held payment (approved, by the client or because its days
  -- are over) only while the Order is being worked on and no chargeback is open. During a dispute Cuvori decides; a payout
  -- already begun before the dispute (approved, transfer on its way) is still recorded.
  if c.payment_mode = 'escrow' and old.status in ('pending', 'submitted') and new.status in ('approved', 'released')
     and (c.status not in ('funded', 'delivered') or c.chargeback_status = 'open') then
    raise exception 'release_paused' using hint = 'nothing is paid out while the Order is in dispute, no longer open, or has a chargeback open';
  end if;
  -- Every Order paid through Cuvori (the payment audit of 31 October): while a price increase both sides accepted is
  -- not paid in, a part is handed in only if the money still held covers it, beside the parts already handed in and not
  -- paid out yet. The freelancer never hands in more work than the client has paid for: the parts that are paid for can
  -- still be handed in, the rest once the increase is paid. (An Order from before the money counters, funded_cents 0,
  -- reads as paid at its price, as the payment code reads it; an increase under €0.50 can never be charged and does not
  -- stop it.)
  if c.payment_mode = 'escrow' and old.status = 'pending' and new.status = 'submitted'
     and coalesce(c.amount_cents, 0) - coalesce(nullif(c.funded_cents, 0), c.amount_cents, 0) >= 50
     and coalesce(new.amount_cents, 0) + coalesce((select sum(o.amount_cents) from public.order_milestones o
                                                    where o.order_id = c.id and o.id <> new.id
                                                      and (o.status = 'submitted' or (o.status = 'approved' and o.transfer_ref is null))), 0)
         > coalesce(nullif(c.funded_cents, 0), c.amount_cents, 0) - coalesce(c.released_cents, 0) - coalesce(c.refunded_cents, 0) then
    raise exception 'increase_not_paid' using hint = 'the money paid in covers the parts handed in so far; the rest once the price increase is paid in';
  end if;
  -- under the new prices the review days of a part start with a valid delivery: a link to it
  if c.pricing_version >= 2 and c.payment_mode = 'escrow' and old.status = 'pending' and new.status = 'submitted'
     and coalesce(btrim(new.delivery_url), '') = '' then
    raise exception 'link_required' using hint = 'a part handed in under the new prices needs a link to the work';
  end if;
  return new;
end $$;
drop trigger if exists order_milestones_pricing on public.order_milestones;
create trigger order_milestones_pricing before update on public.order_milestones for each row execute function public.order_milestones_pricing();

-- Every step of the payment code that moves an Order's money first takes a money key naming the Order ('lock:<Order
-- id>', 'transfer:<Order id>:…', 'refund:<Order id>:…', 'checkout:<Order id>:…'), before it calls Stripe. Old code is
-- stopped there, so it never moves money at Stripe for a plan 2 Order (a refused ledger line afterwards would come too
-- late). Closing an open payment page, letting go of an uncharged card hold and sending back a late payment that never
-- went into the Order name a payment, not an Order, and are not stopped here.
create or replace function public.money_keys_pricing()
returns trigger language plpgsql set search_path = public as $$
declare v_order text := split_part(new.scope, ':', 2);
begin
  if current_user <> 'service_role' or v_order !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return new; end if;
  if exists (select 1 from public.contracts c where c.id = v_order::uuid and c.pricing_version >= 2 and c.payment_mode = 'escrow' and public.pricing_engine() < c.pricing_version) then
    raise exception 'pricing_engine_too_old' using hint = 'this Order uses the new prices, which this payment code does not know';
  end if;
  return new;
end $$;
drop trigger if exists money_keys_pricing on public.money_keys;
create trigger money_keys_pricing before insert on public.money_keys for each row execute function public.money_keys_pricing();

-- ---------- 7. Accept, under the prices in force (v38's function, with three additions marked v56) ----------
create or replace function public.order_accept(p_order uuid, p_version integer default null)
returns text language plpgsql security definer set search_path = public as $$
declare c public.contracts%rowtype; me uuid := auth.uid(); cur public.pricing_plans%rowtype;
begin
  if me is null then return 'not_signed_in'; end if;
  select * into c from public.contracts where id = p_order and me in (editor, client) for update;
  if not found then return 'not_found'; end if;
  if public.is_banned(me) or public.is_banned(c.editor) or public.is_banned(c.client) then return 'banned'; end if;
  if c.status <> 'proposed' then return 'not_allowed'; end if;
  -- v38: only the version the person read can be accepted; a page that names none (opened before v38) must reload
  if p_version is distinct from c.terms_version then return 'order_changed'; end if;
  begin perform public.rate_limit('contract_action', 60, interval '1 hour'); exception when others then return 'rate_limited'; end;
  -- v56: an Order is agreed only under the prices in force. When the switch moved since this version was proposed, the
  -- Order becomes a new version with today's prices (the price stamp does that) that both sides read and accept again.
  select p.* into cur from public.pricing_plans p join public.pricing_switch s on s.version = p.version;
  if coalesce(c.pricing_version, 1) <> cur.version then
    update public.contracts set terms_version = terms_version + 1,
           client_accepted_version = coalesce(client_accepted_version, case when proposed_by = client then terms_version end),
           freelancer_accepted_version = coalesce(freelancer_accepted_version, case when proposed_by = editor then terms_version end)
     where id = c.id returning * into c;
    perform public.order_log(c.id, 'prices_changed', jsonb_build_object('version', c.terms_version, 'pricing_version', c.pricing_version,
            'commission_bps', c.commission_bps, 'review_days', c.auto_days));
    -- the chat card says Cuvori's prices changed (a "terms_changed" card reads as a change the person clicking made)
    perform public.contract_event(c, 'prices_changed');
    return 'order_changed';
  end if;
  -- v56: an Order paid through Cuvori under the new prices starts at the plan's minimum (a proposal made at today's
  -- prices may be below it): it must be changed first, nothing is recorded
  if c.pricing_version >= 2 and c.payment_mode = 'escrow' and c.amount_cents < cur.min_project_cents then return 'bad_price'; end if;
  -- Orders made before v18 carry no acceptance columns: whoever proposed had accepted their own draft
  if c.client_accepted_version is null and c.freelancer_accepted_version is null then
    if c.proposed_by = c.client then c.client_accepted_version := c.terms_version; else c.freelancer_accepted_version := c.terms_version; end if;
  end if;
  -- v56: the plan's site rules. When this click makes the Order an agreement, both sides must have accepted them: that
  -- version or a later one, but never a version from after this month (German time) unless it is a price plan's own.
  -- accept_rules takes any month, and "9999-12" would otherwise count for every rules version ever to come.
  if cur.rules_version is not null
     and ((me = c.client and c.freelancer_accepted_version = c.terms_version) or (me <> c.client and c.client_accepted_version = c.terms_version))
     and exists (select 1 from public.profiles pr where pr.id in (c.client, c.editor)
                  and (coalesce(pr.rules_version, '') < cur.rules_version
                       or (pr.rules_version > greatest(cur.rules_version, to_char(now() at time zone 'Europe/Berlin', 'YYYY-MM'))
                           -- a later price plan's own rules, published ahead of their month as plan 2's are, do count
                           and not exists (select 1 from public.pricing_plans pp where pp.rules_version = pr.rules_version)))) then
    return 'rules_not_accepted';
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

-- A proposal is sent or changed only at the prices its sender was shown: the page names the plan its form showed
-- (p_pricing_version; none for an Order paid directly, whose terms the prices don't change). When the switch has moved
-- since, nothing is written ('pricing_changed') and the page shows the prices in force before the person sends again.
-- The switch can't move meanwhile: its row is held until the proposal is written. order_create and order_update (v18)
-- stay as they are (pages from before this update call them).
create or replace function public.order_create_at_prices(p_conv uuid, p jsonb, p_pricing_version integer)
returns uuid language plpgsql security definer set search_path = public as $$
declare cur int;
begin
  select version into cur from public.pricing_switch where id for share;
  if p_pricing_version is not null and p_pricing_version is distinct from cur then
    raise exception 'pricing_changed' using hint = 'the prices changed since the form was drawn';
  end if;
  return public.order_create(p_conv, p);
end $$;
create or replace function public.order_update_at_prices(p_order uuid, p jsonb, p_pricing_version integer)
returns text language plpgsql security definer set search_path = public as $$
declare cur int;
begin
  select version into cur from public.pricing_switch where id for share;
  if p_pricing_version is not null and p_pricing_version is distinct from cur then
    raise exception 'pricing_changed' using hint = 'the prices changed since the form was drawn';
  end if;
  return public.order_update(p_order, p);
end $$;

-- What was agreed (v38), and under the new prices also the prices: the commission and its rounding, who pays the card
-- costs, and the days to review a delivery. An Order at today's prices gets exactly the text it got before.
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
    'freelancer_name', coalesce((select coalesce(nullif(e.display_name, ''), p.first_name) from public.profiles p left join public.editor_profiles e on e.id = p.id where p.id = c.editor), ''))
  || case when c.pricing_version >= 2 then jsonb_build_object('prices', jsonb_build_object(
       'plan', c.pricing_version, 'commission_bps', c.commission_bps, 'rounding', 'half_up', 'review_days', c.auto_days,
       'card_costs_paid_by', case when c.payment_mode = 'escrow' then (select pp.card_costs_paid_by from public.pricing_plans pp where pp.version = c.pricing_version) end))
     else '{}'::jsonb end;
$$;

-- ---------- 8. reading ----------
-- the admin, or you yourself in the SQL editor (a direct database session, never a request through the website's API)
create or replace function public.pricing_staff()
returns boolean language sql stable set search_path = public as $$
  select public.is_admin() or (auth.uid() is null and session_user <> 'authenticator');
$$;

-- the commission for the next payout of p_gross cents: on the running total of what was released before (for the
-- payment code, under the Order's lock)
create or replace function public.pricing_next_commission(p_order uuid, p_gross integer)
returns integer language plpgsql stable security definer set search_path = public as $$
declare c public.contracts%rowtype; before bigint;
begin
  if p_gross is null or p_gross <= 0 then raise exception 'bad_amount'; end if;
  select * into c from public.contracts where id = p_order;
  if not found or c.pricing_version is null then return null; end if;
  select coalesce(sum(amount_cents), 0) into before from public.order_payments
   where order_id = p_order and kind = 'release' and payout_purpose in ('release', 'release_late') and status = 'succeeded';
  return (public.pricing_commission(before + p_gross, c.commission_bps) - public.pricing_commission(before, c.commission_bps))::int;
end $$;

-- what an Order costs and pays, as agreed (both sides and the admin). An Order paid directly between client and
-- freelancer has no card costs through Cuvori: its "card_costs_paid_by" is empty
create or replace function public.order_price_breakdown(p_order uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select case when coalesce(c.pricing_version, 1) < 2 then
      jsonb_build_object('pricing_version', coalesce(c.pricing_version, 1), 'card_costs_paid_by', case when c.payment_mode = 'escrow' then 'client' end, 'price_cents', c.amount_cents,
                         'commission_bps', 0, 'freelancer_receives_cents', c.amount_cents, 'review_days', c.auto_days)
    else jsonb_build_object('pricing_version', c.pricing_version, 'card_costs_paid_by', case when c.payment_mode = 'escrow' then p.card_costs_paid_by end, 'rounding', p.rounding,
                         'price_cents', c.amount_cents, 'client_pays_cents', c.amount_cents,
                         'commission_bps', c.commission_bps,
                         'commission_cents', public.pricing_commission(c.amount_cents, c.commission_bps),
                         'freelancer_receives_cents', c.amount_cents - public.pricing_commission(c.amount_cents, c.commission_bps),
                         'review_days', c.auto_days)
    end
    from public.contracts c left join public.pricing_plans p on p.version = c.pricing_version
   where c.id = p_order and (auth.uid() in (c.editor, c.client) or public.pricing_staff());
$$;

-- the money of an Order, from its ledger (both sides and the admin; the total Stripe charged Cuvori is given to the admin
-- only here, though both people can read their own payment lines, Stripe's fee on them included)
create or replace function public.order_money_summary(p_order uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  with c as (select * from public.contracts where id = p_order and (auth.uid() in (editor, client) or public.pricing_staff())),
  l as (select p.* from public.order_payments p join c on c.id = p.order_id where p.status = 'succeeded'),
  s as (select
      coalesce(sum(amount_cents) filter (where kind = 'fund'), 0) as funded,
      coalesce(sum(amount_cents) filter (where kind = 'release' and coalesce(payout_purpose, case when note like 'chargeback_won%' then 'repay' else 'release' end) in ('release', 'release_late')), 0) as released,
      coalesce(sum(commission_cents) filter (where kind = 'release'), 0) as commission,
      coalesce(sum(coalesce(payout_cents, amount_cents)) filter (where kind = 'release'), 0) as payouts,
      coalesce(sum(amount_cents) filter (where kind = 'release' and coalesce(payout_purpose, case when note like 'chargeback_won%' then 'repay' end) = 'repay'), 0) as repaid,
      -- refunds minus the refunds that failed at Stripe (their money came back to Cuvori)
      coalesce(sum(amount_cents) filter (where kind = 'refund'), 0) - coalesce(sum(amount_cents) filter (where kind = 'refund_failed'), 0) as refunded,
      coalesce(sum(amount_cents) filter (where kind = 'refund_failed'), 0) as refund_failed,
      coalesce(sum(amount_cents) filter (where kind = 'reversal'), 0) as reversed,
      coalesce(sum(amount_cents) filter (where kind = 'chargeback'), 0) as charged_back,
      coalesce(sum(provider_fee_cents) filter (where kind = 'fund'), 0) as card_costs
    from l)
  select jsonb_build_object('pricing_version', coalesce(c.pricing_version, 1), 'agreed_cents', c.amount_cents,
           'commission_bps', coalesce(c.commission_bps, 0),
           'funded_cents', s.funded,
           'released_cents', s.released, 'commission_cents', s.commission, 'payouts_cents', s.payouts, 'repaid_cents', s.repaid,
           'refunded_cents', s.refunded, 'refund_failed_cents', s.refund_failed, 'reversed_cents', s.reversed, 'charged_back_cents', s.charged_back,
           'freelancer_earnings_cents', s.payouts - s.reversed,
           'held_cents', greatest(coalesce(c.funded_cents, 0) - coalesce(c.released_cents, 0) - coalesce(c.refunded_cents, 0), 0))
         || case when public.pricing_staff() then jsonb_build_object('processing_costs_cents', s.card_costs,
              'card_costs_paid_by', case when c.payment_mode <> 'escrow' then null when coalesce(c.pricing_version, 1) >= 2
                then (select pp.card_costs_paid_by from public.pricing_plans pp where pp.version = c.pricing_version) else 'client' end) else '{}'::jsonb end
    from c, s;
$$;

-- the admin's report under the new prices (plan 2 Orders only): money paid in and refunded (refunds minus the refunds that
-- failed at Stripe), the commission, the payouts
-- and what was pulled back from freelancers after chargebacks, what the banks took, and the card costs Cuvori paid; in
-- all and by freelancer. The dates are German dates (a payout at 00:30 on 1 November belongs to November), taken from each
-- line's created_at: a line written afterwards from Stripe's record carries Stripe's own time, so it counts in the month
-- the money moved.
create or replace function public.admin_pricing_report(p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare res jsonb;
begin
  if not public.pricing_staff() then return jsonb_build_object('error', 'forbidden'); end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 400 then return jsonb_build_object('error', 'bad_dates'); end if;
  with l as (select p.*, c.editor from public.order_payments p join public.contracts c on c.id = p.order_id
              where p.pricing_version >= 2 and c.payment_mode = 'escrow' and p.status = 'succeeded'
                and (p.created_at at time zone 'Europe/Berlin')::date between p_from and p_to)
  select jsonb_build_object('from', p_from, 'to', p_to, 'dates', 'Europe/Berlin',
           'totals', jsonb_build_object(
             'paid_in_cents', coalesce(sum(amount_cents) filter (where kind = 'fund'), 0),
             -- refunds minus the refunds that failed at Stripe, each in the month it happened (in the month a refund failed
             -- its money back shows as a minus there), and the failed ones on their own
             'refunded_cents', coalesce(sum(amount_cents) filter (where kind = 'refund'), 0) - coalesce(sum(amount_cents) filter (where kind = 'refund_failed'), 0),
             'refund_failed_cents', coalesce(sum(amount_cents) filter (where kind = 'refund_failed'), 0),
             'commission_cents', coalesce(sum(commission_cents) filter (where kind = 'release'), 0),
             'payouts_cents', coalesce(sum(payout_cents) filter (where kind = 'release'), 0),
             'pulled_back_cents', coalesce(sum(amount_cents) filter (where kind = 'reversal'), 0),
             'charged_back_cents', coalesce(sum(amount_cents) filter (where kind = 'chargeback'), 0),
             'processing_costs_cents', coalesce(sum(provider_fee_cents) filter (where kind = 'fund'), 0)),
           'by_freelancer', coalesce((select jsonb_agg(f order by f->>'freelancer') from (
               select jsonb_build_object('freelancer', editor,
                        'released_cents', coalesce(sum(amount_cents) filter (where kind = 'release' and coalesce(payout_purpose, 'release') in ('release', 'release_late')), 0),
                        'commission_cents', coalesce(sum(commission_cents) filter (where kind = 'release'), 0),
                        'payouts_cents', coalesce(sum(payout_cents) filter (where kind = 'release'), 0),
                        'pulled_back_cents', coalesce(sum(amount_cents) filter (where kind = 'reversal'), 0),
                        'payouts', count(*) filter (where kind = 'release')) as f
                 from l where kind in ('release', 'reversal') group by editor) x), '[]'::jsonb))
    into res from l;
  return res;
end $$;

-- The admin's ledger check over plan 2 Orders. Every money line is recorded as it happened at Stripe (a refused line
-- would hide money that has moved); this check is where anything that does not add up shows. Everywhere in it, what was
-- refunded is the refunds minus the refunds that failed at Stripe (refund_failed: that money came back to Cuvori).
--   problems (should be empty; ask for help with each Order listed):
--     commission_off           the commission kept is not exactly the commission on everything paid out (a re-payment
--                              that kept something again counts here too)
--     totals_differ            the Order's commission total differs from its ledger lines
--     paid_more_than_agreed    more was paid in (after refunds and what a bank took back) than the agreed price
--     client_charged_card_fee  a payment charged the client card costs, which Cuvori pays under the new prices, and they
--                              were not refunded (a refund is written on the payment's line)
--     more_out_than_in         refunds, chargebacks and payouts (net of pull-backs) are more than was paid in: money went
--                              out twice (for example a refund made in the Stripe dashboard after the payout)
--     commission_without_money more commission is booked than the money Cuvori still has from the Order (for example
--                              a small refund made in the Stripe dashboard after the payout; a bigger one is listed as
--                              more_out_than_in)
--     repay_off                a re-payment after a chargeback without a won chargeback, or more than it pulled back
--     money_left_at_cuvori     a finished Order left Cuvori with more than its commission (for example a divided dispute
--                              decision that took the 5% out of the client's refund instead of the freelancer's share);
--                              not while a chargeback is open or the Order notes a won one's re-payment as owed, nor when
--                              line_missing
--     commission_twice         normal payouts add up to more than was paid in, so 5% was kept on money paid out twice:
--                              for example money pulled back after a chargeback that went out again as a normal payout
--                              instead of a re-payment
--     chargeback_not_recorded  a chargeback was lost but its lines show less than the bank took (for example its pull-back
--                              failed and only what Cuvori still held was written): Cuvori lost the rest
--     line_missing             the Order counts more money paid in, paid out or refunded than its ledger lines show: a
--                              line was not written (the payment code's hourly run is to add it from Stripe's record; today's
--                              code does that only for some kinds of lines; if it stays, by hand)
--   and on every Order paid through Cuvori, at any prices (the payment audit of 31 October):
--     counter_behind_ledger    the Order counts less money paid in, paid out or refunded than its ledger lines show: a
--                              line was written but the Order's total not raised, so the next payout or refund would move
--                              the same money again (also after a refund made in the Stripe dashboard once the freelancer
--                              was paid: the Order then counts only what it still held, and the money went out twice)
--     milestone_payout_off     a part has more than one normal payout line (paid out twice), or its payout lines add up to
--                              another amount than the part's
--     payment_line_twice       one Stripe payment has more than one payment line (written before v56: since v56 the
--                              database takes one only)
--   to_decide (your decision, see SETUP.md Part 20):
--     commission_on_pulled_back_payout  a payout was pulled back after a chargeback that was not lost, and not paid back
--                                    as a re-payment: the 5% kept on it is still booked, whether that money then went
--                                    back to the client or out again as a normal payout (then the 5% was kept twice)
--     commission_on_lost_chargeback  a chargeback was lost after the payout and the payout was pulled back, but the 5%
--                                    is still booked as commission
create or replace function public.admin_pricing_check()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare res jsonb; n int;
begin
  if not public.pricing_staff() then return jsonb_build_object('error', 'forbidden'); end if;
  select count(*) into n from public.contracts where pricing_version >= 2 and payment_mode = 'escrow';
  with o as (select c.id, c.status, c.commission_bps, c.commission_cents, c.amount_cents, c.chargeback_status, c.chargeback_id, c.money_error, c.chargeback_cents,
                    coalesce(c.funded_cents, 0) as count_in, coalesce(c.released_cents, 0) as count_out, coalesce(c.refunded_cents, 0) as count_back,
                    coalesce(sum(p.amount_cents) filter (where p.kind = 'release' and p.payout_purpose in ('release', 'release_late')), 0) as released,
                    coalesce(sum(p.amount_cents) filter (where p.kind = 'release'), 0) as released_all,
                    coalesce(sum(p.commission_cents) filter (where p.kind = 'release'), 0) as kept,
                    coalesce(sum(p.amount_cents) filter (where p.kind = 'fund'), 0) as paid_in,
                    coalesce(sum(coalesce(p.fee_cents, 0) + coalesce(p.connect_cents, 0) - coalesce(p.fee_refund_cents, 0)) filter (where p.kind = 'fund'), 0) as card_fees,
                    -- refunds minus the refunds that failed at Stripe (their money came back to Cuvori)
                    coalesce(sum(p.amount_cents) filter (where p.kind = 'refund'), 0) - coalesce(sum(p.amount_cents) filter (where p.kind = 'refund_failed'), 0) as refunded,
                    coalesce(sum(p.amount_cents) filter (where p.kind = 'chargeback'), 0) as to_bank,
                    coalesce(sum(p.payout_cents) filter (where p.kind = 'release'), 0) as payouts,
                    coalesce(sum(p.amount_cents) filter (where p.kind = 'reversal'), 0) as pulled_back,
                    coalesce(sum(p.amount_cents) filter (where p.kind = 'release' and p.payout_purpose = 'repay'), 0) as repaid_total
               from public.contracts c left join public.order_payments p on p.order_id = c.id and p.status = 'succeeded'
              where c.pricing_version >= 2 and c.payment_mode = 'escrow' group by c.id),
  -- the to-decide case (a lost chargeback after the payout, its 5% still booked): listed there, not as a problem
  -- (each dispute on its own: a pull-back for that very dispute; found by its lines too, so a later chargeback on the
  -- same Order does not hide it, and a pull-back for another, won, dispute does not count)
  od as (select o.*, ((coalesce(chargeback_status, '') = 'lost' and exists (
                  select 1 from public.order_payments r where r.order_id = o.id and r.kind = 'reversal' and r.status = 'succeeded'
                                                          and r.note = 'chargeback ' || o.chargeback_id)) or exists (
                  select 1 from public.order_payments l join public.order_payments r on r.order_id = l.order_id and r.kind = 'reversal' and r.status = 'succeeded'
                                                                                     and r.note = 'chargeback ' || l.provider_ref
                   where l.order_id = o.id and l.kind = 'chargeback' and l.status = 'succeeded')) and kept > 0 as lost_cb,
                -- the Order's own chargeback now (won, but what it pulled back not yet paid again): counted by that dispute only
                coalesce((select sum(r.amount_cents) from public.order_payments r where r.order_id = o.id and r.kind = 'reversal' and r.status = 'succeeded'
                            and r.note = 'chargeback ' || o.chargeback_id), 0) as cb_pulled,
                coalesce((select sum(r.amount_cents) from public.order_payments r where r.order_id = o.id and r.kind = 'release' and r.payout_purpose = 'repay'
                            and r.status = 'succeeded' and r.note = 'chargeback_won ' || o.chargeback_id), 0) as cb_repaid,
                -- each lost chargeback on its own (its chargeback line, and the pull-backs that name it): what it took of the 5%
                -- Cuvori kept (the bank took more than came back from the freelancer, but at most the 5% kept on what came back:
                -- a chargeback on money Cuvori still held takes none of it; worked back from what came back, rounded up, so
                -- never a cent below the 5% kept, which was rounded half up on the whole amount), and what was pulled back for it
                coalesce((select sum(greatest(0, least(x.taken - x.pulled, ceil(x.pulled::numeric * o.commission_bps / (10000 - o.commission_bps))::bigint)))
                            from (select l.amount_cents as taken,
                                         coalesce((select sum(r.amount_cents) from public.order_payments r where r.order_id = l.order_id and r.kind = 'reversal'
                                                     and r.status = 'succeeded' and r.note = 'chargeback ' || l.provider_ref), 0) as pulled
                                    from public.order_payments l where l.order_id = o.id and l.kind = 'chargeback' and l.status = 'succeeded') x), 0) as lost_loss,
                coalesce((select sum(r.amount_cents) from public.order_payments r where r.order_id = o.id and r.kind = 'reversal' and r.status = 'succeeded'
                            and exists (select 1 from public.order_payments l where l.order_id = o.id and l.kind = 'chargeback' and l.status = 'succeeded'
                                          and r.note = 'chargeback ' || l.provider_ref)), 0) as lost_pulled,
                -- what the lines say the bank took for the Order's own chargeback now
                coalesce((select sum(l.amount_cents) from public.order_payments l where l.order_id = o.id and l.kind = 'chargeback' and l.status = 'succeeded'
                            and l.provider_ref = o.chargeback_id), 0) as cb_recorded,
                paid_in - refunded - to_bank - (payouts - pulled_back) as still_here
           from o),
  -- re-payments by chargeback: what was paid again for each dispute, what that dispute pulled back, and whether it was won
  rp as (select p.order_id as id, substring(p.note from '^chargeback_won (.+)$') as dispute, sum(p.amount_cents) as repaid
           from public.order_payments p join od on od.id = p.order_id
          where p.kind = 'release' and p.payout_purpose = 'repay' and p.status = 'succeeded' group by 1, 2),
  rp2 as (select rp.*, coalesce((select sum(r.amount_cents) from public.order_payments r where r.order_id = rp.id and r.kind = 'reversal' and r.status = 'succeeded'
                                   and r.note = 'chargeback ' || rp.dispute), 0) as pulled,
                 exists (select 1 from public.contracts c where c.id = rp.id and c.chargeback_id = rp.dispute and c.chargeback_status = 'won')
                 or exists (select 1 from public.order_events e where e.order_id = rp.id and e.event = 'chargeback_won' and e.data->>'chargeback' = rp.dispute) as won
            from rp),
  -- every Order paid through Cuvori, at any prices: its totals against its lines. An Order from before the money
  -- counters (funded_cents 0 while it holds money) reads as paid in at its price, as the payment code reads it
  e as (select c.id, coalesce(c.released_cents, 0) as count_out, coalesce(c.refunded_cents, 0) as count_back,
               case when coalesce(c.funded_cents, 0) = 0 and c.status in ('funded', 'delivered', 'disputed', 'releasing', 'resolving')
                    then coalesce(c.amount_cents, 0) else coalesce(c.funded_cents, 0) end as count_in,
               coalesce(sum(p.amount_cents) filter (where p.kind = 'fund'), 0) as lines_in,
               coalesce(sum(p.amount_cents) filter (where p.kind = 'release'), 0) - coalesce(sum(p.amount_cents) filter (where p.kind = 'reversal'), 0) as lines_out,
               -- a plan 2 line that says what of it the Order counts ("dashboard_refund counted <cents>": a refund made in
               -- the dashboard after the money was paid out; "chargeback_lost counted <cents>": the bank took the payment in
               -- full, the Order counts what Cuvori still held) takes that part; every other line counts whole
               coalesce(sum(case when p.pricing_version >= 2 and p.note ~ '^(dashboard_refund|chargeback_lost) counted [0-9]{1,12}$'
                                 then least(substring(p.note from ' counted ([0-9]{1,12})$')::bigint, p.amount_cents::bigint)
                                 else p.amount_cents end) filter (where p.kind in ('refund', 'chargeback')), 0)
                 - coalesce(sum(p.amount_cents) filter (where p.kind = 'refund_failed'), 0) as lines_back
          from public.contracts c left join public.order_payments p on p.order_id = c.id and p.status = 'succeeded'
         where c.payment_mode = 'escrow' group by c.id),
  -- each part's normal payout lines (a re-payment after a won chargeback is not one; at today's prices its line reads
  -- "chargeback_won"). A payout from money held apart at Stripe (funds segregation, not on yet) is made of one transfer per
  -- payment it comes from, each line naming its payment (charge_ref), and at most one more from Cuvori's balance: such
  -- lines together are the part's one payout.
  mp as (select m.order_id as id, m.id as milestone, m.amount_cents, count(*) as lines, sum(p.amount_cents) as paid,
                count(*) filter (where p.charge_ref is null) as unlinked, count(p.charge_ref) as linked, count(distinct p.charge_ref) as charges
           from public.order_milestones m join public.contracts c on c.id = m.order_id and c.payment_mode = 'escrow'
           join public.order_payments p on p.milestone_id = m.id and p.kind = 'release' and p.status = 'succeeded'
                and coalesce(p.payout_purpose, case when p.note like 'chargeback_won%' then 'repay' else 'release' end) in ('release', 'release_late')
          group by m.order_id, m.id, m.amount_cents),
  -- one Stripe payment written on more than one payment line (only lines from before v56 can be)
  pt as (select distinct p.order_id as id, p.provider_ref as payment, d.lines
           from public.order_payments p
           join (select provider_ref, count(*) as lines from public.order_payments where kind = 'fund' and provider = 'stripe' and provider_ref is not null
                  group by provider_ref having count(*) > 1) d on d.provider_ref = p.provider_ref
           join public.contracts c on c.id = p.order_id and c.payment_mode = 'escrow'
          where p.kind = 'fund' and p.provider = 'stripe'),
  bad as (
    select jsonb_build_object('order', id, 'problem', 'commission_off', 'kept_cents', kept, 'expected_cents', public.pricing_commission(released, commission_bps)) as b
      from od where kept <> public.pricing_commission(released, commission_bps)
    union all
    select jsonb_build_object('order', id, 'problem', 'totals_differ', 'commission', commission_cents, 'ledger_commission', kept)
      from od where commission_cents <> kept
    union all
    select jsonb_build_object('order', id, 'problem', 'paid_more_than_agreed', 'agreed_cents', amount_cents, 'paid_in_cents', paid_in, 'refunded_cents', refunded, 'to_bank_cents', to_bank)
      from od where paid_in - refunded - to_bank > amount_cents
    union all
    select jsonb_build_object('order', id, 'problem', 'client_charged_card_fee', 'card_fee_cents', card_fees)
      from od where card_fees > 0
    union all
    select jsonb_build_object('order', id, 'problem', 'more_out_than_in', 'paid_in_cents', paid_in, 'refunded_cents', refunded, 'to_bank_cents', to_bank,
                              'sent_to_freelancer_cents', payouts - pulled_back)
      from od where still_here < 0
    union all
    select jsonb_build_object('order', id, 'problem', 'commission_without_money', 'commission_cents', kept, 'still_here_cents', still_here)
      from od where still_here >= 0 and still_here < kept - lost_loss   -- a lost chargeback explains only the 5% it took
    union all
    select jsonb_build_object('order', id, 'problem', 'repay_off', 'chargeback', dispute, 'repaid_cents', repaid, 'pulled_back_cents', pulled, 'won', won)
      from rp2 where repaid > pulled or not won
    union all
    select jsonb_build_object('order', id, 'problem', 'money_left_at_cuvori', 'still_here_cents', still_here, 'commission_cents', kept)
      from od where status in ('completed', 'refunded', 'cancelled') and still_here > kept
        and coalesce(chargeback_status, '') <> 'open'                                  -- the bank has that money for now
        -- won, not yet paid again, and the Order notes it as owed (the hourly run pays it). Without that note nothing will
        -- pay it (today's code drops it when the chargeback is won while the Order still holds money): listed
        and not (coalesce(chargeback_status, '') = 'won' and cb_pulled > cb_repaid and coalesce(money_error, '') like 'chargeback won%')
        and not (count_in > paid_in or count_out > released_all - pulled_back or count_back > refunded + to_bank)   -- listed as line_missing
    union all
    -- normal payouts never add up to more than was paid in: money pulled back after a chargeback that went out again as a
    -- normal payout (instead of a re-payment) had its 5% kept a second time
    select jsonb_build_object('order', id, 'problem', 'commission_twice', 'paid_out_cents', released, 'paid_in_cents', paid_in, 'commission_cents', kept)
      from od where released > paid_in
    union all
    select jsonb_build_object('order', id, 'problem', 'chargeback_not_recorded', 'chargeback', chargeback_id, 'bank_took_cents', chargeback_cents, 'recorded_cents', cb_recorded)
      from od where coalesce(chargeback_status, '') = 'lost' and chargeback_cents is not null and cb_recorded < chargeback_cents
    union all
    select jsonb_build_object('order', id, 'problem', 'line_missing', 'counted_in_cents', count_in, 'lines_in_cents', paid_in,
                              'counted_out_cents', count_out, 'lines_out_cents', released_all - pulled_back, 'counted_back_cents', count_back, 'lines_back_cents', refunded + to_bank)
      from od where count_in > paid_in or count_out > released_all - pulled_back or count_back > refunded + to_bank
    union all
    -- a line written but the Order's total not raised: the next payout or refund would move the same money again
    select jsonb_build_object('order', id, 'problem', 'counter_behind_ledger', 'counted_in_cents', count_in, 'lines_in_cents', lines_in,
                              'counted_out_cents', count_out, 'lines_out_cents', lines_out, 'counted_back_cents', count_back, 'lines_back_cents', lines_back)
      from e where count_in < lines_in or count_out < lines_out or count_back < lines_back
    union all
    select jsonb_build_object('order', id, 'problem', 'milestone_payout_off', 'milestone', milestone, 'milestone_cents', amount_cents,
                              'payout_lines', lines, 'paid_out_cents', paid)
      from mp where paid <> amount_cents or (lines > 1 and (unlinked > 1 or charges <> linked))
    union all
    select jsonb_build_object('order', id, 'problem', 'payment_line_twice', 'payment', payment, 'lines', lines)
      from pt),
  decide as (
    select jsonb_build_object('order', id, 'item', 'commission_on_lost_chargeback', 'commission_cents', kept, 'lost_part_commission_cents', least(kept, lost_loss),
                              'pulled_back_cents', pulled_back) as d
      from od where lost_cb
    union all
    -- a payout pulled back after a chargeback that was not lost, and not paid back as a re-payment: the 5% kept on it is
    -- still booked though the freelancer kept nothing of it, whether that money then went back to the client or out again
    -- as a normal payout (then the 5% was kept twice). Not while the money is still at Cuvori (money_left_at_cuvori)
    select jsonb_build_object('order', id, 'item', 'commission_on_pulled_back_payout', 'commission_cents', kept, 'pulled_back_cents', pulled_back - lost_pulled - repaid_total)
      from od where status in ('completed', 'refunded', 'cancelled') and coalesce(chargeback_status, '') <> 'open'
        and pulled_back - lost_pulled > repaid_total and kept > 0 and still_here <= kept)
  select jsonb_build_object('orders_checked', n, 'problems', coalesce((select jsonb_agg(b) from bad), '[]'::jsonb),
                            'to_decide', coalesce((select jsonb_agg(d) from decide), '[]'::jsonb)) into res;
  return res;
end $$;

-- ---------- 9. who may read, write and call what ----------
alter table public.pricing_plans enable row level security;
alter table public.pricing_switch enable row level security;
alter table public.pricing_switch_log enable row level security;
drop policy if exists "everyone reads price plans" on public.pricing_plans;
create policy "everyone reads price plans" on public.pricing_plans for select to anon, authenticated using (true);
drop policy if exists "everyone reads the price switch" on public.pricing_switch;
create policy "everyone reads the price switch" on public.pricing_switch for select to anon, authenticated using (true);
drop policy if exists "admins read the price switch log" on public.pricing_switch_log;
create policy "admins read the price switch log" on public.pricing_switch_log for select to authenticated using (public.is_admin());
-- nobody but the owner writes these tables, not even the payment functions (which pass row security)
revoke all on table public.pricing_plans, public.pricing_switch, public.pricing_switch_log from public, anon, authenticated, service_role;
grant select on table public.pricing_plans to anon, authenticated, service_role;
-- which plan is on, but not your note on it (the page reads the prices with pricing_now())
grant select (id, version, changed_at) on table public.pricing_switch to anon, authenticated;
grant select on table public.pricing_switch to service_role;
grant select on table public.pricing_switch_log to authenticated;
revoke all on sequence public.pricing_switch_log_id_seq from public, anon, authenticated, service_role;

revoke execute on function public.pricing_plans_guard(), public.pricing_switch_logged(), public.contracts_pricing(), public.order_amendments_pricing(),
  public.order_payments_pricing(), public.order_payments_pricing_totals(), public.order_payments_pricing_frozen(), public.order_milestones_pricing(), public.money_keys_pricing(),
  public.pricing_switch_to(integer, text), public.pricing_next_commission(uuid, integer), public.pricing_engine(),
  public.pricing_now(), public.pricing_commission(bigint, integer), public.order_price_breakdown(uuid), public.order_money_summary(uuid),
  public.admin_pricing_report(date, date), public.admin_pricing_check(), public.pricing_staff(),
  public.order_create_at_prices(uuid, jsonb, integer), public.order_update_at_prices(uuid, jsonb, integer) from public, anon, authenticated, service_role;
grant execute on function public.order_create_at_prices(uuid, jsonb, integer), public.order_update_at_prices(uuid, jsonb, integer) to authenticated;
grant execute on function public.pricing_now(), public.pricing_commission(bigint, integer) to anon, authenticated, service_role;
grant execute on function public.pricing_engine() to service_role;
grant execute on function public.pricing_next_commission(uuid, integer) to service_role;
grant execute on function public.order_price_breakdown(uuid), public.order_money_summary(uuid) to authenticated;
grant execute on function public.admin_pricing_report(date, date), public.admin_pricing_check() to authenticated;

-- ---------- 10. every Order, from the moment v56 runs (the payment audit of 31 October) ----------
-- On every Order paid through Cuvori:
--   * the work is delivered only once every price increase both sides accepted is paid in (the money is there before
--     the work is done); an Order already delivered whose price goes up is back to being worked on, its automatic
--     payout stopped: the client pays the increase, then the freelancer delivers again (a part is handed in while the
--     money paid in covers it: section 6).
--     An Order from before the money counters (funded_cents 0) reads as paid at its price, as the payment code reads
--     it; an increase under €0.50 can never be charged and does not stop it. Its price can no longer change at all
--     ("order_needs_check"): read as paid at the NEW price, an accepted increase would have counted as paid and been paid
--     out of other clients' money (check of 1 November). Its paid-in total is set from its payment lines first, by hand.
--   * the payment code starts paying out a whole Order only while it is being worked on (paid in or delivered) and no
--     chargeback is open. Cuvori's decision on a dispute is not a payout of this kind: the payment code moves a disputed
--     Order to "resolving" for it, and that goes through as before. An automatic payout (no approval: nobody named as
--     having decided) starts only once the Order's review period is over ("release_too_early").
create or replace function public.contracts_money_first()
returns trigger language plpgsql set search_path = public as $$
declare owed int;
begin
  if new.payment_mode is distinct from 'escrow' then return new; end if;
  if new.amount_cents is distinct from old.amount_cents and coalesce(old.funded_cents, 0) = 0
     and old.status in ('funded', 'delivered', 'disputed', 'releasing', 'resolving') then
    raise exception 'order_needs_check' using hint = 'this Order records nothing paid in: its paid-in total is set from its payment lines before its price can change';
  end if;
  owed := greatest(coalesce(new.amount_cents, 0) - coalesce(nullif(new.funded_cents, 0), new.amount_cents, 0), 0);
  if owed >= 50 then
    if old.status = 'delivered' and new.status = 'delivered' and new.amount_cents > old.amount_cents then
      new.status := 'funded'; new.auto_release_at := null;
    elsif new.status = 'delivered' and old.status is distinct from 'delivered' then
      raise exception 'increase_not_paid' using hint = 'the price increase is paid in before the work is delivered';
    end if;
  end if;
  if current_user = 'service_role' and new.status = 'releasing' and new.resolution = 'release'
     and (old.status is distinct from 'releasing' or old.resolution is distinct from 'release')
     and (old.status not in ('funded', 'delivered') or coalesce(old.chargeback_status, '') = 'open' or coalesce(new.chargeback_status, '') = 'open') then
    raise exception 'release_paused' using hint = 'a whole Order is paid out only while it is being worked on and no chargeback is open';
  end if;
  -- an automatic payout (nobody approved it: no one is named as having decided) starts only once the Order's review period
  -- is over; the client's approval names the client, and Cuvori's decision goes through "resolving"
  if current_user = 'service_role' and new.status = 'releasing' and new.resolution = 'release' and new.resolved_by is null
     and (old.status is distinct from 'releasing' or old.resolution is distinct from 'release')
     and (old.auto_release_at is null or old.auto_release_at > now()) then
    raise exception 'release_too_early' using hint = 'an automatic payout starts only once the review period is over';
  end if;
  return new;
end $$;
drop trigger if exists contracts_money_first on public.contracts;
create trigger contracts_money_first before update on public.contracts for each row execute function public.contracts_money_first();
revoke execute on function public.contracts_money_first() from public, anon, authenticated, service_role;

-- The Order's buttons (v38's function, with one change marked v56): an Order paid directly that the client approves
-- records as paid out what the freelancer confirmed as paid in, the same amount on its total and on its line (a price
-- increase accepted after the payment was confirmed is not money Cuvori saw; v38 wrote the new price on the line and
-- kept the old one on the total).
create or replace function public.order_action(p_order uuid, p_action text, p_note text default null, p_link text default null, p_version integer default null)
returns text language plpgsql security definer set search_path = public as $$
declare c public.contracts%rowtype; me uuid := auth.uid(); ev text := p_action;
begin
  if me is null then return 'not_signed_in'; end if;
  select * into c from public.contracts where id = p_order and me in (editor, client) for update;
  if not found then return 'not_found'; end if;
  if public.is_banned(me) then return 'banned'; end if;
  p_note := nullif(btrim(coalesce(p_note, '')), ''); p_link := nullif(btrim(coalesce(p_link, '')), '');
  if length(coalesce(p_note, '')) > 2000 then return 'note_too_long'; end if;
  if p_link is not null and not public.is_safe_url(p_link) then return 'bad_link'; end if;
  begin perform public.rate_limit('contract_action', 60, interval '1 hour'); exception when others then return 'rate_limited'; end;
  if p_action = 'accept' then return public.order_accept(p_order, p_version);
  elsif p_action = 'decline' then
    if c.status <> 'proposed' or c.proposed_by = me then return 'not_allowed'; end if;
    update public.contracts set status = 'declined', closed_at = now() where id = c.id returning * into c;
    perform public.order_log(c.id, 'declined', jsonb_build_object('note', p_note));
  elsif p_action = 'cancel' then
    -- before money is held either side can walk away; a funded Order ends only by approval, refund or Cuvori's decision
    if c.status in ('proposed','accepted') then null;
    elsif c.payment_mode = 'direct' and c.status in ('paid_marked') then null;
    else return 'not_allowed'; end if;
    update public.contracts set status = 'cancelled', closed_at = now() where id = c.id returning * into c;
    perform public.order_log(c.id, 'cancelled', jsonb_build_object('note', p_note));
  elsif p_action = 'mark_paid' then
    if c.payment_mode <> 'direct' or c.status <> 'accepted' or me <> c.client then return 'not_allowed'; end if;
    update public.contracts set status = 'paid_marked', paid_marked_at = now() where id = c.id returning * into c;
    perform public.order_log(c.id, 'paid_marked', '{}'::jsonb);
  elsif p_action = 'confirm_paid' then
    if c.payment_mode <> 'direct' or c.status not in ('accepted','paid_marked') or me <> c.editor then return 'not_allowed'; end if;
    update public.contracts set status = 'paid', paid_at = now(), paid_marked_at = coalesce(paid_marked_at, now()), funded_cents = amount_cents where id = c.id returning * into c;
    insert into public.order_payments (order_id, kind, amount_cents, provider, note) values (c.id, 'fund', c.amount_cents, 'direct', 'confirmed by the freelancer');
    perform public.order_log(c.id, 'paid_confirmed', jsonb_build_object('amount_cents', c.amount_cents));
  elsif p_action = 'complete' then
    if c.payment_mode <> 'direct' or c.status <> 'paid' or me <> c.client then return 'not_allowed'; end if;
    -- v56: the total and the line say the same: what was confirmed as paid (an Order from before the money counters,
    -- funded_cents 0, its price, as before)
    -- (and the paid-in total of an Order confirmed before the counters, so paid out never exceeds paid in: check of 1 November)
    update public.contracts set status = 'completed', completed_at = now(), closed_at = now(), released_cents = coalesce(nullif(funded_cents, 0), amount_cents),
           funded_cents = coalesce(nullif(funded_cents, 0), amount_cents) where id = c.id returning * into c;
    insert into public.order_payments (order_id, kind, amount_cents, provider, note) values (c.id, 'release', c.released_cents, 'direct', 'work approved by the client');
    perform public.order_log(c.id, 'completed', '{}'::jsonb);
  elsif p_action = 'deliver' then
    if c.status not in ('funded','paid') or me <> c.editor or c.has_milestones then return 'not_allowed'; end if;
    if c.payment_mode = 'escrow' then
      update public.contracts set status = 'delivered', delivered_at = now(), delivery_note = p_note, delivery_url = p_link, changes_open = false,
             auto_release_at = now() + (coalesce(c.auto_days, 7) || ' days')::interval where id = c.id returning * into c;
    else
      update public.contracts set delivered_at = now(), delivery_note = p_note, delivery_url = p_link, changes_open = false where id = c.id returning * into c;
    end if;
    perform public.order_log(c.id, 'delivered', jsonb_build_object('note', p_note, 'link', p_link));
  elsif p_action = 'request_changes' then
    if me <> c.client then return 'not_allowed'; end if;
    if c.payment_mode = 'escrow' then
      if c.status <> 'delivered' then return 'not_allowed'; end if;
      -- within the paid revision rounds the review clock stops; after them it keeps running (a dispute is the route then)
      if c.changes_used < coalesce(c.revisions, 0) then
        update public.contracts set status = 'funded', changes_used = c.changes_used + 1, changes_open = true, auto_release_at = null where id = c.id returning * into c;
      else
        update public.contracts set changes_used = c.changes_used + 1, changes_open = true where id = c.id returning * into c;
      end if;
    else
      if c.status not in ('paid','paid_marked','accepted') or c.delivered_at is null then return 'not_allowed'; end if;
      update public.contracts set changes_used = c.changes_used + 1, changes_open = true where id = c.id returning * into c;
    end if;
    if p_note is not null then insert into public.messages (conversation_id, sender, kind, body) values (c.conversation_id, me, 'change_request', p_note); end if;
    perform public.order_log(c.id, 'changes_requested', jsonb_build_object('note', p_note, 'round', c.changes_used));
  elsif p_action = 'dispute' then
    if c.payment_mode <> 'escrow' or c.status not in ('funded','delivered') then return 'not_allowed'; end if;
    update public.contracts set status = 'disputed', dispute_by = me, dispute_reason = p_note, disputed_at = now(), auto_release_at = null where id = c.id returning * into c;
    update public.order_milestones set auto_release_at = null where order_id = c.id;
    perform public.order_log(c.id, 'disputed', jsonb_build_object('note', p_note));
  else return 'bad_action'; end if;
  perform public.contract_event(c, ev);
  return 'ok';
end $$;

-- A part's buttons (v43's function, with one change marked v56): the Order is locked first and then the part, in the
-- same order as the Order's own buttons (a dispute locks the Order and then its parts). The other way round, a part
-- handed in at the same moment as a dispute was opened made each wait for the other until Postgres stopped one of
-- them ("deadlock detected").
create or replace function public.order_milestone_action(p_ms uuid, p_action text, p_note text default null, p_link text default null)
returns text language plpgsql security definer set search_path = public as $$
declare m public.order_milestones%rowtype; c public.contracts%rowtype; me uuid := auth.uid(); left_open int; v_order uuid;
begin
  if me is null then return 'not_signed_in'; end if;
  -- v56: the Order first, then the part
  select order_id into v_order from public.order_milestones where id = p_ms;
  if not found then return 'not_found'; end if;
  select * into c from public.contracts where id = v_order and me in (editor, client) for update;
  if not found then return 'not_found'; end if;
  select * into m from public.order_milestones where id = p_ms and order_id = c.id for update;
  if not found then return 'not_found'; end if;
  if public.is_banned(me) then return 'banned'; end if;
  p_note := nullif(btrim(coalesce(p_note, '')), ''); p_link := nullif(btrim(coalesce(p_link, '')), '');
  if length(coalesce(p_note, '')) > 2000 then return 'note_too_long'; end if;
  if p_link is not null and not public.is_safe_url(p_link) then return 'bad_link'; end if;
  begin perform public.rate_limit('contract_action', 60, interval '1 hour'); exception when others then return 'rate_limited'; end;
  if p_action = 'submit' then
    if me <> c.editor or c.status not in ('funded','paid') or m.status <> 'pending' then return 'not_allowed'; end if;
    update public.order_milestones set status = 'submitted', submitted_at = now(), delivery_note = p_note, delivery_url = p_link,
           auto_release_at = case when c.payment_mode = 'escrow' then now() + (coalesce(c.auto_days, 7) || ' days')::interval end where id = m.id returning * into m;
    update public.contracts set changes_open = false where id = c.id returning * into c;
    perform public.order_log(c.id, 'milestone_submitted', jsonb_build_object('milestone', m.id, 'title', m.title, 'amount_cents', m.amount_cents, 'note', p_note, 'link', p_link));
    perform public.order_amount_event(c, 'milestone_submitted', m.amount_cents, m.title);
  elsif p_action = 'request_changes' then
    -- v43: only while the Order is open for work (as the Order screen shows the button), never during a dispute or after it ended
    if me <> c.client or m.status <> 'submitted'
       or not ((c.payment_mode = 'escrow' and c.status = 'funded') or (c.payment_mode = 'direct' and c.status = 'paid')) then return 'not_allowed'; end if;
    if c.changes_used < coalesce(c.revisions, 0) then
      update public.order_milestones set status = 'pending', auto_release_at = null where id = m.id returning * into m;
      update public.contracts set changes_used = c.changes_used + 1, changes_open = true where id = c.id returning * into c;
    else
      update public.contracts set changes_used = c.changes_used + 1, changes_open = true where id = c.id returning * into c;   -- clock keeps running
    end if;
    if p_note is not null then insert into public.messages (conversation_id, sender, kind, body) values (c.conversation_id, me, 'change_request', p_note); end if;
    perform public.order_log(c.id, 'milestone_changes_requested', jsonb_build_object('milestone', m.id, 'title', m.title, 'note', p_note, 'round', c.changes_used));
    perform public.order_amount_event(c, 'request_changes', m.amount_cents, m.title);
  elsif p_action = 'approve' then
    -- direct payments only: approval records agreement, the money moved outside Cuvori
    if me <> c.client or c.payment_mode <> 'direct' or c.status <> 'paid' or m.status <> 'submitted' then return 'not_allowed'; end if;   -- v43: only while open
    update public.order_milestones set status = 'approved', approved_at = now() where id = m.id returning * into m;
    perform public.order_log(c.id, 'milestone_approved', jsonb_build_object('milestone', m.id, 'title', m.title, 'amount_cents', m.amount_cents));
    perform public.order_amount_event(c, 'milestone_approved', m.amount_cents, m.title);
    select count(*) into left_open from public.order_milestones where order_id = c.id and status not in ('approved','released');
    if left_open = 0 then update public.contracts set delivered_at = now() where id = c.id; end if;
  else return 'bad_action'; end if;
  return 'ok';
end $$;

-- Reading an Order's payment lines. Both sides of an Order read each line's amounts, its card fee, Stripe's fee on it,
-- the 5% kept and what was sent; the page uses no more. A line's Stripe ids (provider_ref, charge_ref, fee_refund_ref),
-- its entry key and its note (it names Stripe disputes) are for the payment code and the admin only, in the table and
-- in the Order screen's data (order_bundle, v18's function with one change marked v56). An Order's own row stays
-- readable whole by its two sides: the page reads it with select('*'), which needs every column.
revoke select on table public.order_payments from authenticated;
grant select (id, order_id, milestone_id, kind, amount_cents, fee_cents, provider, status, created_at, provider_fee_cents, fee_refund_cents,
              connect_cents, commission_cents, payout_cents, payout_purpose, pricing_version) on table public.order_payments to authenticated;
create or replace function public.order_bundle(p_order uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'order', to_jsonb(c),
    'milestones', coalesce((select jsonb_agg(to_jsonb(m) order by m.position) from public.order_milestones m where m.order_id = c.id), '[]'::jsonb),
    'amendments', coalesce((select jsonb_agg(to_jsonb(a) order by a.created_at) from public.order_amendments a where a.order_id = c.id), '[]'::jsonb),
    'events', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'actor', e.actor, 'event', e.event, 'data', e.data, 'at', e.created_at) order by e.id) from public.order_events e where e.order_id = c.id), '[]'::jsonb),
    -- v56: the payment lines without their Stripe ids, entry key and note, except for the admin
    'payments', coalesce((select jsonb_agg(case when public.is_admin() then to_jsonb(p) else to_jsonb(p) - array['provider_ref', 'charge_ref', 'fee_refund_ref', 'entry_key', 'note'] end order by p.created_at)
                            from public.order_payments p where p.order_id = c.id), '[]'::jsonb),
    'client_name', (select coalesce(pc.first_name, '') from public.profiles pc where pc.id = c.client),
    'freelancer_name', (select coalesce(e.display_name, pe.first_name, '') from public.profiles pe left join public.editor_profiles e on e.id = pe.id where pe.id = c.editor))
  from public.contracts c where c.id = p_order and (auth.uid() in (c.editor, c.client) or public.is_admin());
$$;

-- A second chargeback that comes while another one is open on the same Order is noted on the Order by the payment code
-- ("chargeback dp_… also open on payment pi_…", the payment audit of 31 October). That note keeps every payout and refund
-- on the Order stopped until the payment code takes the chargeback over, or the bank decides it for Cuvori; the hourly
-- run removes it then. So "Mark as handled" (v55's function, with one change marked v56) leaves it, as it leaves the other
-- notes the hourly run works from: the rest of the note goes, that part stays. The same for the note of the bank's
-- inquiry on a payment: it is what holds back the automatic payout while the bank asks, and the payment code removes it
-- when the inquiry ends (the hourly run asks Stripe, in case the notice was lost); marked as handled, the payout went
-- ahead while the bank was still asking (check of 1 November). And an Order with a second chargeback's note still has
-- money on the way (v51's function), and so does its people's money for deleting an account (v35's function), each with
-- one change marked v56: test and live mode can't be switched, and the account can't be deleted, meanwhile.
-- (v56, check of 7 November: nobody marks a note on their own Order as handled (an admin who is its client or freelancer:
-- another admin does it, as with a decision or the evidence: 'your_order'); and when a part of the note stays, the answer
-- says so ('partly'), never 'ok' as though the whole note had gone)
create or replace function public.admin_clear_order_note(p_order uuid, p_note text)
returns text language plpgsql security definer set search_path = public as $$
declare v_note text; v_keep text; v_client uuid; v_editor uuid;
begin
  if not public.is_admin() then return 'forbidden'; end if;
  select money_error, client, editor into v_note, v_client, v_editor from public.contracts where id = p_order for update;
  if not found then return 'not_found'; end if;
  if auth.uid() in (v_client, v_editor) then return 'your_order'; end if;
  if v_note is null then return 'ok'; end if;                                   -- already gone
  if v_note is distinct from p_note then return 'changed'; end if;              -- a newer note came in: the admin reads it first
  if v_note like 'chargeback:%' or v_note like 'chargeback won%'
     or v_note like 'ledger line of the first payment not saved: %' or v_note like 'ledger line of a milestone payout not saved: %'
     or v_note like 'ledger line of the re-payment not saved: %' then
    return 'automatic';
  end if;
  -- v56: a second chargeback, or the bank's inquiry, noted on the Order stays (the payment code removes it itself); so
  -- does "decision not on record" (Cuvori's decision whose history line could not be saved: the admin decides the Order
  -- again, and the payment code removes the note once the decision is on record); the rest of the note goes
  select string_agg(n, ' · Also: ' order by i) into v_keep
    from unnest(string_to_array(v_note, ' · Also: ')) with ordinality as u(n, i)
   where n ~ '^chargeback \S+ also (open )?on payment ' or n like 'the client''s bank asked about payment %'
      or n like 'decision not on record: %';
  if v_keep = v_note then return 'automatic'; end if;
  update public.contracts set money_error = v_keep where id = p_order;
  return case when v_keep is null then 'ok' else 'partly' end;
end $$;

-- The admin's list of Orders (v26's function, with one change marked v56): "the card cost came out higher than what the
-- client paid for it" is only a question at today's prices, where the client pays the card cost. Under the new prices Cuvori
-- pays it, so every such Order showed Stripe's whole fee as "not covered" and was sorted above every other Order not in a
-- dispute (check of 7 November). And who made a decision under way (resolved_by, the last column): the Evidence button tells
-- an admin's decision from the freelancer's own cancel by it, as the database does (check of 8 November). The function is made
-- again (its columns changed); undo_v56.sql puts v26's back.
drop function if exists public.admin_list_contracts();
create or replace function public.admin_list_contracts()
returns table (id uuid, title text, price numeric, currency text, pricing text, status text, payment_mode text, created_at timestamptz,
               delivered_at timestamptz, disputed_at timestamptz, dispute_by uuid, dispute_reason text, delivery_note text, delivery_url text,
               auto_release_at timestamptz, resolution text, conversation_id uuid,
               editor uuid, editor_name text, editor_email text, client uuid, client_name text, client_email text,
               profession_slug text, amount_cents int, funded_cents int, released_cents int, refunded_cents int, has_milestones boolean, amendments int,
               money_error text, chargeback_status text, chargeback_cents int, chargeback_id text, stripe_payment_intent text, stripe_transfer_id text, stripe_refund_id text,
               fee_short_cents int, resolved_by uuid)
language sql stable security definer set search_path = public as $$
  select c.id, c.title, c.price, c.currency, c.pricing, c.status, c.payment_mode, c.created_at,
         c.delivered_at, c.disputed_at, c.dispute_by, c.dispute_reason, c.delivery_note, c.delivery_url, c.auto_release_at, c.resolution, c.conversation_id,
         c.editor, coalesce(e.display_name, pe.first_name), pe.email, c.client, pc.first_name, pc.email,
         c.profession_slug, c.amount_cents, c.funded_cents, c.released_cents, c.refunded_cents, c.has_milestones, c.amendments,
         c.money_error, c.chargeback_status, c.chargeback_cents, c.chargeback_id, c.stripe_payment_intent, c.stripe_transfer_id, c.stripe_refund_id,
         fs.short_cents, c.resolved_by
  from public.contracts c
  left join public.editor_profiles e on e.id = c.editor
  left join public.profiles pe on pe.id = c.editor
  left join public.profiles pc on pc.id = c.client
  left join lateral (
    select coalesce(sum(greatest(p.provider_fee_cents - p.fee_cents, 0)), 0)::int as short_cents
    from public.order_payments p
    where p.order_id = c.id and p.kind = 'fund' and p.status = 'succeeded' and p.provider_fee_cents is not null
      and coalesce(c.pricing_version, 1) < 2                                     -- v56: only at today's prices
  ) fs on true
  where public.is_admin()
  order by (c.chargeback_status = 'open' or c.money_error is not null) desc nulls last, (c.status = 'disputed') desc, (fs.short_cents > 0) desc, c.created_at desc;
$$;
grant execute on function public.admin_list_contracts() to authenticated;

create or replace function public.orders_with_money_on_the_way()
returns int language sql stable security definer set search_path = public as $$
  select count(*)::int from public.contracts c
   where c.payment_mode = 'escrow'
     and (c.status in ('funded','delivered','disputed','releasing','resolving')
          or c.chargeback_status = 'open'
          or c.money_error like 'chargeback won%'
          -- v56: a second chargeback noted on the Order, not taken over yet (the payment audit of 31 October)
          or c.money_error ~ '(^| · Also: )chargeback \S+ also (open )?on payment '
          or exists (select 1 from public.money_keys k
                      where k.scope = 'lock:' || c.id::text and k.created_at > now() - interval '90 seconds'));
$$;

create or replace function public.has_money_held(target uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.contracts c where target in (c.editor, c.client)
                 and (c.status in ('funded','delivered','disputed','releasing','resolving')
                      or c.chargeback_status = 'open'
                      or coalesce(c.money_error, '') like 'chargeback won%'
                      -- v56: a second chargeback noted on the Order, not taken over yet (the check of 1 November)
                      or coalesce(c.money_error, '') ~ '(^| · Also: )chargeback \S+ also (open )?on payment '
                      or exists (select 1 from public.money_keys k
                                  where k.scope = 'lock:' || c.id::text and k.created_at > now() - interval '90 seconds')));
$$;

-- ---------- 11. the admin log ----------
-- Every change an admin makes through the site (the admin panel's buttons: a ban, a role, a flag, an invite, a review or
-- a report handled, a setting, the fee table, a note marked as handled, a message to someone, …) is written, as it
-- happens and by the database itself, into the admin log: who, when, what and on which row, with the values before and
-- after (long texts cut). Cuvori's decisions on disputes, which the payment code carries out, are written there by the
-- payment code, before any money moves. Nobody can change or delete a line, not even an admin; admins can read it.
-- (Changes made in this SQL editor are yours and are not in it.)
create table if not exists public.admin_audit (
  id           bigserial primary key,
  at           timestamptz not null default now(),
  actor        uuid,
  action       text not null check (length(action) between 1 and 80),
  target_table text,
  target_id    text,
  detail       jsonb not null default '{}'::jsonb
);
create index if not exists admin_audit_at on public.admin_audit (at desc);
create index if not exists admin_audit_target on public.admin_audit (target_table, target_id);
alter table public.admin_audit enable row level security;
drop policy if exists "admins read the admin log" on public.admin_audit;
create policy "admins read the admin log" on public.admin_audit for select to authenticated using (public.is_admin());
revoke all on public.admin_audit from public, anon, authenticated;
grant select on public.admin_audit to authenticated;
revoke update, delete, truncate on public.admin_audit from service_role;
grant select, insert on public.admin_audit to service_role;
grant usage on sequence public.admin_audit_id_seq to service_role;

create or replace function public.admin_audit_frozen()
returns trigger language plpgsql set search_path = public as $$
begin
  raise exception 'admin_audit_frozen' using hint = 'the admin log is never changed or emptied';
end $$;
drop trigger if exists admin_audit_frozen on public.admin_audit;
create trigger admin_audit_frozen before update or delete on public.admin_audit for each row execute function public.admin_audit_frozen();
drop trigger if exists admin_audit_frozen_truncate on public.admin_audit;
create trigger admin_audit_frozen_truncate before truncate on public.admin_audit for each statement execute function public.admin_audit_frozen();
revoke execute on function public.admin_audit_frozen() from public, anon, authenticated, service_role;

-- a value for the log: a long text is cut to 300 characters
create or replace function public.admin_audit_cut(v jsonb)
returns jsonb language sql immutable set search_path = public as $$
  select case when jsonb_typeof(v) = 'string' and length(v #>> '{}') > 300 then to_jsonb(left(v #>> '{}', 300) || '…') else v end;
$$;
revoke execute on function public.admin_audit_cut(jsonb) from public, anon, authenticated, service_role;

-- the database writes the line itself whenever a signed-in admin's request changes one of these tables (the admin panel's
-- functions run as the admin, so they are caught however they are called); everyone else's changes, and the payment
-- code's, are not admin changes and are not written.
-- The log can never be changed or emptied, so it never keeps what people wrote or who they are (check of 7 November: a
-- deleted account's chat messages, word for word, its Orders, reviews and job posts, and its e-mail address stayed in the log
-- for good, and so did an admin's own private chats and Orders):
--   - a chat message's text and attachment are never written: only how long it is, and that it changed;
--   - a deleted row of what people write or who they are (a chat message, a conversation, a profile, an Order, a review, a
--     job post, a flag, a report, an identity check) is written by its ids (and its kind or status) only; Cuvori's own
--     settings (an invite, a setting, the fee table, a filter, a profession) are written whole, as before;
--   - erasing a profile (deleting an account) writes which fields were erased, never what they said;
--   - the admin's own rows, as anyone uses Cuvori (their own Orders, reviews, job posts, reports, chats), are written without
--     any text (only ids, amounts, dates, yes/no and the status); and being seen online is not written at all.
-- What an admin does to someone else (a ban and its reason, a flag, a note marked as handled) is written as before; a message
-- to them is written with its words by admin_message_user (below), never a job warning's (it quotes the job's title), and
-- the chat line itself by its length as every message.
-- The owner can change this rule.
create or replace function public.admin_audit_row()
returns trigger language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); o jsonb; n jsonb; o0 jsonb; n0 jsonb; ch jsonb := '{}'::jsonb; k text; own boolean;
        uuid_re constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
        time_re constant text := '^[0-9]{4}-[0-9]{2}-[0-9]{2}([T ][0-9:.+-]+)?$';
        people constant text[] := array['messages', 'conversations', 'profiles', 'contracts', 'order_reviews', 'jobs', 'user_flags', 'reports', 'identity_verifications', 'job_flags'];
begin
  if me is null or not public.is_admin() then return null; end if;
  if tg_op in ('UPDATE', 'DELETE') then o := to_jsonb(old); end if;
  if tg_op in ('INSERT', 'UPDATE') then n := to_jsonb(new); end if;
  o0 := o; n0 := n;
  -- the admin's own profile, when only the time they were last seen changed
  if tg_op = 'UPDATE' and tg_table_name = 'profiles' and n ->> 'id' = me::text
     and (o - 'last_seen_at' - 'updated_at') = (n - 'last_seen_at' - 'updated_at') then return null; end if;
  if tg_op = 'DELETE' and tg_table_name = any(people) then
    select coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb) into o from jsonb_each(o0) e
     where e.key in ('kind', 'status', 'key') or (jsonb_typeof(e.value) = 'string' and (e.value #>> '{}') ~ uuid_re);
  elsif tg_op <> 'DELETE' then
    -- a chat message: its length, never its words or its attachment
    if tg_table_name = 'messages' then
      if o is not null then o := o || jsonb_build_object('body', 'text, ' || length(coalesce(o0 ->> 'body', '')) || ' characters', 'payload', case when coalesce(o0 -> 'payload', 'null'::jsonb) = 'null'::jsonb then null else to_jsonb('attachment'::text) end); end if;
      if n is not null then n := n || jsonb_build_object('body', 'text, ' || length(coalesce(n0 ->> 'body', '')) || ' characters', 'payload', case when coalesce(n0 -> 'payload', 'null'::jsonb) = 'null'::jsonb then null else to_jsonb('attachment'::text) end); end if;
      if tg_op = 'UPDATE' and (o0 -> 'body') is distinct from (n0 -> 'body') then o := o || jsonb_build_object('body', 'text (before)'); n := n || jsonb_build_object('body', 'text (changed)'); end if;
      if tg_op = 'UPDATE' and (o0 -> 'payload') is distinct from (n0 -> 'payload') then o := o || jsonb_build_object('payload', 'attachment (before)'); n := n || jsonb_build_object('payload', 'attachment (changed)'); end if;
    end if;
    -- a profile erased (its account deleted: its fields set to nothing): which fields, never what they said
    if tg_op = 'UPDATE' and tg_table_name = 'profiles' and (o0 ->> 'deleted_at') is null and (n0 ->> 'deleted_at') is not null then
      for k in select jsonb_object_keys(n0) loop
        if jsonb_typeof(o0 -> k) = 'string' and coalesce(n0 -> k, 'null'::jsonb) in ('null'::jsonb, '""'::jsonb) then o := o || jsonb_build_object(k, '(erased)'); end if;
      end loop;
    end if;
    -- the admin's own rows (their own Order, review, job post or chat, their own profile, and the flags the site puts on
    -- their own job posts, which copy its title): without their texts (check of 8 November: the admin's own name and job
    -- titles were kept)
    own := me::text in (coalesce(n0, o0) ->> 'client', coalesce(n0, o0) ->> 'editor', coalesce(n0, o0) ->> 'reviewer', coalesce(n0, o0) ->> 'reviewee',
                        coalesce(n0, o0) ->> 'owner', coalesce(n0, o0) ->> 'sender', coalesce(n0, o0) ->> 'user_a', coalesce(n0, o0) ->> 'user_b',
                        coalesce(n0, o0) ->> 'reporter')
           or (tg_table_name = 'profiles' and coalesce(n0, o0) ->> 'id' = me::text)
           or (tg_table_name = 'job_flags' and exists (select 1 from public.jobs j where j.id::text = coalesce(n0, o0) ->> 'job_id' and j.owner = me));
    if own then
      -- every text goes, short ones too (a phone number fits in a few characters); ids, amounts, dates, yes/no and the
      -- status stay, and so does what an admin does to the row as an admin (a review's moderation and its reason, also on a
      -- review about themselves; check of 8 November: that was hidden as "(text)"). A chat message is already written by its
      -- length.
      for k in select jsonb_object_keys(coalesce(n0, o0)) loop
        if k not in ('status', 'kind', 'resolution', 'payment_mode', 'pricing', 'currency', 'role', 'moderation_status', 'moderation_reason')
           and not (tg_table_name = 'messages' and k in ('body', 'payload')) then
          if o is not null and (jsonb_typeof(o -> k) in ('object', 'array') or (jsonb_typeof(o -> k) = 'string' and (o ->> k) !~ uuid_re and (o ->> k) !~ time_re)) then o := o || jsonb_build_object(k, '(text)'); end if;
          if n is not null and (jsonb_typeof(n -> k) in ('object', 'array') or (jsonb_typeof(n -> k) = 'string' and (n ->> k) !~ uuid_re and (n ->> k) !~ time_re)) then
            n := n || jsonb_build_object(k, case when tg_op = 'UPDATE' and (o0 -> k) is distinct from (n0 -> k) then '(text, changed)' else '(text)' end);
          end if;
        end if;
      end loop;
    end if;
  end if;
  if tg_op = 'UPDATE' then
    for k in select jsonb_object_keys(n0) loop
      if (o0 -> k) is distinct from (n0 -> k) then
        ch := ch || jsonb_build_object(k, jsonb_build_object('from', public.admin_audit_cut(o -> k), 'to', public.admin_audit_cut(n -> k)));
      end if;
    end loop;
    if ch = '{}'::jsonb then return null; end if;
  else
    for k in select jsonb_object_keys(coalesce(n, o)) loop
      ch := ch || jsonb_build_object(k, public.admin_audit_cut(coalesce(n, o) -> k));
    end loop;
  end if;
  insert into public.admin_audit (actor, action, target_table, target_id, detail)
  values (me, lower(tg_op), tg_table_name, coalesce(n0 ->> 'id', o0 ->> 'id', n0 ->> 'key', o0 ->> 'key', n0 ->> 'user_id', o0 ->> 'user_id'), ch);
  return null;
end $$;
revoke execute on function public.admin_audit_row() from public, anon, authenticated, service_role;
do $$
declare t text;
begin
  foreach t in array array['contracts', 'profiles', 'user_flags', 'invites', 'jobs', 'job_flags', 'order_reviews', 'reports',
                           'site_settings', 'fee_schedules', 'filters', 'identity_verifications', 'professions',
                           'profession_filters', 'messages', 'conversations'] loop
    if to_regclass('public.' || t) is not null then
      execute format('drop trigger if exists admin_audit_row on public.%I', t);
      execute format('create trigger admin_audit_row after insert or update or delete on public.%I for each row execute function public.admin_audit_row()', t);
    end if;
  end loop;
end $$;

-- An admin's message to someone: v20's function, and the admin log keeps its words, as for any other thing an admin does to
-- someone (a ban and its reason). The chat line itself is written by its length only, as every message (check of 8
-- November: since the log keeps no chat words, an admin's message to someone was in it as "(text)"). Its one caller on the
-- site is the job "warn" action (admin_job_action), whose message quotes the job's title, the poster's own words: then the
-- log says a job warning went to them, never its words (the warning's reason is in the moderation log, as for every job
-- action; check of 8 November, re-check: the title stayed in the log for good, also after the account was deleted). A job
-- warning is the message the "warn" action sends itself, while it runs (Postgres's call stack says so); any other message
-- keeps its words, also one sent after a job action in the same transaction (second re-check of 8 November: the job
-- action's marker, cuvori.job_admin, lasts until the transaction ends, and such a message was logged as a job warning
-- without its words). v56; undo_v56.sql puts v20's back.
create or replace function public.admin_message_user(p_user uuid, p_text text)
returns text language plpgsql security definer set search_path = public as $$
declare adm uuid := auth.uid(); a uuid; b uuid; cid uuid; mid uuid; stack text;
begin
  if not public.is_admin() or p_user is null or p_user = adm then return 'forbidden'; end if;
  if adm < p_user then a := adm; b := p_user; else a := p_user; b := adm; end if;
  select id into cid from public.conversations where user_a = a and user_b = b;
  if cid is null then insert into public.conversations (user_a, user_b) values (a, b) returning id into cid; end if;
  insert into public.messages (conversation_id, sender, kind, body) values (cid, adm, 'text', left(coalesce(p_text, ''), 4000)) returning id into mid;
  update public.conversations set last_message_at = now() where id = cid;
  -- v56: the words, into the admin log (long ones cut, as every value there); a job warning without them: called by the job
  -- "warn" action itself (admin_job_action calls this for nothing else). Postgres's call stack then reads, line by line: this
  -- function; the warn action's own statement ("SQL statement "SELECT public.admin_message_user(j.owner, ..."); and
  -- admin_job_action(uuid,text,text), whose statement that is. Only those two lines, in those places, count: not the text of another
  -- statement (also one over several lines), a function with a like name, one in another schema or one with other arguments
  -- (check of 11 November); only someone who can create functions (the database owner) could make one look like it on
  -- purpose. The patterns have no backslash, so they read the same whatever the session's standard_conforming_strings
  -- (re-check of 9 November: with that setting off, every admin message and job warning failed).
  get diagnostics stack = pg_context;
  insert into public.admin_audit (actor, action, target_table, target_id, detail)
  values (adm, 'message_user', 'profiles', p_user::text, jsonb_build_object('to', p_user, 'message', mid, 'text',
          case when split_part(stack, chr(10), 2) ~ '^SQL statement "SELECT public[.]admin_message_user[(]j[.]owner, '
                and split_part(stack, chr(10), 3) ~ '^PL/pgSQL function (public[.])?admin_job_action[(]uuid,text,text[)] line [0-9]+ at '
               then to_jsonb('a job warning (its reason is in the moderation log)'::text)
               else public.admin_audit_cut(to_jsonb(left(coalesce(p_text, ''), 4000))) end));
  return 'ok';
end $$;
grant execute on function public.admin_message_user(uuid, text) to authenticated;

-- What Cuvori reviews to decide a dispute (the dispute clause: "the contract, the messages and the work delivered"), and
-- to answer a bank's chargeback: the agreed text, the work handed in (the delivery and every part), the Order's history,
-- what was paid in and out, and the chat of the two sides. Only for an admin who is not on the Order, and only while
-- there is something to decide: a dispute or a decision under way, a chargeback still open, or the bank's inquiry. Every look is in
-- the admin log, so it is known who read which chat and when. The chat's newest 500 messages, oldest first.
create or replace function public.admin_order_evidence(p_order uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); c public.contracts%rowtype; res jsonb; n int;
begin
  if me is null or not public.is_admin() then return jsonb_build_object('error', 'forbidden'); end if;
  select * into c from public.contracts where id = p_order;
  if not found then return jsonb_build_object('error', 'not_found'); end if;
  if me in (c.client, c.editor) then return jsonb_build_object('error', 'your_order'); end if;
  -- (only while it is open: a dispute or a decision under way, a chargeback the bank has not decided, or the bank's inquiry.
  -- Once decided the chat is the two people's own again, also what they write afterwards; check of 7 November: an admin
  -- could read it for good once a dispute had ever been opened)
  -- (a second chargeback noted on the Order counts as open too; a freelancer's own cancel that stopped is no dispute, check of
  -- 7 November, re-check)
  if not (c.status = 'disputed' or (c.status = 'resolving' and (c.disputed_at is not null or c.resolved_by is distinct from c.editor))
          or coalesce(c.chargeback_status, '') = 'open'
          or coalesce(c.money_error, '') ~ '(^| · Also: )the client''s bank asked about payment '        -- (v56: where a note starts, as the page)
          or coalesce(c.money_error, '') ~ '(^| · Also: )chargeback \S+ also (open )?on payment ') then
    return jsonb_build_object('error', 'nothing_to_decide');
  end if;
  select count(*) into n from public.messages where conversation_id = c.conversation_id;
  res := jsonb_build_object(
    'order', jsonb_build_object('id', c.id, 'title', c.title, 'status', c.status, 'price_cents', c.amount_cents, 'currency', c.currency,
             'deadline', c.deadline, 'revisions', c.revisions, 'changes_used', c.changes_used, 'deliverables', c.deliverables,
             'client_duties', c.client_duties, 'freelancer_duties', c.freelancer_duties, 'rights', c.rights, 'terms', c.terms,
             'terms_doc', c.terms_doc, 'accepted_at', c.accepted_at, 'delivered_at', c.delivered_at, 'delivery_url', c.delivery_url,
             'delivery_note', c.delivery_note, 'dispute_by', case when c.dispute_by = c.client then 'client' when c.dispute_by = c.editor then 'freelancer' end,
             'dispute_reason', c.dispute_reason, 'disputed_at', c.disputed_at, 'chargeback_status', c.chargeback_status,
             'funded_cents', c.funded_cents, 'released_cents', c.released_cents, 'refunded_cents', c.refunded_cents,
             'pricing_version', c.pricing_version, 'review_days', c.auto_days),
    'parts', coalesce((select jsonb_agg(jsonb_build_object('position', m.position, 'title', m.title, 'amount_cents', m.amount_cents, 'status', m.status,
             'submitted_at', m.submitted_at, 'delivery_url', m.delivery_url, 'delivery_note', m.delivery_note) order by m.position)
             from public.order_milestones m where m.order_id = c.id), '[]'::jsonb),
    'history', coalesce((select jsonb_agg(jsonb_build_object('at', e.created_at, 'event', e.event,
             'by', case when e.actor = c.client then 'client' when e.actor = c.editor then 'freelancer' when e.actor is null then 'Cuvori' else 'admin' end, 'data', e.data) order by e.id)
             from public.order_events e where e.order_id = c.id), '[]'::jsonb),
    'messages', coalesce((select jsonb_agg(x.j order by x.created_at, x.id) from (
             select m.id, m.created_at, jsonb_build_object('at', m.created_at, 'kind', m.kind, 'body', left(coalesce(m.body, ''), 4000),
               'from', case when m.sender = c.client then 'client' when m.sender = c.editor then 'freelancer' else 'Cuvori' end,
               'link', case when jsonb_typeof(m.payload) = 'object' then coalesce(m.payload ->> 'url', m.payload ->> 'link', m.payload ->> 'videoSrc') end) as j
               from public.messages m where m.conversation_id = c.conversation_id order by m.created_at desc, m.id desc limit 500) x), '[]'::jsonb),
    'messages_total', n);
  insert into public.admin_audit (actor, action, target_table, target_id, detail)
  values (me, 'order.evidence', 'contracts', c.id::text, jsonb_build_object('messages_read', least(n, 500), 'status', c.status));
  return res;
end $$;
revoke execute on function public.admin_order_evidence(uuid) from public, anon;
grant execute on function public.admin_order_evidence(uuid) to authenticated;

-- Shows whether this ran: one row that says "v56 applied", which plan new Orders get, and that Orders from before v56
-- were left as they were.
select case when to_regclass('public.pricing_plans') is not null and to_regclass('public.pricing_switch') is not null
             and (select count(*) from pg_trigger where tgname in ('contracts_pricing', 'order_payments_pricing', 'order_payments_pricing_totals',
                    'order_payments_pricing_frozen', 'order_milestones_pricing', 'order_amendments_pricing', 'pricing_plans_guard', 'pricing_switch_logged',
                    'money_keys_pricing', 'contracts_money_first') and not tgisinternal) = 10
             and pg_get_functiondef('public.order_accept(uuid, integer)'::regprocedure) like '%prices_changed%'
             and pg_get_functiondef('public.order_milestone_action(uuid, text, text, text)'::regprocedure) like '%v56: the Order first%'
             and pg_get_functiondef('public.order_action(uuid, text, text, text, integer)'::regprocedure) like '%v56: the total and the line say the same%'
             and pg_get_functiondef('public.admin_clear_order_note(uuid, text)'::regprocedure) like '%v56: a second chargeback%'
             and pg_get_functiondef('public.orders_with_money_on_the_way()'::regprocedure) like '%v56: a second chargeback%'
             and pg_get_functiondef('public.has_money_held(uuid)'::regprocedure) like '%v56: a second chargeback%'
             and pg_get_functiondef('public.admin_clear_order_note(uuid, text)'::regprocedure) like '%asked about payment%'
             and pg_get_functiondef('public.admin_clear_order_note(uuid, text)'::regprocedure) like '%decision not on record%'
             and to_regclass('public.order_payments_fund_ref_uq') is not null
             and (select pg_get_constraintdef(oid) from pg_constraint where conrelid = 'public.order_payments'::regclass and conname = 'order_payments_kind_check') like '%''refund_failed''%'
             and not has_column_privilege('authenticated', 'public.order_payments', 'provider_ref', 'select')
             and to_regprocedure('public.order_create_at_prices(uuid, jsonb, integer)') is not null
             and to_regprocedure('public.order_update_at_prices(uuid, jsonb, integer)') is not null
             and not has_column_privilege('anon', 'public.pricing_switch', 'note', 'select')
             and not has_function_privilege('authenticated', 'public.pricing_switch_to(integer, text)', 'execute')
             and not has_function_privilege('service_role', 'public.pricing_switch_to(integer, text)', 'execute')
             and not has_table_privilege('service_role', 'public.pricing_plans', 'update')
             and not exists (select 1 from information_schema.columns where table_schema = 'public' and column_name like 'client_fee%')
             and to_regclass('public.admin_audit') is not null
             and (select count(*) from pg_trigger where tgname = 'admin_audit_row' and not tgisinternal) >= 14
             and pg_get_functiondef('public.contracts_money_first()'::regprocedure) like '%release_too_early%'
             and to_regprocedure('public.admin_order_evidence(uuid)') is not null
            then 'v56 applied: the new prices are in the database' || case when (select version from public.pricing_switch) = 1 then ' and switched off' else '' end
                 || '. New Orders get plan ' || (select version from public.pricing_switch)
                 || ' (' || (select name from public.pricing_plans p join public.pricing_switch s on s.version = p.version) || '). Orders from before v56, left as they were: '
                 || (select count(*) from public.contracts where pricing_version is null) || '.'
                 || coalesce((select ' Payments written twice before v56 (the ledger check lists them as payment_line_twice): ' || count(distinct provider_ref) || '.'
                                from public.order_payments where kind = 'fund' and provider = 'stripe' and provider_ref is not null
                                  and provider_ref in (select provider_ref from public.order_payments where kind = 'fund' and provider = 'stripe' group by provider_ref having count(*) > 1)
                              having count(*) > 0), '')
            else 'v56 NOT applied' end as result;
