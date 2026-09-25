-- Cuvori v22 — reviews that belong to an Order.
--
-- Why a new table: public.reviews (v3) is one row per (editor, client) pair and is not tied to an
-- Order, so it cannot carry "this review came from a real, completed Order". That table is left
-- exactly as it is; nothing is deleted. From v22 on, the public rating comes from order_reviews,
-- which can only be written by the two people named on a completed Order.
--
-- Shape of the rules, all enforced here rather than in the page:
--   * one review per side per Order, never about yourself, only by a party to the Order
--   * one overall rating, 1..5. 1-3 needs a reason and a written explanation; 4-5 does not
--   * blind: your review is hidden until the other side reviews too, or the window runs out
--   * the window is a setting (review_window_days), not a number buried in the code
--   * an Order must be completed before either side can review it
--   * hidden reviews stop counting towards the average the moment an admin hides them

-- ---------- the window ----------
insert into public.site_settings (key, value) values ('review_window_days', '14'::jsonb)
on conflict (key) do nothing;

create or replace function public.review_window_days()
returns int language sql stable security definer set search_path = public as $$
  select greatest(1, least(365, coalesce((public.setting('review_window_days'))::text::int, 14)));
$$;
grant execute on function public.review_window_days() to anon, authenticated;

-- ---------- the table ----------
create table if not exists public.order_reviews (
  id                uuid primary key default gen_random_uuid(),
  order_id          uuid not null references public.contracts(id) on delete cascade,
  reviewer          uuid not null references public.profiles(id) on delete cascade,
  reviewee          uuid not null references public.profiles(id) on delete cascade,
  reviewer_role     text not null,
  rating            int  not null,
  comment           text not null default '',
  low_reason        text,
  submitted_at      timestamptz not null default now(),
  reveal_due        timestamptz not null,
  revealed_at       timestamptz,
  is_revealed       boolean not null default false,
  moderation_status text not null default 'visible',
  moderation_reason text,
  edits             int not null default 0,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

alter table public.order_reviews drop constraint if exists order_reviews_one_per_side;
alter table public.order_reviews add  constraint order_reviews_one_per_side unique (order_id, reviewer_role);
alter table public.order_reviews drop constraint if exists order_reviews_one_per_person;
alter table public.order_reviews add  constraint order_reviews_one_per_person unique (order_id, reviewer);
alter table public.order_reviews drop constraint if exists order_reviews_not_self;
alter table public.order_reviews add  constraint order_reviews_not_self check (reviewer <> reviewee);
alter table public.order_reviews drop constraint if exists order_reviews_role_check;
alter table public.order_reviews add  constraint order_reviews_role_check check (reviewer_role in ('client','freelancer'));
alter table public.order_reviews drop constraint if exists order_reviews_rating_check;
alter table public.order_reviews add  constraint order_reviews_rating_check check (rating between 1 and 5);
alter table public.order_reviews drop constraint if exists order_reviews_comment_len;
alter table public.order_reviews add  constraint order_reviews_comment_len check (length(comment) <= 2000);
alter table public.order_reviews drop constraint if exists order_reviews_moderation_check;
alter table public.order_reviews add  constraint order_reviews_moderation_check check (moderation_status in ('visible','reported','hidden'));
-- 1-3 stars: a reason from that side's list and a written explanation. 4-5: both optional.
alter table public.order_reviews drop constraint if exists order_reviews_low_needs_why;
alter table public.order_reviews add  constraint order_reviews_low_needs_why
  check (rating >= 4 or (low_reason is not null and length(btrim(comment)) >= 10));
alter table public.order_reviews drop constraint if exists order_reviews_reason_check;
alter table public.order_reviews add  constraint order_reviews_reason_check check (
  low_reason is null
  or (reviewer_role = 'client'     and low_reason in ('poor_quality','missed_deadline','poor_communication','scope_not_followed','unprofessional','other'))
  or (reviewer_role = 'freelancer' and low_reason in ('poor_communication','scope_changes','payment_issue','unreasonable_demands','missing_materials','abusive','other'))
);

create index if not exists order_reviews_reviewee_idx on public.order_reviews(reviewee, submitted_at desc);
create index if not exists order_reviews_order_idx    on public.order_reviews(order_id);

alter table public.order_reviews enable row level security;
-- No policies on purpose: every read and write goes through the functions below, the same way
-- contracts and reports work. Nothing here is reachable with a raw PostgREST call.
revoke all on public.order_reviews from anon, authenticated;

-- history is kept: an update may never rewrite who said what about which Order
create or replace function public.order_reviews_guard()
returns trigger language plpgsql as $$
begin
  new.order_id      := old.order_id;
  new.reviewer      := old.reviewer;
  new.reviewee      := old.reviewee;
  new.reviewer_role := old.reviewer_role;
  new.created_at    := old.created_at;
  new.submitted_at  := old.submitted_at;
  new.updated_at    := now();
  return new;
end $$;
drop trigger if exists order_reviews_guard on public.order_reviews;
create trigger order_reviews_guard before update on public.order_reviews
  for each row execute function public.order_reviews_guard();

-- ---------- what a visible review is ----------
-- Revealed when both sides have answered, or when the window has run out. Hidden by an admin
-- means gone from the public number and the public list, while the row itself stays for the audit.
create or replace function public.order_review_is_public(r public.order_reviews)
returns boolean language sql stable as $$
  select r.moderation_status = 'visible' and (r.is_revealed or now() > r.reveal_due);
$$;

-- ---------- eligibility ----------
-- Only a completed Order, only the two people on it, only inside the window.
create or replace function public.order_review_role(c public.contracts, uid uuid)
returns text language sql immutable as $$
  select case when uid = c.client then 'client' when uid = c.editor then 'freelancer' else null end;
$$;

create or replace function public.order_review_opens(c public.contracts)
returns timestamptz language sql stable as $$
  select coalesce(c.completed_at, c.closed_at, c.created_at);
$$;

-- small internal history writer (order_log is service_role only)
create or replace function public.order_log_review(p_order uuid, p_event text)
returns void language sql security definer set search_path = public as $$
  insert into public.order_events (order_id, actor, event, data) values (p_order, auth.uid(), p_event, '{}'::jsonb);
$$;
revoke execute on function public.order_log_review(uuid, text) from public, anon, authenticated;

-- ---------- submitting ----------
create or replace function public.order_review_submit(p_order uuid, p_rating int, p_comment text, p_reason text)
returns text language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); c public.contracts; my_role text; other public.order_reviews; mine public.order_reviews; due timestamptz;
begin
  if me is null then return 'not_signed_in'; end if;
  if public.is_banned(me) then return 'banned'; end if;
  select * into c from public.contracts where id = p_order;
  if not found then return 'not_found'; end if;
  my_role := public.order_review_role(c, me);
  if my_role is null then return 'not_your_order'; end if;              -- not a party to this Order
  if c.status <> 'completed' then return 'review_not_completed'; end if;
  due := public.order_review_opens(c) + (public.review_window_days() || ' days')::interval;
  if now() > due then return 'review_window_closed'; end if;

  p_comment := btrim(coalesce(p_comment, ''));
  p_reason  := nullif(btrim(coalesce(p_reason, '')), '');
  if p_rating is null or p_rating < 1 or p_rating > 5 then return 'bad_rating'; end if;
  if length(p_comment) > 2000 then return 'comment_too_long'; end if;
  if p_rating <= 3 then
    if p_reason is null then return 'reason_required'; end if;
    if length(p_comment) < 10 then return 'comment_required'; end if;
  else
    if p_reason is not null then p_reason := null; end if;              -- a reason only belongs to a low rating
  end if;
  if p_reason is not null and not (
       (my_role = 'client'     and p_reason in ('poor_quality','missed_deadline','poor_communication','scope_not_followed','unprofessional','other'))
    or (my_role = 'freelancer' and p_reason in ('poor_communication','scope_changes','payment_issue','unreasonable_demands','missing_materials','abusive','other')))
  then return 'bad_reason'; end if;

  select * into mine from public.order_reviews where order_id = p_order and reviewer = me;
  if found then
    -- a correction is allowed while the review is still blind, and only twice
    if mine.is_revealed or now() > mine.reveal_due then return 'review_locked'; end if;
    if mine.edits >= 2 then return 'review_edit_limit'; end if;
    update public.order_reviews
       set rating = p_rating, comment = p_comment, low_reason = p_reason, edits = mine.edits + 1
     where id = mine.id;
  else
    begin
      perform public.rate_limit('order_review', 20, interval '1 day');
    exception when others then return 'rate_limited';
    end;
    insert into public.order_reviews (order_id, reviewer, reviewee, reviewer_role, rating, comment, low_reason, reveal_due)
    values (p_order, me, case when my_role = 'client' then c.editor else c.client end, my_role, p_rating, p_comment, p_reason, due);
  end if;

  -- both sides have spoken: lift the blind on both at the same moment
  select * into other from public.order_reviews where order_id = p_order and reviewer <> me;
  if found then
    update public.order_reviews set is_revealed = true, revealed_at = coalesce(revealed_at, now())
     where order_id = p_order and not is_revealed;
    perform public.order_log_review(p_order, 'reviews_revealed');
  end if;
  return 'ok';
