-- Guardar el chatId original de WhatsApp (`message.from`) en cada pedido.
-- Esto evita "No LID for user" en cuentas multidispositivo: cuando el bot
-- inicia un mensaje (notifier de delivery), usa este id directo y no tiene
-- que adivinar entre @c.us / @lid.
alter table public.orders
  add column if not exists customer_chat_id text;
