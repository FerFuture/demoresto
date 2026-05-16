const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");
const bcrypt = require("bcryptjs");
const ws = require("ws");

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

const supabase = createClient(supabaseUrl, supabaseKey, {
  // Node.js < 22 no tiene WebSocket global; Realtime de Supabase lo necesita.
  realtime: { transport: ws }
});

const TABLES = {
  restaurants: process.env.SUPABASE_RESTAURANTS_TABLE || "restaurants",
  menuItems: process.env.SUPABASE_MENU_ITEMS_TABLE || "menu_items",
  interactions: process.env.SUPABASE_INTERACTIONS_TABLE || "bot_interactions",
  orders: process.env.SUPABASE_ORDERS_TABLE || "orders"
};

const DASHBOARD_USERS_TABLE = process.env.SUPABASE_DASHBOARD_USERS_TABLE || "dashboard_users";

const DASHBOARD_LOGIN_DB_ROLES = ["admin", "encargado", "delivery", "kitchen", "waiter"];

function deliveryMayLoginTodayDb(weekdays) {
  if (weekdays == null) return true;
  if (!Array.isArray(weekdays) || weekdays.length === 0) return false;
  return weekdays.includes(new Date().getDay());
}

const DAY_NAMES_ES = [
  "domingo",
  "lunes",
  "martes",
  "miércoles",
  "jueves",
  "viernes",
  "sábado"
];

function formatAllowedWeekdaysSentenceDb(weekdays) {
  if (weekdays == null) return "todos los días";
  if (!Array.isArray(weekdays) || weekdays.length === 0) {
    return "ninguno (cuenta sin días habilitados)";
  }
  const sorted = [...new Set(weekdays)].sort((a, b) => a - b);
  return sorted.map((d) => DAY_NAMES_ES[d] ?? `día ${d}`).join(", ");
}

/**
 * Login de dashboard_users vía service role (solo llamar desde index.js).
 * No devuelve password_hash al cliente.
 */
