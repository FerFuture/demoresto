require("dotenv").config();

const fs = require("fs/promises");
const path = require("path");
const qrcode = require("qrcode-terminal");
const { Client, LocalAuth } = require("whatsapp-web.js");
const {
  getRestaurantByIncomingNumber,
  getRestaurantContext,
  getAvailableMenuItems,
  getRecentInteractions,
  saveInteraction,
  saveOrder
} = require("./database");
const { startOrderDeliveryNotifier } = require("./order_delivery_notifier");
const { startPaymentStatusPoller } = require("./payment_status_poller");
const {
  MAX_AUDIO_SECONDS,
  transcribeAudioWithWhisper,
  generateProductQuestionAnswer,
  generateAssistantResponse,
  generateOrderQuote,
  detectAddressIntent
} = require("./ia_service");
const { createPaymentPreference } = require("./payment_service");

const AUTH_PATH = process.env.WWEBJS_AUTH_PATH || ".wwebjs_auth";
const TEMP_AUDIO_DIR = path.resolve(process.cwd(), "tmp_audio");
const MIN_TEXT_LENGTH = 3;
/** Inactividad maxima en checkout antes de limpiar sesion en RAM (ms). */
const CHECKOUT_SESSION_TTL_MS = Number(process.env.CHECKOUT_SESSION_TTL_MS || 15 * 60 * 1000);
const checkoutSessions = new Map();
const conversationState = new Map();

/**
 * Horario de atencion del bot. Se puede sobreescribir por .env sin tocar codigo:
 *   BOT_TIMEZONE=America/Argentina/Buenos_Aires
 *   BOT_OPEN_TIME=05:41           (HH:MM 24h)
 *   BOT_CLOSE_TIME=22:00          (HH:MM 24h)
 *   BOT_OPEN_DAYS=1,2,3,4,5,6,7   (1=Lunes ... 7=Domingo)
 */
const BUSINESS_HOURS = {
  timezone: process.env.BOT_TIMEZONE || "America/Argentina/Buenos_Aires",
openTime: process.env.BOT_OPEN_TIME || "06:05",
closeTime: process.env.BOT_CLOSE_TIME || "00:00",
  openDays: (process.env.BOT_OPEN_DAYS || "1,2,3,4,5,6,7")
    .split(",")
    .map((d) => Number(d.trim()))
    .filter((d) => Number.isFinite(d) && d >= 1 && d <= 7)
};

const DAY_LABELS_ES = ["Lunes", "Martes", "Miercoles", "Jueves", "Viernes", "Sabado", "Domingo"];

function parseTimeToMinutes(value) {
  const [h, m] = String(value || "")
    .split(":")
    .map((n) => Number(n));
  const hour = Number.isFinite(h) ? h : 0;
  const minute = Number.isFinite(m) ? m : 0;
  return hour * 60 + minute;
}

/** Devuelve { weekday (1-7), minutes } en la zona horaria configurada. */
function getLocalNowParts(timezone) {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
  const parts = fmt.formatToParts(new Date());
  const weekdayStr = parts.find((p) => p.type === "weekday")?.value || "Mon";
  const hourStr = parts.find((p) => p.type === "hour")?.value || "00";
  const minuteStr = parts.find((p) => p.type === "minute")?.value || "00";
  const weekdayMap = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  const weekday = weekdayMap[weekdayStr] || 1;
  const minutes = Number(hourStr) * 60 + Number(minuteStr);
  return { weekday, minutes };
}

function isWithinBusinessHours(config = BUSINESS_HOURS) {
  const { weekday, minutes } = getLocalNowParts(config.timezone);
  if (!config.openDays.includes(weekday)) return false;
  const openMin = parseTimeToMinutes(config.openTime);
  const closeMin = parseTimeToMinutes(config.closeTime);
  if (closeMin <= openMin) {
    return minutes >= openMin || minutes < closeMin;
  }
  return minutes >= openMin && minutes < closeMin;
}

function formatBusinessDays(days) {
  if (!days?.length) return "sin dias definidos";
  if (days.length === 7) return "todos los dias";
  const sorted = [...days].sort((a, b) => a - b);
  let run = [sorted[0]];
  const ranges = [];
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i] === run[run.length - 1] + 1) {
      run.push(sorted[i]);
    } else {
      ranges.push(run);
      run = [sorted[i]];
    }
  }
  ranges.push(run);
  return ranges
    .map((r) =>
      r.length === 1
        ? DAY_LABELS_ES[r[0] - 1]
        : `${DAY_LABELS_ES[r[0] - 1]} a ${DAY_LABELS_ES[r[r.length - 1] - 1]}`
    )
    .join(", ");
}

function buildClosedReply(config = BUSINESS_HOURS) {
  const days = formatBusinessDays(config.openDays);
  return (
    `Gracias por tu mensaje. En este momento estamos cerrados.\n` +
    `Nuestro horario de atencion es ${days} de ${config.openTime} a ${config.closeTime} ` +
    `(hora ${config.timezone}).\n` +
    `Escribinos dentro de ese horario y te ayudamos con tu pedido.`
  );
}

function normalizeNumber(raw) {
  return (raw || "").toString().replace(/[^0-9]/g, "");
}

function extractIncomingBotNumber(message) {
  return normalizeNumber((message.to || "").split("@")[0]);
}

function extractCustomerNumber(message) {
  return normalizeNumber((message.from || "").split("@")[0]);
}

function isEmojiOnly(text) {
  const cleaned = (text || "").replace(/\s/g, "");
  if (!cleaned) return false;
  return /^(\p{Extended_Pictographic}|\uFE0F)+$/u.test(cleaned);
}

function resolveIncomingBotNumber(message, waClient) {
  const fromMessageTo = extractIncomingBotNumber(message);
  if (fromMessageTo) return fromMessageTo;

  const fromClientInfo = normalizeNumber(waClient?.info?.wid?.user);
  if (fromClientInfo) return fromClientInfo;

  return "";
}

function shouldIgnoreTextMessage(text) {
  const normalized = (text || "").trim();
  if (normalized.length < MIN_TEXT_LENGTH) return true;
  if (isEmojiOnly(normalized)) return true;
  return false;
}

function looksLikePhysicalAddress(text) {
  const normalized = normalizeTextForMatch(text);
  if (!normalized) return false;

  const hasStreetHint = /\b(calle|av|avenida|pasaje|pasillo|camino|direccion|dirección|entre|nro|numero|número|#)\b/.test(
    normalized
  );
  const hasReferenceHint = /\b(frente|al lado|cerca|esquina|plaza|parque|mercado|edificio|torre|barrio|zona)\b/.test(
    normalized
  );
  const hasNumber = /\d{1,4}/.test(normalized);
  const hasStreetLikeName = /\b[a-z]{4,}\s+\d{1,5}\b/.test(normalized);
  const longEnough = normalized.length >= 12;

  // Regla flexible:
  // - formato clasico: pista de calle + numero/largo suficiente
  // - formato natural: referencia + numero
  // - formato corto comun: "luzuriaga 333"
  if ((hasStreetHint && longEnough) || (hasStreetHint && hasNumber)) return true;
  if (hasReferenceHint && hasNumber && longEnough) return true;
  if (hasStreetLikeName) return true;
  return false;
}

function isConfirmedAddress(addressCheck, originalText) {
  if (!addressCheck?.isAddress) return false;
  const candidate = addressCheck.normalizedAddress || originalText || "";
  return looksLikePhysicalAddress(candidate);
}

function extractAudioDurationSeconds(message) {
  const rawDataSeconds = Number(message?._data?.seconds);
  const rawDataDuration = Number(message?._data?.duration);
  if (Number.isFinite(rawDataSeconds) && rawDataSeconds > 0) return rawDataSeconds;
  if (Number.isFinite(rawDataDuration) && rawDataDuration > 0) return rawDataDuration;
  return 0;
}

