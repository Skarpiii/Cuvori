-- Cuvori schema v43 — milestone actions only while the Order is being worked on.
-- Run after schema_v42.sql, in the Supabase SQL editor.
--
-- The Order screen shows a milestone's "Request changes" and "Approve" only while the Order is paid in and open (a
-- protected payment held, or a payment outside Cuvori confirmed). The database checked only the milestone, not the Order.
-- During a dispute the client could still send a submitted milestone back (also from the video review screen): it went
-- back to "not delivered", used one of the paid revision rounds, and changed what Cuvori was deciding on, while the
-- freelancer could no longer deliver it again. After a refund, or after an Order paid outside Cuvori was completed, the
-- same still worked, and "Approve" still marked a milestone approved on a finished Order.
-- Now both are refused unless the Order is open for work, the same rule the screen uses. Nothing else changes.

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

-- Shows whether this ran: one row that says "v43 applied".
select case when pg_get_functiondef('public.order_milestone_action(uuid, text, text, text)'::regprocedure) like '%v43: only while the Order is open for work%'
             and pg_get_functiondef('public.order_milestone_action(uuid, text, text, text)'::regprocedure) like '%c.status <> ''paid'' or m.status%'
            then 'v43 applied: milestone changes and approvals only while the Order is open for work.'
            else 'v43 NOT applied' end as result;
