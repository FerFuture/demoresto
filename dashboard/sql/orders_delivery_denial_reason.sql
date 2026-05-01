-- Motivo cuando el local no puede hacer delivery a la dirección (texto libre, mostrado al cliente por WhatsApp).
alter table public.orders
  add column if not exists delivery_denial_reason text;
