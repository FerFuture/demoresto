-- Agrega columna `customer_phone` a `orders`.
--
-- Motivo: cuando el cliente tiene activada la privacidad del numero en
-- WhatsApp, `message.from` viene como `<lid>@lid` y `customer_number` queda
-- guardado como LID (no sirve para llamar/WhatsApp desde el dashboard).
-- `customer_phone` guarda el telefono real resuelto via `message.getContact()`
-- cuando esta disponible. Si no, queda NULL y el dashboard cae al
-- customer_number con la heuristica de "parece telefono".
--
-- Idempotente: podes re-ejecutarlo sin riesgo.

alter table public.orders
  add column if not exists customer_phone text;

comment on column public.orders.customer_phone is
  'Telefono real del cliente (E.164 sin signos). Se completa cuando el LID se resuelve a un numero. Para pedidos viejos puede ser NULL.';