async function verifyDashboardUserCredentials({ username, password, restaurantId }) {
  const norm = String(username || "")
    .trim()
    .toLowerCase();
  if (!norm) {
    return { ok: false, error: "Ingresá un usuario o usá la contraseña del rol sin completar usuario." };
  }
  const rid = restaurantId ? String(restaurantId).trim() : "";
  let q = supabase
    .from(DASHBOARD_USERS_TABLE)
    .select("id, password_hash, role, is_active, delivery_work_weekdays, updated_at, restaurant_id")
    .eq("username", norm);
  if (rid) {
    q = q.eq("restaurant_id", rid);
  } else {
    // Login en `/login` (sin slug): solo cuentas “legado” sin tenant. Los usuarios de demos/locales
    // tienen `restaurant_id` y deben entrar por `/d/{slug}/login` para no cruzar credenciales.
    q = q.is("restaurant_id", null);
  }
  const { data, error } = await q.maybeSingle();

  if (error) {
    if (error.code === "42P01" || (error.message || "").includes("does not exist")) {
      return {
        ok: false,
        error: "Acceso de usuarios no disponible. Contactá al administrador.",
        code: error.code
      };
    }
    if (error.code === "42703" || (error.message || "").includes("restaurant_id")) {
      return {
        ok: false,
        error:
          "La base no tiene restaurant_id en dashboard_users. Ejecutá dashboard/sql/demo_multi_tenant.sql en Supabase.",
        code: error.code
      };
    }
    return { ok: false, error: `Error de acceso: ${error.message}`, code: error.code };
  }
  if (!data || !data.is_active) {
    return { ok: false, error: "Usuario o contraseña incorrectos." };
  }
  if (!DASHBOARD_LOGIN_DB_ROLES.includes(data.role)) {
    return { ok: false, error: "Rol inválido en la base de datos." };
  }
  if (rid && data.restaurant_id && data.restaurant_id !== rid) {
    return { ok: false, error: "Usuario o contraseña incorrectos." };
  }
  let bcryptOk = false;
  try {
    bcryptOk = bcrypt.compareSync(String(password || ""), String(data.password_hash || ""));
  } catch {
    bcryptOk = false;
  }
  if (!bcryptOk) {
    return { ok: false, error: "Usuario o contraseña incorrectos." };
  }
  if (data.role === "delivery" && !deliveryMayLoginTodayDb(data.delivery_work_weekdays)) {
    const hint = formatAllowedWeekdaysSentenceDb(data.delivery_work_weekdays);
    return {
      ok: false,
      error: `Hoy no podés entrar con esta cuenta de reparto. Días habilitados: ${hint}.`
    };
  }
  return {
    ok: true,
    user: {
      id: data.id,
      role: data.role,
      updated_at: data.updated_at,
      restaurant_id: data.restaurant_id
    }
  };
}

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
    .select(
      "id, name, public_name, whatsapp_number, opening_hours, address, delivery_zones, delivery_enabled, local_enabled, mesa_enabled, cash_enabled, mercadopago_enabled, table_count, policies, metadata"
    )
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
    status: payload.status || "confirmed",
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
  // Telefono real resuelto via Contact (cuando el cliente usa @lid el
  // customer_number queda como LID y no sirve para llamar/WhatsApp). Si no
  // se pudo resolver, queda null y el dashboard cae al customer_number.
  if (payload.customerPhone) {
    row.customer_phone = sanitizeWhatsAppId(payload.customerPhone) || null;
  }
  if (payload.deliveryTotalConfirmedAt != null) {
    row.delivery_total_confirmed_at = payload.deliveryTotalConfirmedAt;
  }
  if (payload.tableNumber != null && payload.tableNumber !== "") {
    const tn = Number(payload.tableNumber);
    if (Number.isFinite(tn)) row.table_number = tn;
  }

  let { data, error } = await supabase.from(TABLES.orders).insert(row).select("*").single();
  // Si la migracion `customer_phone` todavia no se aplicó en la DB, Postgres
  // tira "column ... does not exist". Reintentamos sin la columna para no
  // bloquear los pedidos. El telefono se podrá guardar cuando se aplique el SQL.
  if (error && /customer_phone/i.test(error.message || "") && "customer_phone" in row) {
    const fallbackRow = { ...row };
    delete fallbackRow.customer_phone;
    const retry = await supabase.from(TABLES.orders).insert(fallbackRow).select("*").single();
    data = retry.data;
    error = retry.error;
  }
  if (error && /delivery_total_confirmed_at/i.test(error.message || "") && "delivery_total_confirmed_at" in row) {
    const fallbackRow = { ...row };
    delete fallbackRow.delivery_total_confirmed_at;
    const retry = await supabase.from(TABLES.orders).insert(fallbackRow).select("*").single();
    data = retry.data;
    error = retry.error;
  }
  if (error && /table_number/i.test(error.message || "") && "table_number" in row) {
    const fallbackRow = { ...row };
    delete fallbackRow.table_number;
    const retry = await supabase.from(TABLES.orders).insert(fallbackRow).select("*").single();
    data = retry.data;
    error = retry.error;
  }
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
  if (constraints.expectPaymentPendingOrNull) {
    query = query.or("payment_status.is.null,payment_status.eq.pending");
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

/**
 * Marca visible para el cliente: `public_name` (dashboard), si no `name`.
 * Para mensajes, tickets y MP — no el nombre interno si hay marca pública.
 */
async function getRestaurantNameById(restaurantId) {
  const { data, error } = await supabase
    .from(TABLES.restaurants)
    .select("name, public_name")
    .eq("id", restaurantId)
    .maybeSingle();
  if (error) {
    throw new Error(`Error consultando restaurante: ${error.message}`);
  }
  if (!data) return "Restaurante";
  const pub = String(data.public_name || "").trim();
  if (pub) return pub;
  return String(data.name || "").trim() || "Restaurante";
}

function normalizeDemoSlug(raw) {
  const s = String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/_+/g, "-");
  return s.replace(/-+/g, "-").replace(/^-|-$/g, "");
}

/** Evita INSERT inválido si la plantilla tiene metadata null/array o tipos raros. */
function coerceMetadataForRestaurantInsert(value) {
  if (value == null || value === "") return {};
  if (typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const p = JSON.parse(value);
      if (typeof p === "object" && p !== null && !Array.isArray(p)) return p;
    } catch {
      /* no es JSON */
    }
    return {};
  }
  return {};
}

/**
 * Número solo para fila `is_demo`: nunca reutilizar el WA de la plantilla (UNIQUE en whatsapp_number).
 */
function uniquePlaceholderWhatsAppForDemo() {
  const tail = Array.from(crypto.randomBytes(10), (b) => String(b % 10)).join("");
  return `5699${String(Date.now()).slice(-8)}${tail}`;
}

const DEMO_WHATSAPP_MAX_DIGITS = 20;

