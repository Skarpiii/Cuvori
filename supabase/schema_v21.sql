-- ============================================================
-- Cuvori — schema v21: money that survives the real world.
-- Chargebacks (before and after a release), the provider's real fee per payment, the charge behind
-- each payment (so releases can be tied to it and refunds go back where they came from), and a small
-- table of idempotency keys so a retry after a failure is a real attempt while a retry after an
-- unknown outcome can never pay twice. Run AFTER schema_v20.sql. Re-runnable.
-- ============================================================

-- ---------- contracts: a chargeback is a state of its own ----------
alter table public.contracts add column if not exists chargeback_id      text;
alter table public.contracts add column if not exists chargeback_status  text;
alter table public.contracts add column if not exists chargeback_cents   int;
alter table public.contracts add column if not exists stripe_reversal_id text;
alter table public.contracts drop constraint if exists contracts_chargeback_check;
alter table public.contracts add constraint contracts_chargeback_check check (chargeback_status is null or chargeback_status in ('open','won','lost')) not valid;
alter table public.contracts drop constraint if exists contracts_resolution_check;
alter table public.contracts add constraint contracts_resolution_check check (resolution is null or resolution in ('release','refund','split','chargeback')) not valid;

-- ---------- ledger: which charge, what the provider really took, money pulled back or lost ----------
alter table public.order_payments add column if not exists charge_ref         text;
alter table public.order_payments add column if not exists provider_fee_cents int;
alter table public.order_payments drop constraint if exists order_payments_kind_check;
alter table public.order_payments add constraint order_payments_kind_check check (kind in ('fund','release','refund','reversal','chargeback'));

-- ---------- idempotency keys: one per money move, kept while the outcome is unknown ----------
create table if not exists public.money_keys (
  scope      text primary key,
  key        text not null,
  created_at timestamptz not null default now()
);
alter table public.money_keys enable row level security;              -- no policies: only the service role (the functions) can touch it
revoke all on public.money_keys from anon, authenticated;

-- ---------- an account with an open chargeback cannot be deleted either ----------
create or replace function public.has_money_held(target uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.contracts c where target in (c.editor, c.client)
                 and (c.status in ('funded','delivered','disputed','releasing','resolving') or c.chargeback_status = 'open'));
$$;
revoke execute on function public.has_money_held(uuid) from public, anon, authenticated;

-- ---------- the admin sees what needs a hand ----------
drop function if exists public.admin_list_contracts();
create or replace function public.admin_list_contracts()
returns table (id uuid, title text, price numeric, currency text, pricing text, status text, payment_mode text, created_at timestamptz,
               delivered_at timestamptz, disputed_at timestamptz, dispute_by uuid, dispute_reason text, delivery_note text, delivery_url text,
               auto_release_at timestamptz, resolution text, conversation_id uuid,
               editor uuid, editor_name text, editor_email text, client uuid, client_name text, client_email text,
               profession_slug text, amount_cents int, funded_cents int, released_cents int, refunded_cents int, has_milestones boolean, amendments int,
               money_error text, chargeback_status text, chargeback_cents int, chargeback_id text, stripe_payment_intent text, stripe_transfer_id text, stripe_refund_id text)
language sql stable security definer set search_path = public as $$
  select c.id, c.title, c.price, c.currency, c.pricing, c.status, c.payment_mode, c.created_at,
         c.delivered_at, c.disputed_at, c.dispute_by, c.dispute_reason, c.delivery_note, c.delivery_url, c.auto_release_at, c.resolution, c.conversation_id,
         c.editor, coalesce(e.display_name, pe.first_name), pe.email, c.client, pc.first_name, pc.email,
         c.profession_slug, c.amount_cents, c.funded_cents, c.released_cents, c.refunded_cents, c.has_milestones, c.amendments,
         c.money_error, c.chargeback_status, c.chargeback_cents, c.chargeback_id, c.stripe_payment_intent, c.stripe_transfer_id, c.stripe_refund_id
  from public.contracts c
  left join public.editor_profiles e on e.id = c.editor
  left join public.profiles pe on pe.id = c.editor
  left join public.profiles pc on pc.id = c.client
  where public.is_admin()
  order by (c.chargeback_status = 'open' or c.money_error is not null) desc nulls last, (c.status = 'disputed') desc, c.created_at desc;
$$;
grant execute on function public.admin_list_contracts() to authenticated;

-- ---------- nobody but the functions moves money: the counters and chargeback fields stay out of reach ----------
-- (the v18 rule already keeps members away from status/counters; the new columns are covered by the same column grants)
revoke update on public.contracts from authenticated;