end $$;
revoke execute on function public.order_review_submit(uuid, int, text, text) from public, anon;
grant   execute on function public.order_review_submit(uuid, int, text, text) to authenticated;

-- ---------- what each side may see about one Order ----------
create or replace function public.order_review_state(p_order uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare me uuid := auth.uid(); c public.contracts; my_role text; mine public.order_reviews; theirs public.order_reviews;
        due timestamptz; shown boolean;
begin
  if me is null then return jsonb_build_object('eligible', false, 'reason', 'not_signed_in'); end if;
  select * into c from public.contracts where id = p_order;
  if not found then return jsonb_build_object('eligible', false, 'reason', 'not_found'); end if;
  my_role := public.order_review_role(c, me);
  if my_role is null and not public.is_admin() then return jsonb_build_object('eligible', false, 'reason', 'not_your_order'); end if;
  due := public.order_review_opens(c) + (public.review_window_days() || ' days')::interval;
  select * into mine   from public.order_reviews where order_id = p_order and reviewer  = me;
  select * into theirs from public.order_reviews where order_id = p_order and reviewer <> me;
  shown := theirs.id is not null and public.order_review_is_public(theirs);
  return jsonb_build_object(
    'eligible',   c.status = 'completed' and my_role is not null and now() <= due,
    'role',       my_role,
    'status',     c.status,
    'window_days', public.review_window_days(),
    'closes_at',  due,
    'other_name', coalesce((select coalesce(nullif(ep.display_name,''), p.first_name, 'Cuvori')
                              from public.profiles p left join public.editor_profiles ep on ep.id = p.id
                             where p.id = case when my_role = 'client' then c.editor else c.client end), 'Cuvori'),
    'other_id',   case when my_role = 'client' then c.editor else c.client end,
    'mine',       case when mine.id is null then null else jsonb_build_object(
                    'id', mine.id, 'rating', mine.rating, 'comment', mine.comment, 'reason', mine.low_reason,
                    'submitted_at', mine.submitted_at, 'revealed', public.order_review_is_public(mine),
                    'edits_left', greatest(0, 2 - mine.edits)) end,
    'theirs',     case when shown then jsonb_build_object(
                    'id', theirs.id, 'rating', theirs.rating, 'comment', theirs.comment, 'reason', theirs.low_reason,
                    'submitted_at', theirs.submitted_at) else null end,
    'theirs_waiting', theirs.id is not null and not shown
  );
end $$;
revoke execute on function public.order_review_state(uuid) from public, anon;
grant   execute on function public.order_review_state(uuid) to authenticated;

-- ---------- what the public sees ----------
-- One number and a count, derived every time from the reviews that are visible right now, so
-- hiding a review changes the average immediately and there is no counter to drift out of step.
create or replace function public.profile_ratings(p_ids uuid[])
returns table (user_id uuid, rating numeric, reviews int)
language sql stable security definer set search_path = public as $$
  select r.reviewee,
         round(avg(r.rating)::numeric, 1),
         count(*)::int
    from public.order_reviews r
   where r.reviewee = any(coalesce(p_ids, '{}'::uuid[]))
     and public.order_review_is_public(r)
   group by r.reviewee;
$$;
grant execute on function public.profile_ratings(uuid[]) to anon, authenticated;

-- The list for one person's profile. Reviewer identity follows the same rule as the rest of the
-- site: first name (or public display name). No prices, no files, no messages, no Order id.
create or replace function public.profile_reviews(p_user uuid, p_limit int default 20)
returns jsonb language sql stable security definer set search_path = public as $$
  with vis as (
    select r.*, c.profession_slug
      from public.order_reviews r
      join public.contracts c on c.id = r.order_id
     where r.reviewee = p_user and public.order_review_is_public(r)
     order by r.submitted_at desc
     limit greatest(1, least(100, coalesce(p_limit, 20)))
  )
  select jsonb_build_object(
    'user_id', p_user,
    'rating',  (select round(avg(rating)::numeric, 1) from public.order_reviews r2 where r2.reviewee = p_user and public.order_review_is_public(r2)),
    'count',   (select count(*)::int from public.order_reviews r2 where r2.reviewee = p_user and public.order_review_is_public(r2)),
    'reviews', coalesce((select jsonb_agg(jsonb_build_object(
                  'id', v.id,
                  'rating', v.rating,
                  'comment', v.comment,
                  'reason', v.low_reason,
                  'role', v.reviewer_role,
                  'profession', v.profession_slug,
                  'submitted_at', v.submitted_at,
                  'verified', true,
                  'who', coalesce(nullif(ep.display_name, ''), p.first_name, 'Cuvori')
                ) order by v.submitted_at desc)
                from vis v
                left join public.profiles p on p.id = v.reviewer
                left join public.editor_profiles ep on ep.id = v.reviewer), '[]'::jsonb)
  );
$$;
grant execute on function public.profile_reviews(uuid, int) to anon, authenticated;

-- Orders waiting for my review, newest first: what the bell counts and the page links to.
create or replace function public.my_review_invites()
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'order_id', c.id,
           'other_id', case when c.client = auth.uid() then c.editor else c.client end,
           'title', c.title,
           'closes_at', public.order_review_opens(c) + (public.review_window_days() || ' days')::interval,
           'other_name', coalesce(nullif(ep.display_name, ''), p.first_name, 'Cuvori')
         ) order by c.completed_at desc nulls last), '[]'::jsonb)
    from public.contracts c
    left join public.profiles p on p.id = case when c.client = auth.uid() then c.editor else c.client end
    left join public.editor_profiles ep on ep.id = p.id
   where auth.uid() in (c.client, c.editor)
     and c.status = 'completed'
     and now() <= public.order_review_opens(c) + (public.review_window_days() || ' days')::interval
     and not exists (select 1 from public.order_reviews r where r.order_id = c.id and r.reviewer = auth.uid());
