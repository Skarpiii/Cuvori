-- Cuvori schema v37 — no payment into an Order that can no longer be done, and the old contract functions closed.
-- Run after schema_v36.sql, in the Supabase SQL editor.
--
-- 1. An account deleted after both sides agreed an Order, before the client paid. Since v35 the agreed Order is kept (so
--    its records stay), but it stayed open: a deleted freelancer's Stripe account and its "ready" mark are kept too (a
--    re-payment after a won chargeback goes there), so the client's page still showed Fund and the payment went through,
--    into an Order nobody would ever deliver. The only way back was a dispute and Cuvori's refund, and Stripe keeps its
--    card fee on a refund, so the client lost it. A deleted client left the freelancer waiting for a payment that could
--    never come.
--    Now a deletion (the person's own, an admin's, or one in Supabase's dashboard) closes the person's agreed Orders that
--    no money went into yet: they become "cancelled", with a line in the Order's history. Fund only works on an agreed
--    Order, so nothing can be paid into them, and a payment page that was already open is released with nothing charged.
--    Orders that money went into are not touched (a deletion still waits while money is on its way, and finished Orders
--    keep their records). This file also closes the Orders that deletions before it left open.
-- 2. Two old contract functions the page no longer calls (it uses order_create and order_update) were still open to
--    everyone. adjust_contract changed an Order's price without its milestones: the client could pay €20 for €10 of
--    milestones, and once those were released the Order closed with €10 of the client's money left with Cuvori, with no
--    button to release or refund it. propose_contract skipped the newer checks. Now no visitor and nobody signed in may
--    call either of them.

-- What a deletion removes and keeps (as v36), plus: the person's agreed Orders that no money went into yet are closed.
create or replace function public.purge_user_data(target uuid)
returns void language plpgsql security definer set search_path = public, storage as $$
declare was_bad boolean; kept uuid[];
begin
  perform set_config('cuvori.purge', '1', true);
  was_bad := exists (select 1 from public.user_flags f where f.user_id = target) or coalesce((select banned from public.profiles where id = target), false);
  if was_bad then
    insert into public.deleted_user_identifiers (kind, value_hash, label, note)
    select i.kind, i.value_hash, i.label, coalesce((select string_agg(f.kind || ': ' || f.reason, ' | ') from public.user_flags f where f.user_id = target), 'banned')
    from public.user_identifiers i where i.user_id = target;
  end if;
  -- the Orders that stay: agreed by both, or money went through Cuvori for them
  kept := array(select c.id from public.contracts c
                 where target in (c.editor, c.client)
                   and (c.accepted_at is not null or coalesce(c.funded_cents, 0) > 0 or c.chargeback_id is not null
                        or exists (select 1 from public.order_payments p where p.order_id = c.id)));
  -- v37: of those, the ones still waiting for their first payment can no longer be done. They close, so nobody can pay
  -- into them; their history says why. Nothing is paid in: no money counted, no payment line.
  with closed as (
    update public.contracts c set status = 'cancelled', closed_at = now()
     where c.id = any(kept) and c.status in ('proposed', 'accepted') and coalesce(c.funded_cents, 0) = 0
       and not exists (select 1 from public.order_payments p where p.order_id = c.id and p.kind = 'fund')
    returning c.id)
  insert into public.order_events (order_id, actor, event, data)
  select id, auth.uid(), 'cancelled', jsonb_build_object('reason', 'account_deleted') from closed;
  delete from public.order_reviews where reviewer = target or reviewee = target;
  delete from public.contracts where (editor = target or client = target) and not (id = any(kept));
  delete from public.messages where sender = target;
  -- a chat stays only while a kept Order is in it
  delete from public.conversations v where (v.user_a = target or v.user_b = target)
     and not exists (select 1 from public.contracts k where k.conversation_id = v.id and k.id = any(kept));
  delete from public.reviews where client = target or editor = target;
  delete from public.jobs where owner = target;
  delete from public.projects where owner = target;
  delete from public.editor_profiles where id = target;
  update public.invites set used_by = null, note = coalesce(note,'') || ' [user deleted]' where used_by = target;
  if cardinality(kept) = 0 then
    delete from public.payout_details where id = target;
    delete from public.profiles where id = target;               -- the rest of the person's rows go with it
    return;
  end if;
  -- on a kept Order: an empty profile row stays for the Order to point at. A freelancer's Stripe account id stays (a
  -- re-payment after a won chargeback goes there); the bank details and the note go.
  update public.payout_details set methods = '[]'::jsonb, note = '', updated_at = now() where id = target;
  delete from public.services where profile_id = target;
  delete from public.identity_verifications where user_id = target;
  delete from public.user_identifiers where user_id = target;
  delete from public.user_flags where user_id = target;
  update public.user_flags set created_by = null where created_by = target;
  delete from public.job_reports where reporter = target;
  update public.reports set reporter = null where reporter = target;
  update public.reports set handled_by = null where handled_by = target;
  update public.profiles set email = null, first_name = null, ban_reason = null, is_admin = false, rules_version = null,
         rules_accepted_at = null, last_seen_at = null, visibility = 'hidden', deleted_at = now(), updated_at = now()
   where id = target;
