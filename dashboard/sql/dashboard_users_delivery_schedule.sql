-- Días permitidos para login de cuentas `delivery` (0=domingo … 6=sábado, igual que Date.getDay en JS).
-- NULL = puede entrar cualquier día (comportamiento anterior).
-- Ejecutar en Supabase SQL Editor si ya tenías la tabla `dashboard_users`.

alter table public.dashboard_users
  add column if not exists delivery_work_weekdays integer[];

comment on column public.dashboard_users.delivery_work_weekdays is
  'Solo delivery: días en los que puede iniciar sesión (0–6). NULL = todos los días.';