$$;
revoke execute on function public.my_review_invites() from public, anon;
grant   execute on function public.my_review_invites() to authenticated;

-- ---------- moderation ----------
create or replace function public.admin_list_order_reviews(p_status text default null)
returns table (id uuid, order_id uuid, reviewer uuid, reviewee uuid, reviewer_role text, rating int,
               comment text, low_reason text, submitted_at timestamptz, is_revealed boolean,
               moderation_status text, moderation_reason text, reviewer_name text, reviewee_name text)
language sql stable security definer set search_path = public as $$
  select r.id, r.order_id, r.reviewer, r.reviewee, r.reviewer_role, r.rating, r.comment, r.low_reason,
         r.submitted_at, r.is_revealed, r.moderation_status, r.moderation_reason,
         coalesce(pr.first_name, 'user'), coalesce(pe.first_name, 'user')
    from public.order_reviews r
    left join public.profiles pr on pr.id = r.reviewer
    left join public.profiles pe on pe.id = r.reviewee
   where public.is_admin()
     and (p_status is null or r.moderation_status = p_status)
   order by r.submitted_at desc
   limit 200;
$$;
grant execute on function public.admin_list_order_reviews(text) to authenticated;

-- Hide or show. The text the person wrote is never touched; the reason for hiding is kept
-- next to it and a line goes into the moderation log.
create or replace function public.admin_moderate_review(p_id uuid, p_status text, p_reason text)
returns text language plpgsql security definer set search_path = public as $$
declare r public.order_reviews;
begin
  if not public.is_admin() then return 'forbidden'; end if;
  if p_status not in ('visible','reported','hidden') then return 'bad_status'; end if;
  select * into r from public.order_reviews where id = p_id;
  if not found then return 'not_found'; end if;
  update public.order_reviews
     set moderation_status = p_status,
         moderation_reason = nullif(btrim(coalesce(p_reason, '')), '')
   where id = p_id;
  insert into public.moderation_actions (job_id, target_user, admin, action, reason)
  values (null, r.reviewee, auth.uid(), 'review_' || p_status, coalesce(btrim(p_reason), ''));
  return 'ok';
