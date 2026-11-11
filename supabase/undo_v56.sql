-- Cuvori — undo schema v56. Only if you decide never to use the new prices: it removes the price plans, the switch,
-- the new columns and the new checks again, and puts Accept and the agreed text back exactly as they were in v38.
-- It refuses (and changes nothing) once any Order or payment line uses the new prices, also a proposal that was
-- declined or cancelled: plan 2 is part of those Orders, and agreed ones keep their prices and their 14 days for good. It also refuses once the payment code for the new prices has written a
-- ledger line (it gives every line an entry key, also at today's prices; today's code never does): that code writes the
-- columns undo takes away, and every money step would then fail after Stripe had moved the money. Orders made after
-- v56 at today's prices only lose the note "plan 1" (no amount and no day changes: they kept today's 7 days). It also
-- deletes the switch history (pricing_switch_log) and the admin log (admin_audit), every line in them. The rules of the payment audit of 31 October go too: the Order's
-- buttons and a part's buttons are put back as in v38 and v43, the Order screen's data as in v18, and both sides of an
-- Order read whole payment lines again. The ledger's kinds of line are put back as v21 left them (without refund_failed):
-- it refuses while any failed refund's line is in the ledger, as ledger lines are never removed.
-- Run in the Supabase SQL editor, the whole file at once.

do $$
begin
  if to_regclass('public.pricing_plans') is null then raise exception 'v56 is not in this database: nothing to undo.'; end if;
  -- nothing new comes in while this runs, and the new prices must be switched off first. Every table this file changes
  -- or removes, locked before anything changes: the tables v56 changed (in v56's order), then v56's own four. Postgres
  -- waits up to lock_timeout for EACH table, and every Order screen and payment step waits behind this file meanwhile:
  -- 9 tables x half a second stays well below the 8 seconds the payment code waits for the database. A payment being
  -- made then stops this file with a lock timeout, nothing changed.
  perform set_config('lock_timeout', '500ms', true);
  lock table public.contracts, public.order_payments, public.order_milestones, public.order_amendments, public.money_keys,
             public.pricing_plans, public.pricing_switch, public.pricing_switch_log, public.admin_audit in access exclusive mode;
  if (select version from public.pricing_switch) <> 1 then
    raise exception 'The switch is on (plan %): turn it back first with select public.pricing_switch_to(1, ''…''); Nothing was changed.', (select version from public.pricing_switch);
  end if;
  if exists (select 1 from public.contracts where pricing_version >= 2) or exists (select 1 from public.order_payments where pricing_version >= 2) then
    raise exception 'Orders use the new prices (plan 2), so v56 stays. Nothing was changed.';
  end if;
  if exists (select 1 from public.order_payments where entry_key is not null) then
    raise exception 'The payment code for the new prices has written ledger lines: undoing v56 would break every payment step, so v56 stays. Nothing was changed.';
  end if;
  -- (the payment code for the new prices writes one with an entry key, refused above; this is one written by hand)
  if exists (select 1 from public.order_payments where kind = 'refund_failed') then
    raise exception 'A failed refund is recorded in the ledger (a refund_failed line): ledger lines are never removed, and without v56 the ledger has no such kind of line, so v56 stays. Nothing was changed.';
  end if;
end $$;

drop trigger if exists contracts_pricing on public.contracts;
drop trigger if exists order_amendments_pricing on public.order_amendments;
drop trigger if exists order_payments_pricing on public.order_payments;
drop trigger if exists order_payments_pricing_totals on public.order_payments;
drop trigger if exists order_payments_pricing_frozen on public.order_payments;
drop trigger if exists order_milestones_pricing on public.order_milestones;
drop trigger if exists money_keys_pricing on public.money_keys;
drop trigger if exists contracts_money_first on public.contracts;
-- the admin log (v56, section 11) goes too, with every line in it
do $$
declare t text;
begin
  foreach t in array array['contracts', 'profiles', 'user_flags', 'invites', 'jobs', 'job_flags', 'order_reviews', 'reports',
                           'site_settings', 'fee_schedules', 'filters', 'identity_verifications', 'professions',
                           'profession_filters', 'messages', 'conversations'] loop
    if to_regclass('public.' || t) is not null then execute format('drop trigger if exists admin_audit_row on public.%I', t); end if;
  end loop;
end $$;

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

-- The Order's buttons, a part's buttons and the Order screen's data, as in schema_v38.sql, schema_v43.sql and schema_v18.sql
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
    update public.contracts set status = 'completed', completed_at = now(), closed_at = now(), released_cents = funded_cents where id = c.id returning * into c;
    insert into public.order_payments (order_id, kind, amount_cents, provider, note) values (c.id, 'release', c.amount_cents, 'direct', 'work approved by the client');
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

create or replace function public.order_milestone_action(p_ms uuid, p_action text, p_note text default null, p_link text default null)
returns text language plpgsql security definer set search_path = public as $$
declare m public.order_milestones%rowtype; c public.contracts%rowtype; me uuid := auth.uid(); left_open int;
begin
  if me is null then return 'not_signed_in'; end if;
  select * into m from public.order_milestones where id = p_ms for update;
  if not found then return 'not_found'; end if;
  select * into c from public.contracts where id = m.order_id and me in (editor, client) for update;
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
end 
$$;

create or replace function public.order_bundle(p_order uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'order', to_jsonb(c),
    'milestones', coalesce((select jsonb_agg(to_jsonb(m) order by m.position) from public.order_milestones m where m.order_id = c.id), '[]'::jsonb),
    'amendments', coalesce((select jsonb_agg(to_jsonb(a) order by a.created_at) from public.order_amendments a where a.order_id = c.id), '[]'::jsonb),
    'events', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'actor', e.actor, 'event', e.event, 'data', e.data, 'at', e.created_at) order by e.id) from public.order_events e where e.order_id = c.id), '[]'::jsonb),
    'payments', coalesce((select jsonb_agg(to_jsonb(p) order by p.created_at) from public.order_payments p where p.order_id = c.id), '[]'::jsonb),
    'client_name', (select coalesce(pc.first_name, '') from public.profiles pc where pc.id = c.client),
    'freelancer_name', (select coalesce(e.display_name, pe.first_name, '') from public.profiles pe left join public.editor_profiles e on e.id = pe.id where pe.id = c.editor))
  from public.contracts c where c.id = p_order and (auth.uid() in (c.editor, c.client) or public.is_admin());