end $$;
revoke execute on function public.purge_user_data(uuid) from public, anon, authenticated;

-- The Orders that deletions before v37 left open: closed the same way (run here, by the owner, so no payment lock applies;
-- a payment that comes in for one later is released or sent back by the payment functions, as for any cancelled Order).
with closed as (
  update public.contracts c set status = 'cancelled', closed_at = now()
   where c.status in ('proposed', 'accepted') and coalesce(c.funded_cents, 0) = 0
     and not exists (select 1 from public.order_payments p where p.order_id = c.id and p.kind = 'fund')
     and exists (select 1 from public.profiles d where d.id in (c.editor, c.client) and d.deleted_at is not null)
  returning c.id)
insert into public.order_events (order_id, actor, event, data)
select id, null, 'cancelled', jsonb_build_object('reason', 'account_deleted') from closed;

-- The old contract functions: nobody but the owner may call them any more (every version of them).
do $$
declare f regprocedure;
begin
  for f in select p.oid::regprocedure from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('adjust_contract', 'propose_contract') loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
  end loop;
end $$;

-- Shows whether this ran: one row that says "v37 applied", how many Orders a deletion has closed, and how many open Orders
-- have milestones that do not add up to their price (should be 0; any other number needs a look by hand).
select case when pg_get_functiondef('public.purge_user_data(uuid)'::regprocedure) like '%account_deleted%'
             and not exists (select 1 from pg_proc p cross join (values ('anon'), ('authenticated')) r(r)
                              where p.pronamespace = 'public'::regnamespace and p.proname in ('adjust_contract', 'propose_contract')
                                and has_function_privilege(r.r, p.oid, 'execute'))
             and not exists (select 1 from public.contracts c where c.status in ('proposed', 'accepted') and coalesce(c.funded_cents, 0) = 0
                              and not exists (select 1 from public.order_payments p where p.order_id = c.id and p.kind = 'fund')
                              and exists (select 1 from public.profiles d where d.id in (c.editor, c.client) and d.deleted_at is not null))
            then 'v37 applied: an unpaid Order closes when one of its people deletes the account; old contract functions closed. Orders closed by a deletion: '
                 || (select count(*) from public.order_events where event = 'cancelled' and data->>'reason' = 'account_deleted')
                 || '. Open Orders whose milestones do not add up to the price: '
                 || (select count(*) from public.contracts c where c.has_milestones
                       and c.status not in ('declined', 'cancelled', 'completed', 'refunded')
                       and c.amount_cents <> coalesce((select sum(m.amount_cents) from public.order_milestones m where m.order_id = c.id), 0))
            else 'v37 NOT applied' end as result;
