-- Verificación paso 2 (RLS + dashboard anon) — SOLO SELECT
-- Ejecutá esto en Supabase → SQL Editor cuando quieras comprobar el estado.
-- No modifica nada. Si falta una fila esperada, volvé a ejecutar rls_policies_restobot.sql

-- 1) Políticas RestoBot en tablas clave
select
  schemaname,
  tablename,
  policyname,
  roles,
  cmd as operation
from pg_policies
where schemaname = 'public'
  and tablename in ('orders', 'menu_items', 'restaurants', 'bot_interactions')
  and policyname like 'restobot_%'
order by tablename, policyname;

-- Esperado (resumen):
--   orders:     restobot_orders_anon_{select,insert,update} + auth_* (mismo set)
--   menu_items: restobot_menu_items_anon_all (incluye DELETE para borrar ítems en dashboard)
--   restaurants: restobot_restaurants_anon_{select,update} (+ auth select/update)
--   bot_interactions: anon/auth select + insert (sin update; el dashboard no la usa)

-- 2) RLS activado por tabla
select
  n.nspname as schema,
  c.relname as table,
  c.relrowsecurity as rls_enabled
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relkind = 'r'
  and c.relname in ('orders', 'menu_items', 'restaurants', 'bot_interactions')
order by c.relname;

-- 3) Conteo rápido: deberías ver al menos 1 política por tabla objetivo (bot_interactions tiene menos ops)
select tablename, count(*) as policy_count
from pg_policies
where schemaname = 'public'
  and tablename in ('orders', 'menu_items', 'restaurants', 'bot_interactions')
  and policyname like 'restobot_%'
group by tablename
order by tablename;