const INTENT_PHRASES = {
  closeOrder: [
    "eso es todo",
    "es todo",
    "solo eso",
    "nada mas",
    "nada mas",
    "ya no mas",
    "ya no ma",
    "nomas",
    "no ma",
    "finalizar pedido",
    "cerrar pedido",
    "terminamos"
  ],
  confirmSelection: ["si quiero", "si dame", "confirmo", "ok", "dale", "listo", "perfecto", "si por favor", "si"],
  addMore: ["agregar", "anadir", "añadir", "sumar", "otra", "otro", "mas", "más"],
  noMore: ["no", "no gracias", "solo eso", "es todo", "continuar", "listo"],
  delivery: ["delivery", "domicilio", "envio", "envio a domicilio", "a mi casa", "para la casa", "a casa"],
  local: ["local", "comer en el local", "retiro", "retirar", "paso a buscar", "voy al local", "para llevar"],
  cash: ["efectivo"],
  mercadoPago: ["mercado pago", "mp"],
  /** Cancelar el armado del pedido (checkout en curso), no confundir con "no quiero mas productos". */
  cancelCheckout: [
    "cancelar",
    "cancelá el pedido",
    "cancela el pedido",
    "quiero cancelar",
    "cancelar pedido",
    "cancelar todo",
    "no quiero seguir",
    "no deseo seguir",
    "no sigo",
    "no continuo",
    "no quiero el pedido",
    "no deseo el pedido",
    "olvida el pedido",
    "olvidate del pedido",
    "deja el pedido",
    "dejá el pedido",
    "no me interesa el pedido",
    "anular pedido",
    "anular el pedido",
    "no quiero pedir",
    "no quiero comprar",
    "mejor no",
    "me arrepiento",
    "no era eso",
    "borra el pedido",
    "cancelalo",
    "chau con el pedido",
    "suspende el pedido",
    "ya no",
    "no gracias ya no quiero",
    "desisto",
    "desistir",
    "no quiero",
    "no deseo",
    "cancel"
  ]
};

function hasAnyPhrase(text, phrases = []) {
  const normalized = normalizeTextForMatch(text);
  return phrases.some((phrase) => {
    const p = normalizeTextForMatch(phrase);
    if (!p) return false;
    // Frases con espacio: basta con substring (ej. "mercado pago", "es todo").
    if (p.includes(" ")) return normalized.includes(p);
    // Token suelto: exigir "palabra completa" para no disparar "mp" dentro de "completo",
    // "si" dentro de otras palabras, "no" dentro de "nota", etc.
    const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(normalized);
  });
}

function numericOption(text) {
  const normalized = (text || "").trim();
  // Solo aceptar opcion numerica cuando el mensaje es unicamente "1" o "2".
  // Evita confundir direcciones como "12 de octubre 1234" con elecciones de menu.
  if (/^1$/.test(normalized)) return 1;
  if (/^2$/.test(normalized)) return 2;
  return null;
}

function wantsToCloseOrder(text) {
  return hasAnyPhrase(text, INTENT_PHRASES.closeOrder);
}

function wantsToConfirmSelection(text) {
  return hasAnyPhrase(text, INTENT_PHRASES.confirmSelection);
}

function wantsToCancelCheckout(text) {
  return hasAnyPhrase(text, INTENT_PHRASES.cancelCheckout);
}

function getConversationKey(tenantId, customerNumber, botNumber) {
  // Usar una clave estable por restaurante+cliente evita perder el estado cuando
  // WhatsApp cambia el formato de `message.to` entre mensajes.
  return `${tenantId}:${customerNumber}`;
}

function getOrCreateSession(conversationKey) {
  const existing = checkoutSessions.get(conversationKey);
  if (existing) {
    if (typeof existing.lastActivityAt !== "number") {
      existing.lastActivityAt = Date.now();
    }
    return existing;
  }

  const fresh = {
    status: "browsing",
    details: "",
    items: [],
    totalAmount: 0,
    fulfillmentType: "",
    deliveryAddress: "",
    conversationText: "",
    lastActivityAt: Date.now()
  };
  checkoutSessions.set(conversationKey, fresh);
  return fresh;
}

/** Limpia el carrito en memoria para que un mensaje nuevo no quede enganchado al pedido ya cerrado. */
function resetCheckoutSession(conversationKey) {
  checkoutSessions.delete(conversationKey);
}

/**
 * Los checkouts viven en RAM y se pierden al reiniciar/rebuildar el contenedor.
 * Rehidratamos desde el ultimo turno del bot si en la DB quedo un estado de checkout activo.
 */
const CHECKOUT_STATUSES = ["awaiting_add_more", "awaiting_fulfillment", "awaiting_address", "awaiting_payment"];

function sessionIsEmpty(session) {
  if (!session) return true;
  if (session.status && session.status !== "browsing") return false;
  if (Number(session.totalAmount) > 0) return false;
  if (Array.isArray(session.items) && session.items.length > 0) return false;
  return true;
}

function rehydrateSessionFromHistory(session, recentHistory) {
  if (!sessionIsEmpty(session)) return session;
  if (!Array.isArray(recentHistory) || !recentHistory.length) return session;

  for (let i = recentHistory.length - 1; i >= 0; i -= 1) {
    const turn = recentHistory[i];
    const meta = turn?.metadata;
    if (!meta || typeof meta !== "object") continue;

    const lastBot = turn?.bot_response || "";
    if (botReplyIndicatesOrderHandedToRestaurant(lastBot)) {
      return session;
    }

    if (!CHECKOUT_STATUSES.includes(meta.status)) continue;

    const totalAmount = Number(meta.totalAmount || 0);
    const items = Array.isArray(meta.items) ? meta.items.filter(Boolean) : [];
    const details = String(meta.details || "").trim();

    if (!totalAmount && !items.length) continue;

    session.status = meta.status;
    session.totalAmount = totalAmount;
    session.details = details || items.join(", ");
    session.items = items.length ? items : details ? [details] : [];
    session.fulfillmentType = meta.fulfillmentType || session.fulfillmentType || "";
    session.deliveryAddress = meta.deliveryAddress || session.deliveryAddress || "";
    session.lastActivityAt = Date.now();
    return session;
  }

  return session;
}

/** El pedido ya quedó registrado para el restaurante (link MP o confirmación efectivo). */
function botReplyIndicatesOrderHandedToRestaurant(botResponse) {
  if (!botResponse || typeof botResponse !== "string") return false;
  const t = botResponse.toLowerCase();
  if (t.includes("pref_id=")) return true;
  if (t.includes("checkout/v1")) return true;
  if (t.includes("mercadopago") && (t.includes("checkout") || t.includes("redirect"))) return true;
  if (t.includes("tu pedido quedo registrado")) return true;
  if (t.includes("costo de envio") || t.includes("costo de envío")) return true;
  if (t.includes("confirma el local")) return true;
  if (t.includes("mercado pago") && t.includes("usa este link")) return true;
  if (t.includes("mercado pago") && t.includes("link")) return true;
  if (t.includes("init_point")) return true;
  return false;
}

/** Respuesta errónea cuando el carrito en RAM quedó colgado tras cerrar el pedido. */
function botReplyIsStaleLoadedCartPrompt(botResponse) {
  if (!botResponse || typeof botResponse !== "string") return false;
  return normalizeTextForMatch(botResponse).includes(normalizeTextForMatch("Ya tengo tu pedido cargado"));
}

function sessionLooksActiveForCheckout(session) {
  if (!session) return false;
  if (Number(session.totalAmount) > 0) return true;
  if (Array.isArray(session.items) && session.items.length > 0) return true;
  return ["awaiting_payment", "awaiting_fulfillment", "awaiting_add_more", "awaiting_address"].includes(
    session.status
  );
}

/** Metadata estandar para rehidratar la sesion despues de restarts. */
function sessionMetadata(session, extra = {}) {
  return {
    status: session?.status || "browsing",
    items: Array.isArray(session?.items) ? session.items : [],
    totalAmount: Number(session?.totalAmount || 0),
    details: session?.details || "",
    fulfillmentType: session?.fulfillmentType || "",
    deliveryAddress: session?.deliveryAddress || "",
    ...extra
  };
}

/**
 * Si el ultimo turno en DB ya cerró el pedido (link MP / efectivo) o quedó el mensaje erróneo,
 * y la sesión en RAM sigue ocupada, limpiamos antes de seguir.
 * Solo el ultimo turno: mirar mas filas borraba sesiones nuevas si un MP viejo seguía en el historial.
 */
