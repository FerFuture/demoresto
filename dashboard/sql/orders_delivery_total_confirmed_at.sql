-- Marca de confirmación del total delivery + efectivo (sustituye el texto en notes).
alter table public.orders
  add column if not exists delivery_total_confirmed_at timestamptz null;

comment on column public.orders.delivery_total_confirmed_at is
  'Cliente confirmó el total con envío (efectivo); evita depender de texto en notes.';
