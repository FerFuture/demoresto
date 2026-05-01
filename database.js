const { createClient } = require("@supabase/supabase-js");

const supabaseUrl = process.env.SUPABASE_URL;
// Service role bypasses RLS (solo servidor / .env del bot). La clave anon suele chocar con RLS en inserts.
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error(
    "Faltan SUPABASE_URL y una clave: SUPABASE_SERVICE_ROLE_KEY (recomendado para el bot) o SUPABASE_KEY."
  );
}

if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.warn(
    "[restobot] SUPABASE_SERVICE_ROLE_KEY no definida: se usa SUPABASE_KEY. Con RLS en Supabase los pedidos/interacciones pueden fallar. Configura la service role en el .env del proceso Node (nunca en el frontend)."
  );
}

const supabase = createClient(supabaseUrl, supabaseKey);

const TABLES = {
  restaurants: process.env.SUPABASE_RESTAURANTS_TABLE || "restaurants",
  menuItems: process.env.SUPABASE_MENU_ITEMS_TABLE || "menu_items",
  interactions: process.env.SUPABASE_INTERACTIONS_TABLE || "bot_interactions",
  orders: process.env.SUPABASE_ORDERS_TABLE || "orders"
};

function sanitizeWhatsAppId(raw) {
  return (raw || "").toString().replace(/[^0-9]/g, "");
}

function getPossibleIncomingNumbers(rawNumber) {
  const normalized = sanitizeWhatsAppId(rawNumber);
  if (!normalized) return [];

  const variants = new Set([normalized]);

  // Chile mobile normalization variants:
  // - 56XXXXXXXXX (without mobile 9)
  // - 569XXXXXXXX (with mobile 9)
  if (normalized.startsWith("569") && normalized.length === 11) {
    variants.add(`56${normalized.slice(3)}`);
  } else if (normalized.startsWith("56") && normalized.length === 10) {
    variants.add(`569${normalized.slice(2)}`);
  }

  return Array.from(variants);
}

async function getRestaurantByIncomingNumber(toNumber) {
  const candidates = getPossibleIncomingNumbers(toNumber);
  if (!candidates.length) return null;

  const { data, error } = await supabase
    .from(TABLES.restaurants)
    .select("*")
    .in("whatsapp_number", candidates)
    .maybeSingle();

  if (error) {
    throw new Error(`Error buscando restaurante por numero: ${error.message}`);
  }

  return data || null;
}

async function getRestaurantContext(restaurantId) {
  const { data: restaurant, error: restaurantError } = await supabase
    .from(TABLES.restaurants)
    .select("id, name, whatsapp_number, opening_hours, policies, metadata")
    .eq("id", restaurantId)
    .maybeSingle();

  if (restaurantError) {
    throw new Error(`Error consultando restaurante: ${restaurantError.message}`);
  }

  if (!restaurant) return null;

  const { data: menuItems, error: menuError } = await supabase
    .from(TABLES.menuItems)
    .select("id, name, description, price, category, tags, available")
    .eq("restaurant_id", restaurantId)
    .eq("available", true)
    .order("category", { ascending: true })
    .order("name", { ascending: true });

  if (menuError) {
    throw new Error(`Error consultando menu: ${menuError.message}`);
  }

  return {
    restaurant,
    menuItems: menuItems || []
  };
}

async function getAvailableMenuItems(restaurantId) {
  const { data, error } = await supabase
    .from(TABLES.menuItems)
    .select("id, name, description, price, category, tags, available")
    .eq("restaurant_id", restaurantId)
    .eq("available", true)
    .order("category", { ascending: true })
    .order("name", { ascending: true });

  if (error) {
    throw new Error(`Error consultando productos disponibles: ${error.message}`);
  }

  return data || [];
}

async function saveInteraction(payload) {
  const row = {
    restaurant_id: payload.restaurantId || null,
    customer_number: sanitizeWhatsAppId(payload.customerNumber),
    bot_number: sanitizeWhatsAppId(payload.botNumber),
    message_type: payload.messageType || "text",
    user_message: payload.userMessage || null,
    bot_response: payload.botResponse || null,
    metadata: payload.metadata || {},
    created_at: new Date().toISOString()
  };

  const { error } = await supabase.from(TABLES.interactions).insert(row);
  if (error) {
    throw new Error(`Error registrando interaccion: ${error.message}`);
  }
}

