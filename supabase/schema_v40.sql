-- Cuvori schema v40 — an Order is linked only to the client's own job post and the freelancer's own service.
-- Run after schema_v39.sql, in the Supabase SQL editor.
--
-- order_create saved whatever job post and service the browser sent, without checking whose they were. An Order linked
-- to a stranger's job post counted as a hire for it: once the Order was paid the stranger's post was closed as "filled"
-- and left the jobs board, their "My jobs" list showed a hire they never made, and a protected payment showed as
-- "Payment secured" on it. Two people in a chat (one of them a freelancer) could close anyone's job post this way, for
-- free, with an Order paid outside Cuvori that the freelancer marks as received. The service link was not checked either
-- (order_update took any service too).
-- Now the database keeps a job link only to a post of the Order's client, and a service link only to a service of the
-- Order's freelancer, however the Order is written; any other link is left empty and the Order is made as usual. A post
-- is closed as "filled" only by its owner's own Order. This file also removes such links from Orders made before it.

create or replace function public.contracts_links_ok()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.job_id is not null and (tg_op = 'INSERT' or new.job_id is distinct from old.job_id or new.client is distinct from old.client)
     and not exists (select 1 from public.jobs j where j.id = new.job_id and j.owner = new.client) then
    new.job_id := null;
  end if;
  if new.service_id is not null and (tg_op = 'INSERT' or new.service_id is distinct from old.service_id or new.editor is distinct from old.editor)
     and not exists (select 1 from public.services s where s.id = new.service_id and s.profile_id = new.editor) then
    new.service_id := null;
  end if;
  return new;
end $$;
revoke execute on function public.contracts_links_ok() from public, anon, authenticated;

drop trigger if exists contracts_links_ok on public.contracts;
create trigger contracts_links_ok before insert or update of job_id, service_id, client, editor on public.contracts
  for each row execute function public.contracts_links_ok();

-- A paid Order closes its job post as "filled" only when the post is the client's own (as before, plus that check).
create or replace function public.contracts_fill_job()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.job_id is not null and new.status in ('paid','funded') and (old.status is distinct from new.status) then
    perform set_config('cuvori.job_admin', '1', true);
    update public.jobs set status = 'filled', closed_at = now() where id = new.job_id and status = 'open' and owner = new.client;
  end if;
  return new;
end $$;

-- Orders made before v40: the links that are not the people's own are removed. The job posts such an Order may have
-- closed are counted (not reopened: a post can also be closed by its owner; reopen one by hand if its owner asks).
do $$
declare n int; m int;
begin
  select count(distinct j.id) into m from public.jobs j join public.contracts c on c.job_id = j.id
   where j.status = 'filled' and c.client <> j.owner and c.status in ('paid','funded','delivered','disputed','releasing','resolving','completed','refunded');
  with fixed as (
    update public.contracts c
       set job_id = case when exists (select 1 from public.jobs j where j.id = c.job_id and j.owner = c.client) then c.job_id end,
           service_id = case when exists (select 1 from public.services s where s.id = c.service_id and s.profile_id = c.editor) then c.service_id end
     where (c.job_id is not null and not exists (select 1 from public.jobs j where j.id = c.job_id and j.owner = c.client))
        or (c.service_id is not null and not exists (select 1 from public.services s where s.id = c.service_id and s.profile_id = c.editor))
    returning c.id)
  select count(*) into n from fixed;
  perform set_config('cuvori.v40_unlinked', n::text, false);
  perform set_config('cuvori.v40_closed', m::text, false);
end $$;

-- Shows whether this ran: one row that says "v40 applied", how many Orders lost a link this time, and how many job posts
-- such an Order may have closed.
select case when exists (select 1 from pg_trigger where tgrelid = 'public.contracts'::regclass and tgname = 'contracts_links_ok' and tgenabled <> 'D')
             and pg_get_functiondef('public.contracts_fill_job()'::regprocedure) like '%owner = new.client%'
             and not exists (select 1 from public.contracts c where (c.job_id is not null and not exists (select 1 from public.jobs j where j.id = c.job_id and j.owner = c.client))
                                                                or (c.service_id is not null and not exists (select 1 from public.services s where s.id = c.service_id and s.profile_id = c.editor)))
            then 'v40 applied: an Order is linked only to the client''s own job post and the freelancer''s own service. Orders unlinked now: '
                 || current_setting('cuvori.v40_unlinked') || '. Job posts such an Order may have closed: ' || current_setting('cuvori.v40_closed')
            else 'v40 NOT applied' end as result;
