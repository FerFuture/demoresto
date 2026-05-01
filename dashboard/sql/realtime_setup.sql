-- Habilita Supabase Realtime para que el dashboard reciba pedidos nuevos
-- sin necesidad de refrescar la pagina. Ejecutar UNA vez en:
--   Supabase → SQL Editor → New query → pegar y Run.
-- Es idempotente: se puede correr varias veces sin romper nada.

-- 1) Asegura que la publicacion "supabase_realtime" exista (en Supabase suele venir creada,
--    pero por las dudas la creamos vacia si no esta).
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end
$$;

-- 2) Agrega la tabla orders a la publicacion solo si aun no esta, para evitar el error
--    "relation is already member of publication".
do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'orders'
  ) then
    alter publication supabase_realtime add table public.orders;
  end if;
end
$$;

-- 3) REPLICA IDENTITY FULL hace que los eventos UPDATE viajen con toda la fila en payload.new.
--    Sin esto, los cambios de estado podrian llegar incompletos al cliente.
alter table public.orders replica identity full;

-- Opcional: si tambien queres que el menu_items cambie en vivo (precios, disponibilidad)
-- descomenta las lineas siguientes:
-- do $$
-- begin
--   if not exists (
--     select 1
--     from pg_publication_tables
--     where pubname = 'supabase_realtime'
--       and schemaname = 'public'
--       and tablename = 'menu_items'
--   ) then
--     alter publication supabase_realtime add table public.menu_items;
--   end if;
-- end
-- $$;
-- alter table public.menu_items replica identity full;

-- Verificacion rapida: deberia listar "orders" (y "menu_items" si lo activaste).
select schemaname, tablename
from pg_publication_tables
where pubname = 'supabase_realtime'
order by tablename;
