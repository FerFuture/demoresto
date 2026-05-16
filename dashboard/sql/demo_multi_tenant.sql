-- =============================================================================
-- RestoBot — multi-tenant demos (URL /d/{demo_slug}/…)
-- Ejecutar en Supabase → SQL Editor. Idempotente.
-- =============================================================================
-- Después de aplicar:
-- 1) Asigná demo_slug único a cada restaurante demo (ej. 'cliente-acme').
-- 2) Poné demo_expires_at si querés caducidad automática (ver demo_cleanup_expired.sql).
-- 3) Actualizá dashboard_users.restaurant_id = <uuid del restaurante> por usuario.
-- =============================================================================

-- ---------- restaurants ----------
alter table public.restaurants
  add column if not exists demo_slug text,
  add column if not exists demo_expires_at timestamptz,
  add column if not exists is_demo boolean not null default false;

comment on column public.restaurants.demo_slug is
  'Slug público: rutas /d/{slug}/login, /d/{slug}/carta, etc. Minúsculas, sin espacios.';
comment on column public.restaurants.demo_expires_at is
  'Si no null y < now(), el demo se considera vencido (bloqueo en app + limpieza opcional).';
comment on column public.restaurants.is_demo is
  'True si esta fila es una instancia de demo (operación interna).';

drop index if exists restaurants_demo_slug_lower_idx;
create unique index restaurants_demo_slug_lower_idx
  on public.restaurants (lower(trim(demo_slug)))
  where demo_slug is not null and length(trim(demo_slug)) > 0;

-- ---------- dashboard_users: pertenencia al restaurante ----------
alter table public.dashboard_users
  add column if not exists restaurant_id uuid references public.restaurants(id) on delete cascade;

comment on column public.dashboard_users.restaurant_id is
  'Restaurante al que pertenece el usuario del panel. Null = legado (único tenant).';

-- Unicidad: (restaurant_id, username) por demo; username global único solo si restaurant_id es null.
drop index if exists dashboard_users_username_lower_idx;
drop index if exists dashboard_users_restaurant_username_lower_idx;
drop index if exists dashboard_users_username_lower_legacy_idx;

create unique index dashboard_users_restaurant_username_lower_idx
  on public.dashboard_users (restaurant_id, lower(username))
  where restaurant_id is not null;

create unique index dashboard_users_username_lower_legacy_idx
  on public.dashboard_users (lower(username))
  where restaurant_id is null;

-- Verificación
select column_name, data_type
from information_schema.columns
where table_schema = 'public'
  and table_name = 'restaurants'
  and column_name in ('demo_slug', 'demo_expires_at', 'is_demo')
order by column_name;

select column_name, data_type
from information_schema.columns
where table_schema = 'public'
  and table_name = 'dashboard_users'
  and column_name = 'restaurant_id';