function botNumberVariantsForQuery(botNumber) {
  const raw = sanitizeWhatsAppId(botNumber);
  if (!raw) return [];
  const fromHelper = getPossibleIncomingNumbers(botNumber);
  return [...new Set([raw, ...fromHelper.map(sanitizeWhatsAppId)])].filter(Boolean);
}

async function getRecentInteractions({ restaurantId, customerNumber, botNumber, limit = 40 }) {
  const botVariants = botNumberVariantsForQuery(botNumber);
  if (!botVariants.length) {
    return [];
  }

  let query = supabase
    .from(TABLES.interactions)
    .select("user_message, bot_response, metadata, created_at")
    .eq("restaurant_id", restaurantId)
    .eq("customer_number", sanitizeWhatsAppId(customerNumber));

  query =
    botVariants.length > 1 ? query.in("bot_number", botVariants) : query.eq("bot_number", botVariants[0]);

  const { data, error } = await query.order("created_at", { ascending: false }).limit(limit);

  if (error) {
    throw new Error(`Error consultando historial de interacciones: ${error.message}`);
  }

  return (data || []).reverse();
}

async function saveOrder(payload) {
  const totalProducts = payload.totalAmount != null ? Number(payload.totalAmount) : null;
  const row = {
    restaurant_id: payload.restaurantId,
    customer_number: sanitizeWhatsAppId(payload.customerNumber),
    bot_number: sanitizeWhatsAppId(payload.botNumber),
    items: payload.items || [],
    address: payload.address || null,
    notes: payload.notes || null,
    status: payload.status || "pending",
    payment_method: payload.paymentMethod || null,
    payment_status: payload.paymentStatus || null,
    total_price: totalProducts,
    total_amount: totalProducts,
    raw_request: payload.rawRequest || null,
    created_at: new Date().toISOString()
  };

  if (payload.fulfillmentType != null) {
    row.fulfillment_type = payload.fulfillmentType;
  }
  if (payload.subtotalAmount != null) {
    row.subtotal_amount = Number(payload.subtotalAmount);
  }
  if ("deliveryFee" in payload) {
    row.delivery_fee = payload.deliveryFee;
  }
  if ("finalTotalAmount" in payload) {
    row.final_total_amount = payload.finalTotalAmount;
  }
  if ("paymentLink" in payload) {
    row.payment_link = payload.paymentLink;
  }
  if ("customerNotifiedAt" in payload) {
    row.customer_notified_at = payload.customerNotifiedAt;
  }
  if (payload.customerChatId) {
    row.customer_chat_id = String(payload.customerChatId).trim() || null;
  }

  const { data, error } = await supabase.from(TABLES.orders).insert(row).select("*").single();
  if (error) {
    throw new Error(`Error registrando pedido: ${error.message}`);
  }

  return data;
}

async function updateOrder(orderId, values) {
  const { data, error } = await supabase
    .from(TABLES.orders)
    .update(values)
    .eq("id", orderId)
    .select("*")
    .single();

  if (error) {
    throw new Error(`Error actualizando pedido: ${error.message}`);
  }

  return data;
}

/**
 * UPDATE condicional (ej. solo si status sigue siendo X y aún no se notificó).
 * Devuelve la fila actualizada o null si no hubo match (idempotencia / carrera).
 */
async function updateOrderMatching(orderId, patch, constraints = {}) {
  let query = supabase.from(TABLES.orders).update(patch).eq("id", orderId);
  if (constraints.expectStatus != null) {
    query = query.eq("status", constraints.expectStatus);
  }
  if (constraints.requireCustomerNotifiedNull) {
    query = query.is("customer_notified_at", null);
  }
  const { data, error } = await query.select("*").maybeSingle();
  if (error) {
    throw new Error(`Error actualizando pedido: ${error.message}`);
  }
  return data || null;
}

async function getRestaurantNameById(restaurantId) {
  const { data, error } = await supabase
    .from(TABLES.restaurants)
    .select("name")
    .eq("id", restaurantId)
    .maybeSingle();
  if (error) {
    throw new Error(`Error consultando restaurante: ${error.message}`);
  }
  return data?.name || "Restaurante";
}

module.exports = {
  supabase,
  TABLES,
  getRestaurantByIncomingNumber,
  getRestaurantContext,
  getAvailableMenuItems,
  getRecentInteractions,
  saveInteraction,
  saveOrder,
  updateOrder,
  updateOrderMatching,
  getRestaurantNameById
};
