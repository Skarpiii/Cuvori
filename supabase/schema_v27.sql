-- Cuvori v27 — an Order can be at most €950,000.
--
-- A protected payment goes through Stripe as one card payment of at most €999,999.99, and the card fee is added on
-- top of the price, so the payment code takes an Order of at most €950,000 (MAX_CENTS in netlify/lib/cuvori.mjs):
-- at the highest card rate the client then pays €981,912.41. The database allowed €1,000,000, so an Order could be
-- agreed that could never be paid, and a price increase that took a paid Order over €950,000 could neither be paid
-- nor let the client approve and release. Now one rule for every Order, also ones paid directly outside Cuvori:
-- order_input_ok() (a new or edited Order), order_amend() (proposing a price change), order_amendment_decide()
-- (accepting one proposed earlier) and the old contract_input_ok() all stop at €950,000. Orders that already exist
-- are not changed. Nothing else changes. Safe to run more than once.

create or replace function public.order_input_ok(p jsonb, p_mode text)
returns void language plpgsql stable as $$
declare price int; rev int; dl date;
begin
  if p is null or jsonb_typeof(p) <> 'object' or pg_column_size(p) > 60000 then raise exception 'bad_terms'; end if;
  if length(btrim(coalesce(p->>'title', ''))) < 1 or length(p->>'title') > 200 then raise exception 'bad_title'; end if;
  if length(coalesce(p->>'scope', '')) > 5000 then raise exception 'description_too_long'; end if;
  if length(coalesce(p->>'deliverables', '')) > 3000 or length(coalesce(p->>'client_duties', '')) > 2000 or length(coalesce(p->>'freelancer_duties', '')) > 2000
     or length(coalesce(p->>'custom', '')) > 5000 then raise exception 'description_too_long'; end if;
  if (p->>'price_cents') is null or (p->>'price_cents') !~ '^[0-9]{1,9}$' then raise exception 'bad_price'; end if;
  price := (p->>'price_cents')::int;
  if price < 100 or price > 95000000 then raise exception 'bad_price'; end if;             -- €1 … €950,000 (v27; was €1,000,000)
  rev := coalesce(nullif(p->>'revisions', '')::int, 2);
  if rev < 0 or rev > 50 then raise exception 'bad_revisions'; end if;
  dl := nullif(p->>'deadline', '')::date;
  if dl is not null and dl < current_date then raise exception 'deadline_in_past'; end if;
  if coalesce(p->>'rights', 'full') not in ('full', 'license') then raise exception 'bad_rights'; end if;
  if coalesce(p->>'currency', 'EUR') <> 'EUR' then raise exception 'bad_currency'; end if;
  if coalesce(p->>'language', 'en') not in ('en','de','ru','lt','es','pl','uk') then raise exception 'bad_language'; end if;
  if upper(coalesce(p->>'law', 'XX')) !~ '^[A-Z]{2}$' then raise exception 'bad_country'; end if;
  if nullif(p->>'profession_slug', '') is not null and not exists (select 1 from public.professions where slug = p->>'profession_slug') then raise exception 'bad_profession'; end if;
  perform public.order_milestones_ok(p->'milestones', price);
end $$;

