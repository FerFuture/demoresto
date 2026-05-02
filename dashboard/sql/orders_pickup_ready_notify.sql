-- Retiro en local: el admin pide avisar al cliente; el bot envía WhatsApp y marca notificado.
-- Idempotente. Ejecutar en Supabase SQL Editor.

alter table public.orders
  add column if not exists pickup_ready_notify_requested_at timestamptz,
  add column if not exists pickup_ready_customer_notified_at timestamptz;

create index if not exists orders_pickup_ready_pending_idx
  on public.orders (pickup_ready_notify_requested_at)
  where pickup_ready_customer_notified_at is null;
