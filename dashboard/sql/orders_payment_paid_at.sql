-- Columnas para registrar pagos (efectivo / Mercado Pago) y cierre del pedido
-- (entregado / cancelado). Idempotente: se puede re-ejecutar sin riesgo.
-- Ejecutar en Supabase SQL Editor.

alter table public.orders
  add column if not exists payment_paid_at timestamptz,
  add column if not exists mp_payment_id text,
  add column if not exists delivered_at timestamptz,
  add column if not exists cancelled_at timestamptz;

create index if not exists orders_payment_status_idx
  on public.orders (payment_status);

create index if not exists orders_payment_method_idx
  on public.orders (payment_method);
