-- Cuvori schema v38 — Accept says which version was read, and the database itself saves what was agreed.
-- Run after schema_v37.sql, in the Supabase SQL editor. Run it right after the page that sends the version is live (the
-- page from the same day): an Accept from an older page names no version and is refused until that page is reloaded.
--
-- 1. Accept did not say which version of the Order the person had read. The Order screen does not refresh by itself, so
--    when the other side changed the Order (a higher price, a shorter deadline) a moment before the click, the click
--    accepted the new version the person never saw, and with the other side's acceptance already on it the Order was
--    agreed at that price. Now the page sends the version it shows, and an Accept for any other version, or for none, is
--    refused with "order_changed"; the page then reloads the Order and asks to read it again.
-- 2. The text of an accepted Order (the clauses both people agreed to) was whatever the first browser sent afterwards
--    through store_contract_doc: either person could save a made-up contract text once, and it then counted as the
--    agreed copy that can never be changed. Now the database saves what was agreed, in the same step as the acceptance:
--    the version, the price, the terms, the milestones, the law and language, and both names (contracts.terms_doc, marked
--    "kind": "facts"). The page builds the clause wording from those facts with the templates of the Order's
--    clauses_version. Nobody signed in may call store_contract_doc any more. Copies saved before v38 stay as they are.

-- What was agreed, as the database has it at the moment of acceptance. Only the database calls it (from order_accept).
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
revoke execute on function public.order_terms_snapshot(public.contracts) from public, anon, authenticated;

-- Accept, for the version the person read. The old one-argument version is replaced (a second version next to it would
-- make the page's calls ambiguous).
drop function if exists public.order_action(uuid, text, text, text);
drop function if exists public.order_accept(uuid);

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

-- The page's buttons on an Order. Unchanged except that Accept passes on the version (p_version).
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

grant execute on function public.order_accept(uuid, integer) to anon, authenticated, service_role;
grant execute on function public.order_action(uuid, text, text, text, integer) to anon, authenticated, service_role;

-- The page no longer sends a contract text: nobody signed in, and no visitor, may write one.
revoke execute on function public.store_contract_doc(uuid, jsonb) from public, anon, authenticated;

-- Shows whether this ran: one row that says "v38 applied", and how many agreed Orders keep a copy a browser sent before
-- v38 (they stay as they are; if one of them is ever disputed, compare it with the Order's history).
select case when exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace and proname = 'order_action' and 'p_version' = any(proargnames))
             and exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace and proname = 'order_accept' and 'p_version' = any(proargnames))
             and (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname in ('order_accept', 'order_action')) = 2
             and pg_get_functiondef('public.order_accept(uuid, integer)'::regprocedure) like '%order_terms_snapshot%'
             and not exists (select 1 from pg_proc p cross join (values ('anon'), ('authenticated')) r(r)
                              where p.pronamespace = 'public'::regnamespace and p.proname in ('store_contract_doc', 'order_terms_snapshot')
                                and has_function_privilege(r.r, p.oid, 'execute'))
            then 'v38 applied: Accept names the version that was read; the database saves what was agreed. Agreed Orders with a copy a browser sent before v38: '
                 || (select count(*) from public.contracts where terms_doc is not null and coalesce(terms_doc->>'kind', '') <> 'facts')
                 || '. Agreed Orders with no copy: '
                 || (select count(*) from public.contracts where accepted_at is not null and terms_doc is null and status not in ('declined', 'cancelled'))
            else 'v38 NOT applied' end as result;
