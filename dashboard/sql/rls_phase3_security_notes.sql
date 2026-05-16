-- =============================================================================
-- FASE 3 — Notas de seguridad RLS / anon (RestoBot)
-- =============================================================================
-- Este archivo NO aplica políticas por sí solo: son consultas de auditoría y
-- guía. El dashboard hoy usa la clave `anon` de Supabase; las políticas en
-- rls_policies_restobot.sql usan USING (true) para que el panel funcione.
--
-- Paso implementado en código (repo):
--   POST /api/dashboard/db-login en index.js + verifyDashboardUserCredentials en
--   database.js (service role). El login del panel intenta primero esa ruta y
--   ya no necesita traer password_hash al navegador cuando el backend responde.
--
-- Antes de QUITAR el acceso anon a public.dashboard_users (u otras tablas):
--   1) Asegurate de que index.js esté publicado y el proxy /api (Vite) o
--      MESA_API_PROXY_ORIGIN (Vercel) apunte a ese proceso.
--   2) validateStoredSession en el dashboard sigue usando anon para leer
--      dashboard_users por id; hace falta un endpoint de revalidación firmado
--      o Supabase Auth con JWT por tenant (ver DEMO_ROADMAP Fase 3).
--
-- =============================================================================
-- Auditoría: políticas (solo lectura)
-- =============================================================================
select
  schemaname,
  tablename,
  policyname,
  roles,
  cmd as operation,
  qual as using_expression,
  with_check as with_check_expression
from pg_policies
where schemaname = 'public'
  and tablename in (
    'restaurants',
    'menu_items',
    'bot_interactions',
    'orders',
    'dashboard_users',
    'stock_items',
    'stock_recipes',
    'stock_recipe_ingredients'
  )
order by tablename, policyname;

-- =============================================================================
-- Checklist operativo (3.3 / 3.4)
-- =============================================================================
-- [ ] Proyecto Supabase dedicado a demos vs producción real.
-- [ ] Rotar SUPABASE_KEY (anon) y SUPABASE_SERVICE_ROLE_KEY si hubo exposición.
-- [ ] No commitear .env con claves; usar variables por entorno en el host.
