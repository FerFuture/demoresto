-- Políticas RLS — Paso 2 (dashboard con clave anon)
-- Ejecutá TODO este archivo en Supabase → SQL Editor (idempotente: podés re-ejecutar).
-- Después corré `rls_step2_verify.sql` para comprobar políticas y RLS sin tocar datos.
--
-- El bot Node debería usar SUPABASE_SERVICE_ROLE_KEY (no pasa por RLS).
-- El dashboard Vite usa SUPABASE_KEY (anon): si RLS está ON, hace falta estas políticas.
--
-- Seguridad: USING (true) permite a cualquiera con la clave anon leer/escribir esas tablas.
-- Para producción pública endurecé (auth, por restaurant_id, etc.).

-- ---------- restaurants ----------
alter table public.restaurants enable row level security;

drop policy if exists "restobot_restaurants_anon_select" on public.restaurants;
create policy "restobot_restaurants_anon_select"
  on public.restaurants for select to anon using (true);

drop policy if exists "restobot_restaurants_auth_select" on public.restaurants;
create policy "restobot_restaurants_auth_select"
  on public.restaurants for select to authenticated using (true);

-- UPDATE: necesario para guardar configuración (Admin → pestaña Configuración).
-- (También definidas en restaurants_config_columns.sql; conviven por DROP IF EXISTS.)
drop policy if exists "restobot_restaurants_anon_update" on public.restaurants;
create policy "restobot_restaurants_anon_update"
  on public.restaurants for update to anon using (true) with check (true);

drop policy if exists "restobot_restaurants_auth_update" on public.restaurants;
create policy "restobot_restaurants_auth_update"
  on public.restaurants for update to authenticated using (true) with check (true);

-- ---------- menu_items ----------
alter table public.menu_items enable row level security;

drop policy if exists "restobot_menu_items_anon_all" on public.menu_items;
create policy "restobot_menu_items_anon_all"
  on public.menu_items for all to anon using (true) with check (true);

drop policy if exists "restobot_menu_items_auth_all" on public.menu_items;
create policy "restobot_menu_items_auth_all"
  on public.menu_items for all to authenticated using (true) with check (true);

-- ---------- bot_interactions (nombre por defecto del proyecto) ----------
alter table public.bot_interactions enable row level security;

drop policy if exists "restobot_interactions_anon_select" on public.bot_interactions;
create policy "restobot_interactions_anon_select"
  on public.bot_interactions for select to anon using (true);

drop policy if exists "restobot_interactions_anon_insert" on public.bot_interactions;
create policy "restobot_interactions_anon_insert"
  on public.bot_interactions for insert to anon with check (true);

drop policy if exists "restobot_interactions_auth_select" on public.bot_interactions;
create policy "restobot_interactions_auth_select"
  on public.bot_interactions for select to authenticated using (true);

drop policy if exists "restobot_interactions_auth_insert" on public.bot_interactions;
create policy "restobot_interactions_auth_insert"
  on public.bot_interactions for insert to authenticated with check (true);

-- ---------- orders ----------
alter table public.orders enable row level security;

drop policy if exists "restobot_orders_anon_select" on public.orders;
create policy "restobot_orders_anon_select"
  on public.orders for select to anon using (true);

drop policy if exists "restobot_orders_anon_insert" on public.orders;
create policy "restobot_orders_anon_insert"
  on public.orders for insert to anon with check (true);

drop policy if exists "restobot_orders_anon_update" on public.orders;
create policy "restobot_orders_anon_update"
  on public.orders for update to anon using (true) with check (true);

drop policy if exists "restobot_orders_auth_select" on public.orders;
create policy "restobot_orders_auth_select"
  on public.orders for select to authenticated using (true);

drop policy if exists "restobot_orders_auth_insert" on public.orders;
create policy "restobot_orders_auth_insert"
  on public.orders for insert to authenticated with check (true);

drop policy if exists "restobot_orders_auth_update" on public.orders;
create policy "restobot_orders_auth_update"
  on public.orders for update to authenticated using (true) with check (true);

-- ---------- stock_items ----------
alter table public.stock_items enable row level security;

drop policy if exists "restobot_stock_items_anon_all" on public.stock_items;
create policy "restobot_stock_items_anon_all"
  on public.stock_items for all to anon using (true) with check (true);

drop policy if exists "restobot_stock_items_auth_all" on public.stock_items;
create policy "restobot_stock_items_auth_all"
  on public.stock_items for all to authenticated using (true) with check (true);

-- ---------- stock_recipes ----------
alter table public.stock_recipes enable row level security;

drop policy if exists "restobot_stock_recipes_anon_all" on public.stock_recipes;
create policy "restobot_stock_recipes_anon_all"
  on public.stock_recipes for all to anon using (true) with check (true);

drop policy if exists "restobot_stock_recipes_auth_all" on public.stock_recipes;
create policy "restobot_stock_recipes_auth_all"
  on public.stock_recipes for all to authenticated using (true) with check (true);

-- ---------- stock_recipe_ingredients ----------
alter table public.stock_recipe_ingredients enable row level security;

drop policy if exists "restobot_stock_recipe_ingredients_anon_all" on public.stock_recipe_ingredients;
create policy "restobot_stock_recipe_ingredients_anon_all"
  on public.stock_recipe_ingredients for all to anon using (true) with check (true);

drop policy if exists "restobot_stock_recipe_ingredients_auth_all" on public.stock_recipe_ingredients;
create policy "restobot_stock_recipe_ingredients_auth_all"
  on public.stock_recipe_ingredients for all to authenticated using (true) with check (true);

-- =============================================================================
-- Verificación (solo lectura; seguro re-ejecutar)
-- =============================================================================

-- Políticas creadas para anon/authenticated en las tablas del dashboard
select
  schemaname,
  tablename,
  policyname,
  roles,
  cmd as operation
from pg_policies
where schemaname = 'public'
  and tablename in ('orders', 'menu_items', 'restaurants', 'bot_interactions', 'stock_items', 'stock_recipes', 'stock_recipe_ingredients')
  and policyname like 'restobot_%'
order by tablename, policyname;

-- RLS encendido en esas tablas (relrowsecurity = true)
select
  n.nspname as schema,
  c.relname as table,
  c.relrowsecurity as rls_enabled
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relkind = 'r'
  and c.relname in ('orders', 'menu_items', 'restaurants', 'bot_interactions', 'stock_items', 'stock_recipes', 'stock_recipe_ingredients')
order by c.relname;