$$;

-- "Mark as handled", the count of Orders with money on the way and the money check before deleting an account, exactly
-- as v55, v51 and v35 left them (and the admin's list of Orders as v26 left it, below)
create or replace function public.has_money_held(target uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.contracts c where target in (c.editor, c.client)
                 and (c.status in ('funded','delivered','disputed','releasing','resolving')
                      or c.chargeback_status = 'open'
                      or coalesce(c.money_error, '') like 'chargeback won%'
                      or exists (select 1 from public.money_keys k
                                  where k.scope = 'lock:' || c.id::text and k.created_at > now() - interval '90 seconds')));
$$;

create or replace function public.admin_clear_order_note(p_order uuid, p_note text)
returns text language plpgsql security definer set search_path = public as $$
declare v_note text;
begin
  if not public.is_admin() then return 'forbidden'; end if;
  select money_error into v_note from public.contracts where id = p_order for update;
  if not found then return 'not_found'; end if;
  if v_note is null then return 'ok'; end if;                                   -- already gone
  if v_note is distinct from p_note then return 'changed'; end if;              -- a newer note came in: the admin reads it first
  if v_note like 'chargeback:%' or v_note like 'chargeback won%'
     or v_note like 'ledger line of the first payment not saved: %' or v_note like 'ledger line of a milestone payout not saved: %'
     or v_note like 'ledger line of the re-payment not saved: %' then
    return 'automatic';
  end if;
  update public.contracts set money_error = null where id = p_order;
  return 'ok';
end $$;

-- an admin's message to someone, exactly as v20 left it
create or replace function public.admin_message_user(p_user uuid, p_text text)
returns text language plpgsql security definer set search_path = public as $$
declare adm uuid := auth.uid(); a uuid; b uuid; cid uuid;
begin
  if not public.is_admin() or p_user is null or p_user = adm then return 'forbidden'; end if;
  if adm < p_user then a := adm; b := p_user; else a := p_user; b := adm; end if;
  select id into cid from public.conversations where user_a = a and user_b = b;
  if cid is null then insert into public.conversations (user_a, user_b) values (a, b) returning id into cid; end if;
  insert into public.messages (conversation_id, sender, kind, body) values (cid, adm, 'text', left(coalesce(p_text, ''), 4000));
  update public.conversations set last_message_at = now() where id = cid;
  return 'ok';
end $$;
grant execute on function public.admin_message_user(uuid, text) to authenticated;

-- the admin's list of Orders, exactly as v26 left it (v56 made it again with one more column: dropped first)
drop function if exists public.admin_list_contracts();
create or replace function public.admin_list_contracts()
returns table (id uuid, title text, price numeric, currency text, pricing text, status text, payment_mode text, created_at timestamptz,
               delivered_at timestamptz, disputed_at timestamptz, dispute_by uuid, dispute_reason text, delivery_note text, delivery_url text,
               auto_release_at timestamptz, resolution text, conversation_id uuid,
               editor uuid, editor_name text, editor_email text, client uuid, client_name text, client_email text,
               profession_slug text, amount_cents int, funded_cents int, released_cents int, refunded_cents int, has_milestones boolean, amendments int,
               money_error text, chargeback_status text, chargeback_cents int, chargeback_id text, stripe_payment_intent text, stripe_transfer_id text, stripe_refund_id text,
               fee_short_cents int)
language sql stable security definer set search_path = public as $$
  select c.id, c.title, c.price, c.currency, c.pricing, c.status, c.payment_mode, c.created_at,
         c.delivered_at, c.disputed_at, c.dispute_by, c.dispute_reason, c.delivery_note, c.delivery_url, c.auto_release_at, c.resolution, c.conversation_id,
         c.editor, coalesce(e.display_name, pe.first_name), pe.email, c.client, pc.first_name, pc.email,
         c.profession_slug, c.amount_cents, c.funded_cents, c.released_cents, c.refunded_cents, c.has_milestones, c.amendments,
         c.money_error, c.chargeback_status, c.chargeback_cents, c.chargeback_id, c.stripe_payment_intent, c.stripe_transfer_id, c.stripe_refund_id,
         fs.short_cents
  from public.contracts c
  left join public.editor_profiles e on e.id = c.editor
  left join public.profiles pe on pe.id = c.editor
  left join public.profiles pc on pc.id = c.client
  left join lateral (
    select coalesce(sum(greatest(p.provider_fee_cents - p.fee_cents, 0)), 0)::int as short_cents
    from public.order_payments p
    where p.order_id = c.id and p.kind = 'fund' and p.status = 'succeeded' and p.provider_fee_cents is not null
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
          or exists (select 1 from public.money_keys k
                      where k.scope = 'lock:' || c.id::text and k.created_at > now() - interval '90 seconds'));
$$;

-- both sides of an Order read whole payment lines again, as before v56
revoke select (id, order_id, milestone_id, kind, amount_cents, fee_cents, provider, status, created_at, provider_fee_cents, fee_refund_cents,
               connect_cents, commission_cents, payout_cents, payout_purpose, pricing_version) on table public.order_payments from authenticated;
grant select on table public.order_payments to authenticated;

drop index if exists public.order_payments_fund_ref_uq;
drop index if exists public.order_payments_entry_key_uq;
drop index if exists public.order_payments_v2_object_uq;
alter table public.order_payments drop constraint if exists order_payments_pricing_ok;
-- the ledger's kinds of line, exactly as schema_v21.sql left them (v56 added refund_failed)
alter table public.order_payments drop constraint if exists order_payments_kind_check;
alter table public.order_payments add constraint order_payments_kind_check check (kind in ('fund','release','refund','reversal','chargeback'));
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
drop function if exists public.contracts_money_first();
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
drop function if exists public.admin_order_evidence(uuid);
drop table if exists public.admin_audit;
drop function if exists public.admin_audit_row();
drop function if exists public.admin_audit_cut(jsonb);
drop function if exists public.admin_audit_frozen();

-- Shows whether this ran
select case when to_regclass('public.pricing_plans') is null
             and not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'contracts' and column_name = 'pricing_version')
             and pg_get_functiondef('public.order_accept(uuid, integer)'::regprocedure) not like '%prices_changed%'
             and to_regprocedure('public.order_create_at_prices(uuid, jsonb, integer)') is null
             and to_regprocedure('public.order_update_at_prices(uuid, jsonb, integer)') is null
             and to_regprocedure('public.contracts_money_first()') is null
             and to_regclass('public.admin_audit') is null and not exists (select 1 from pg_trigger where tgname = 'admin_audit_row')
             and to_regprocedure('public.admin_order_evidence(uuid)') is null
             and to_regclass('public.order_payments_fund_ref_uq') is null
             and (select pg_get_constraintdef(oid) from pg_constraint where conrelid = 'public.order_payments'::regclass and conname = 'order_payments_kind_check') not like '%refund_failed%'
             and pg_get_functiondef('public.order_milestone_action(uuid, text, text, text)'::regprocedure) not like '%v56%'
             and pg_get_functiondef('public.order_action(uuid, text, text, text, integer)'::regprocedure) not like '%v56%'
             and has_table_privilege('authenticated', 'public.order_payments', 'select')
             and pg_get_functiondef('public.admin_clear_order_note(uuid, text)'::regprocedure) not like '%v56%'
             and pg_get_functiondef('public.admin_list_contracts()'::regprocedure) not like '%v56%'
             and pg_get_functiondef('public.admin_message_user(uuid, text)'::regprocedure) not like '%v56%'
             and pg_get_functiondef('public.orders_with_money_on_the_way()'::regprocedure) not like '%v56%'
             and pg_get_functiondef('public.has_money_held(uuid)'::regprocedure) not like '%v56%'
            then 'v56 undone: the database is as it was at v55.'
            else 'v56 NOT undone' end as result;
