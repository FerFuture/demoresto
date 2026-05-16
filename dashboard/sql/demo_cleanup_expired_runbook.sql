-- =============================================================================
-- FASE 4 — Runbook: demos con demo_expires_at vencidos (Supabase SQL Editor)
-- =============================================================================
-- Objetivo: decidir QUÉ borrar (4.1) y CÓMO programarlo (4.2). Este archivo no
-- borra nada solo: son SELECT y comentarios. Copiá bloques a mano cuando toque.
--
-- Estrategia típica (elegí una):
--   A) Borrar fila restaurant + menú + usuarios (cascade si configuraste FK).
--   B) Solo desactivar: is_active en dashboard_users + acortar demo_expires_at.
--
-- =============================================================================
-- PASO 1 — Inventario (siempre seguro)
-- =============================================================================
select
  id,
  name,
  demo_slug,
  is_demo,
  demo_expires_at,
  demo_expires_at < now() as expired
from public.restaurants
where demo_expires_at is not null
order by demo_expires_at nulls last;

-- Solo vencidos (candidatos a limpieza):
select id, name, demo_slug, demo_expires_at
from public.restaurants
where demo_expires_at is not null
  and demo_expires_at < now()
order by demo_expires_at;

-- Opcional: limitar a filas marcadas como demo
--   and coalesce(is_demo, false) = true

-- =============================================================================
-- PASO 2 — Por cada UUID: borrar dependencias (ejemplo comentado)
-- =============================================================================
-- Reemplazá :rid por el uuid del restaurante vencido. Orden sugerido:
--   bot_interactions → orders → stock_* → menu_items → dashboard_users → restaurants
--
-- delete from public.bot_interactions where restaurant_id = :rid;
-- delete from public.orders where restaurant_id = :rid;
-- delete from public.menu_items where restaurant_id = :rid;
-- delete from public.restaurants where id = :rid;

-- =============================================================================
-- PASO 3 — Automatización (4.2): ejemplo pg_cron (Postgres con extensión)
-- =============================================================================
-- create extension if not exists pg_cron;
-- select cron.schedule(
--   'restobot_demo_cleanup_daily',
--   '5 4 * * *',  -- 04:05 UTC todos los días; ajustá zona
--   $$ … pegá aquí un procedimiento almacenado que liste vencidos y borre … $$
-- );

-- Alternativa sin pg_cron: GitHub Actions con supabase CLI + SQL, o un worker
-- Node que use SUPABASE_SERVICE_ROLE_KEY (misma idea que index.js).
