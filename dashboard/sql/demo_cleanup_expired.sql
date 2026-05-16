-- Limpieza de datos de demos vencidos (ejecutar con rol postgres / cron).
-- Ajustá la cláusula WHERE si solo querés tocar is_demo = true.
--
-- Política de “cuántos días dura un demo”: la define el equipo (campo demo_expires_at al crear el demo).
-- En el dashboard Maestro, el valor inicial del formulario puede fijarse con VITE_DEFAULT_DEMO_EXPIRES_DAYS en .env.
--
-- Orden sugerido: dependencias → filas grandes.
--
-- PASO 1 — Listar candidatos
-- select id, name, demo_slug, demo_expires_at
-- from public.restaurants
-- where demo_expires_at is not null and demo_expires_at < now();
--
-- PASO 2 — Borrar pedidos e interacciones del restaurante (reemplazar UUID)
/*
delete from public.bot_interactions where restaurant_id = '00000000-0000-0000-0000-000000000000'::uuid;
delete from public.orders where restaurant_id = '00000000-0000-0000-0000-000000000000'::uuid;
*/
--
-- Opcional: stock (si existen tablas stock_* con restaurant_id)
/*
delete from public.stock_recipe_ingredients
where recipe_id in (select id from public.stock_recipes where restaurant_id = '…'::uuid);
delete from public.stock_recipes where restaurant_id = '…'::uuid;
delete from public.stock_items where restaurant_id = '…'::uuid;
*/
--
-- Opcional: volver menú a plantilla (borrar ítems del demo y re-insertar desde seed)
-- delete from public.menu_items where restaurant_id = '…'::uuid;
--
-- Los usuarios dashboard_users con FK on delete cascade se borran al borrar el restaurante:
-- delete from public.restaurants where id = '…'::uuid;
--
-- O solo “cerrar” el demo sin borrar restaurante:
-- update public.restaurants set demo_expires_at = now() where id = '…'::uuid;
-- update public.dashboard_users set is_active = false where restaurant_id = '…'::uuid;
