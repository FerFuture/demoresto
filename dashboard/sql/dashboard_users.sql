-- Usuarios del dashboard (admin / delivery). Ejecutar en Supabase SQL Editor.
-- Las contraseñas se guardan con bcrypt (hash en columna password_hash).
-- La política RLS es permisiva para la clave anon del frontend: en producción
-- conviene restringir (p. ej. Supabase Auth o Edge Functions con service role).

create table if not exists public.dashboard_users (
  id uuid primary key default gen_random_uuid(),
  username text not null,
  password_hash text not null,
  role text not null check (role in ('admin', 'delivery', 'kitchen', 'waiter')),
  label text,
  is_active boolean not null default true,
  delivery_work_weekdays integer[],
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists dashboard_users_username_lower_idx
  on public.dashboard_users (lower(username));

alter table public.dashboard_users enable row level security;

drop policy if exists "dashboard_users_allow_all" on public.dashboard_users;
create policy "dashboard_users_allow_all"
  on public.dashboard_users
  for all
  using (true)
  with check (true);

comment on table public.dashboard_users is 'Cuentas para login del dashboard RestoBot (bcrypt).';
comment on column public.dashboard_users.delivery_work_weekdays is
  'Solo rol delivery: días permitidos para login (0–6, Date.getDay). NULL = todos los días.';
