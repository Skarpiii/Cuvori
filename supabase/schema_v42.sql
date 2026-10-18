-- Cuvori schema v42 — a freelancer's bank details only while the client still has to pay them.
-- Run after schema_v41.sql, in the Supabase SQL editor.
--
-- On an Order paid outside Cuvori ("direct"), the client needs the freelancer's bank details to pay, and the Order screen
-- shows them while the Order waits for that payment or is being paid (accepted, marked paid, paid). payout_info also
-- answered for a finished (completed) Order, with no end date: any client the freelancer ever finished such an Order with
-- could keep reading the freelancer's bank details, including a new account saved months later. The page never shows them
-- then; only someone asking the database directly saw them.
-- Now the database answers at the same stages the page shows them, and no longer once the Order is finished.

create or replace function public.payout_info(ed uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select case
    when auth.uid() is null then null
    when auth.uid() = ed or exists (select 1 from public.contracts k
         where k.editor = ed and k.client = auth.uid() and k.payment_mode = 'direct'
           and k.status in ('accepted','paid_marked','paid'))
      then (select jsonb_build_object('methods', p.methods, 'note', p.note) from public.payout_details p where p.id = ed)
    else null end;
$$;

-- Shows whether this ran: one row that says "v42 applied".
select case when pg_get_functiondef('public.payout_info(uuid)'::regprocedure) like '%(''accepted'',''paid_marked'',''paid'')%'
             and pg_get_functiondef('public.payout_info(uuid)'::regprocedure) not like '%completed%'
            then 'v42 applied: bank details only while the client still has to pay them.'
            else 'v42 NOT applied' end as result;