function shouldClearStaleCheckoutCart(recentHistory, session) {
  if (!sessionLooksActiveForCheckout(session)) return false;
  if (!recentHistory?.length) return false;
  const last = recentHistory[recentHistory.length - 1];
  const lastBot = last?.bot_response || "";
  if (botReplyIndicatesOrderHandedToRestaurant(lastBot)) return true;
  if (botReplyIsStaleLoadedCartPrompt(lastBot)) return true;
  return false;
}

/** Sin mensajes del usuario durante CHECKOUT_SESSION_TTL_MS con checkout activo: liberar RAM. */
function shouldExpireCheckoutSessionByTtl(session) {
  if (!sessionLooksActiveForCheckout(session)) return false;
  const last = typeof session?.lastActivityAt === "number" ? session.lastActivityAt : Date.now();
  return Date.now() - last > CHECKOUT_SESSION_TTL_MS;
}

function formatTotal(totalAmount) {
  return new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency: "ARS",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(Number(totalAmount) || 0);
}

const DELIVERY_PENDING_FEE_MESSAGE =
  "Gracias. Tu pedido quedó registrado con delivery a domicilio. " +
  "El costo de envío lo confirma el local en unos minutos. " +
  "En cuanto lo tengamos te enviamos el total en pesos argentinos (ARS) y los datos para pagar o el link de Mercado Pago. " +
  "Si no recibís nada en un rato, escribinos de nuevo por acá.";

/**
 * Recalcula el total a partir de los items en la sesion y el menu vigente.
 * Util como red de seguridad cuando la rehidratacion trae items pero totalAmount=0
 * (o cuando algun turno guardo metadata incompleta).
 */
function recomputeSessionTotalFromMenu(session, menuItems = []) {
  if (!session || !Array.isArray(session.items) || !session.items.length) return 0;
  if (!Array.isArray(menuItems) || !menuItems.length) return Number(session.totalAmount || 0);

  const byName = new Map();
  for (const item of menuItems) {
    const key = normalizeTextForMatch(item?.name);
    if (!key) continue;
    const price = Number(item?.price || 0);
    if (!Number.isFinite(price) || price <= 0) continue;
    byName.set(key, price);
  }

  let sum = 0;
  let matchedAll = true;
  for (const name of session.items) {
    const key = normalizeTextForMatch(name);
    if (!key) { matchedAll = false; continue; }
    const price = byName.get(key);
    if (typeof price === "number") {
      sum += price;
    } else {
      matchedAll = false;
    }
  }

  if (matchedAll && sum > 0) return sum;
  return Number(session.totalAmount || 0) || sum;
}

/** Asegura que session.totalAmount refleje el valor real de los items antes de responder. */
function ensureSessionTotals(session, menuItems = []) {
  if (!session) return;
  const current = Number(session.totalAmount || 0);
  if (current > 0) return;
  const recomputed = recomputeSessionTotalFromMenu(session, menuItems);
  if (recomputed > 0) {
    session.totalAmount = recomputed;
    if (!session.details && Array.isArray(session.items) && session.items.length) {
      session.details = session.items.join(", ");
    }
  }
}

function buildFulfillmentQuestion(totalAmount) {
  return `¡Recibido! El total de tu pedido es ${formatTotal(
    totalAmount
  )}. ¿Cómo preferís recibirlo?\n1. Delivery\n2. Comer en el local`;
}

function buildPaymentQuestion(details, totalAmount) {
  return `¡Recibido! El total por ${details} es ${formatTotal(
    totalAmount
  )}. ¿Cómo preferís pagar?\n1. Efectivo al recibir\n2. Mercado Pago`;
}

function buildAddMoreQuestion(details, totalAmount) {
  return `Perfecto, llevo en tu pedido: ${details} (total ${formatTotal(
    totalAmount
  )}). ¿Querés agregar algo más?\n1. Sí, agregar más productos\n2. No, continuar`;
}

function formatOrderDetailsForDisplay(items, fallbackDetails) {
  const names = (Array.isArray(items) ? items : [])
    .map((n) => String(n || "").trim())
    .filter(Boolean);
  if (!names.length) {
    return String(fallbackDetails || "tu pedido").trim() || "tu pedido";
  }

  const counts = new Map();
  for (const name of names) {
    counts.set(name, (counts.get(name) || 0) + 1);
  }

  const orderedUnique = [];
  const seen = new Set();
  for (const name of names) {
    if (seen.has(name)) continue;
    seen.add(name);
    orderedUnique.push(name);
  }

  return orderedUnique
    .map((name) => {
      const qty = counts.get(name) || 1;
      return qty > 1 ? `${name} x${qty}` : name;
    })
    .join(", ");
}

function wantsMenuList(text) {
  const t = normalizeTextForMatch(text).replace(/\s+/g, " ").trim();
  if (!t) return false;
  return (
    t.includes("menu") ||
    t.includes("menú") ||
    t.includes("carta") ||
    t.includes("lista de productos") ||
    t.includes("que tienen") ||
    t.includes("que hay")
  );
}

/** Normaliza categoria de DB y filtro (combos, pizza) para comparar. */
function normalizeMenuCategoryValue(value) {
  return normalizeTextForMatch(String(value || "").trim());
}

function itemMatchesMenuCategoryFilter(item, filterKey) {
  const cat = normalizeMenuCategoryValue(item?.category);
  const want = normalizeMenuCategoryValue(filterKey);
  if (!cat || !want) return false;
  if (cat === want) return true;
  if (cat.includes(want) || want.includes(cat)) return true;
  return false;
}

/**
 * Si el usuario pide ver combos / pizzas (seccion), devuelve la clave de categoria.
 * No aplica cuando parece un pedido ("quiero pizza italiana").
 */
function inferMenuCategoryFilter(text, rawText = "") {
  const t = normalizeTextForMatch(text).replace(/\s+/g, " ").trim();
  if (!t) return null;

  if (/^(quiero|dame|pedir|necesito|mandame|traeme)\b/.test(t)) return null;
  if (/\bpizza\s+(boliviana|italiana|comun)\b/.test(t)) return null;
  if (/\b(quiero|dame)\s+(una|dos|tres|\d+)\s*pizza\b/.test(t)) return null;

  if (
    /\bcombos?\b/.test(t) ||
    /\bmenu\s+de\s+combos?\b/.test(t) ||
    /\bmenú\s+de\s+combos?\b/.test(t) ||
    /\blos\s+combos?\b/.test(t) ||
    /\blas\s+combos?\b/.test(t) ||
    /\bopciones?\s+de\s+combo\b/.test(t) ||
    /\b(seccion|sección)\s+combos?\b/.test(t)
  ) {
    return "combos";
  }

  if (!/\bpizzas?\b/.test(t)) return null;

  const browsePizza =
    /\b(ver|mostrar|menu|menú|carta|lista|tienen|hay|precio|cuanto|cuesta|todas|seccion|sección)\b/.test(t) ||
    /\b(menu|menú)\s+(de\s+)?pizzas?\b/.test(t) ||
    /^(\s*)(las?\s+)?pizzas?\s*[!?.]*\s*$/i.test(String(rawText || "").trim()) ||
    /^(\s*)pizza\s*[!?.]*\s*$/i.test(String(rawText || "").trim()) ||
    (t.length <= 24 && !/\b(quiero|dame|pedi|pedir|necesito|mandame)\b/.test(t));

  if (browsePizza) return "pizza";
  return null;
}

/**
 * @returns {null | { scope: 'full' } | { scope: 'category', category: string }}
 */
function resolveMenuListIntent(text) {
  const t = normalizeTextForMatch(text).replace(/\s+/g, " ").trim();
  if (!t) return null;

  const category = inferMenuCategoryFilter(t, text);
  if (category) {
    return { scope: "category", category };
  }

  if (wantsMenuList(text)) {
    return { scope: "full" };
  }
  return null;
}

/**
 * Pregunta sobre un producto ya nombrado en el mensaje (ingredientes, como es, etc.).
 * Se usa junto con findMentionedMenuItem para no disparar en "que tienen" del menu general.
 */
