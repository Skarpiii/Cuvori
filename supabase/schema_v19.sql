-- ============================================================
-- Cuvori — schema v19: accounts created through Google / Facebook get a
-- first name from what the provider sends. Run AFTER schema_v18.sql. Re-runnable.
-- To switch the providers on: Supabase → Authentication → Providers (SETUP Part 14).
-- ============================================================
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public, extensions as $$
declare nm text;
begin
  nm := coalesce(nullif(new.raw_user_meta_data->>'first_name', ''), nullif(new.raw_user_meta_data->>'given_name', ''),
                 nullif(split_part(coalesce(new.raw_user_meta_data->>'full_name', ''), ' ', 1), ''),
                 nullif(split_part(coalesce(new.raw_user_meta_data->>'name', ''), ' ', 1), ''), '');
  insert into public.profiles (id, email, first_name)
  values (new.id, new.email, left(regexp_replace(nm, '[[:cntrl:]<>]', '', 'g'), 80))
  on conflict (id) do nothing;
  return new;
end $$;