end $$;
grant execute on function public.admin_moderate_review(uuid, text, text) to authenticated;

-- ---------- the invitation ----------
-- The moment an Order is completed both sides get the usual chat card, this one asking for a
-- review. Clicking it opens that Order, where the review button lives.
create or replace function public.contracts_review_invite()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'completed' and coalesce(old.status, '') <> 'completed' then
    begin
      perform public.contract_event(new, 'review_invited');
      insert into public.order_events (order_id, actor, event, data)
      values (new.id, null, 'review_invited', jsonb_build_object('closes_at', public.order_review_opens(new) + (public.review_window_days() || ' days')::interval));
    exception when others then null;   -- an Order must never fail to complete because of this
    end;
  end if;
  return new;
end $$;
drop trigger if exists contracts_review_invite on public.contracts;
create trigger contracts_review_invite after update of status on public.contracts
  for each row execute function public.contracts_review_invite();

-- ---------- deleting a person takes their reviews with them ----------
create or replace function public.purge_user(target uuid)
returns void language plpgsql security definer set search_path = public, storage as $$
declare was_bad boolean;
begin
  was_bad := exists (select 1 from public.user_flags f where f.user_id = target) or coalesce((select banned from public.profiles where id = target), false);
  if was_bad then
    insert into public.deleted_user_identifiers (kind, value_hash, label, note)
    select i.kind, i.value_hash, i.label, coalesce((select string_agg(f.kind || ': ' || f.reason, ' | ') from public.user_flags f where f.user_id = target), 'banned')
    from public.user_identifiers i where i.user_id = target;
  end if;
  delete from storage.objects where bucket_id = 'portfolio' and name like target::text || '/%';
  delete from public.order_reviews where reviewer = target or reviewee = target;
  delete from public.contracts where editor = target or client = target;
  delete from public.payout_details where id = target;
  delete from public.reviews where client = target or editor = target;
  delete from public.messages where sender = target;
  delete from public.conversations where user_a = target or user_b = target;
  delete from public.jobs where owner = target;
  delete from public.projects where owner = target;
  delete from public.editor_profiles where id = target;
  update public.invites set used_by = null, note = coalesce(note,'') || ' [user deleted]' where used_by = target;
  delete from public.profiles where id = target;
  delete from auth.users where id = target;
end $$;
revoke execute on function public.purge_user(uuid) from public, anon, authenticated;