function isProductDetailQuestion(text) {
  const t = normalizeTextForMatch(text).replace(/\s+/g, " ").trim();
  if (!t) return false;
  return /\b(como\s+es|como\s+viene|como\s+son|que\s+es|qué\s+es|que\s+tiene|qué\s+tiene|que\s+trae|qué\s+trae|que\s+lleva|qué\s+lleva|de\s+que\s+esta|de\s+qué\s+está|de\s+que\s+es|de\s+qué\s+es|de\s+que\s+va|con\s+que\s+viene|viene\s+con|trae\s+eso|ingredientes|incluye|que\s+onda\s+con)\b/.test(
    t
  );
}

function findMentionedMenuItem(text, menuItems = []) {
  const normalizedText = normalizeForItemMatch(text);
  if (!normalizedText) return null;

  const sorted = [...(menuItems || [])]
    .filter((item) => String(item?.name || "").trim())
    .sort((a, b) => normalizeForItemMatch(b.name).length - normalizeForItemMatch(a.name).length);

  for (const item of sorted) {
    const name = normalizeForItemMatch(item.name);
    if (!name) continue;
    if (normalizedText.includes(name)) return item;
  }

  return null;
}

function buildMenuLinesForWhatsApp(menuItems = [], tenant = null, options = {}) {
  const brand =
    (process.env.RESTAURANT_PUBLIC_NAME || "").trim() || tenant?.name || "Restaurante Palermo";
  const bot = (process.env.BOT_DISPLAY_NAME || "RestoBot").trim();
  const header = `*${bot} · ${brand}*\n\n`;
  const valid = (menuItems || []).filter((item) => Number(item?.price) > 0 && String(item?.name || "").trim());
  const sectionKey = (options.sectionKey || "").trim();
  const sectionLabel =
    options.sectionLabel ||
    (sectionKey ? sectionKey.charAt(0).toUpperCase() + sectionKey.slice(1) : "");
  if (!valid.length) {
    const emptyMsg = sectionKey
      ? `Todavia no hay productos cargados en la categoria *${sectionLabel}*. Escribi *menu* para ver todo el listado.`
      : "Ahora mismo no hay productos disponibles en el menu.";
    return `${header}${emptyMsg}`;
  }
  const lines = valid.map((item) => `- ${item.name} (${formatTotal(item.price)})`);
  const intro = sectionKey
    ? `Aqui tenes la seccion *${sectionLabel}*:\n${lines.join("\n")}`
    : `Aqui tienes el menu disponible:\n${lines.join("\n")}`;
  return `${header}${intro}`;
}

function detectFulfillmentIntent(text) {
  if (hasAnyPhrase(text, INTENT_PHRASES.delivery)) return "delivery";
  if (hasAnyPhrase(text, INTENT_PHRASES.local)) return "local";
  return null;
}

