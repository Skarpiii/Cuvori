-- Cuvori v23 — a price cut can no longer be accepted after the client has paid.
--
-- order_amend() already refuses to PROPOSE a lower price once money is held. But a discount proposed while the
-- Order was still unpaid could be ACCEPTED after the client paid: the price went down, the money held did not,
-- and on release the freelancer was paid the old, higher amount. order_amendment_decide() now checks the same
-- rule at the moment of acceptance. Nothing else changes. Safe to run more than once.

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
