-- Cocina / mozo: mesa y momento en que cocina marcó el pedido como listo.
-- Ejecutar en Supabase SQL Editor (idempotente).

alter table public.orders
  add column if not exists table_number integer,
  add column if not exists kitchen_ready_at timestamptz;

comment on column public.orders.table_number is 'Número de mesa (pedidos desde mozo o asignación manual).';
comment on column public.orders.kitchen_ready_at is 'Cocina marcó el pedido listo para entrega/retiro/delivery.';

-- Ampliar roles del panel (antes solo admin, delivery)
alter table public.dashboard_users
  drop constraint if exists dashboard_users_role_check;

alter table public.dashboard_users
  add constraint dashboard_users_role_check
  check (role in ('admin', 'delivery', 'kitchen', 'waiter'));
