-- Cuvori v30 — a limit on how often one person can make Cuvori ask Stripe.
--
-- Stripe takes only so many requests a second from Cuvori as a whole (25 a second for one kind of request, such as
-- checking a freelancer's account). Without a limit, one person — or a small script — pressing a payment button over
-- and over could use all of it, and Stripe would then refuse Cuvori's requests for everyone: nobody could pay, and
-- payouts would wait until they stopped. The payment functions now ask this function first: past about 10 tries a
-- minute of one button the person is asked to wait a minute, and Stripe is not asked at all. Normal use never comes close.
--
-- It counts in the rate_events table the database already uses for its own limits (schema v9). Only the payment
-- functions can use it; members and visitors cannot. Nothing else changes. Safe to run more than once.

create or replace function public.rate_limit_for(p_user uuid, p_kind text, p_max int, p_seconds int)
returns boolean language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if p_user is null or p_kind is null or p_kind !~ '^[a-z_]{1,40}$' or p_max is null or p_max < 1 or p_max > 1000
     or p_seconds is null or p_seconds < 1 or p_seconds > 86400 then
    raise exception 'bad_input';
  end if;
  -- one count at a time for each person and button, so two tries at the same moment cannot both slip past the limit
  perform pg_advisory_xact_lock(hashtextextended('rate:' || p_user::text || ':' || p_kind, 0));
  delete from public.rate_events where user_id = p_user and kind = p_kind and at < now() - make_interval(secs => p_seconds);
  select count(*) into n from public.rate_events where user_id = p_user and kind = p_kind;
  if n >= p_max then return false; end if;
  insert into public.rate_events (user_id, kind) values (p_user, p_kind);
  return true;
end $$;
revoke execute on function public.rate_limit_for(uuid, text, int, int) from public, anon, authenticated;
grant execute on function public.rate_limit_for(uuid, text, int, int) to service_role;

-- Shows whether this ran: one row that says "v30 applied".
select case when exists (select 1 from pg_proc where proname = 'rate_limit_for' and pronamespace = 'public'::regnamespace)
             and not has_function_privilege('anon', 'public.rate_limit_for(uuid,text,int,int)', 'execute')
             and not has_function_privilege('authenticated', 'public.rate_limit_for(uuid,text,int,int)', 'execute')
             and has_function_privilege('service_role', 'public.rate_limit_for(uuid,text,int,int)', 'execute')
            then 'v30 applied: one person can no longer use up Stripe''s limit for everyone'
            else 'v30 NOT applied' end as result;
