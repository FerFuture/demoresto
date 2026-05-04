-- =============================================================================
-- Vaciar pedidos para demo (Supabase → SQL Editor, rol postgres)
-- =============================================================================
-- Las políticas RLS del dashboard (anon/authenticated) no incluyen DELETE en
-- `orders`; por eso esto no se puede hacer desde el frontend. Ejecutá acá.
--
-- Efecto: el listado admin, reparto y estadísticas dejan de ver esos pedidos.
-- No borra menú, restaurantes ni usuarios del panel.
--
-- Si en tu proyecto otra tabla tiene FK a public.orders(id), el DELETE puede
-- fallar: en ese caso borrá primero las filas hijas o usá el mensaje de error
-- de Postgres para ajustar.
-- =============================================================================

-- 1) Ver restaurantes y cantidad de pedidos (elegí el uuid correcto)
-- select r.id, r.name, r.public_name, count(o.id) as pedidos
-- from public.restaurants r
-- left join public.orders o on o.restaurant_id = r.id
-- group by r.id, r.name, r.public_name
-- order by r.name;

-- -----------------------------------------------------------------------------
-- Opción A (recomendada): solo UN restaurante (demo sin tocar otros locales)
-- -----------------------------------------------------------------------------
-- Reemplazá el uuid por el de tu fila en `restaurants`:
/*
delete from public.orders
where restaurant_id = '00000000-0000-0000-0000-000000000000'::uuid;
*/

-- -----------------------------------------------------------------------------
-- Opción B: borrar TODOS los pedidos de la base (todos los restaurantes)
-- -----------------------------------------------------------------------------
/*
delete from public.orders;
*/

-- -----------------------------------------------------------------------------
-- Opción C: solo pedidos “cerrados” (dejás pendientes / en curso si los hay)
-- Ajustá la lista de estados si tu esquema usa otros valores.
-- -----------------------------------------------------------------------------
/*
delete from public.orders
where restaurant_id = '00000000-0000-0000-0000-000000000000'::uuid
  and coalesce(status, '') in (
    'delivered',
    'cancelled',
    'delivery_denied'
  );
*/

-- Verificación rápida tras borrar:
-- select count(*) from public.orders;
-- select count(*) from public.orders where restaurant_id = '...'::uuid;
