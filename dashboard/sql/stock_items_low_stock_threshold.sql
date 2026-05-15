-- Umbral de alerta personalizado por ingrediente (null = default según unidad en el dashboard).
alter table public.stock_items
  add column if not exists low_stock_threshold numeric check (low_stock_threshold is null or low_stock_threshold >= 0);
