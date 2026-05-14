-- Permisos GRANT para roles API de Supabase (`anon`, `authenticated`).
-- PostgREST exige privilegio en la tabla además de las políticas RLS.
-- Si SELECT funciona pero UPDATE falla con "permission denied", ejecutá este archivo.
-- Idempotente: repetir GRANT es seguro.

grant usage on schema public to anon, authenticated;

grant select, update on table public.restaurants to anon, authenticated;

grant select, insert, update, delete on table public.menu_items to anon, authenticated;

grant select, insert, update on table public.orders to anon, authenticated;

grant select, insert on table public.bot_interactions to anon, authenticated;

grant select, insert, update, delete on table public.dashboard_users to anon, authenticated;

grant select, insert, update, delete on table public.stock_items to anon, authenticated;

grant select, insert, update, delete on table public.stock_recipes to anon, authenticated;

grant select, insert, update, delete on table public.stock_recipe_ingredients to anon, authenticated;