/** Solo dígitos; vacío = null (usar placeholder). */
function normalizeOptionalDemoWhatsApp(raw) {
  const d = String(raw ?? "")
    .replace(/\D/g, "")
    .trim();
  if (!d) return null;
  if (d.length < 8) {
    throw new Error("WhatsApp del demo: al menos 8 dígitos, o dejá el campo vacío para generar uno automático.");
  }
  if (d.length > DEMO_WHATSAPP_MAX_DIGITS) {
    throw new Error(`WhatsApp del demo: como máximo ${DEMO_WHATSAPP_MAX_DIGITS} dígitos.`);
  }
  return d;
}

function flagOrDefault(v, defaultTrue = true) {
  if (v === null || v === undefined) return defaultTrue;
  return Boolean(v);
}

function formatSupabaseErrHint(err) {
  const m = String(err?.message || "");
  const c = String(err?.code || "");
  const combined = `${m} ${c}`;
  if (/permission denied|42501|row-level security|RLS/i.test(combined)) {
    return " Configurá SUPABASE_SERVICE_ROLE_KEY en el .env del proceso Node (index.js); la clave anon no alcanza para INSERT en restaurants.";
  }
  if (/column|42703|does not exist/i.test(combined)) {
    return " Revisá migraciones: dashboard/sql/demo_multi_tenant.sql y columnas de restaurants.";
  }
  return "";
}

/** Metadata del restaurante demo: no heredar URL base de la plantilla (rompe QR/carta); habilitar módulos públicos. */
function metadataForDemoTenant(templateMetadata) {
  const base = coerceMetadataForRestaurantInsert(templateMetadata);
  if (typeof base !== "object" || base === null || Array.isArray(base)) {
    return { mesa_qr_enabled: true, qr_menu_enabled: true };
  }
  const out = { ...base };
  delete out.public_dashboard_base_url;
  out.mesa_qr_enabled = true;
  out.qr_menu_enabled = true;
  if ("mesa_qr_blocked_tables" in out) {
    out.mesa_qr_blocked_tables = [];
  }
  return out;
}

/**
 * Clona un restaurante plantilla + filas de menú y (opcional) un usuario admin del dashboard.
 * Usa service role (solo desde proceso Node).
 */
