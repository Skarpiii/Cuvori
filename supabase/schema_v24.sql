-- Cuvori v24 — a price increase of €0.01–€0.49 on a paid Order is refused.
--
-- A paid Order whose price grows is topped up by the client through Stripe Checkout. Stripe cannot take a card
-- payment that small (its minimum for a euro charge is €0.50), and Cuvori refuses to round the charge up, so such
-- an amendment could be accepted but never paid: the Order would show a price the money held cannot reach.
-- order_amend() now refuses to propose it and order_amendment_decide() refuses to accept it (an increase proposed
-- while the Order was still unpaid, accepted after payment). Unpaid Orders are unaffected: their first payment is the
-- whole price, from €1. Nothing else changes. Safe to run more than once.

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