function normalizeTextForMatch(text) {
  return (text || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function normalizeForItemMatch(text) {
  return normalizeTextForMatch(text)
    .replace(/s\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const SPANISH_QTY_WORDS = {
  un: 1,
  una: 1,
  uno: 1,
  dos: 2,
  tres: 3,
  cuatro: 4,
  cinco: 5,
  seis: 6,
  siete: 7,
  ocho: 8,
  nueve: 9,
  diez: 10
};

const QTY_FILLER_TOKENS = new Set([
  "quiero",
  "dame",
  "me",
  "das",
  "por",
  "favor",
  "de",
  "del",
  "la",
  "el",
  "los",
  "las",
  "y",
  "con",
  "entonces",
  "dale"
]);

function extractQuantityBeforePosition(normalizedText, position) {
  if (position <= 0) return 1;
  const window = normalizedText.slice(Math.max(0, position - 40), position).trim();
  if (!window) return 1;
  const tokens = window.split(/\s+/);
  for (let i = tokens.length - 1; i >= 0; i -= 1) {
    const t = tokens[i];
    if (!t) continue;
    if (/^\d+$/.test(t)) {
      const n = parseInt(t, 10);
      if (Number.isFinite(n) && n > 0) return Math.min(20, n);
      return 1;
    }
    if (SPANISH_QTY_WORDS[t] !== undefined) return SPANISH_QTY_WORDS[t];
    if (!QTY_FILLER_TOKENS.has(t)) break;
  }
  return 1;
}

/** Evita disparar cierre de pedido / quote con direccion falsa en saludos cortos. */
function isTrivialGreeting(text) {
  const t = normalizeTextForMatch(text).trim();
  if (!t || t.length > 32) return false;
  return /^(hola|buenas|hey|hi|que tal|qué tal|buenos dias|buenas tardes|buenas noches)\b/.test(t);
}

function detectDirectMenuOrder(text, menuItems = []) {
  let working = normalizeForItemMatch(text);
  if (!working) return null;

  // Ordenamos por nombre mas largo primero para que "pizza italiana" no quede
  // tapado por un match temprano de "pizza".
  const sortedMenu = [...(menuItems || [])]
    .filter((item) => {
      const name = normalizeForItemMatch(item?.name);
      const price = Number(item?.price || 0);
      return name && Number.isFinite(price) && price > 0;
    })
    .sort(
      (a, b) => normalizeForItemMatch(b.name).length - normalizeForItemMatch(a.name).length
    );

  const foundItems = [];
  for (const item of sortedMenu) {
    const normalizedName = normalizeForItemMatch(item.name);
    // Permite repetidos: "dos sopas de mani" o "sopa de mani y sopa de mani".
    let idx = working.indexOf(normalizedName);
    while (idx !== -1) {
      const qty = extractQuantityBeforePosition(working, idx);
      for (let i = 0; i < qty; i += 1) {
        foundItems.push(item);
      }
      working =
        working.slice(0, idx) + " ".repeat(normalizedName.length) + working.slice(idx + normalizedName.length);
      idx = working.indexOf(normalizedName);
    }
  }

  if (!foundItems.length) return null;

  const totalAmount = foundItems.reduce((sum, item) => sum + Number(item.price || 0), 0);
  if (!Number.isFinite(totalAmount) || totalAmount <= 0) return null;

  const names = foundItems.map((item) => item.name);
  return {
    details: names.join(", "),
    items: names,
    totalAmount
  };
}

function isShortOptionMessage(text) {
  const option = numericOption(text);
  if (option === 1 || option === 2) return true;
  return hasAnyPhrase(text, [
    ...INTENT_PHRASES.confirmSelection,
    ...INTENT_PHRASES.noMore,
    ...INTENT_PHRASES.cash,
    ...INTENT_PHRASES.mercadoPago,
    ...INTENT_PHRASES.delivery,
    ...INTENT_PHRASES.local
  ]);
}

async function ensureTempDir() {
  await fs.mkdir(TEMP_AUDIO_DIR, { recursive: true });
}

async function handleAudioMessage(message, restaurantContext, tenant, customerNumber, botNumber, recentHistory) {
  const media = await message.downloadMedia();
  if (!media || !media.data) {
    return "No pude procesar el audio. Podrias reenviarlo, por favor?";
  }

  const durationSeconds = extractAudioDurationSeconds(message);
  if (durationSeconds > MAX_AUDIO_SECONDS) {
    return `Tu audio dura mas de ${MAX_AUDIO_SECONDS} segundos. Enviame uno mas corto para poder ayudarte rapido.`;
  }

  const extension = (media.mimetype || "").includes("ogg") ? "ogg" : "mp3";
  const tmpFilePath = path.join(TEMP_AUDIO_DIR, `${Date.now()}-${customerNumber}.${extension}`);

  await fs.writeFile(tmpFilePath, media.data, { encoding: "base64" });

  try {
    const transcription = await transcribeAudioWithWhisper({
      filePath: tmpFilePath,
      durationSeconds
    });

    if (transcription.tooLong) {
      return `Tu audio dura mas de ${transcription.maxSeconds} segundos. Enviame uno mas corto para continuar.`;
    }

    const transcriptText = transcription.transcript || "No se pudo transcribir el audio.";
    if (!transcriptText || transcriptText.length < 2) {
      return "No pude entender bien el audio. Podrias repetirlo en otro audio o por texto?";
    }

    // Enrutamos el audio transcrito por el mismo flujo de checkout de texto
    // para mantener consistencia (agregar items, delivery/local, direccion, pago).
    return handleTextMessage(
      { body: transcriptText, from: message.from },
      restaurantContext,
      tenant,
      customerNumber,
      botNumber,
      recentHistory
    );
  } finally {
    fs.unlink(tmpFilePath).catch(() => null);
  }
}

async function handleTextMessage(message, restaurantContext, tenant, customerNumber, botNumber, recentHistory) {
  const text = message.body || "";
  const trimmedText = text.trim();
  // chatId crudo de WhatsApp (e.g. "5491155551234@c.us" o "208460633350292@lid").
  // Lo guardamos en la orden para responder despues sin adivinar el sufijo.
  const customerChatId = (message?.from || "").trim() || null;
  const conversationKey = getConversationKey(tenant.id, customerNumber, botNumber);
  const menuItems = restaurantContext?.menuItems || [];
  let session = getOrCreateSession(conversationKey);
  rehydrateSessionFromHistory(session, recentHistory);
  if (shouldClearStaleCheckoutCart(recentHistory, session)) {
    resetCheckoutSession(conversationKey);
    conversationState.delete(conversationKey);
    session = getOrCreateSession(conversationKey);
    rehydrateSessionFromHistory(session, recentHistory);
  }
  if (shouldExpireCheckoutSessionByTtl(session)) {
    resetCheckoutSession(conversationKey);
    conversationState.delete(conversationKey);
    session = getOrCreateSession(conversationKey);
    rehydrateSessionFromHistory(session, recentHistory);
  }
  // Si la sesion quedo sin total pero con items (ej. turno anterior guardo metadata con total 0),
  // recomponemos a partir del menu para no mostrar "$0".
  ensureSessionTotals(session, menuItems);
  session.lastActivityAt = Date.now();
  const previousMessages = conversationState.get(conversationKey) || [];
  let updatedMessages = [...previousMessages, text].slice(-20);
  conversationState.set(conversationKey, updatedMessages);
  session = getOrCreateSession(conversationKey);
  const addressCheck = await detectAddressIntent({
    customerMessage: text,
    chatHistory: recentHistory
  });
  const hasConfirmedAddress = isConfirmedAddress(addressCheck, text);
  const fulfillmentIntent = detectFulfillmentIntent(trimmedText);
  const option = numericOption(trimmedText);

  if (wantsToCancelCheckout(trimmedText) && sessionLooksActiveForCheckout(session)) {
    resetCheckoutSession(conversationKey);
    conversationState.delete(conversationKey);
    const cancelReply =
      "Listo, cancelamos el pedido que tenias armado. Cuando quieras, escribime de nuevo y arrancamos de cero.";
    await saveInteraction({
      restaurantId: tenant.id,
      customerNumber,
      botNumber,
      messageType: "text",
      userMessage: text,
      botResponse: cancelReply,
      metadata: {
        status: "browsing",
        checkoutCancelled: true,
        totalAmount: 0,
        items: [],
        details: ""
      }
    });
    return cancelReply;
  }

  const menuListIntent = resolveMenuListIntent(trimmedText);
  if (menuListIntent) {
    let itemsForMessage = menuItems;
    let menuMeta = { menuShown: true, menuScope: menuListIntent.scope };
    if (menuListIntent.scope === "category") {
      itemsForMessage = menuItems.filter((item) =>
        itemMatchesMenuCategoryFilter(item, menuListIntent.category)
      );
      menuMeta.menuCategory = menuListIntent.category;
    }
    const menuReply = buildMenuLinesForWhatsApp(itemsForMessage, tenant, {
      sectionKey: menuListIntent.scope === "category" ? menuListIntent.category : "",
      sectionLabel:
        menuListIntent.scope === "category"
          ? menuListIntent.category === "combos"
            ? "combos"
            : menuListIntent.category === "pizza"
              ? "pizzas"
              : menuListIntent.category
          : ""
    });
    await saveInteraction({
      restaurantId: tenant.id,
      customerNumber,
      botNumber,
      messageType: "text",
      userMessage: text,
      botResponse: menuReply,
      metadata: sessionMetadata(session, menuMeta)
    });
    return menuReply;
  }

  const mentionedProductForDetail = findMentionedMenuItem(trimmedText, menuItems);
  if (mentionedProductForDetail && isProductDetailQuestion(trimmedText)) {
    let dishReply;
    try {
      dishReply = await generateProductQuestionAnswer({
        customerMessage: text,
        menuItem: mentionedProductForDetail,
        restaurantContext
      });
    } catch (detailErr) {
      console.error("Error generateProductQuestionAnswer:", detailErr);
      const d = String(mentionedProductForDetail.description || "").trim();
      const priceHint =
        mentionedProductForDetail.price != null
          ? ` Sale ${formatTotal(mentionedProductForDetail.price)}.`
          : "";
      dishReply = d
        ? `${mentionedProductForDetail.name}: te resumo lo que figura: ${d.slice(0, 220)}${d.length > 220 ? "..." : ""}${priceHint}`
        : `${mentionedProductForDetail.name}: no tenemos el detalle cargado.${priceHint} Si queres lo pedimos igual.`;
    }
    await saveInteraction({
      restaurantId: tenant.id,
      customerNumber,
      botNumber,
      messageType: "text",
      userMessage: text,
      botResponse: dishReply,
      metadata: sessionMetadata(session, {
        dishDescriptionShown: true,
        dishName: mentionedProductForDetail.name,
        productDetailAnswer: true
      })
    });
    return dishReply;
  }

  // Recupera el flujo si llega una opcion corta aunque el estado previo se haya desfasado.
  if (session.totalAmount > 0 && session.status === "browsing") {
    if (option === 1 || fulfillmentIntent === "delivery") {
      session.status = "awaiting_fulfillment";
    } else if (option === 2 || fulfillmentIntent === "local") {
      session.status = "awaiting_fulfillment";
    }
  }

  if (session.status === "awaiting_add_more") {
    // Si el cliente manda directamente otro producto del menu (uno o varios),
    // lo acumulamos sin forzar el paso intermedio de "1".
    const directOrderWhileAddMore = detectDirectMenuOrder(text, restaurantContext?.menuItems || []);
    if (directOrderWhileAddMore) {
      session.items = [...(session.items || []), ...directOrderWhileAddMore.items];
      session.totalAmount = Number(session.totalAmount || 0) + directOrderWhileAddMore.totalAmount;
      session.details = session.items.join(", ");
      session.conversationText = updatedMessages.join(" | ");

      const addMoreQuestion = buildAddMoreQuestion(
        formatOrderDetailsForDisplay(session.items, session.details),
        session.totalAmount
      );
      await saveInteraction({
        restaurantId: tenant.id,
        customerNumber,
        botNumber,
        messageType: "text",
        userMessage: text,
        botResponse: addMoreQuestion,
        metadata: sessionMetadata(session, { accumulated: true })
      });
      return addMoreQuestion;
    }

    if (wantsToCloseOrder(text) || option === 2 || hasAnyPhrase(text, INTENT_PHRASES.noMore)) {
      ensureSessionTotals(session, menuItems);
      if (!Number(session.totalAmount) || Number(session.totalAmount) <= 0) {
        const missingTotalReply =
          "No pude calcular el total del pedido en este paso. Confirmame nuevamente los productos para continuar.";
        await saveInteraction({
          restaurantId: tenant.id,
          customerNumber,
          botNumber,
          messageType: "text",
          userMessage: text,
          botResponse: missingTotalReply,
          metadata: sessionMetadata(session, { missingTotalBeforeFulfillment: true })
        });
        return missingTotalReply;
      }
      session.status = "awaiting_fulfillment";
      const fulfillmentQuestion = buildFulfillmentQuestion(session.totalAmount);
      await saveInteraction({
        restaurantId: tenant.id,
        customerNumber,
        botNumber,
        messageType: "text",
        userMessage: text,
        botResponse: fulfillmentQuestion,
        metadata: sessionMetadata(session)
      });
      return fulfillmentQuestion;
    }

    if (option === 1 || hasAnyPhrase(text, [...INTENT_PHRASES.confirmSelection, ...INTENT_PHRASES.addMore])) {
      session.status = "browsing";
      const addMoreReply = `${buildMenuLinesForWhatsApp(menuItems, tenant)}\n\nPerfecto, decime qué más querés agregar.`;
      await saveInteraction({
        restaurantId: tenant.id,
        customerNumber,
        botNumber,
        messageType: "text",
        userMessage: text,
        botResponse: addMoreReply,
        metadata: sessionMetadata(session)
      });
      return addMoreReply;
    }

    if (option === 2 || hasAnyPhrase(text, INTENT_PHRASES.noMore)) {
      ensureSessionTotals(session, menuItems);
      if (!Number(session.totalAmount) || Number(session.totalAmount) <= 0) {
        const missingTotalReply =
          "No pude calcular el total del pedido en este paso. Confirmame nuevamente los productos para continuar.";
        await saveInteraction({
          restaurantId: tenant.id,
          customerNumber,
          botNumber,
          messageType: "text",
          userMessage: text,
          botResponse: missingTotalReply,
          metadata: sessionMetadata(session, { missingTotalBeforeFulfillment: true })
        });
        return missingTotalReply;
      }
      session.status = "awaiting_fulfillment";
      const fulfillmentQuestion = buildFulfillmentQuestion(session.totalAmount);
      await saveInteraction({
        restaurantId: tenant.id,
        customerNumber,
        botNumber,
        messageType: "text",
        userMessage: text,
        botResponse: fulfillmentQuestion,
        metadata: sessionMetadata(session)
      });
      return fulfillmentQuestion;
    }

    const invalidAddMoreReply = "No entendí tu opción. Responde 1 para agregar más productos o 2 para continuar.";
    await saveInteraction({
      restaurantId: tenant.id,
      customerNumber,
      botNumber,
      messageType: "text",
      userMessage: text,
      botResponse: invalidAddMoreReply,
      metadata: sessionMetadata(session, { invalidChoice: true })
    });
    return invalidAddMoreReply;
  }

  if (session.status === "awaiting_fulfillment") {
    if (option === 1 || fulfillmentIntent === "delivery") {
      session.fulfillmentType = "delivery";
      if (hasConfirmedAddress) {
        session.deliveryAddress = addressCheck.normalizedAddress || text;
      }

      if (!session.deliveryAddress) {
        session.status = "awaiting_address";
        const askAddress =
          "Perfecto. Para delivery necesito tu direccion exacta de entrega (calle y numero).";
        await saveInteraction({
          restaurantId: tenant.id,
          customerNumber,
          botNumber,
          messageType: "text",
          userMessage: text,
          botResponse: askAddress,
          metadata: sessionMetadata(session)
        });
        return askAddress;
      }

      session.status = "awaiting_payment";
      const paymentQuestion = buildPaymentQuestion(
        formatOrderDetailsForDisplay(session.items, session.details),
        session.totalAmount
      );
      await saveInteraction({
        restaurantId: tenant.id,
        customerNumber,
        botNumber,
        messageType: "text",
        userMessage: text,
        botResponse: paymentQuestion,
        metadata: sessionMetadata(session)
      });
      return paymentQuestion;
    }

    if (option === 2 || fulfillmentIntent === "local") {
      session.fulfillmentType = "local";
      session.deliveryAddress = "";
      session.status = "awaiting_payment";
      const paymentQuestion = buildPaymentQuestion(
        formatOrderDetailsForDisplay(session.items, session.details),
        session.totalAmount
      );
      await saveInteraction({
        restaurantId: tenant.id,
        customerNumber,
        botNumber,
        messageType: "text",
        userMessage: text,
        botResponse: paymentQuestion,
        metadata: sessionMetadata(session)
      });
      return paymentQuestion;
    }

    if (hasAnyPhrase(text, INTENT_PHRASES.addMore)) {
      session.status = "browsing";
      const addMoreReply = `${buildMenuLinesForWhatsApp(menuItems, tenant)}\n\nPerfecto, decime qué más querés agregar.`;
      await saveInteraction({
        restaurantId: tenant.id,
        customerNumber,
        botNumber,
        messageType: "text",
        userMessage: text,
        botResponse: addMoreReply,
        metadata: sessionMetadata(session)
      });
      return addMoreReply;
    }

    const invalidFulfillmentReply = "No entendi tu opcion. Responde 1 para Delivery o 2 para Comer en el local.";
    await saveInteraction({
      restaurantId: tenant.id,
      customerNumber,
      botNumber,
      messageType: "text",
      userMessage: text,
      botResponse: invalidFulfillmentReply,
      metadata: sessionMetadata(session, { invalidChoice: true })
    });
    return invalidFulfillmentReply;
  }

  if (session.status === "awaiting_payment") {
    const isLocal = session.fulfillmentType === "local";
    const orderNotesBase = `Detalle: ${session.details} | Modalidad: ${
      session.fulfillmentType === "local" ? "comer_en_local" : "delivery"
    }${session.deliveryAddress ? ` | Direccion: ${session.deliveryAddress}` : ""}`;
    const baseOrderPayload = {
      restaurantId: tenant.id,
      customerNumber,
      customerChatId,
      botNumber,
      items: session.items?.length ? session.items : [session.details],
      notes: orderNotesBase,
      address: session.deliveryAddress || null,
      rawRequest: session.conversationText,
      totalAmount: session.totalAmount
    };

    if (option === 1 || hasAnyPhrase(text, INTENT_PHRASES.cash)) {
      if (!isLocal) {
        const order = await saveOrder({
          ...baseOrderPayload,
          status: "awaiting_delivery_fee",
          paymentMethod: "efectivo",
          paymentStatus: "pending",
          fulfillmentType: "delivery",
          subtotalAmount: session.totalAmount,
          deliveryFee: null,
          finalTotalAmount: null,
          paymentLink: null,
          customerNotifiedAt: null
        });

        await saveInteraction({
          restaurantId: tenant.id,
          customerNumber,
          botNumber,
          messageType: "text",
          userMessage: text,
          botResponse: DELIVERY_PENDING_FEE_MESSAGE,
          metadata: {
            orderId: order.id,
            paymentChoice: "cash",
            fulfillmentType: "delivery",
            details: session.details,
            deliveryAwaitingFee: true
          }
        });

        resetCheckoutSession(conversationKey);
        conversationState.delete(conversationKey);
        return DELIVERY_PENDING_FEE_MESSAGE;
      }

      const order = await saveOrder({
        ...baseOrderPayload,
        status: "pending",
        paymentMethod: "efectivo",
        paymentStatus: "pending"
      });

      const cashReply = "Perfecto, pago en efectivo al recibir. Tu pedido quedo registrado y en preparacion.";

      await saveInteraction({
        restaurantId: tenant.id,
        customerNumber,
        botNumber,
        messageType: "text",
        userMessage: text,
        botResponse: cashReply,
        metadata: {
          orderId: order.id,
          paymentChoice: "cash",
          fulfillmentType: session.fulfillmentType || "delivery",
          details: session.details
        }
      });

      resetCheckoutSession(conversationKey);
      conversationState.delete(conversationKey);
      return cashReply;
    }

    if (option === 2 || hasAnyPhrase(text, INTENT_PHRASES.mercadoPago)) {
      if (!session.totalAmount || session.totalAmount <= 0) {
        const missingTotalReply = "No pude calcular el total del pedido. Revisa los productos y volve a cerrar el pedido.";
        await saveInteraction({
          restaurantId: tenant.id,
          customerNumber,
          botNumber,
          messageType: "text",
          userMessage: text,
          botResponse: missingTotalReply,
          metadata: { paymentChoice: "mercadopago_missing_total" }
        });
        return missingTotalReply;
      }

      if (!isLocal) {
        const order = await saveOrder({
          ...baseOrderPayload,
          status: "awaiting_delivery_fee",
          paymentMethod: "mercadopago",
          paymentStatus: "pending",
          fulfillmentType: "delivery",
          subtotalAmount: session.totalAmount,
          deliveryFee: null,
          finalTotalAmount: null,
          paymentLink: null,
          customerNotifiedAt: null
        });

        await saveInteraction({
          restaurantId: tenant.id,
          customerNumber,
          botNumber,
          messageType: "text",
          userMessage: text,
          botResponse: DELIVERY_PENDING_FEE_MESSAGE,
          metadata: {
            orderId: order.id,
            paymentChoice: "mercadopago",
            fulfillmentType: "delivery",
            details: session.details,
            deliveryAwaitingFee: true
          }
        });

        resetCheckoutSession(conversationKey);
        conversationState.delete(conversationKey);
        return DELIVERY_PENDING_FEE_MESSAGE;
      }

      const order = await saveOrder({
        ...baseOrderPayload,
        status: "pending",
        paymentMethod: "mercadopago",
        paymentStatus: "pending"
      });

      let paymentUrl;
      try {
        paymentUrl = await createPaymentPreference({
          orderId: order.id,
          totalAmount: session.totalAmount,
          restaurantName: tenant.name
        });
      } catch (mpError) {
        const mpErrorReply = `No pude generar el link de Mercado Pago. ${mpError.message || ""}`.trim();
        await saveInteraction({
          restaurantId: tenant.id,
          customerNumber,
          botNumber,
          messageType: "text",
          userMessage: text,
          botResponse: `${mpErrorReply} Si queres, responde 1 para pagar en efectivo al recibir.`,
          metadata: { orderId: order.id, paymentChoice: "mercadopago_error", error: String(mpError.message || mpError) }
        });
        return `${mpErrorReply}\nSi queres, responde 1 para pagar en efectivo al recibir.`;
      }

      const mpReply = `Perfecto. Para completar tu pago con Mercado Pago usa este link:\n${paymentUrl}`;

      await saveInteraction({
        restaurantId: tenant.id,
        customerNumber,
        botNumber,
        messageType: "text",
        userMessage: text,
        botResponse: mpReply,
        metadata: {
          orderId: order.id,
          paymentChoice: "mercadopago",
          fulfillmentType: session.fulfillmentType || "delivery",
          details: session.details
        }
      });

      resetCheckoutSession(conversationKey);
      conversationState.delete(conversationKey);
      return mpReply;
    }

    const invalidOptionReply = "No entendi tu opcion. Responde 1 para Efectivo o 2 para Mercado Pago.";
    await saveInteraction({
      restaurantId: tenant.id,
      customerNumber,
      botNumber,
      messageType: "text",
      userMessage: text,
      botResponse: invalidOptionReply,
      metadata: { paymentChoice: "invalid" }
    });
    return invalidOptionReply;
  }

  if (session.status === "awaiting_address" && session.totalAmount > 0) {
    if (hasConfirmedAddress) {
      session.deliveryAddress = addressCheck.normalizedAddress || text;
      session.status = "awaiting_payment";
      session.fulfillmentType = session.fulfillmentType || "delivery";

      const paymentQuestion = buildPaymentQuestion(
        formatOrderDetailsForDisplay(session.items, session.details),
        session.totalAmount
      );
      await saveInteraction({
        restaurantId: tenant.id,
        customerNumber,
        botNumber,
        messageType: "text",
        userMessage: text,
        botResponse: paymentQuestion,
        metadata: sessionMetadata(session)
      });

      return paymentQuestion;
    }

    const askAddressAgain =
      "Perfecto. Para cerrar el pedido necesito tu direccion exacta de entrega (calle y numero).";
    await saveInteraction({
      restaurantId: tenant.id,
      customerNumber,
      botNumber,
      messageType: "text",
      userMessage: text,
      botResponse: askAddressAgain,
      metadata: sessionMetadata(session)
    });
    return askAddressAgain;
  }

  if (session.status === "browsing" && session.items?.length && session.totalAmount > 0) {
    if (hasConfirmedAddress) {
      session.fulfillmentType = "delivery";
      session.deliveryAddress = addressCheck.normalizedAddress || text;
      session.status = "awaiting_payment";
      const paymentQuestion = buildPaymentQuestion(
        formatOrderDetailsForDisplay(session.items, session.details),
        session.totalAmount
      );
      await saveInteraction({
        restaurantId: tenant.id,
        customerNumber,
        botNumber,
        messageType: "text",
        userMessage: text,
        botResponse: paymentQuestion,
        metadata: sessionMetadata(session)
      });
      return paymentQuestion;
    }

    if (fulfillmentIntent === "delivery") {
      session.fulfillmentType = "delivery";
      session.status = "awaiting_address";
      const askAddress = "Perfecto. Para delivery necesito tu direccion exacta de entrega (calle y numero).";
      await saveInteraction({
        restaurantId: tenant.id,
        customerNumber,
        botNumber,
        messageType: "text",
        userMessage: text,
        botResponse: askAddress,
        metadata: sessionMetadata(session)
      });
      return askAddress;
    }

    if (fulfillmentIntent === "local") {
      session.fulfillmentType = "local";
      session.deliveryAddress = "";
      session.status = "awaiting_payment";
      const paymentQuestion = buildPaymentQuestion(
        formatOrderDetailsForDisplay(session.items, session.details),
        session.totalAmount
      );
      await saveInteraction({
        restaurantId: tenant.id,
        customerNumber,
        botNumber,
        messageType: "text",
        userMessage: text,
        botResponse: paymentQuestion,
        metadata: sessionMetadata(session)
      });
      return paymentQuestion;
    }
  }

  const directOrder = detectDirectMenuOrder(text, restaurantContext?.menuItems || []);
  if (directOrder) {
    const hadPreviousItems =
      Array.isArray(session.items) && session.items.length > 0 && Number(session.totalAmount) > 0;
    if (hadPreviousItems) {
      // Acumulamos: el cliente ya tenia carrito y esta sumando productos.
      session.items = [...session.items, ...directOrder.items];
      session.totalAmount = Number(session.totalAmount) + directOrder.totalAmount;
      session.details = session.items.join(", ");
    } else {
      session.totalAmount = directOrder.totalAmount;
      session.details = directOrder.details;
      session.items = directOrder.items;
      session.fulfillmentType = "";
    }
    session.conversationText = updatedMessages.join(" | ");
    if (hasConfirmedAddress) {
      session.deliveryAddress = addressCheck.normalizedAddress || text;
    }

    session.status = "awaiting_add_more";
    const addMoreQuestion = buildAddMoreQuestion(
      formatOrderDetailsForDisplay(session.items, session.details),
      session.totalAmount
    );
    await saveInteraction({
      restaurantId: tenant.id,
      customerNumber,
      botNumber,
      messageType: "text",
      userMessage: text,
      botResponse: addMoreQuestion,
      metadata: sessionMetadata(session)
    });

    return addMoreQuestion;
  }

  if (
    wantsToCloseOrder(text) ||
    wantsToConfirmSelection(text) ||
    (hasConfirmedAddress && !isTrivialGreeting(text))
  ) {
    const quote = await generateOrderQuote({
      conversationText: updatedMessages.join("\n"),
      restaurantContext,
      chatHistory: recentHistory
    });

    if (!quote.hasOrder || !quote.totalAmount || quote.totalAmount <= 0) {
      if (session.items?.length && session.totalAmount > 0) {
        session.status = "awaiting_fulfillment";
        const keepSessionReply = "Ya tengo tu pedido cargado. Responde 1 para Delivery o 2 para Comer en el local.";
        await saveInteraction({
          restaurantId: tenant.id,
          customerNumber,
          botNumber,
          messageType: "text",
          userMessage: text,
          botResponse: keepSessionReply,
          metadata: sessionMetadata(session)
        });
        return keepSessionReply;
      }

      const fallbackReply =
        quote.missingItemsMessage ||
        "No logre identificar un pedido valido con productos del menu. Decime que productos queres pedir.";
      await saveInteraction({
        restaurantId: tenant.id,
        customerNumber,
        botNumber,
        messageType: "text",
        userMessage: text,
        botResponse: fallbackReply
      });
      return fallbackReply;
    }

    session.status = "awaiting_add_more";
    session.totalAmount = quote.totalAmount;
    session.details = quote.details || "tu pedido";
    session.items = quote.items || [];
    session.fulfillmentType = "";
    session.deliveryAddress = quote.deliveryAddress || (hasConfirmedAddress ? addressCheck.normalizedAddress || text : "");
    session.conversationText = updatedMessages.join(" | ");

    const addMoreQuestion = buildAddMoreQuestion(
      formatOrderDetailsForDisplay(session.items, session.details),
      session.totalAmount
    );
    await saveInteraction({
      restaurantId: tenant.id,
      customerNumber,
      botNumber,
      messageType: "text",
      userMessage: text,
      botResponse: addMoreQuestion,
      metadata: sessionMetadata(session)
    });

    return addMoreQuestion;
  }

  // Si ya hay un pedido armado, evitamos volver al asistente generico.
  if (session.items?.length && session.totalAmount > 0) {
    const lastTurn = recentHistory?.length ? recentHistory[recentHistory.length - 1] : null;
    const lastBot = lastTurn?.bot_response || "";
    if (botReplyIndicatesOrderHandedToRestaurant(lastBot) || botReplyIsStaleLoadedCartPrompt(lastBot)) {
      resetCheckoutSession(conversationKey);
      conversationState.delete(conversationKey);
      session = getOrCreateSession(conversationKey);
      updatedMessages = [text].filter(Boolean);
      conversationState.set(conversationKey, updatedMessages);
    } else {
      session.status = "awaiting_add_more";
      const activeOrderReply =
        "Ya tengo tu pedido cargado. Responde 1 para agregar más productos o 2 para continuar.";
      await saveInteraction({
        restaurantId: tenant.id,
        customerNumber,
        botNumber,
        messageType: "text",
        userMessage: text,
        botResponse: activeOrderReply,
        metadata: sessionMetadata(session)
      });
      return activeOrderReply;
    }
  }

  if (isShortOptionMessage(trimmedText)) {
    // Ultima red de seguridad: si llegamos aca con "1"/"2" y el ultimo turno del bot
    // fue un prompt de checkout, intentamos recuperar el estado y re-enrutar.
    const lastTurn = recentHistory?.length ? recentHistory[recentHistory.length - 1] : null;
    const lastBot = (lastTurn?.bot_response || "").toLowerCase();
    const lastMetaStatus = lastTurn?.metadata?.status;

    let recoveredStatus = null;
    if (lastMetaStatus && CHECKOUT_STATUSES.includes(lastMetaStatus)) {
      recoveredStatus = lastMetaStatus;
    } else if (lastBot.includes("querés agregar algo más") || lastBot.includes("queres agregar algo mas")) {
      recoveredStatus = "awaiting_add_more";
    } else if (lastBot.includes("cómo preferís recibirlo") || lastBot.includes("como preferis recibirlo")) {
      recoveredStatus = "awaiting_fulfillment";
    } else if (lastBot.includes("cómo preferís pagar") || lastBot.includes("como preferis pagar")) {
      recoveredStatus = "awaiting_payment";
    }

    if (recoveredStatus && !botReplyIndicatesOrderHandedToRestaurant(lastBot)) {
      session.status = recoveredStatus;
      const meta = lastTurn?.metadata || {};
      if (!session.totalAmount && Number(meta.totalAmount) > 0) session.totalAmount = Number(meta.totalAmount);
      if ((!session.items || !session.items.length) && Array.isArray(meta.items) && meta.items.length) {
        session.items = meta.items;
      }
      if (!session.details && meta.details) session.details = meta.details;
      if (!session.fulfillmentType && meta.fulfillmentType) session.fulfillmentType = meta.fulfillmentType;
      if (!session.deliveryAddress && meta.deliveryAddress) session.deliveryAddress = meta.deliveryAddress;

      // Reintento recursivo con estado recuperado. Marca para evitar loops infinitos.
      if (!message.__recovered) {
        return handleTextMessage(
          { body: text, from: message.from, __recovered: true },
          restaurantContext,
          tenant,
          customerNumber,
          botNumber,
          recentHistory
        );
      }
    }

    const helpReply =
      "Todavia no tengo un pedido activo para esa opcion. Decime que producto queres pedir y te guio paso a paso.";
    await saveInteraction({
      restaurantId: tenant.id,
      customerNumber,
      botNumber,
      messageType: "text",
      userMessage: text,
      botResponse: helpReply,
      metadata: { status: "browsing", shortOptionWithoutSession: true }
    });
    return helpReply;
  }

  const answer = await generateAssistantResponse({
    customerMessage: text,
    restaurantContext,
    chatHistory: recentHistory,
    isFirstContact: !recentHistory?.length
  });

  await saveInteraction({
    restaurantId: tenant.id,
    customerNumber,
    botNumber,
    messageType: "text",
    userMessage: text,
    botResponse: answer
  });

  return answer;
}

const client = new Client({
  authStrategy: new LocalAuth({
    clientId: process.env.WWEBJS_CLIENT_ID || "restobot-main",
    dataPath: AUTH_PATH
  }),
  puppeteer: {
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  }
});

client.on("qr", (qr) => {
  console.log("Escanea el QR para iniciar sesion:");
  qrcode.generate(qr, { small: true });
});

let stopDeliveryNotifier = null;
let stopPaymentPoller = null;
client.on("ready", () => {
  console.log("WhatsApp conectado y listo.");
  try {
    if (typeof stopDeliveryNotifier === "function") {
      stopDeliveryNotifier();
    }
  } catch (_) {
    // ignore
  }
  try {
    if (typeof stopPaymentPoller === "function") {
      stopPaymentPoller();
    }
  } catch (_) {
    // ignore
  }
  stopDeliveryNotifier = startOrderDeliveryNotifier(client);
  stopPaymentPoller = startPaymentStatusPoller(client);
});

client.on("authenticated", () => {
  console.log("Sesion autenticada correctamente.");
});

client.on("auth_failure", (error) => {
  console.error("Fallo de autenticacion:", error);
});

client.on("disconnected", (reason) => {
  console.error("Cliente desconectado:", reason);
});

client.on("message", async (message) => {
  try {
    if (message.fromMe) return;
    if (message.type === "sticker") return;

    const botNumber = resolveIncomingBotNumber(message, client);
    const customerNumber = extractCustomerNumber(message);

    const tenant = await getRestaurantByIncomingNumber(botNumber);
    if (!tenant) {
      console.warn("Tenant no encontrado para numero entrante:", {
        botNumber,
        messageTo: message.to,
        clientWid: client?.info?.wid?.user
      });
      await message.reply("No tengo configurado este numero para ningun restaurante.");
      return;
    }

    if (!isWithinBusinessHours()) {
      const closedReply = buildClosedReply();
      await message.reply(closedReply);
      try {
        await saveInteraction({
          restaurantId: tenant.id,
          customerNumber,
          botNumber,
          messageType: message.type === "ptt" ? "audio" : "text",
          userMessage: message.body || null,
          botResponse: closedReply,
          metadata: { status: "out_of_hours", businessHours: BUSINESS_HOURS }
        });
      } catch (logErr) {
        console.error("No pude registrar la interaccion fuera de horario:", logErr);
      }
      return;
    }

    const restaurantContext = await getRestaurantContext(tenant.id);
    if (!restaurantContext) {
      await message.reply("No pude cargar la informacion del restaurante en este momento.");
      return;
    }
    const availableMenuItems = await getAvailableMenuItems(tenant.id);
    const iaContext = {
      ...restaurantContext,
      menuItems: availableMenuItems
    };
    const recentHistory = await getRecentInteractions({
      restaurantId: tenant.id,
      customerNumber,
      botNumber,
      limit: 40
    });

    let replyText = null;

    if (message.hasMedia && message.type === "ptt") {
      replyText = await handleAudioMessage(
        message,
        iaContext,
        tenant,
        customerNumber,
        botNumber,
        recentHistory
      );
    } else if (message.type === "chat") {
      const conversationKey = getConversationKey(tenant.id, customerNumber, botNumber);
      const activeSession = getOrCreateSession(conversationKey);
      const normalizedBody = (message.body || "").trim();
      const isKnownShortOption = /^(1|2|si|sí|no|ok|mp|delivery|local)$/i.test(normalizedBody);
      const expectingShortReply = ["awaiting_payment", "awaiting_fulfillment", "awaiting_add_more"].includes(
        activeSession.status
      );
      if (shouldIgnoreTextMessage(message.body) && !expectingShortReply && !isKnownShortOption) return;
      replyText = await handleTextMessage(
        message,
        iaContext,
        tenant,
        customerNumber,
        botNumber,
        recentHistory
      );
    } else {
      return;
    }

    if (replyText) {
      await message.reply(replyText);
    }
  } catch (error) {
    console.error("Error procesando mensaje:", error);
    try {
      await message.reply("Tuve un problema tecnico procesando tu mensaje. Intenta de nuevo.");
    } catch (_) {
      // Ignora fallos de respuesta secundarios
    }
  }
});

ensureTempDir()
  .then(() => client.initialize())
  .catch((error) => {
    console.error("No se pudo inicializar el bot:", error);
    process.exit(1);
  });
