-- Cuvori schema v44 — nothing new is written into a chat with a person who deleted their account.
-- Run after schema_v43.sql, in the Supabase SQL editor.
--
-- When one of two people deletes their account, an Order they agreed is kept, and so is its chat (v35): the other person
-- keeps seeing the Order and its history. That person could still send messages, progress reports and change requests
-- into the chat. Nobody will ever read them, and the page gave no sign of it, so the person left behind could keep
-- writing and waiting for an answer that never comes. (v41 already refuses a new Order or change there.)
-- Now a message, report or change request a signed-in person writes into such a chat is refused ("not_available": the
-- page says "This person can't be contacted right now."), and the page can ask which of its chats these are, to say so up
-- front. The Order's own history cards and Cuvori's notes on an Order (written by the database's own functions and by the
-- payment functions) still arrive, so the person left behind keeps seeing what happens to a kept Order. Messages already
-- in the chat stay.

-- The signed-in person's chats in which the other person has deleted their account.
create or replace function public.chats_with_deleted_people()
returns uuid[] language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(c.id), '{}') from public.conversations c
   where auth.uid() in (c.user_a, c.user_b)
     and exists (select 1 from public.profiles p where p.id in (c.user_a, c.user_b) and p.deleted_at is not null);
$$;
revoke execute on function public.chats_with_deleted_people() from public, anon;
grant execute on function public.chats_with_deleted_people() to authenticated;

-- Runs as the person writing (not as the database owner), so it can tell what a signed-in person writes themselves from
-- what the database's functions and the payment functions write.
create or replace function public.messages_need_both_people()
returns trigger language plpgsql set search_path = public as $$
begin
  if current_user = 'authenticated'
     and new.conversation_id = any(public.chats_with_deleted_people()) then
    raise exception 'not_available' using hint = 'the other person in this chat has deleted their account';
  end if;
  return new;
end $$;
revoke execute on function public.messages_need_both_people() from public, anon, authenticated;

drop trigger if exists messages_need_both_people on public.messages;
create trigger messages_need_both_people before insert on public.messages
  for each row execute function public.messages_need_both_people();

-- Shows whether this ran: one row that says "v44 applied".
select case when exists (select 1 from pg_trigger where tgrelid = 'public.messages'::regclass and tgname = 'messages_need_both_people' and tgenabled <> 'D')
             and has_function_privilege('authenticated', 'public.chats_with_deleted_people()', 'execute')
             and not has_function_privilege('anon', 'public.chats_with_deleted_people()', 'execute')
            then 'v44 applied: nothing new is written into a chat with a person who deleted their account.'
            else 'v44 NOT applied' end as result;
