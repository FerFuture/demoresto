-- Tablas para Gestor de stock y Recetario del dashboard.
-- Idempotente: se puede re-ejecutar sin perder datos existentes.

create table if not exists public.stock_items (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  name text not null,
  current_stock numeric not null default 0 check (current_stock >= 0),
  unit text not null default 'UNIDAD',
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  unique (restaurant_id, name)
);

create table if not exists public.stock_recipes (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  name text not null,
  preparation text,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  unique (restaurant_id, name)
);

create table if not exists public.stock_recipe_ingredients (
  id uuid primary key default gen_random_uuid(),
  recipe_id uuid not null references public.stock_recipes(id) on delete cascade,
  ingredient_name text not null,
  quantity numeric not null default 1 check (quantity > 0),
  unit text not null default 'UNIDAD',
  created_at timestamp with time zone not null default now(),
  unique (recipe_id, ingredient_name)
);

alter table public.stock_items
  add column if not exists unit text not null default 'UNIDAD';

alter table public.stock_items
  add column if not exists low_stock_threshold numeric check (low_stock_threshold is null or low_stock_threshold >= 0);

alter table public.stock_items
  alter column current_stock type numeric using current_stock::numeric;

alter table public.stock_recipe_ingredients
  add column if not exists unit text not null default 'UNIDAD';

alter table public.stock_recipe_ingredients
  add column if not exists quantity numeric not null default 1;

update public.stock_items
set unit = case
  when upper(unit) in ('GR', 'GRS', 'GRAMO', 'GRAMOS') then 'G'
  when upper(unit) in ('LITRO', 'LITROS', 'LT') then 'L'
  when upper(unit) in ('MILILITRO', 'MILILITROS') then 'ML'
  else upper(unit)
end;

update public.stock_recipe_ingredients
set unit = case
  when upper(unit) in ('GR', 'GRS', 'GRAMO', 'GRAMOS') then 'G'
  when upper(unit) in ('LITRO', 'LITROS', 'LT') then 'L'
  when upper(unit) in ('MILILITRO', 'MILILITROS') then 'ML'
  else upper(unit)
end;

update public.stock_items
set name = translate(name, 'ÁÉÍÓÚáéíóú', 'AEIOUAEIOU')
where name <> translate(name, 'ÁÉÍÓÚáéíóú', 'AEIOUAEIOU');

grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on table public.stock_items to anon, authenticated;
grant select, insert, update, delete on table public.stock_recipes to anon, authenticated;
grant select, insert, update, delete on table public.stock_recipe_ingredients to anon, authenticated;

alter table public.stock_items enable row level security;
alter table public.stock_recipes enable row level security;
alter table public.stock_recipe_ingredients enable row level security;

drop policy if exists "restobot_stock_items_anon_all" on public.stock_items;
create policy "restobot_stock_items_anon_all"
  on public.stock_items for all to anon using (true) with check (true);

drop policy if exists "restobot_stock_items_auth_all" on public.stock_items;
create policy "restobot_stock_items_auth_all"
  on public.stock_items for all to authenticated using (true) with check (true);

drop policy if exists "restobot_stock_recipes_anon_all" on public.stock_recipes;
create policy "restobot_stock_recipes_anon_all"
  on public.stock_recipes for all to anon using (true) with check (true);

drop policy if exists "restobot_stock_recipes_auth_all" on public.stock_recipes;
create policy "restobot_stock_recipes_auth_all"
  on public.stock_recipes for all to authenticated using (true) with check (true);

drop policy if exists "restobot_stock_recipe_ingredients_anon_all" on public.stock_recipe_ingredients;
create policy "restobot_stock_recipe_ingredients_anon_all"
  on public.stock_recipe_ingredients for all to anon using (true) with check (true);

drop policy if exists "restobot_stock_recipe_ingredients_auth_all" on public.stock_recipe_ingredients;
create policy "restobot_stock_recipe_ingredients_auth_all"
  on public.stock_recipe_ingredients for all to authenticated using (true) with check (true);

select table_name
from information_schema.tables
where table_schema = 'public'
  and table_name in ('stock_items', 'stock_recipes', 'stock_recipe_ingredients')
order by table_name;