create or replace function public.order_amend(p_order uuid, p jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare c public.contracts%rowtype; me uuid := auth.uid(); a public.order_amendments%rowtype; delta int; new_total int; m jsonb; ms_total bigint := 0;
begin
  if me is null then raise exception 'not_signed_in'; end if;
  select * into c from public.contracts where id = p_order and me in (editor, client) for update;
  if not found then raise exception 'not_found'; end if;
  if public.is_banned(me) or public.is_banned(c.editor) or public.is_banned(c.client) then raise exception 'banned'; end if;
  if c.status not in ('accepted','paid_marked','paid','funded','delivered') then raise exception 'not_allowed'; end if;
  if exists (select 1 from public.order_amendments where order_id = c.id and status = 'proposed') then raise exception 'amendment_open'; end if;
  if p is null or jsonb_typeof(p) <> 'object' or pg_column_size(p) > 20000 then raise exception 'bad_terms'; end if;
  if length(coalesce(p->>'note', '')) > 2000 or length(coalesce(p->>'scope_add', '')) > 3000 or length(coalesce(p->>'deliverables_add', '')) > 2000 then raise exception 'description_too_long'; end if;
  delta := coalesce(nullif(p->>'price_delta_cents', '')::int, 0);
  if delta < -c.amount_cents or delta > 100000000 then raise exception 'bad_price'; end if;
  new_total := c.amount_cents + delta;
  if new_total < 100 then raise exception 'bad_price'; end if;
  if new_total > 95000000 then raise exception 'bad_price'; end if;   -- v27: an Order is at most €950,000
  if delta < 0 and (c.has_milestones or c.status in ('funded','delivered')) then raise exception 'bad_price'; end if;   -- money already held cannot be talked down
  if delta > 0 and delta < 50 and (c.status in ('funded','delivered') or coalesce(c.funded_cents, 0) > 0) then raise exception 'bad_price'; end if;   -- a top-up under €0.50 can never be charged
  if nullif(p->>'new_deadline', '') is not null and (p->>'new_deadline')::date < current_date then raise exception 'deadline_in_past'; end if;
  if coalesce(nullif(p->>'revisions_add', '')::int, 0) < 0 or coalesce(nullif(p->>'revisions_add', '')::int, 0) > 50 then raise exception 'bad_revisions'; end if;
  if jsonb_typeof(p->'milestones') = 'array' and jsonb_array_length(p->'milestones') > 0 then
    if not c.has_milestones then raise exception 'bad_milestones'; end if;
    for m in select * from jsonb_array_elements(p->'milestones') loop
      if length(btrim(coalesce(m->>'title', ''))) < 1 or length(m->>'title') > 120 or (m->>'amount_cents') !~ '^[0-9]{1,9}$' or (m->>'amount_cents')::int <= 0 then raise exception 'bad_milestones'; end if;
      ms_total := ms_total + (m->>'amount_cents')::int;
    end loop;
    if ms_total <> delta then raise exception 'milestones_sum'; end if;   -- new milestones are exactly the extra money
    if (select count(*) from public.order_milestones where order_id = c.id) + jsonb_array_length(p->'milestones') > 20 then raise exception 'too_many_milestones'; end if;
  elsif c.has_milestones and delta > 0 then raise exception 'milestones_sum'; end if;
  if length(coalesce(p->>'note', '')) < 1 and delta = 0 and nullif(p->>'new_deadline', '') is null and coalesce(p->>'scope_add', '') = '' and coalesce(p->>'deliverables_add', '') = '' and coalesce(nullif(p->>'revisions_add', '')::int, 0) = 0 then
    raise exception 'bad_terms';
  end if;
  begin perform public.rate_limit('contract_action', 60, interval '1 hour'); exception when others then raise exception 'rate_limited'; end;
  insert into public.order_amendments (order_id, proposed_by, note, price_delta_cents, new_deadline, scope_add, deliverables_add, revisions_add, milestones)
  values (c.id, me, coalesce(p->>'note', ''), delta, nullif(p->>'new_deadline', '')::date, coalesce(p->>'scope_add', ''), coalesce(p->>'deliverables_add', ''),
          coalesce(nullif(p->>'revisions_add', '')::int, 0), coalesce(p->'milestones', '[]'::jsonb))
  returning * into a;
  perform public.order_log(c.id, 'amendment_proposed', jsonb_build_object('amendment', a.id, 'price_delta_cents', delta, 'new_deadline', a.new_deadline, 'note', a.note));
  perform public.order_amount_event(c, 'amendment_proposed', delta, a.note);
  return a.id;
end $$;

grant execute on function public.order_amend(uuid, jsonb) to authenticated;

create or replace function public.order_amendment_decide(p_amend uuid, p_accept boolean)
returns text language plpgsql security definer set search_path = public as $$
declare a public.order_amendments%rowtype; c public.contracts%rowtype; me uuid := auth.uid(); m jsonb; i int; n int;
begin
  if me is null then return 'not_signed_in'; end if;
  select * into a from public.order_amendments where id = p_amend for update;
  if not found then return 'not_found'; end if;
  select * into c from public.contracts where id = a.order_id and me in (editor, client) for update;
  if not found then return 'not_found'; end if;
  if public.is_banned(me) then return 'banned'; end if;
  if a.status <> 'proposed' then return 'not_allowed'; end if;
  begin perform public.rate_limit('contract_action', 60, interval '1 hour'); exception when others then return 'rate_limited'; end;
  if a.proposed_by = me then
    if p_accept then return 'not_allowed'; end if;
    update public.order_amendments set status = 'withdrawn', decided_at = now(), decided_by = me where id = a.id;
    perform public.order_log(c.id, 'amendment_withdrawn', jsonb_build_object('amendment', a.id));
    return 'ok';
  end if;
  if not p_accept then
    update public.order_amendments set status = 'declined', decided_at = now(), decided_by = me where id = a.id;
    perform public.order_log(c.id, 'amendment_declined', jsonb_build_object('amendment', a.id));
    perform public.order_amount_event(c, 'amendment_declined', a.price_delta_cents, a.note);
    return 'ok';
  end if;
  if c.status not in ('accepted','paid_marked','paid','funded','delivered') then return 'not_allowed'; end if;
  -- v23: the same rule order_amend() applies when a change is proposed, checked again when it is accepted.
  -- A discount proposed while the Order was unpaid must not go through after the client has paid: the money
  -- held would then be more than the price, and the difference would go to the freelancer on release.
  if a.price_delta_cents < 0 and (c.has_milestones or c.status in ('funded','delivered') or coalesce(c.funded_cents, 0) > 0) then return 'not_allowed'; end if;
  if c.amount_cents + a.price_delta_cents < 0 then return 'not_allowed'; end if;
  if c.amount_cents + a.price_delta_cents > 95000000 then return 'not_allowed'; end if;   -- v27: at most €950,000 (an increase proposed earlier)
  if a.price_delta_cents > 0 and a.price_delta_cents < 50 and (c.status in ('funded','delivered') or coalesce(c.funded_cents, 0) > 0) then return 'not_allowed'; end if;   -- a top-up under €0.50 can never be charged
  n := c.amendments + 1;
  update public.contracts set amount_cents = amount_cents + a.price_delta_cents, price = (amount_cents + a.price_delta_cents) / 100.0,
         deadline = coalesce(a.new_deadline, deadline), revisions = revisions + a.revisions_add,
         description = case when a.scope_add <> '' then description || E'\n\n' || 'Amendment ' || n || ': ' || a.scope_add else description end,
         deliverables = case when a.deliverables_add <> '' then deliverables || E'\n' || a.deliverables_add else deliverables end,
         amendments = n
   where id = c.id returning * into c;
  if jsonb_typeof(a.milestones) = 'array' and jsonb_array_length(a.milestones) > 0 then
    select coalesce(max(position), 0) into i from public.order_milestones where order_id = c.id;
    for m in select * from jsonb_array_elements(a.milestones) loop
      i := i + 1;
      insert into public.order_milestones (order_id, position, title, amount_cents, due) values (c.id, i, btrim(m->>'title'), (m->>'amount_cents')::int, nullif(m->>'due', '')::date);
    end loop;
  end if;
  update public.order_amendments set status = 'accepted', decided_at = now(), decided_by = me where id = a.id;
  perform public.order_log(c.id, 'amendment_accepted', jsonb_build_object('amendment', a.id, 'price_delta_cents', a.price_delta_cents, 'price_cents', c.amount_cents, 'deadline', c.deadline, 'n', n));
  perform public.order_amount_event(c, 'amendment_accepted', a.price_delta_cents, a.note);
  return 'ok';
end $$;

grant execute on function public.order_amendment_decide(uuid, boolean) to authenticated;

create or replace function public.contract_input_ok(title text, description text, price numeric, pricing text, deadline date, revisions int,
                                                     mode text, ctype text, law text, lang text, terms jsonb)
returns void language plpgsql immutable as $$
begin
  if length(coalesce(title, '')) < 1 or length(title) > 200 then raise exception 'bad_title'; end if;
  if length(coalesce(description, '')) > 5000 then raise exception 'description_too_long'; end if;
  if price is null or price < 0 or price > 950000 then raise exception 'bad_price'; end if;   -- v27: at most €950,000 (was €1,000,000)
  if pricing not in ('project','hour','day','month') then raise exception 'bad_pricing'; end if;
  if ctype not in ('fixed','hourly','retainer','quick') then raise exception 'bad_type'; end if;
  if (ctype in ('fixed','quick') and pricing <> 'project') or (ctype = 'hourly' and pricing not in ('hour','day')) or (ctype = 'retainer' and pricing <> 'month') then
    raise exception 'bad_pricing';
  end if;
  if revisions is not null and (revisions < 0 or revisions > 50) then raise exception 'bad_revisions'; end if;
  if deadline is not null and deadline < current_date then raise exception 'deadline_in_past'; end if;
  if mode = 'escrow' and pricing <> 'project' then raise exception 'escrow_fixed_price_only'; end if;
  if mode = 'escrow' and price < 1 then raise exception 'escrow_minimum'; end if;
  if law !~ '^[A-Z]{2}$' then raise exception 'bad_country'; end if;
  if lang not in ('en','de','ru','lt','es','pl','uk') then raise exception 'bad_language'; end if;
  if not public.terms_ok(terms) then raise exception 'bad_terms'; end if;
end $$;

-- Shows whether this ran: one row that says "v27 applied".
select case when pg_get_functiondef('public.order_input_ok(jsonb,text)'::regprocedure) like '%price > 95000000%'
             and pg_get_functiondef('public.order_amend(uuid,jsonb)'::regprocedure) like '%new_total > 95000000%'
             and pg_get_functiondef('public.order_amendment_decide(uuid,boolean)'::regprocedure) like '%a.price_delta_cents > 95000000%'
             and pg_get_functiondef('public.contract_input_ok(text,text,numeric,text,date,integer,text,text,text,text,jsonb)'::regprocedure) like '%price > 950000%'
            then 'v27 applied: an Order is at most €950,000' else 'v27 NOT applied' end as result;
