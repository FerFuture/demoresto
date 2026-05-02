-- Despacho multi-repartidor: aviso desde admin, un repartidor toma el pedido, reporte de incidencias.
-- Ejecutar en Supabase SQL Editor (idempotente).

alter table public.orders
  add column if not exists delivery_ready_broadcast_at timestamptz,
  add column if not exists delivery_claimed_by_user_id uuid references public.dashboard_users (id) on delete set null,
  add column if not exists delivery_claimed_at timestamptz,
  add column if not exists delivery_issue_reported_at timestamptz,
  add column if not exists delivery_issue_reason text,
  add column if not exists delivery_issue_reported_by_user_id uuid references public.dashboard_users (id) on delete set null,
  add column if not exists delivery_en_route_customer_notified_at timestamptz,
  add column if not exists delivery_issue_acknowledged_at timestamptz;

create index if not exists orders_delivery_pool_idx
  on public.orders (restaurant_id, delivery_ready_broadcast_at)
  where delivery_claimed_by_user_id is null and delivery_ready_broadcast_at is not null;