async function createDemoFromTemplate({
  templateRestaurantId,
  demoSlug: demoSlugRaw,
  demoName: demoNameRaw,
  expiresDays: expiresDaysRaw,
  adminUsername: adminUsernameRaw,
  adminPassword: adminPasswordRaw,
  demoWhatsappNumber: demoWhatsappNumberRaw
}) {
  const tpl = String(templateRestaurantId || "").trim();
  const slug = normalizeDemoSlug(demoSlugRaw);
  const demoName = String(demoNameRaw || "").trim();
  const days = Number(expiresDaysRaw);
  const adminUsername = String(adminUsernameRaw || "").trim().toLowerCase();
  const adminPassword = String(adminPasswordRaw || "");

  if (!tpl) {
    throw new Error("Falta templateRestaurantId (UUID del restaurante plantilla).");
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tpl)) {
    throw new Error("templateRestaurantId no es un UUID válido.");
  }
  if (!slug || slug.length < 2) {
    throw new Error("demo_slug demasiado corto (mínimo 2 caracteres).");
  }
  if (slug.length > 64) {
    throw new Error("demo_slug demasiado largo (máximo 64).");
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    throw new Error("demo_slug inválido: usá minúsculas, números y guiones (sin espacios).");
  }
  if (!demoName) {
    throw new Error("Falta el nombre del demo.");
  }
  if (!Number.isFinite(days) || days < 1 || days > 366) {
    throw new Error("expiresDays debe ser un número entre 1 y 366.");
  }
  if (adminUsername.length < 2) {
    throw new Error("Usuario admin demasiado corto.");
  }
  if (adminPassword.length < 6) {
    throw new Error("Contraseña admin: mínimo 6 caracteres.");
  }

  const { data: dup, error: dupErr } = await supabase
    .from(TABLES.restaurants)
    .select("id")
    .eq("demo_slug", slug)
    .maybeSingle();
  if (dupErr) {
    throw new Error(`No se pudo verificar demo_slug: ${dupErr.message}`);
  }
  if (dup) {
    throw new Error("Ese demo_slug ya existe.");
  }

  const { data: template, error: tErr } = await supabase
    .from(TABLES.restaurants)
    .select(
      "whatsapp_number, opening_hours, policies, address, delivery_zones, delivery_enabled, local_enabled, mesa_enabled, cash_enabled, mercadopago_enabled, stats_enabled, table_count, metadata"
    )
    .eq("id", tpl)
    .maybeSingle();
  if (tErr) {
    throw new Error(`Error leyendo plantilla: ${tErr.message}`);
  }
  if (!template) {
    throw new Error("Plantilla no encontrada.");
  }

  const requestedWa = normalizeOptionalDemoWhatsApp(demoWhatsappNumberRaw);
  let whatsappForInsert;
  if (requestedWa) {
    const { data: waDup, error: waDupErr } = await supabase
      .from(TABLES.restaurants)
      .select("id")
      .eq("whatsapp_number", requestedWa)
      .maybeSingle();
    if (waDupErr) {
      throw new Error(`No se pudo verificar WhatsApp: ${waDupErr.message}`);
    }
    if (waDup) {
      throw new Error(
        "Ese número de WhatsApp ya está en uso por otro restaurante. Probá con otro o dejá el campo vacío para uno automático."
      );
    }
    whatsappForInsert = requestedWa;
  } else {
    whatsappForInsert = uniquePlaceholderWhatsAppForDemo();
  }

  const expiresIso = new Date(Date.now() + Math.floor(days) * 86400000).toISOString();
  const insertRow = {
    name: demoName,
    public_name: demoName,
    whatsapp_number: whatsappForInsert,
    opening_hours: template.opening_hours ?? null,
    policies: template.policies ?? null,
    address: template.address ?? null,
    delivery_zones: template.delivery_zones ?? null,
    delivery_enabled: flagOrDefault(template.delivery_enabled),
    local_enabled: flagOrDefault(template.local_enabled),
    mesa_enabled: flagOrDefault(template.mesa_enabled),
    cash_enabled: flagOrDefault(template.cash_enabled),
    mercadopago_enabled: flagOrDefault(template.mercadopago_enabled),
    stats_enabled: flagOrDefault(template.stats_enabled),
    table_count:
      Number.isFinite(Number(template.table_count)) && Number(template.table_count) >= 1
        ? Math.floor(Number(template.table_count))
        : 12,
    metadata: metadataForDemoTenant(template.metadata),
    demo_slug: slug,
    demo_expires_at: expiresIso,
    is_demo: true
  };

  const { data: newRest, error: insErr } = await supabase
    .from(TABLES.restaurants)
    .insert(insertRow)
    .select("id")
    .single();
  if (insErr) {
    const pe = insErr;
    const human = [pe.message, pe.details, pe.hint].filter(Boolean).join(" — ");
    throw new Error(
      `No se pudo crear el restaurante demo: ${human || JSON.stringify(pe)}${formatSupabaseErrHint(pe)}`
    );
  }
  if (!newRest?.id) {
    throw new Error(
      "No se pudo crear el restaurante demo: respuesta sin id. Revisá permisos (service role) y RLS."
    );
  }
  const newId = newRest.id;

  async function rollback() {
    await supabase.from(TABLES.restaurants).delete().eq("id", newId);
  }

  try {
    const { data: menuRows, error: mErr } = await supabase
      .from(TABLES.menuItems)
      .select("name, description, category, price, available")
      .eq("restaurant_id", tpl);
    if (mErr) {
      throw new Error(`Error copiando menú: ${mErr.message}`);
    }
    const rows = menuRows || [];
    if (rows.length) {
      const inserts = rows.map((m) => ({
        restaurant_id: newId,
        name: m.name,
        description: m.description,
        category: m.category,
        price: m.price,
        available: m.available
      }));
      const { error: miErr } = await supabase.from(TABLES.menuItems).insert(inserts);
      if (miErr) {
        throw new Error(`No se pudo insertar menú clonado: ${miErr.message}`);
      }
    }

    const passwordHash = bcrypt.hashSync(adminPassword, 10);
    const nowIso = new Date().toISOString();
    const { error: duErr } = await supabase.from(DASHBOARD_USERS_TABLE).insert({
      username: adminUsername,
      password_hash: passwordHash,
      role: "admin",
      restaurant_id: newId,
      is_active: true,
      label: "Admin demo",
      updated_at: nowIso
    });
    if (duErr) {
      throw new Error(`No se pudo crear el usuario admin: ${duErr.message}`);
    }

    return {
      restaurantId: newId,
      demoSlug: slug,
      demoExpiresAt: expiresIso,
      menuItemCount: rows.length,
      demoWhatsappNumber: whatsappForInsert
    };
  } catch (e) {
    try {
      await rollback();
    } catch {
      /* best effort */
    }
    throw e;
  }
}

