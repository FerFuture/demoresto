-- Paso 1: columnas delivery + totales (ejecutar en Supabase SQL Editor si aún no están)
alter table public.orders
  add column if not exists fulfillment_type text,
  add column if not exists subtotal_amount numeric(12,2),
  add column if not exists delivery_fee numeric(12,2),
  add column if not exists final_total_amount numeric(12,2),
  add column if not exists payment_link text,
  add column if not exists customer_notified_at timestamptz;
