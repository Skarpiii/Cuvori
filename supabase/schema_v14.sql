-- ============================================================
-- Cuvori — schema v14: a report reaches the administrator as a real message,
-- in the same inbox as everything else. Run AFTER schema_v13.sql. Re-runnable.
-- ============================================================

-- Opens (or finds) the conversation between the person reporting and each administrator
-- and drops the report into it. Runs as the owner, so it can start a conversation that
-- open_conversation() would normally refuse — a normal user cannot message an admin
-- out of the blue, but a report is exactly the case where they should be able to.
create or replace function public.deliver_report_to_admins(
  p_reporter uuid, p_kind text, p_target_kind text, p_target_id text, p_body text)
returns int language plpgsql security definer set search_path = public as $$
declare adm uuid; a uuid; b uuid; cid uuid; header text; n int := 0;
begin
  header := 'Report · ' || p_kind || ' · ' || coalesce(nullif(p_target_kind, ''), 'other')
            || case when coalesce(p_target_id, '') <> '' then ' (' || left(p_target_id, 60) || ')' else '' end;
  for adm in select id from public.profiles where is_admin = true and id <> p_reporter and banned = false loop
    if p_reporter < adm then a := p_reporter; b := adm; else a := adm; b := p_reporter; end if;
    select id into cid from public.conversations where user_a = a and user_b = b;
    if cid is null then
      insert into public.conversations (user_a, user_b) values (a, b) returning id into cid;
    end if;
    insert into public.messages (conversation_id, sender, kind, body)
    values (cid, p_reporter, 'text', header || E'\n' || left(coalesce(p_body, ''), 4000));
    update public.conversations set last_message_at = now() where id = cid;
    n := n + 1;
  end loop;
  return n;
end $$;
revoke execute on function public.deliver_report_to_admins(uuid, text, text, text, text) from public, anon, authenticated;

create or replace function public.submit_report(p_kind text, p_target_kind text, p_target_id text, p_body text)
returns text language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid();
begin
  if me is null then return 'not_signed_in'; end if;
  p_body := btrim(coalesce(p_body, ''));
  if length(p_body) < 10 or length(p_body) > 4000 then return 'bad_body'; end if;
  if p_kind is null or p_kind not in ('illegal','rights','scam','abuse','fake','other') then return 'bad_kind'; end if;
  if coalesce(p_target_kind,'other') not in ('profile','job','review','message','contract','other') then return 'bad_kind'; end if;
  if length(coalesce(p_target_id,'')) > 200 then return 'bad_target'; end if;
  perform public.rate_limit('report_day', 20, interval '1 day');
  insert into public.reports (reporter, kind, target_kind, target_id, body)
  values (me, p_kind, coalesce(p_target_kind,'other'), coalesce(p_target_id,''), p_body);
  -- delivery is a convenience: if it fails, the report is still filed and still in the queue
  begin
    perform public.deliver_report_to_admins(me, p_kind, coalesce(p_target_kind,'other'), coalesce(p_target_id,''), p_body);
  exception when others then null;
  end;
  return 'ok';
end $$;
revoke execute on function public.submit_report(text, text, text, text) from public, anon;
grant   execute on function public.submit_report(text, text, text, text) to authenticated;

-- how many reports are still waiting for an answer (0 for everyone who is not an admin)
create or replace function public.admin_open_reports()
returns int language sql stable security definer set search_path = public as $$
  select case when public.is_admin()
              then (select count(*)::int from public.reports where status = 'open')
              else 0 end;
$$;
revoke execute on function public.admin_open_reports() from public, anon;
grant   execute on function public.admin_open_reports() to authenticated;
