-- Añade rol `encargado` (debajo de admin: solo pedidos + gestor de menú en el dashboard).
-- Ejecutar en Supabase SQL Editor después de dashboard_users.sql.

alter table public.dashboard_users drop constraint if exists dashboard_users_role_check;

alter table public.dashboard_users add constraint dashboard_users_role_check
  check (role in ('admin', 'delivery', 'kitchen', 'waiter', 'encargado'));
