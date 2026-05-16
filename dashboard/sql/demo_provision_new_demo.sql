-- =============================================================================
-- Crear un NUEVO demo clonando menú desde un restaurante plantilla
-- =============================================================================
-- Requisitos:
--   - demo_multi_tenant.sql ya ejecutado (columnas demo_slug, restaurant_id, etc.)
--   - Rol: postgres en SQL Editor (o service role; debe poder INSERT sin RLS)
--
-- Pasos:
--   1) Reemplazá los literales en el bloque DO (tpl, v_slug, v_name, v_days).
--   2) Ejecutá el script completo una vez por cada nuevo cliente demo.
--   3) Creá al menos un usuario en dashboard_users con restaurant_id = el UUID
--      que muestra el NOTICE (desde Admin → Usuarios en /d/{slug}/admin, o INSERT).
--   Nota: si en `restaurants` hay UNIQUE(whatsapp_number), al clonar no podés repetir el mismo
--   número que la plantilla: asigná otro en el SELECT (ej. placeholder 5699… o vía Panel Maestro / API).
--
-- Luego probá: https://TU_DOMINIO/d/{v_slug}/login
-- =============================================================================

DO $$
DECLARE
  -- >>> EDITAR ESTOS VALORES <<<
  tpl uuid := '00000000-0000-0000-0000-000000000000'::uuid;  -- UUID del restaurante PLANTILLA
  v_slug text := 'mi-cliente-demo';                          -- único, minúsculas, sin espacios
  v_name text := 'Demo Mi Cliente';                          -- nombre interno / público inicial
  v_days int := 14;                                          -- días hasta demo_expires_at
  new_id uuid;
  n_menu int;
BEGIN
  IF tpl = '00000000-0000-0000-0000-000000000000'::uuid THEN
    RAISE EXCEPTION 'Configurá tpl con el UUID real del restaurante plantilla.';
  END IF;

  IF length(trim(v_slug)) < 2 THEN
    RAISE EXCEPTION 'demo_slug demasiado corto.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.restaurants
    WHERE lower(trim(demo_slug)) = lower(trim(v_slug))
  ) THEN
    RAISE EXCEPTION 'demo_slug ya existe: %', v_slug;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.restaurants WHERE id = tpl) THEN
    RAISE EXCEPTION 'Plantilla no encontrada: %', tpl;
  END IF;

  INSERT INTO public.restaurants (
    name,
    public_name,
    whatsapp_number,
    opening_hours,
    policies,
    address,
    delivery_zones,
    delivery_enabled,
    local_enabled,
    mesa_enabled,
    cash_enabled,
    mercadopago_enabled,
    stats_enabled,
    table_count,
    metadata,
    demo_slug,
    demo_expires_at,
    is_demo
  )
  SELECT
    v_name,
    v_name,
    r.whatsapp_number,
    r.opening_hours,
    r.policies,
    r.address,
    r.delivery_zones,
    r.delivery_enabled,
    r.local_enabled,
    r.mesa_enabled,
    r.cash_enabled,
    r.mercadopago_enabled,
    r.stats_enabled,
    r.table_count,
    COALESCE(r.metadata, '{}'::jsonb),
    lower(trim(v_slug)),
    now() + (v_days || ' days')::interval,
    true
  FROM public.restaurants r
  WHERE r.id = tpl
  RETURNING id INTO new_id;

  INSERT INTO public.menu_items (
    restaurant_id,
    name,
    description,
    category,
    price,
    available
  )
  SELECT
    new_id,
    m.name,
    m.description,
    m.category,
    m.price,
    m.available
  FROM public.menu_items m
  WHERE m.restaurant_id = tpl;

  GET DIAGNOSTICS n_menu = ROW_COUNT;

  RAISE NOTICE 'Demo creado: restaurant_id=% demo_slug=% filas_menu=%', new_id, lower(trim(v_slug)), n_menu;
  RAISE NOTICE 'Siguiente: crear usuario(s) en dashboard_users con restaurant_id=% y probar /d/%/login',
    new_id, lower(trim(v_slug));
END $$;