function isUuidString(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value || "").trim());
}

/**
 * Borra un tenant demo (pedidos, interacciones, menú, usuarios vía cascade) y la fila en `restaurants`.
 * Solo acepta filas con `is_demo === true` (no toca plantillas ni clientes reales).
 *
 * Preferí `restaurantId` (UUID) desde el panel Maestro; si no, `demoSlug`.
 */
async function deleteDemoBySlug({ demoSlug: demoSlugRaw, restaurantId: restaurantIdRaw }) {
  const ridIn = String(restaurantIdRaw || "").trim();
  let row;
  let resolvedSlug = "";

  if (isUuidString(ridIn)) {
    const { data, error: selErr } = await supabase
      .from(TABLES.restaurants)
      .select("id, is_demo, demo_slug, name")
      .eq("id", ridIn)
      .maybeSingle();
    if (selErr) {
      throw new Error(`No se pudo buscar el restaurante: ${selErr.message}${formatSupabaseErrHint(selErr)}`);
    }
    row = data;
    resolvedSlug = normalizeDemoSlug(row?.demo_slug || "");
  } else {
    const slug = normalizeDemoSlug(demoSlugRaw);
    if (!slug || slug.length < 2) {
      throw new Error("Falta el id del restaurante demo o un demo_slug válido.");
    }
    const { data, error: selErr } = await supabase
      .from(TABLES.restaurants)
      .select("id, is_demo, demo_slug, name")
      .eq("demo_slug", slug)
      .maybeSingle();
    if (selErr) {
      throw new Error(`No se pudo buscar el demo: ${selErr.message}${formatSupabaseErrHint(selErr)}`);
    }
    row = data;
    resolvedSlug = slug;
  }

  if (!row?.id) {
    throw new Error(
      isUuidString(ridIn)
        ? "No existe restaurante con ese id."
        : "No existe un restaurante con ese demo_slug."
    );
  }
  if (!row.is_demo) {
    throw new Error(
      "Ese local no está marcado como demo (is_demo). Por seguridad solo se eliminan demos creados como tal."
    );
  }

  const rid = row.id;

  const { error: intErr } = await supabase.from(TABLES.interactions).delete().eq("restaurant_id", rid);
  if (intErr) {
    throw new Error(`No se pudo borrar bot_interactions: ${intErr.message}${formatSupabaseErrHint(intErr)}`);
  }
  const { error: ordErr } = await supabase.from(TABLES.orders).delete().eq("restaurant_id", rid);
  if (ordErr) {
    throw new Error(`No se pudo borrar orders: ${ordErr.message}${formatSupabaseErrHint(ordErr)}`);
  }
  const { error: menuErr } = await supabase.from(TABLES.menuItems).delete().eq("restaurant_id", rid);
  if (menuErr) {
    throw new Error(`No se pudo borrar menu_items: ${menuErr.message}${formatSupabaseErrHint(menuErr)}`);
  }

  const { error: delErr } = await supabase.from(TABLES.restaurants).delete().eq("id", rid);
  if (delErr) {
    throw new Error(`No se pudo borrar el restaurante: ${delErr.message}${formatSupabaseErrHint(delErr)}`);
  }

  return {
    deletedRestaurantId: rid,
    demoSlug: resolvedSlug || String(row.demo_slug || "").trim(),
    name: String(row.name || row.demo_slug || "").trim() || resolvedSlug || rid
  };
}

async function getOrderAwaitingCustomerTotalConfirm({ restaurantId, customerNumber, botNumber }) {
  const botVariants = botNumberVariantsForQuery(botNumber);
  if (!botVariants.length) return null;

  let query = supabase
    .from(TABLES.orders)
    .select("*")
    .eq("restaurant_id", restaurantId)
    .eq("customer_number", sanitizeWhatsAppId(customerNumber))
    .eq("status", "awaiting_delivery_total_confirm")
    .order("created_at", { ascending: false })
    .limit(1);

  query =
    botVariants.length > 1 ? query.in("bot_number", botVariants) : query.eq("bot_number", botVariants[0]);

  const { data, error } = await query.maybeSingle();
  if (error) {
    throw new Error(`Error buscando pedido pendiente de confirmacion de total: ${error.message}`);
  }
  return data || null;
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
  getRestaurantNameById,
  getOrderAwaitingCustomerTotalConfirm,
  createDemoFromTemplate,
  deleteDemoBySlug,
  verifyDashboardUserCredentials
};
