-- Columnas de configuracion editable por restaurante (dashboard).
-- Reemplazan los datos hardcoded del prompt de IA (`ia_service.js`).
-- Idempotente: re-ejecutable sin riesgo.

alter table public.restaurants
  add column if not exists public_name text,
  add column if not exists address text,
  add column if not exists delivery_zones text;

-- `opening_hours` y `policies` ya existian; quedan como estan.

-- Politica RLS para que el dashboard (clave anon) pueda actualizar la fila
-- del restaurante. SELECT ya esta cubierto en rls_policies_restobot.sql.
-- Si no usas RLS aun, esta sentencia falla silenciosa al re-ejecutarse.

drop policy if exists "restobot_restaurants_anon_update" on public.restaurants;
create policy "restobot_restaurants_anon_update"
  on public.restaurants for update to anon using (true) with check (true);

drop policy if exists "restobot_restaurants_auth_update" on public.restaurants;
create policy "restobot_restaurants_auth_update"
  on public.restaurants for update to authenticated using (true) with check (true);

-- Verificacion (solo lectura)
select column_name, data_type
from information_schema.columns
where table_schema = 'public'
  and table_name = 'restaurants'
  and column_name in ('public_name','address','delivery_zones','opening_hours','policies','name','whatsapp_number')
order by column_name;
