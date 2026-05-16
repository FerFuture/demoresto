require("dotenv").config();

const crypto = require("crypto");
const http = require("http");
const fs = require("fs/promises");
const path = require("path");
const bcrypt = require("bcryptjs");
const qrcode = require("qrcode-terminal");
const { Client, LocalAuth } = require("whatsapp-web.js");
const {
  getRestaurantByIncomingNumber,
  getRestaurantContext,
  getAvailableMenuItems,
  getRecentInteractions,
  saveInteraction,
  saveOrder,
  getOrderAwaitingCustomerTotalConfirm,
  updateOrderMatching,
  getRestaurantNameById,
  createDemoFromTemplate,
  verifyDashboardUserCredentials
} = require("./database");
const { startOrderDeliveryNotifier } = require("./order_delivery_notifier");
const { startPaymentStatusPoller } = require("./payment_status_poller");
const {
  MAX_AUDIO_SECONDS,
  transcribeAudioWithWhisper,
  generateProductQuestionAnswer,
  generateAssistantResponse,
  generateOrderQuote,
  detectAddressIntent,
  parseRecipeFromText,
  resolvePublicBrandName,
  resolveBotDisplayName
} = require("./ia_service");
const { createPaymentPreference } = require("./payment_service");
const {
  maybeEmpanadaQuantityGate,
  tryResolvePendingEmpanadaOrder,
  tryEmpanadaPackDirectOrder
} = require("./empanada_order_rules");
const {
  maybePersonPortionGate,
  tryResolvePendingPersonPortion,
  tryPersonPortionDirectOrder,
  tryPersonPortionImplicitSingle
} = require("./person_portion_order_rules");

const AUTH_PATH = process.env.WWEBJS_AUTH_PATH || ".wwebjs_auth";
const TEMP_AUDIO_DIR = path.resolve(process.cwd(), "tmp_audio");
const MIN_TEXT_LENGTH = 3;
/** Inactividad maxima en checkout antes de limpiar sesion en RAM (ms). */
const CHECKOUT_SESSION_TTL_MS = Number(process.env.CHECKOUT_SESSION_TTL_MS || 15 * 60 * 1000);
const checkoutSessions = new Map();
const conversationState = new Map();

async function readJsonBody(req, { maxBytes = 1_000_000 } = {}) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) throw new Error("Payload demasiado grande");
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`JSON inválido: ${e?.message || e}`);
  }
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload ?? null);
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Length", Buffer.byteLength(body));
  res.end(body);
}

// API mínima para el panel web "Cliente de Mesa" (QR por mesa).
// Crea órdenes confirmadas ancladas al `table_number` y, si elige MP,
// genera el link de pago (Mercado Pago) usando el service role.
const MESA_API_PORT = Number(process.env.MESA_API_PORT || 3000);
const MESA_ORDER_PATH = "/api/mesa/order";
const DASHBOARD_PASSWORD_VERIFY_PATH = "/api/dashboard/password/verify";
const DASHBOARD_PASSWORD_HASH_PATH = "/api/dashboard/password/hash";
const DASHBOARD_DB_LOGIN_PATH = "/api/dashboard/db-login";
const DASHBOARD_STOCK_RECIPE_AI_PATH = "/api/dashboard/stock/recipe-ai";
const MAESTRO_CREATE_DEMO_PATH = "/api/maestro/create-demo";
/** Contraseña del panel Maestro (servidor). Preferí MAESTRO_PASSWORD; si no, se acepta VITE_MAESTRO_PASSWORD del mismo .env. */
const MAESTRO_PASSWORD_EXPECTED = String(
  process.env.MAESTRO_PASSWORD || process.env.VITE_MAESTRO_PASSWORD || ""
).trim();
/** Misma cadena que `VITE_MESA_QR_SECRET` en el dashboard: si está definida, exige `mesaToken` en POST /api/mesa/order */
const MESA_QR_SECRET = String(process.env.MESA_QR_SECRET || "").trim();

function validateMesaQrToken(restaurantId, tableNumber, token) {
  if (!MESA_QR_SECRET) {
    return {
      ok: false,
      error: "Mesa QR no disponible: falta configurar MESA_QR_SECRET en el servidor."
    };
  }
  if (!token || typeof token !== "string") {
    return { ok: false, error: "Falta token de mesa. Abrí el enlace del QR impreso en la mesa." };
  }
  const expected = crypto
    .createHmac("sha256", MESA_QR_SECRET)
    .update(`${restaurantId}|${tableNumber}`)
    .digest("hex");
  const a = Buffer.from(String(token).trim(), "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length) return { ok: false, error: "Token de mesa inválido." };
  if (!crypto.timingSafeEqual(a, b)) return { ok: false, error: "Token de mesa inválido." };
  return { ok: true };
}

function isMesaQrModuleEnabled(restaurant) {
  const meta =
    restaurant && typeof restaurant.metadata === "object" && !Array.isArray(restaurant.metadata)
      ? restaurant.metadata
      : null;
  return meta?.mesa_qr_enabled !== false;
}

function normalizeMesaQrBlockedTables(value, maxTableCount = 500) {
  if (!Array.isArray(value)) return [];
  const max = Number.isFinite(maxTableCount) && maxTableCount >= 1 ? Math.floor(maxTableCount) : 500;
  return [...new Set(value.map((entry) => Number(entry)).filter((entry) => Number.isFinite(entry) && entry >= 1 && entry <= max))]
    .sort((a, b) => a - b);
}

function isMesaQrTableBlocked(restaurant, tableNumber) {
  const meta =
    restaurant && typeof restaurant.metadata === "object" && !Array.isArray(restaurant.metadata)
      ? restaurant.metadata
      : null;
  const blockedTables = normalizeMesaQrBlockedTables(meta?.mesa_qr_blocked_tables, Number(restaurant?.table_count) || 500);
  return blockedTables.includes(Number(tableNumber));
}

const mesaApiServer = http.createServer(async (req, res) => {
  // CORS para el panel web (Vite suele correr en otro puerto).
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  try {
    if (req.method !== "POST") return sendJson(res, 405, { error: "Método no permitido" });

    const url = new URL(req.url || "", `http://${req.headers.host || "localhost"}`);
    const pathName = String(url.pathname || "/").replace(/\/+$/, "") || "/";
    if (
      pathName !== MESA_ORDER_PATH &&
      pathName !== DASHBOARD_PASSWORD_VERIFY_PATH &&
      pathName !== DASHBOARD_PASSWORD_HASH_PATH &&
      pathName !== DASHBOARD_DB_LOGIN_PATH &&
      pathName !== DASHBOARD_STOCK_RECIPE_AI_PATH &&
      pathName !== MAESTRO_CREATE_DEMO_PATH
    ) {
      return sendJson(res, 404, { error: "Not found" });
    }

    let body;
    try {
      body = await readJsonBody(req);
    } catch (parseErr) {
      return sendJson(res, 400, { error: parseErr?.message || "Cuerpo inválido" });
    }
    if (!body || typeof body !== "object") return sendJson(res, 400, { error: "JSON inválido" });

    if (pathName === DASHBOARD_PASSWORD_VERIFY_PATH) {
      const password = String(body.password || "");
      const passwordHash = String(body.passwordHash || "");
      if (!passwordHash) return sendJson(res, 400, { error: "Falta passwordHash" });
      let ok = false;
      try {
        ok = bcrypt.compareSync(password, passwordHash);
      } catch {
        ok = false;
      }
      return sendJson(res, 200, { ok });
    }

    if (pathName === DASHBOARD_PASSWORD_HASH_PATH) {
      const password = String(body.password || "");
      if (password.length < 6) return sendJson(res, 400, { error: "Contraseña demasiado corta" });
      let passwordHash = "";
      try {
        passwordHash = bcrypt.hashSync(password, 10);
      } catch {
        return sendJson(res, 500, { error: "No se pudo generar hash" });
      }
      return sendJson(res, 200, { passwordHash });
    }

    if (pathName === DASHBOARD_DB_LOGIN_PATH) {
      const username = String(body.username || "");
      const password = String(body.password ?? "");
      const ridRaw = body.restaurantId;
      let restaurantId = null;
      if (ridRaw !== null && ridRaw !== undefined && String(ridRaw).trim() !== "") {
        const s = String(ridRaw).trim();
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) {
          return sendJson(res, 400, { ok: false, error: "restaurantId no es un UUID válido." });
        }
        restaurantId = s;
      }
      try {
        const result = await verifyDashboardUserCredentials({ username, password, restaurantId });
        return sendJson(res, 200, result);
      } catch (e) {
        console.error("[mesa-api] db-login", e);
        return sendJson(res, 500, { ok: false, error: e?.message || "Error interno" });
      }
    }

    if (pathName === DASHBOARD_STOCK_RECIPE_AI_PATH) {
      const text = String(body.text || "").trim();
      if (!text) return sendJson(res, 400, { error: "Falta text" });
      try {
        const recipe = await parseRecipeFromText(text);
        return sendJson(res, 200, { recipe });
      } catch (error) {
        return sendJson(res, 500, { error: error?.message || "No se pudo analizar la receta" });
      }
    }

    if (pathName === MAESTRO_CREATE_DEMO_PATH) {
      if (!MAESTRO_PASSWORD_EXPECTED) {
        return sendJson(res, 503, {
          error: "Servidor sin MAESTRO_PASSWORD (o VITE_MAESTRO_PASSWORD) configurada. No se puede provisionar demos."
        });
      }
      const maestroPassword = String(body.maestroPassword || "");
      if (!maestroPassword || maestroPassword !== MAESTRO_PASSWORD_EXPECTED) {
        return sendJson(res, 403, { error: "Contraseña maestro incorrecta." });
      }
      try {
        const result = await createDemoFromTemplate({
          templateRestaurantId: body.templateRestaurantId,
          demoSlug: body.demoSlug,
          demoName: body.demoName,
          expiresDays: body.expiresDays,
          adminUsername: body.adminUsername,
          adminPassword: body.adminPassword,
          demoWhatsappNumber: body.demoWhatsappNumber
        });
        return sendJson(res, 200, result);
      } catch (error) {
        const msg = error?.message || String(error);
        const code = msg.includes("ya existe") ? 409 : 400;
        return sendJson(res, code, { error: msg });
      }
    }

    const restaurantId = body.restaurantId;
    const tableNumberRaw = body.tableNumber;
    const paymentChoiceRaw = body.paymentMethod;
    const items = body.items;
    const mesaToken = body.mesaToken;

    const tableNumber = Number(tableNumberRaw);
    if (!restaurantId) return sendJson(res, 400, { error: "Falta restaurantId" });
    if (!Number.isFinite(tableNumber) || tableNumber < 1) return sendJson(res, 400, { error: "tableNumber inválido" });
    if (!Array.isArray(items) || items.length < 1) return sendJson(res, 400, { error: "items inválidos" });

    const tokenCheck = validateMesaQrToken(restaurantId, tableNumber, mesaToken);
    if (!tokenCheck.ok) return sendJson(res, 403, { error: tokenCheck.error || "Token inválido" });

    const paymentChoice = String(paymentChoiceRaw || "").toLowerCase().trim();
    const wantsCash = paymentChoice === "cash" || paymentChoice === "efectivo";
    const wantsMp = paymentChoice === "mp" || paymentChoice === "mercadopago" || paymentChoice === "mercado_pago";
    if (!wantsCash && !wantsMp) {
      return sendJson(res, 400, { error: "paymentMethod inválido (use 'cash' o 'mp')" });
    }

    const restaurantContext = await getRestaurantContext(restaurantId);
    if (!restaurantContext?.restaurant) return sendJson(res, 404, { error: "Restaurante no encontrado" });

    const { restaurant, menuItems } = restaurantContext;
    const maxTables = maxTablesForRestaurant(restaurantContext.restaurant || restaurant);
    const mesaOk = Number.isFinite(maxTables) && maxTables > 0 ? tableNumber <= maxTables : true;
    if (!mesaOk) return sendJson(res, 400, { error: `Mesa fuera de rango (max ${maxTables}).` });

    // Flags tipo "Maestro": cash/mp deshabilitados no deberían aceptarse.
    const cashEnabled = restaurant.cash_enabled !== false;
    const mpEnabled = restaurant.mercadopago_enabled !== false;
    if (wantsCash && !cashEnabled) return sendJson(res, 409, { error: "Efectivo deshabilitado para este local" });
    if (wantsMp && !mpEnabled) return sendJson(res, 409, { error: "Mercado Pago deshabilitado para este local" });
    if (!isMesaQrModuleEnabled(restaurant)) {
      return sendJson(res, 409, { error: "Carta QR por mesas deshabilitada" });
    }
    if (isMesaQrTableBlocked(restaurant, tableNumber)) {
      return sendJson(res, 409, { error: `La mesa ${tableNumber} está bloqueada para pedidos QR.` });
    }

    const menuByName = new Map();
    for (const mi of menuItems || []) {
      const n = String(mi?.name || "").trim();
      const p = Number(mi?.price || 0);
      if (!n || !Number.isFinite(p) || p <= 0) continue;
      // Asumimos nombres únicos dentro del menú disponible.
      menuByName.set(n, { name: n, price: p });
    }

    // items viene como lista con duplicados (por cantidad).
    const resolvedItems = [];
    let totalAmount = 0;
    for (const it of items) {
      const name =
        typeof it === "string"
          ? String(it || "").trim()
          : String(it?.name || it?.title || "").trim();
      const mi = menuByName.get(name);
      if (!mi) return sendJson(res, 400, { error: `Producto no disponible: ${name}` });
      resolvedItems.push({ name: mi.name, price: mi.price });
      totalAmount += mi.price;
    }

    if (!Number.isFinite(totalAmount) || totalAmount <= 0) {
      return sendJson(res, 400, { error: "Total inválido" });
    }

    const botNumber = String(restaurant.whatsapp_number || "").replace(/\D/g, "") || "0";
    const paymentMethod = wantsCash ? "efectivo_mesa" : "mercadopago";
    const paymentStatus = "pending";
    const nowIso = new Date().toISOString();

    const order = await saveOrder({
      restaurantId,
      customerNumber: "", // evita "teléfono" en dashboard (Se completa para WhatsApp con message.from)
      customerChatId: null,
      botNumber,
      items: resolvedItems,
      notes: `Mesa: ${tableNumber}`,
      status: "confirmed",
      paymentMethod,
      paymentStatus,
      fulfillmentType: "mesa",
      tableNumber,
      totalAmount,
      subtotalAmount: totalAmount,
      rawRequest: null
    });

    // Si eligió MP, generamos link de pago y lo devolvemos para el usuario.
    let paymentLink = null;
    if (wantsMp) {
      const restaurantName = await getRestaurantNameById(restaurantId);
      const paymentUrl = await createPaymentPreference({
        orderId: order.id,
        totalAmount,
        restaurantName
      });

      // Actualizamos el link en DB (para que el poller lo use / la UI lo muestre).
      await updateOrderMatching(
        order.id,
        {
          payment_link: paymentUrl,
          customer_notified_at: nowIso
        },
        { expectStatus: "confirmed", expectPaymentPendingOrNull: true }
      );
      paymentLink = paymentUrl;
    }

    return sendJson(res, 200, { orderId: order.id, paymentLink });
  } catch (err) {
    console.error("[mesa-api]", err);
    const msg = err?.message || String(err || "Error interno");
    if (!res.headersSent) {
      return sendJson(res, 500, { error: msg });
    }
  }
});

mesaApiServer.listen(MESA_API_PORT, "0.0.0.0", () => {
  console.log(
    `[mesa-api] escuchando en puerto ${MESA_API_PORT} · POST ${MESA_ORDER_PATH}, ${MAESTRO_CREATE_DEMO_PATH}, ${DASHBOARD_DB_LOGIN_PATH}, ${DASHBOARD_PASSWORD_VERIFY_PATH}, ${DASHBOARD_STOCK_RECIPE_AI_PATH}`
  );
});

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
closeTime: process.env.BOT_CLOSE_TIME || "05:50",
  openDays: (process.env.BOT_OPEN_DAYS || "1,2,3,4,5,6,7")
    .split(",")
    .map((d) => Number(d.trim()))
    .filter((d) => Number.isFinite(d) && d >= 1 && d <= 7)
};

const DAY_LABELS_ES = ["Lunes", "Martes", "Miercoles", "Jueves", "Viernes", "Sabado", "Domingo"];
const BUSINESS_DAY_ALIASES = {
  lunes: 1,
  lun: 1,
  martes: 2,
  mar: 2,
  miercoles: 3,
  miercole: 3,
  mier: 3,
  mierc: 3,
  jueves: 4,
  jue: 4,
  viernes: 5,
  vie: 5,
  sabado: 6,
  sab: 6,
  domingo: 7,
  dom: 7
};

function stripDiacritics(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function normalizeBusinessHoursText(value) {
  return stripDiacritics(value)
    .toLowerCase()
    .replace(/[|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const DAY_ALIAS_KEYS = Object.keys(BUSINESS_DAY_ALIASES).sort((a, b) => b.length - a.length);
const DAY_ALIAS_REGEX = new RegExp(`\\b(${DAY_ALIAS_KEYS.join("|")})s?\\b`, "g");
const DAY_RANGE_REGEX = new RegExp(
  `\\b(${DAY_ALIAS_KEYS.join("|")})s?\\b\\s*(?:a|al|hasta|-)\\s*\\b(${DAY_ALIAS_KEYS.join("|")})s?\\b`,
  "g"
);

function dayNumberFromAlias(raw) {
  const key = String(raw || "").toLowerCase().trim();
  return BUSINESS_DAY_ALIASES[key] || null;
}

function addDayRange(targetSet, fromDay, toDay) {
  if (!fromDay || !toDay) return;
  if (fromDay <= toDay) {
    for (let d = fromDay; d <= toDay; d += 1) targetSet.add(d);
    return;
  }
  for (let d = fromDay; d <= 7; d += 1) targetSet.add(d);
  for (let d = 1; d <= toDay; d += 1) targetSet.add(d);
}

function parseOpenDaysFromOpeningHours(rawText) {
  const text = normalizeBusinessHoursText(rawText);
  if (!text) return null;
  if (/\btodos?\s+los?\s+dias\b/.test(text)) return [1, 2, 3, 4, 5, 6, 7];

  const openSet = new Set();
  DAY_RANGE_REGEX.lastIndex = 0;
  let rangeMatch = DAY_RANGE_REGEX.exec(text);
  while (rangeMatch) {
    const fromDay = dayNumberFromAlias(rangeMatch[1]);
    const toDay = dayNumberFromAlias(rangeMatch[2]);
    addDayRange(openSet, fromDay, toDay);
    rangeMatch = DAY_RANGE_REGEX.exec(text);
  }

  DAY_ALIAS_REGEX.lastIndex = 0;
  let singleMatch = DAY_ALIAS_REGEX.exec(text);
  while (singleMatch) {
    const dayNum = dayNumberFromAlias(singleMatch[1]);
    if (dayNum) openSet.add(dayNum);
    singleMatch = DAY_ALIAS_REGEX.exec(text);
  }

  const closedSet = new Set();
  for (const dayAlias of DAY_ALIAS_KEYS) {
    const reA = new RegExp(`\\b${dayAlias}s?\\b[^.\\n\\r]{0,24}\\bcerrad`, "i");
    const reB = new RegExp(`\\bcerrad[^.\\n\\r]{0,24}\\b${dayAlias}s?\\b`, "i");
    if (reA.test(text) || reB.test(text)) {
      const dayNum = dayNumberFromAlias(dayAlias);
      if (dayNum) closedSet.add(dayNum);
    }
  }
  for (const dayNum of closedSet) openSet.delete(dayNum);

  const out = [...openSet].sort((a, b) => a - b).filter((d) => d >= 1 && d <= 7);
  return out.length ? out : null;
}

function parseBusinessHoursFromOpeningHours(rawText) {
  const text = normalizeBusinessHoursText(rawText);
  if (!text) return null;

  const timeMatches = [...text.matchAll(/\b([01]?\d|2[0-3])[:.]([0-5]\d)\b/g)];
  if (timeMatches.length < 2) return null;
  const openTime = `${String(timeMatches[0][1]).padStart(2, "0")}:${timeMatches[0][2]}`;
  const closeTime = `${String(timeMatches[1][1]).padStart(2, "0")}:${timeMatches[1][2]}`;

  const parsedDays = parseOpenDaysFromOpeningHours(text);
  const openDays = parsedDays?.length ? parsedDays : BUSINESS_HOURS.openDays;

  return {
    timezone: BUSINESS_HOURS.timezone,
    openTime,
    closeTime,
    openDays
  };
}

function parseBusinessHoursFromMetadata(tenant) {
  const raw = tenant?.metadata?.business_hours;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;

  const openDays = [...new Set((Array.isArray(raw.open_days) ? raw.open_days : []).map(Number))]
    .filter((day) => day >= 1 && day <= 7)
    .sort((a, b) => a - b);
  const openTime = String(raw.open_time || "").trim();
  const closeTime = String(raw.close_time || "").trim();

  if (
    !openDays.length ||
    !/^([01]\d|2[0-3]):[0-5]\d$/.test(openTime) ||
    !/^([01]\d|2[0-3]):[0-5]\d$/.test(closeTime)
  ) {
    return null;
  }

  return {
    timezone: BUSINESS_HOURS.timezone,
    openTime,
    closeTime,
    openDays
  };
}

function businessHoursForTenant(tenant) {
  const fromMetadata = parseBusinessHoursFromMetadata(tenant);
  if (fromMetadata) return fromMetadata;
  const parsed = parseBusinessHoursFromOpeningHours(tenant?.opening_hours);
  return parsed || BUSINESS_HOURS;
}

/** Si es false en `restaurants.metadata.bot_whatsapp_enabled`, el bot no responde ni registra (silencio total). */
function tenantBotWhatsappEnabled(tenant) {
  const m = tenant?.metadata;
  if (m == null || typeof m !== "object" || Array.isArray(m)) return true;
  if (m.bot_whatsapp_enabled === false) return false;
  return true;
}

/** Si es false en `restaurants.metadata.bot_enforce_opening_hours`, no se corta fuera de horario (solo si el bot está ON). */
function tenantEnforcesOpeningHours(tenant) {
  const m = tenant?.metadata;
  if (m == null || typeof m !== "object" || Array.isArray(m)) return true;
  if (m.bot_enforce_opening_hours === false) return false;
  return true;
}

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

/**
 * Devuelve el telefono real del cliente para que el repartidor pueda
 * llamarlo/WhatsAppearlo. Prueba multiples metodos de whatsapp-web.js para
 * sortear los casos `@lid` (privacidad de numero activada). Si nada funciona,
 * devuelve null y loggea con detalle para diagnostico.
 *
 * Heuristica de "es telefono valido": entre 8 y 14 digitos. Los LIDs suelen
 * tener 15+ digitos sin estructura de pais; con esa cota descartamos LIDs.
 */
function looksLikePhoneDigits(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length < 8 || digits.length > 14) return null;
  return digits;
}

async function resolveCustomerPhone(message, waClient) {
  const from = String(message?.from || "");
  if (!from) return null;

  if (from.endsWith("@c.us")) {
    const digits = normalizeNumber(from.split("@")[0]);
    return looksLikePhoneDigits(digits);
  }

  const attempts = [];
  let contact = null;

  try {
    if (typeof message?.getContact === "function") {
      contact = await message.getContact();
      attempts.push({
        source: "message.getContact",
        number: contact?.number ?? null,
        idUser: contact?.id?.user ?? null,
        idServer: contact?.id?.server ?? null,
        idSerialized: contact?.id?._serialized ?? null,
        pushname: contact?.pushname ?? null,
        verifiedName: contact?.verifiedName ?? null,
        shortName: contact?.shortName ?? null
      });
    }
  } catch (err) {
    attempts.push({ source: "message.getContact", error: String(err?.message || err) });
  }

  if (waClient) {
    try {
      if (typeof waClient.getContactById === "function") {
        const c2 = await waClient.getContactById(from);
        attempts.push({
          source: "client.getContactById(from)",
          number: c2?.number ?? null,
          idUser: c2?.id?.user ?? null,
          idServer: c2?.id?.server ?? null,
          idSerialized: c2?.id?._serialized ?? null
        });
        if (!contact) contact = c2;
      }
    } catch (err) {
      attempts.push({ source: "client.getContactById(from)", error: String(err?.message || err) });
    }

    try {
      if (typeof waClient.getNumberId === "function") {
        const numericPart = from.split("@")[0];
        const probe = await waClient.getNumberId(numericPart);
        attempts.push({
          source: "client.getNumberId(numericPart)",
          serialized: probe?._serialized ?? null,
          user: probe?.user ?? null
        });
        const ser = probe?._serialized || "";
        if (ser.endsWith("@c.us")) {
          const digits = looksLikePhoneDigits(ser.split("@")[0]);
          if (digits) {
            console.log("[resolveCustomerPhone] resolved via getNumberId", { from, digits });
            return digits;
          }
        }
      }
    } catch (err) {
      attempts.push({ source: "client.getNumberId(numericPart)", error: String(err?.message || err) });
    }
  }

  const candidates = [
    contact?.number,
    contact?.id?._serialized?.endsWith("@c.us") ? contact.id._serialized.split("@")[0] : null,
    contact?.id?.user
  ];
  for (const cand of candidates) {
    const digits = looksLikePhoneDigits(cand);
    if (digits) {
      console.log("[resolveCustomerPhone] resolved", { from, digits, attempts });
      return digits;
    }
  }

  console.log("[resolveCustomerPhone] no phone found", { from, attempts });
  return null;
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

/**
 * Detecta saludos "puros" (texto que es solo un saludo, sin pregunta concreta
 * adentro). Si matchea, lo respondemos con texto fijo usando los datos del
 * restaurante activo y NO se llama al modelo IA. Ahorra tokens en el caso mas
 * comun de mensaje sin intencion clara.
 *
 * Casos que matchean:  "hola", "Buenas!!", "buenos dias", "che", "que tal"
 * Casos que NO matchean: "hola, tienen pizza?", "buenas, hacen delivery a X"
 */
const GREETING_REGEX =
  /^(hola+|holis|holi|holaaa+|holu|buen[oa]s?|buen[oa]s\s+d[ií]as?|buen\s+d[ií]a|buenas\s+tardes|buenas\s+noches|que\s*tal|qu[eé]\s*tal|hey+|hi|hello|saludos|che)\b[\s!.?¡¿]*$/i;

/** "hola buenas", "hey buenas", etc.: saludo compuesto sin pedido (sin gastar IA). */
const GREETING_TWO_WORD_REGEX =
  /^(hola|hol[au]|hey|buen[oa]s|qu[eé]\s*tal)\s+(buen[oa]s|tardes|noches|d[ií]as?|che)\b[\s!.?¡¿]*$/i;

function isPureGreeting(text) {
  const t = String(text || "").trim();
  if (!t || t.length > 40) return false;
  if (GREETING_REGEX.test(t)) return true;
  if (GREETING_TWO_WORD_REGEX.test(t)) return true;
  return false;
}

/**
 * Construye la respuesta de saludo usando el nombre publico del restaurante
 * configurado en el dashboard (`restaurants.public_name`, fallback a `name`).
 * No llama a OpenAI: cero tokens.
 */
function buildGreetingReply(restaurantContext) {
  const botName = resolveBotDisplayName();
  const brandName = resolvePublicBrandName(restaurantContext);
  return [
    `*${botName} · ${brandName}*`,
    "",
    `¡Hola! Soy ${botName}, asistente de ${brandName}.`,
    `Escribime *menú* para ver los productos disponibles o decime directamente qué querés pedir.`
  ].join("\n");
}

/**
 * Pre-filtro local: descarta mensajes que claramente NO son direcciones para
 * evitar pagar una llamada de IA. Cubre saludos, opciones numericas, "ok",
 * "menu", etc. Si pasa este filtro, recien ahi consideramos llamar al detector.
 */
const NON_ADDRESS_SHORT_TOKENS = new Set([
  "hola", "holaa", "buenas", "ok", "okk", "okey", "dale", "si", "sí", "sii", "no",
  "noo", "gracias", "menu", "menú", "combos", "pizzas", "bebidas", "cancelar",
  "salir", "stop", "fin", "ya", "listo", "perfecto", "genial", "claro", "bueno"
]);
function looksLikeAddressCandidate(text) {
  const t = String(text || "").trim().toLowerCase();
  if (t.length < 6) return false;
  if (/^\d+$/.test(t)) return false;
  if (NON_ADDRESS_SHORT_TOKENS.has(t)) return false;
  const hasNumber = /\d/.test(t);
  const hasStreetWord =
    /(calle|av\.?|avenida|pasaje|pasillo|ruta|n[º°]|piso|depto|dpto|barrio|villa|manzana|km|esquina|frente|cerca|al lado|entre)/i.test(
      t
    );
  const hasStreetLikeName = /\b[a-z]{4,}\s+\d{1,5}\b/i.test(t);
  return hasNumber || hasStreetWord || hasStreetLikeName;
}

/**
 * Decide si conviene llamar a `detectAddressIntent` (call IA) considerando el
 * estado de la sesion del cliente. Reduce ~80% las llamadas al detector.
 */
function shouldRunAddressDetection(session, text) {
  // Pickup en local o pedido en mesa: jamas necesitamos detectar direccion.
  const ft = String(session?.fulfillmentType || "").toLowerCase();
  if (ft === "local" || ft === "mesa") return false;
  // Si la sesion ya tiene una direccion confirmada, no la sobreescribas en cada mensaje.
  if (session?.deliveryAddress && String(session.deliveryAddress).trim().length >= 8) {
    return false;
  }
  // Si el flujo es delivery sin direccion: vale la pena solo si parece direccion.
  if (session?.fulfillmentType === "delivery") {
    return looksLikeAddressCandidate(text);
  }
  // Sin estado claro: solo si el mensaje pasa la heuristica.
  return looksLikeAddressCandidate(text);
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
  mesa: [
    "mesa",
    "en la mesa",
    "en mi mesa",
    "pedido a mesa",
    "pedir a mesa",
    "para la mesa",
    "comer aca",
    "comer acá",
    "en el salon",
    "en el salón",
    "salon",
    "salón"
  ],
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
    tableNumber: "",
    conversationText: "",
    lastActivityAt: Date.now(),
    /** `{ type, mode, candidates, createdAt }` para confirmar pedido tras sugerencia fuzzy. */
    pendingClarification: null,
    /** `{ filling: 'carne'|'pollo', createdAt }` cuando falta aclarar docena vs media docena. */
    pendingEmpanadaChoice: null,
    /** `{ normBase, baseRaw, createdAt }` cuando falta aclarar 1 vs 2 personas en platos con sufijo en menú. */
    pendingPersonPortionChoice: null
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
const CHECKOUT_STATUSES = [
  "awaiting_add_more",
  "awaiting_fulfillment",
  "awaiting_address",
  "awaiting_table_number",
  "awaiting_payment"
];

function sessionIsEmpty(session) {
  if (!session) return true;
  if (session.status && session.status !== "browsing") return false;
  if (Number(session.totalAmount) > 0) return false;
  if (Array.isArray(session.items) && session.items.length > 0) return false;
  return true;
}

/** `created_at` de la fila en interactions (ISO). Sirve para TTL al rehidratar. */
function parseInteractionCreatedAtMs(turn) {
  const raw = turn?.created_at;
  if (!raw) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Rehidrata checkout desde DB solo si el ultimo guardado con estado activo
 * no supera CHECKOUT_SESSION_TTL_MS. Asi un pedido colgado del dia anterior
 * no reaparece al reiniciar el proceso ni al volver a escribir horas despues.
 */
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

    // Si en este turno el cliente canceló el pedido, no rehidratamos desde
    // turnos anteriores: la sesion arranca limpia. Sin esto, la rehidratacion
    // saltea el turno de cancelacion (status=browsing) y resucita el carrito
    // viejo del turno previo (awaiting_add_more con los items).
    if (meta.checkoutCancelled === true) {
      return session;
    }

    const totalAmount = Number(meta.totalAmount || 0);
    const items = Array.isArray(meta.items) ? meta.items.filter(Boolean) : [];
    const details = String(meta.details || "").trim();

    /**
     * Estados con checkout activo. Incluye `browsing` solo si el metadata trae carrito:
     * tras "1" (agregar más) se guardaba status browsing y rehidratar ignoraba ese turno,
     * perdiendo items al reiniciar el proceso o al vaciar RAM antes del siguiente producto.
     */
    const checkoutLike =
      CHECKOUT_STATUSES.includes(meta.status) ||
      (meta.status === "browsing" && (totalAmount > 0 || items.length > 0));
    if (!checkoutLike) continue;

    if (!totalAmount && !items.length) continue;

    const createdMs = parseInteractionCreatedAtMs(turn);
    if (createdMs == null) {
      continue;
    }
    if (Date.now() - createdMs > CHECKOUT_SESSION_TTL_MS) {
      return session;
    }

    session.status =
      meta.status === "browsing" && (totalAmount > 0 || items.length > 0)
        ? "awaiting_add_more"
        : meta.status;
    session.totalAmount = totalAmount;
    session.details = details || items.join(", ");
    session.items = items.length ? items : details ? [details] : [];
    session.fulfillmentType = meta.fulfillmentType || session.fulfillmentType || "";
    session.deliveryAddress = meta.deliveryAddress || session.deliveryAddress || "";
    session.tableNumber =
      meta.tableNumber != null && meta.tableNumber !== ""
        ? meta.tableNumber
        : session.tableNumber || "";
    session.lastActivityAt = createdMs;
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
  /** Solo si ya hay URL real; "te envío el link" (instrucción previa) no debe disparar esto. */
  if (
    (t.includes("http://") || t.includes("https://")) &&
    (t.includes("mercadopago") || t.includes("mercado pago") || t.includes("mercadolibre"))
  ) {
    return true;
  }
  if (t.includes("init_point")) return true;
  if (t.includes("registramos tu pedido")) return true;
  if (t.includes("equipo lo prepara y te lo acerca")) return true;
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
  return [
    "awaiting_payment",
    "awaiting_fulfillment",
    "awaiting_add_more",
    "awaiting_address",
    "awaiting_table_number"
  ].includes(session.status);
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
    tableNumber: session?.tableNumber ?? "",
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

/**
 * Texto en `orders.notes` para pedidos del cliente (WhatsApp): solo dato operativo.
 * El detalle de productos queda en la columna `items` (JSON).
 */
function paymentMethodLabelForOperationalNotes(paymentMethod) {
  const p = String(paymentMethod || "").toLowerCase();
  if (p.includes("mercado") || p === "mp" || p === "mercadopago") return "Mercado Pago";
  if (p.includes("efectivo") || p === "cash") return "Efectivo al recibir";
  return String(paymentMethod || "").trim() || "—";
}

function buildCustomerOperationalNotes({
  fulfillmentType,
  address,
  customerPhone,
  paymentMethod,
  tableNumber
}) {
  const ft = String(fulfillmentType || "").toLowerCase();
  if (ft === "delivery") {
    const addr = String(address || "").trim();
    return `Dirección: ${addr || "—"} | Pago: ${paymentMethodLabelForOperationalNotes(paymentMethod)}`;
  }
  const ph = String(customerPhone || "").replace(/\D/g, "");
  if (ft === "mesa") {
    const tn = Number(tableNumber);
    const mesaLabel = Number.isFinite(tn) ? String(tn) : "—";
    return `Mesa: ${mesaLabel} | Teléfono: ${ph || "—"} | Pago: ${paymentMethodLabelForOperationalNotes(paymentMethod)}`;
  }
  if (ft === "local") {
    return `Teléfono: ${ph || "—"} | Retiro en local | Pago: ${paymentMethodLabelForOperationalNotes(paymentMethod)}`;
  }
  return "";
}

const DELIVERY_PENDING_FEE_MESSAGE =
  "Gracias. Tu pedido quedó registrado con delivery a domicilio. " +
  "El costo de envío lo confirma el local en unos minutos. " +
  "En cuanto lo tengamos te enviamos el total en pesos argentinos (ARS) y los datos para pagar o el link de Mercado Pago. " +
  "Si no recibís nada en un rato, escribinos de nuevo por acá.";

/**
 * Tras enviar ticket con envío + efectivo: el cliente debe confirmar el total antes de dar por cerrado el pedido.
 * `accept` | `reject` | `unknown`
 */
function detectDeliveryTotalConfirmationIntent(rawText) {
  const trimmed = String(rawText || "").trim();
  if (!trimmed) return "unknown";
  const lower = trimmed.toLowerCase();

  if (/\bno\s+me\s+parece\s+caro\b/i.test(lower) || /\bno\s+est[aá]\s+car[oa]\b/i.test(lower)) {
    return "accept";
  }
  if (/\bme\s+parece\s+(un\s+poco\s+)?car[oa]\b/i.test(lower)) return "reject";
  if (/\b(muy|demasiado|re)\s+car[oa]\b/i.test(lower)) return "reject";
  if (/\b(poco|bastante)\s+car[oa]\b/i.test(lower)) return "reject";
  if (/^no(\s+gracias)?$/i.test(trimmed)) return "reject";
  if (/^no\b/i.test(trimmed) && trimmed.length < 52) return "reject";
  if (/\bno\s+quiero\b/i.test(lower)) return "reject";
  if (/\bcancel(ar|o|á)\b/i.test(lower)) return "reject";

  if (/^(1|sí|si|dale|ok|okey|confirmo|confirmar|adelante|genial|perfecto|listo|va)\b/i.test(trimmed))
    return "accept";
  if (/^2\s*[!?.¡¿]*$/i.test(trimmed)) return "reject";
  if (/\b(está|esta)\s+bien\b/i.test(lower)) return "accept";
  if (/\bde\s+acuerdo\b/i.test(lower)) return "accept";
  if (/\bsí\s*,?\s*quiero\b/i.test(lower) || /\bsi\s*,?\s*quiero\b/i.test(lower)) return "accept";
  if (/\bconfirm(o|amos)?\s+(el\s+)?pedido\b/i.test(lower)) return "accept";

  return "unknown";
}

async function handleCustomerDeliveryTotalConfirmation({
  trimmedText,
  order,
  tenant,
  customerNumber,
  botNumber
}) {
  const intent = detectDeliveryTotalConfirmationIntent(trimmedText);
  if (intent === "unknown") {
    const ask =
      "Necesito una respuesta clara para seguir.\n" +
      "¿Confirmás el pedido con el total que te envié (incluye envío)?\n" +
      "Respondé *SÍ* para confirmar o *NO* para cancelar el pedido.";
    await saveInteraction({
      restaurantId: tenant.id,
      customerNumber,
      botNumber,
      messageType: "text",
      userMessage: trimmedText,
      botResponse: ask,
      metadata: {
        orderId: order.id,
        awaitingDeliveryTotalClarify: true
      }
    });
    return ask;
  }

  if (intent === "reject") {
    const updated = await updateOrderMatching(
      order.id,
      {
        status: "cancelled",
        payment_status: "cancelled",
        cancelled_at: new Date().toISOString()
      },
      { expectStatus: "awaiting_delivery_total_confirm" }
    );
    if (!updated) {
      const gone =
        "Ese pedido ya no está pendiente de confirmación. Si necesitás ayuda, escribí *menú* o lo que quieras pedir.";
      await saveInteraction({
        restaurantId: tenant.id,
        customerNumber,
        botNumber,
        messageType: "text",
        userMessage: trimmedText,
        botResponse: gone,
        metadata: { orderId: order.id, orderAlreadyClosed: true }
      });
      return gone;
    }
    const cancelReply =
      "Listo, *cancelamos el pedido*. Si más adelante querés volver a pedir, escribinos cuando quieras.";
    await saveInteraction({
      restaurantId: tenant.id,
      customerNumber,
      botNumber,
      messageType: "text",
      userMessage: trimmedText,
      botResponse: cancelReply,
      metadata: {
        orderId: order.id,
        customerRejectedDeliveryTotal: true,
        summaryForRestaurant: "El cliente no aceptó el total del pedido con delivery; pedido cancelado."
      }
    });
    return cancelReply;
  }

  const refreshedNotes = buildCustomerOperationalNotes({
    fulfillmentType: order.fulfillment_type || "delivery",
    address: order.address,
    customerPhone: order.customer_phone || order.customer_number,
    paymentMethod: order.payment_method
  });
  const confirmedAt = new Date().toISOString();
  const updated = await updateOrderMatching(
    order.id,
    {
      status: "confirmed",
      payment_status: "pending",
      notes: refreshedNotes,
      delivery_total_confirmed_at: confirmedAt
    },
    { expectStatus: "awaiting_delivery_total_confirm" }
  );
  if (!updated) {
    const gone =
      "Ese pedido ya fue confirmado o actualizado. Si tenés dudas, contactá al local o escribí *menú* para un pedido nuevo.";
    await saveInteraction({
      restaurantId: tenant.id,
      customerNumber,
      botNumber,
      messageType: "text",
      userMessage: trimmedText,
      botResponse: gone,
      metadata: { orderId: order.id, orderAlreadyClosed: true }
    });
    return gone;
  }
  const acceptReply =
    "Perfecto. *Confirmamos tu pedido* con pago en *efectivo* al recibir. " +
    "El local recibió tu confirmación y sigue con el pedido. ¡Gracias!";
  await saveInteraction({
    restaurantId: tenant.id,
    customerNumber,
    botNumber,
    messageType: "text",
    userMessage: trimmedText,
    botResponse: acceptReply,
    metadata: {
      orderId: order.id,
      customerAcceptedDeliveryTotal: true,
      summaryForRestaurant: "El cliente acepta el precio del pedido con delivery (efectivo al recibir)."
    }
  });
  return acceptReply;
}

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

/** Si `delivery_enabled` es false en BD, el bot solo ofrece retiro en local. Valores null/undefined cuentan como habilitado. */
function isRestaurantDeliveryEnabled(restaurantOrTenant) {
  const r = restaurantOrTenant || {};
  return r.delivery_enabled !== false;
}

function isRestaurantLocalEnabled(restaurantOrTenant) {
  const r = restaurantOrTenant || {};
  return r.local_enabled !== false;
}

function isRestaurantMesaEnabled(restaurantOrTenant) {
  const r = restaurantOrTenant || {};
  return r.mesa_enabled !== false;
}

function isRestaurantCashEnabled(restaurantOrTenant) {
  const r = restaurantOrTenant || {};
  return r.cash_enabled !== false;
}

function isRestaurantMercadoPagoEnabled(restaurantOrTenant) {
  const r = restaurantOrTenant || {};
  return r.mercadopago_enabled !== false;
}

function hasAnyEnabledPaymentMethod(tenant) {
  return isRestaurantCashEnabled(tenant) || isRestaurantMercadoPagoEnabled(tenant);
}

function noPaymentMethodAvailableReply() {
  return "No estoy disponible para cobrar en este momento. Intentá de nuevo más tarde.";
}

function getEnabledFulfillmentTypes(tenant) {
  const enabled = [];
  if (isRestaurantDeliveryEnabled(tenant)) enabled.push("delivery");
  if (isRestaurantLocalEnabled(tenant)) enabled.push("local");
  if (isRestaurantMesaEnabled(tenant)) enabled.push("mesa");
  return enabled;
}

function hasAnyEnabledFulfillment(tenant) {
  return getEnabledFulfillmentTypes(tenant).length > 0;
}

function noServiceAvailableReply() {
  return "No estoy disponible con ningún servicio por el momento. Intentá de nuevo más tarde.";
}

/** Mesas numeradas del salón (WhatsApp modalidad mesa). Por defecto 12 si no hay columna o valor inválido. */
function maxTablesForRestaurant(tenant) {
  const n = Number(tenant?.table_count);
  // Evita configuraciones accidentales (1-2) que bloquean casi todos los números de mesa.
  if (Number.isFinite(n) && n >= 3 && n <= 500) return Math.floor(n);
  return 12;
}

function askTableNumberPrompt(tenant) {
  const max = maxTablesForRestaurant(tenant);
  return `¿En qué mesa estás? Escribí solo el número (del 1 al ${max}).`;
}

function parseTableNumberInput(trimmedText, maxTables) {
  const normalized = String(trimmedText || "").trim();
  // Acepta "5" y tambien frases como "mesa 5" o "estoy en la 5".
  const m = normalized.match(/\b(\d{1,3})\b/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  if (!Number.isFinite(n) || n < 1 || n > maxTables) return null;
  return n;
}

function buildFulfillmentQuestion(totalAmount, tenant) {
  const options = [];
  if (isRestaurantDeliveryEnabled(tenant)) options.push("Delivery (envío a domicilio)");
  if (isRestaurantLocalEnabled(tenant)) options.push("Retiro en el local (pasás a buscarlo)");
  if (isRestaurantMesaEnabled(tenant)) options.push("Pedido en mesa (en el salón)");
  if (!options.length) return noServiceAvailableReply();
  const lines = options.map((label, i) => `${i + 1}. ${label}`).join("\n");
  return `¡Recibido! El total de tu pedido es ${formatTotal(totalAmount)}. ¿Cómo querés el pedido?\n${lines}`;
}

function buildPaymentQuestion(details, totalAmount, fulfillmentType, tenant) {
  const head = `¡Recibido! El total por ${details} es ${formatTotal(totalAmount)}.`;
  const ft = String(fulfillmentType || "").toLowerCase();
  const cashEnabled = isRestaurantCashEnabled(tenant);
  const mpEnabled = isRestaurantMercadoPagoEnabled(tenant);
  if (!cashEnabled && !mpEnabled) return noPaymentMethodAvailableReply();
  const paymentOptions = [];
  if (cashEnabled) {
    paymentOptions.push(ft === "mesa" ? "1. Efectivo en la mesa" : "1. Efectivo al retirar");
  }
  if (mpEnabled) {
    paymentOptions.push("2. Mercado Pago");
  }
  const hints = [];
  if (mpEnabled) hints.push("*mercado pago*");
  if (cashEnabled) hints.push("*efectivo*");
  const hintText = hints.length ? `\n\nTambién podés escribir ${hints.join(" o ")}.` : "";
  if (ft === "local") {
    return `${head}\n\n¿Cómo preferís pagar?\n${paymentOptions.join("\n")}${hintText}`;
  }
  if (ft === "mesa") {
    return `${head}\n\n¿Cómo preferís pagar?\n${paymentOptions.join("\n")}${hintText}`;
  }
  const deliveryOptions = [];
  if (cashEnabled) deliveryOptions.push("1. Efectivo al recibir");
  if (mpEnabled) deliveryOptions.push("2. Mercado Pago");
  return `${head} ¿Cómo preferís pagar?\n${deliveryOptions.join("\n")}`;
}

function buildAddMoreQuestion(details, totalAmount) {
  return `Perfecto, llevo en tu pedido: ${details} (total ${formatTotal(
    totalAmount
  )}). ¿Querés agregar algo más?\n1. Sí, agregar más productos\n2. No, continuar`;
}

function formatOrderDetailsForDisplay(items, fallbackDetails) {
  const names = (Array.isArray(items) ? items : [])
    .map((n) => {
      if (typeof n === "string") return String(n || "").trim();
      if (n && typeof n === "object") return String(n.name || n.title || "").trim();
      return "";
    })
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

function withItemPrices(items, menuItems) {
  const priceByName = new Map(
    (Array.isArray(menuItems) ? menuItems : [])
      .map((mi) => {
        const name = String(mi?.name || "").trim();
        const price = Number(mi?.price);
        return [name, price];
      })
      .filter(([name, price]) => name && Number.isFinite(price) && price > 0)
  );

  const out = [];
  for (const raw of Array.isArray(items) ? items : []) {
    const name =
      typeof raw === "string"
        ? String(raw || "").trim()
        : String(raw?.name || raw?.title || "").trim();
    if (!name) continue;
    const price = priceByName.get(name);
    if (!Number.isFinite(price) || price <= 0) continue;
    out.push({ name, price });
  }
  return out;
}

/** Palabras que empiezan como "carta" pero no son pedido de menú (evita falsos positivos en fuzzy). */
const MENU_FUZZY_BLOCKLIST = new Set([
  "cartera",
  "carteras",
  "cartero",
  "carters",
  "cartel",
  "carteles",
  "carton",
  "cartones",
  "cartucho",
  "cartuchos"
]);

/** Errores ortográficos y jerga habitual por los que el cliente pide ver menú/carta. */
const MENU_REQUEST_TYPO_WHITELIST = new Set([
  "cartola",
  "cartaa",
  "cartta",
  "kartaa",
  "karta",
  "qarta",
  "menuu",
  "menuuu",
  "meni",
  "munu",
  "catalogo",
  "listin",
  "listín",
  "kmenu",
  "qmenu",
  "mcarta",
  "lacarta",
  "lamenu",
  "lamenuu"
]);

function levenshteinDistance(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i += 1) dp[i][0] = i;
  for (let j = 0; j <= n; j += 1) dp[0][j] = j;
  for (let i = 1; i <= m; i += 1) {
    for (let j = 1; j <= n; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[m][n];
}

/**
 * True si el texto pide ver menú/carta y debe responderse SIEMPRE con el listado en base (`buildMenuLinesForWhatsApp`),
 * sin pasar por la IA. Incluye errores de tipeo y formas coloquiales cercanas a "menu"/"carta".
 */
function wantsMenuList(text) {
  const t = normalizeTextForMatch(text).replace(/\s+/g, " ").trim();
  if (!t) return false;

  if (
    t.includes("menu") ||
    t.includes("menú") ||
    t.includes("carta") ||
    t.includes("lista de productos") ||
    t.includes("lista de precios") ||
    t.includes("que tienen") ||
    t.includes("que hay") ||
    /\b(cat[aá]logo|catalogo)\b/.test(t) ||
    /\bopciones?\s+para\s+comer\b/.test(t) ||
    /\bver\s+(los\s+)?precios\b/.test(t)
  ) {
    return true;
  }

  const compact = t.replace(/[^a-z0-9ñ]/g, "");
  if (
    compact.includes("menu") ||
    compact.includes("menú") ||
    compact.includes("carta") ||
    compact.includes("catalogo")
  ) {
    return true;
  }

  const tokens = t.split(/[^a-z0-9ñ]+/).filter((w) => w.length >= 3);
  for (const raw of tokens) {
    const w = normalizeTextForMatch(raw);
    if (MENU_REQUEST_TYPO_WHITELIST.has(w)) return true;
    if (MENU_FUZZY_BLOCKLIST.has(w)) continue;
    // Fuzzy solo con prefijo para no confundir con "mesa", "mensaje", etc.
    if (w.startsWith("cart") && w.length <= 9 && levenshteinDistance(w, "carta") <= 2) return true;
    if (w.startsWith("men") && w.length <= 6 && levenshteinDistance(w, "menu") <= 2) return true;
  }

  return false;
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

function extractUnavailableProductName(text, menuItems = []) {
  if (findMentionedMenuItem(text, menuItems)) return "";
  const t = normalizeTextForMatch(text).replace(/\s+/g, " ").trim();
  if (!t) return "";

  const patterns = [
    /^\s*no\s+hay\s+(.+?)\s*[?!.]*$/,
    /^\s*(?:hay|tenes|tienes|tienen|venden)\s+(.+?)\s*[?!.]*$/
  ];
  let candidate = "";
  for (const re of patterns) {
    const m = t.match(re);
    if (m && m[1]) {
      candidate = m[1];
      break;
    }
  }
  if (!candidate) return "";

  candidate = candidate
    .replace(/^(de|del)\s+/, "")
    .replace(/^(un|una|unos|unas|el|la|los|las)\s+/, "")
    .replace(/\b(por favor|x fa|xfa)\b/g, "")
    .replace(/[?!.]+$/g, "")
    .trim();

  if (!candidate || candidate.length < 2 || candidate.length > 40) return "";
  if (/\b(menu|carta|delivery|retiro|mesa|mercado pago|efectivo|pedido)\b/.test(candidate)) return "";
  return candidate;
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
  const brand = resolvePublicBrandName({ restaurant: tenant || {} });
  const bot = resolveBotDisplayName();
  const header = `*${bot} · ${brand}*\n\n`;
  const valid = (menuItems || []).filter((item) => {
    const category = String(item?.category || "").trim();
    return (
      Number(item?.price) > 0 &&
      String(item?.name || "").trim() &&
      !shouldHideMenuCategoryOnWhatsApp(category)
    );
  });
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
  const byCategory = new Map();
  for (const item of valid) {
    const category = formatMenuCategoryHeading(item.category);
    if (!byCategory.has(category)) byCategory.set(category, []);
    byCategory.get(category).push(item);
  }

  const sections = Array.from(byCategory.entries())
    .sort((a, b) =>
      String(a[0]).localeCompare(String(b[0]), "es", { sensitivity: "base", numeric: true })
    )
    .map(([category, items]) => {
      const lines = [...items]
        .sort((a, b) =>
          String(a?.name || "").localeCompare(String(b?.name || ""), "es", {
            sensitivity: "base",
            numeric: true
          })
        )
        .map((item) => `- ${item.name} (${formatTotal(item.price)})`);
      return [`*${category}*`, ...lines].join("\n");
    });

  const intro = sectionKey
    ? `Aqui tenes la seccion *${sectionLabel}*:\n\n${sections.join("\n\n")}`
    : `Aqui tienes el menu disponible:\n\n${sections.join("\n\n")}`;
  return `${header}${intro}`;
}

function detectFulfillmentIntent(text) {
  if (hasAnyPhrase(text, INTENT_PHRASES.delivery)) return "delivery";
  if (hasAnyPhrase(text, INTENT_PHRASES.mesa)) return "mesa";
  if (hasAnyPhrase(text, INTENT_PHRASES.local)) return "local";
  return null;
}

function normalizeTextForMatch(text) {
  return (text || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function shouldHideMenuCategoryOnWhatsApp(category) {
  const normalized = normalizeTextForMatch(String(category || "").trim());
  if (!normalized) return false;
  return normalized.includes("calle") || normalized.includes("llevar");
}

function formatMenuCategoryHeading(category) {
  const raw = String(category || "").trim() || "OTROS";
  return raw.toLocaleUpperCase("es-AR");
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
  "dale",
  /** Entre cantidad y nombre del producto ("3 combos de pizza con gaseosa"). */
  "combo",
  "combos",
  "menu",
  "pack",
  "packs",
  "paquete",
  "paquetes",
  "plato",
  "platos",
  "porcion",
  "porciones",
  "unidad",
  "unidades",
  "uds",
  "ud"
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

  const normByItem = new Map();
  const normStrings = [];
  for (const item of sortedMenu) {
    const norm = normalizeForItemMatch(item.name);
    normByItem.set(item, norm);
    normStrings.push(norm);
  }

  const firstTokens = normStrings.map((n) => (n.split(/\s+/).filter(Boolean)[0] || "").trim());
  function firstTokenIsUniqueInMenu(token) {
    if (!token || token.length < 4) return false;
    return firstTokens.filter((t) => t === token).length === 1;
  }

  /**
   * Ademas del nombre completo, si la primera palabra del producto es unica en el menu
   * (ej. solo un item empieza con "conito"), permitimos pedidos abreviados: "3 conitos"
   * sin repetir "conito de papas y pancho" caractero por caracter.
   */
  const patternEntries = [];
  for (const item of sortedMenu) {
    const norm = normByItem.get(item);
    patternEntries.push({ item, pattern: norm });
    const fw = norm.split(/\s+/).filter(Boolean)[0] || "";
    if (fw.length >= 4 && fw !== norm && firstTokenIsUniqueInMenu(fw)) {
      patternEntries.push({ item, pattern: fw });
    }
  }
  patternEntries.sort((a, b) => b.pattern.length - a.pattern.length);

  const foundItems = [];
  for (const { item, pattern } of patternEntries) {
    let idx = working.indexOf(pattern);
    while (idx !== -1) {
      const qty = extractQuantityBeforePosition(working, idx);
      for (let i = 0; i < qty; i += 1) {
        foundItems.push(item);
      }
      working =
        working.slice(0, idx) + " ".repeat(pattern.length) + working.slice(idx + pattern.length);
      idx = working.indexOf(pattern);
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

function countLineItemsByName(items) {
  const m = new Map();
  for (const name of items || []) {
    m.set(name, (m.get(name) || 0) + 1);
  }
  return m;
}

/** Reconstruye total desde precios del menú (evita totales inconsistentes al fusionar). */
function expandNameCountsToDirectOrder(countMap, menuItems) {
  const priceByName = new Map(
    (menuItems || []).map((i) => [String(i.name || "").trim(), Number(i.price)])
  );
  const items = [];
  let total = 0;
  for (const [name, count] of countMap.entries()) {
    const p = priceByName.get(name);
    if (!Number.isFinite(p) || p <= 0) continue;
    for (let i = 0; i < count; i += 1) {
      items.push(name);
      total += p;
    }
  }
  if (!items.length) return null;
  return {
    items,
    totalAmount: total,
    details: items.join(", ")
  };
}

/**
 * Une dos interpretaciones del mismo mensaje (regex menu + porciones 1/2 + empanadas).
 * Por producto usa el máximo de cantidades entre fuentes — así no se pierde la costeleta
 * cuando `detectDirectMenuOrder` ya encontró otros platos; evita duplicar si ambas
 * coinciden en el mismo ítem.
 */
function mergeDirectOrderSnapshots(a, b, menuItems) {
  if (!a && !b) return null;
  if (!a) return b;
  if (!b) return a;
  const ca = countLineItemsByName(a.items);
  const cb = countLineItemsByName(b.items);
  const names = new Set([...ca.keys(), ...cb.keys()]);
  const merged = new Map();
  for (const n of names) {
    merged.set(n, Math.max(ca.get(n) || 0, cb.get(n) || 0));
  }
  return expandNameCountsToDirectOrder(merged, menuItems);
}

/**
 * Combina detección por menú con reglas de porciones (1/2 personas) y empanadas.
 * Fusiona resultados para que un mismo mensaje pueda traer fricase + napolitana por nombre
 * y costeleta por la regla de porciones (antes al tomar solo `detectDirectMenuOrder` se
 * perdía la costeleta).
 */
function pickDirectOrderAfterPersonPortionAttempt(text, menuItems, ppExplicitResult) {
  const detected = detectDirectMenuOrder(text, menuItems);
  const ppOrder = ppExplicitResult && ppExplicitResult.order;
  const implicit = tryPersonPortionImplicitSingle(text, menuItems)?.order;
  const empanada = tryEmpanadaPackDirectOrder(text, menuItems);

  let acc = detected;
  acc = mergeDirectOrderSnapshots(acc, ppOrder, menuItems);
  acc = mergeDirectOrderSnapshots(acc, implicit, menuItems);
  acc = mergeDirectOrderSnapshots(acc, empanada, menuItems);
  return acc;
}

/** Ratio máximo distancia/normalizado para sugerir un producto (nomás casos “casi iguales”). */
const FUZZY_ORDER_MAX_RATIO = Number(process.env.FUZZY_ORDER_MAX_RATIO || 0.38);
/** Si el 2.º candidato está casi igual de cerca que el 1.º, listamos opciones numeradas. */
const FUZZY_ORDER_PICK_GAP = Number(process.env.FUZZY_ORDER_PICK_GAP || 0.07);
const PENDING_CLARIFICATION_TTL_MS = Number(process.env.PENDING_CLARIFICATION_TTL_MS || 10 * 60 * 1000);

function minLevenshteinRatio(a, b) {
  const A = String(a || "").trim();
  const B = String(b || "").trim();
  if (!A || !B) return 1;
  const d = levenshteinDistance(A, B);
  return d / Math.max(A.length, B.length, 1);
}

function buildSlidingPhrasesForFuzzy(normalizedLine) {
  const tokens = String(normalizedLine || "")
    .split(/\s+/)
    .filter(Boolean);
  const out = new Set();
  if (!tokens.length) return [];
  const maxLen = Math.min(tokens.length, 14);
  for (let len = maxLen; len >= 2; len -= 1) {
    for (let i = 0; i + len <= tokens.length; i += 1) {
      out.add(tokens.slice(i, i + len).join(" "));
    }
  }
  if (tokens.length === 1) out.add(tokens[0]);
  return Array.from(out);
}

/**
 * Rankea productos del menú por cercanía al texto del cliente (ortografía distinta).
 */
function rankMenuItemsByFuzzy(userText, menuItems = []) {
  const normUser = normalizeForItemMatch(userText);
  if (!normUser) return [];
  const phrases = buildSlidingPhrasesForFuzzy(normUser);

  const scored = [];
  for (const item of menuItems) {
    const ni = normalizeForItemMatch(item?.name);
    const price = Number(item?.price || 0);
    if (!ni || !Number.isFinite(price) || price <= 0) continue;

    let best = minLevenshteinRatio(normUser, ni);
    for (const ph of phrases) {
      if (ni.length > 8 && ph.length < 4) continue;
      const r = minLevenshteinRatio(ph, ni);
      if (r < best) best = r;
    }
    scored.push({ item, ratio: best });
  }
  scored.sort((a, b) => a.ratio - b.ratio);
  return scored;
}

function looksLikeOrderAttemptForFuzzy(text) {
  const t = normalizeTextForMatch(text).replace(/\s+/g, " ").trim();
  if (t.length < 8) return false;
  if (isPureGreeting(text)) return false;
  if (wantsMenuList(text)) return false;
  if (/\b(como\s+es|que\s+es|qué\s+es|cuanto\s+cuesta|cuánto\s+cuesta|tienen|tenes|tenés|hay\s+)\b/i.test(t)) {
    return false;
  }
  const orderCue =
    /\b(quiero|quereria|quería|dame|mandame|necesito|pedir|pedi|traeme|traéme|enviame|enviáme|suma|sumá|agrega|agregá|un pedido|para llevar|para retirar)\b/.test(
      t
    ) ||
    /\b\d+\s/.test(t) ||
    /\b(un|una|unos|unas|dos|tres|cuatro|cinco)\s+\w{3,}/.test(t);
  return Boolean(orderCue);
}

function isAffirmativeFuzzyReply(trimmedText) {
  const s = normalizeTextForMatch(trimmedText).replace(/[!?.]+$/g, "").trim();
  return /^(si|sí|sii|dale|ok|okey|oki|confirmo|va|va\s+bien|simon|sep)$/.test(s);
}

function isNegativeFuzzyReply(trimmedText) {
  const s = normalizeTextForMatch(trimmedText).replace(/[!?.]+$/g, "").trim();
  return /^(no|nop|nope|negativo|mejor\s+no|cancelar)$/.test(s) || /^no\s*,?\s*$/i.test(trimmedText.trim());
}

function clearPendingClarification(session) {
  if (session) session.pendingClarification = null;
}

function mergeDirectOrderIntoSessionAndBuildAddMore({
  session,
  directOrder,
  text,
  updatedMessages,
  hasConfirmedAddress,
  addressCheck,
  menuItems
}) {
  const hadPreviousItems =
    Array.isArray(session.items) && session.items.length > 0 && Number(session.totalAmount) > 0;
  if (hadPreviousItems) {
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
  ensureSessionTotals(session, menuItems);
  return buildAddMoreQuestion(
    formatOrderDetailsForDisplay(session.items, session.details),
    session.totalAmount
  );
}

function buildFuzzyClarificationReplySingle(tenant, menuItem) {
  const bot = resolveBotDisplayName();
  const brand = resolvePublicBrandName({ restaurant: tenant || {} });
  return [
    `*${bot} · ${brand}*`,
    "",
    `No encontré el nombre exacto en el menú. ¿Querías pedir *${menuItem.name}* (${formatTotal(menuItem.price)})?`,
    "",
    "Respondé *SÍ* para sumarlo al pedido o *NO* si era otra cosa."
  ].join("\n");
}

function buildFuzzyClarificationReplyPick(tenant, candidates) {
  const bot = resolveBotDisplayName();
  const brand = resolvePublicBrandName({ restaurant: tenant || {} });
  const lines = candidates.map((c, i) => `${i + 1}. ${c.name} (${formatTotal(c.price)})`);
  return [
    `*${bot} · ${brand}*`,
    "",
    "No estoy seguro cuál pedías. ¿Alguno de estos?",
    "",
    ...lines,
    "",
    "Respondé con el número (1, 2 o 3) o *NO* para cancelar."
  ].join("\n");
}

/**
 * Ofrece aclaración fuzzy solo si no hubo match exacto y el texto parece un pedido.
 * @returns {string|null}
 */
function maybeOfferFuzzyOrderClarification(trimmedText, text, session, menuItems, tenant) {
  if (!menuItems.length) return null;
  if (session.pendingClarification) return null;
  if (["awaiting_payment", "awaiting_address"].includes(session.status)) return null;
  if (resolveMenuListIntent(trimmedText)) return null;
  if (!looksLikeOrderAttemptForFuzzy(trimmedText)) return null;

  const ranked = rankMenuItemsByFuzzy(text, menuItems);
  if (!ranked.length || ranked[0].ratio > FUZZY_ORDER_MAX_RATIO) return null;

  const top = ranked[0];
  const runners = ranked.filter((r) => r.ratio <= FUZZY_ORDER_MAX_RATIO + 0.06).slice(0, 3);

  let mode = "single";
  let candidates = [{ name: top.item.name, price: Number(top.item.price) }];

  if (
    runners.length >= 2 &&
    runners[1].ratio - runners[0].ratio < FUZZY_ORDER_PICK_GAP &&
    runners[1].ratio <= FUZZY_ORDER_MAX_RATIO + 0.06
  ) {
    mode = "pick";
    candidates = runners.map((r) => ({ name: r.item.name, price: Number(r.item.price) }));
  }

  session.pendingClarification = {
    type: "fuzzy_order",
    mode,
    candidates,
    createdAt: Date.now()
  };

  if (mode === "pick" && candidates.length >= 2) {
    return buildFuzzyClarificationReplyPick(tenant, candidates);
  }
  return buildFuzzyClarificationReplySingle(tenant, top.item);
}

/**
 * Responde SÍ/NO/número tras sugerencia fuzzy, o libera pending si el mensaje es otro tema.
 * @returns {string|null}
 */
function handlePendingFuzzyClarification({
  session,
  trimmedText,
  text,
  menuItems,
  tenant,
  updatedMessages,
  hasConfirmedAddress,
  addressCheck
}) {
  const p = session.pendingClarification;
  if (!p || p.type !== "fuzzy_order") return null;
  if (Date.now() - p.createdAt > PENDING_CLARIFICATION_TTL_MS) {
    clearPendingClarification(session);
    return null;
  }

  const t = trimmedText.trim();

  if (isNegativeFuzzyReply(t)) {
    clearPendingClarification(session);
    return "Listo. Decime el producto tal como figura en el menú o escribí *menú* para ver la lista completa.";
  }

  if (p.mode === "pick" && /^[1-3]$/.test(t)) {
    const idx = parseInt(t, 10) - 1;
    const chosen = p.candidates[idx];
    if (chosen) {
      clearPendingClarification(session);
      const directOrder = detectDirectMenuOrder(chosen.name, menuItems);
      if (directOrder) {
        return mergeDirectOrderIntoSessionAndBuildAddMore({
          session,
          directOrder,
          text,
          updatedMessages,
          hasConfirmedAddress,
          addressCheck,
          menuItems
        });
      }
    }
  }

  if (p.mode === "pick" && isAffirmativeFuzzyReply(t) && p.candidates.length >= 1) {
    clearPendingClarification(session);
    const directOrder = detectDirectMenuOrder(p.candidates[0].name, menuItems);
    if (directOrder) {
      return mergeDirectOrderIntoSessionAndBuildAddMore({
        session,
        directOrder,
        text,
        updatedMessages,
        hasConfirmedAddress,
        addressCheck,
        menuItems
      });
    }
  }

  const singleYes =
    p.mode === "single" &&
    p.candidates.length === 1 &&
    (isAffirmativeFuzzyReply(t) || /^1$/.test(t.trim()));
  if (singleYes) {
    clearPendingClarification(session);
    const directOrder = detectDirectMenuOrder(p.candidates[0].name, menuItems);
    if (directOrder) {
      return mergeDirectOrderIntoSessionAndBuildAddMore({
        session,
        directOrder,
        text,
        updatedMessages,
        hasConfirmedAddress,
        addressCheck,
        menuItems
      });
    }
  }

  const directAfter = detectDirectMenuOrder(text, menuItems);
  if (directAfter) {
    clearPendingClarification(session);
    return mergeDirectOrderIntoSessionAndBuildAddMore({
      session,
      directOrder: directAfter,
      text,
      updatedMessages,
      hasConfirmedAddress,
      addressCheck,
      menuItems
    });
  }

  if (t.length > 2 && !isAffirmativeFuzzyReply(t) && !isNegativeFuzzyReply(t) && !/^[1-3]$/.test(t)) {
    clearPendingClarification(session);
  }
  return null;
}

function isShortOptionMessage(text) {
  const normalized = String(text || "").trim();
  const option = numericOption(normalized);
  if (option === 1 || option === 2) return true;
  // Evita confundir preguntas reales ("no hay sopa?") con respuestas cortas de checkout ("no", "listo", etc.).
  if (!normalized || normalized.length > 24 || /[?¿]/.test(normalized)) return false;
  return hasAnyPhrase(normalized, [
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

async function collectChromiumLockFiles(rootDir) {
  const lockFiles = [];
  const stack = [path.resolve(rootDir)];

  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }

    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
        continue;
      }
      if (
        entry.name === "SingletonLock" ||
        entry.name === "SingletonCookie" ||
        entry.name === "SingletonSocket"
      ) {
        lockFiles.push(entryPath);
      }
    }
  }

  return lockFiles;
}

async function cleanupChromiumProfileLocks(authPath = AUTH_PATH) {
  const lockFiles = await collectChromiumLockFiles(authPath);
  if (!lockFiles.length) return;

  await Promise.all(
    lockFiles.map(async (lockFile) => {
      try {
        await fs.rm(lockFile, { force: true });
      } catch (error) {
        if (error?.code !== "ENOENT") {
          console.warn("[startup] No se pudo borrar lock de Chromium:", lockFile, error?.message || error);
        }
      }
    })
  );

  console.log("[startup] Locks de Chromium limpiados:", lockFiles.length);
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

  const pendingTotalConfirmOrder = await getOrderAwaitingCustomerTotalConfirm({
    restaurantId: tenant.id,
    customerNumber,
    botNumber
  });
  if (pendingTotalConfirmOrder) {
    return handleCustomerDeliveryTotalConfirmation({
      trimmedText,
      order: pendingTotalConfirmOrder,
      tenant,
      customerNumber,
      botNumber
    });
  }

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
  // Fallback de robustez: si el ultimo turno del bot pidio numero de mesa,
  // aceptamos un numero puro aunque el estado haya quedado desincronizado.
  if (session.status !== "awaiting_table_number" && /^\d{1,3}$/.test(trimmedText)) {
    const lastTurn = recentHistory?.length ? recentHistory[recentHistory.length - 1] : null;
    const lastBot = String(lastTurn?.bot_response || "").toLowerCase();
    if (lastBot.includes("en qué mesa") || lastBot.includes("en que mesa")) {
      session.status = "awaiting_table_number";
    }
  }
  // Guard: solo llamamos al detector IA cuando el contexto lo justifica.
  // Cubre los casos comunes (saludo, opcion numerica, retiro en local, direccion ya
  // confirmada) sin gastar tokens. Reduce ~80% las llamadas a OpenAI.
  let addressCheck = { isAddress: false, normalizedAddress: "" };
  if (shouldRunAddressDetection(session, text)) {
    addressCheck = await detectAddressIntent({
      customerMessage: text,
      chatHistory: recentHistory
    });
  }
  const hasConfirmedAddress = isConfirmedAddress(addressCheck, text);
  const fulfillmentIntent = detectFulfillmentIntent(trimmedText);
  let option = numericOption(trimmedText);
  if (
    session.status === "awaiting_fulfillment" &&
    isRestaurantDeliveryEnabled(tenant) &&
    option === null &&
    /^3$/.test(trimmedText.trim())
  ) {
    option = 3;
  }

  // Regla fuerte: si el checkout ya esta en modalidad mesa y aun falta numero,
  // un mensaje numerico puro debe tomarse como mesa (aunque el estado venga corrido).
  if (
    /^\d{1,3}$/.test(trimmedText) &&
    Number(session.totalAmount || 0) > 0 &&
    (session.fulfillmentType === "mesa" || fulfillmentIntent === "mesa") &&
    (session.tableNumber === "" || session.tableNumber == null)
  ) {
    session.status = "awaiting_table_number";
    if (!session.fulfillmentType) session.fulfillmentType = "mesa";
  }

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

  const fuzzyResolvedEarly = handlePendingFuzzyClarification({
    session,
    trimmedText,
    text,
    menuItems,
    tenant,
    updatedMessages,
    hasConfirmedAddress,
    addressCheck
  });
  if (fuzzyResolvedEarly) {
    await saveInteraction({
      restaurantId: tenant.id,
      customerNumber,
      botNumber,
      messageType: "text",
      userMessage: text,
      botResponse: fuzzyResolvedEarly,
      metadata: sessionMetadata(session, { fuzzyClarificationResolved: true })
    });
    return fuzzyResolvedEarly;
  }

  const empanadaPending = tryResolvePendingEmpanadaOrder(session, text, menuItems);
  if (empanadaPending?.reply) {
    await saveInteraction({
      restaurantId: tenant.id,
      customerNumber,
      botNumber,
      messageType: "text",
      userMessage: text,
      botResponse: empanadaPending.reply,
      metadata: sessionMetadata(session, { empanadaPendingError: true })
    });
    return empanadaPending.reply;
  }
  if (empanadaPending?.order) {
    const empanadaAddMore = mergeDirectOrderIntoSessionAndBuildAddMore({
      session,
      directOrder: empanadaPending.order,
      text,
      updatedMessages,
      hasConfirmedAddress,
      addressCheck,
      menuItems
    });
    await saveInteraction({
      restaurantId: tenant.id,
      customerNumber,
      botNumber,
      messageType: "text",
      userMessage: text,
      botResponse: empanadaAddMore,
      metadata: sessionMetadata(session, { empanadaClarificationResolved: true })
    });
    return empanadaAddMore;
  }

  const personPortionPending = tryResolvePendingPersonPortion(session, text, menuItems);
  if (personPortionPending?.reply) {
    await saveInteraction({
      restaurantId: tenant.id,
      customerNumber,
      botNumber,
      messageType: "text",
      userMessage: text,
      botResponse: personPortionPending.reply,
      metadata: sessionMetadata(session, { personPortionPendingError: true })
    });
    return personPortionPending.reply;
  }
  if (personPortionPending?.order) {
    const portionAddMore = mergeDirectOrderIntoSessionAndBuildAddMore({
      session,
      directOrder: personPortionPending.order,
      text,
      updatedMessages,
      hasConfirmedAddress,
      addressCheck,
      menuItems
    });
    await saveInteraction({
      restaurantId: tenant.id,
      customerNumber,
      botNumber,
      messageType: "text",
      userMessage: text,
      botResponse: portionAddMore,
      metadata: sessionMetadata(session, { personPortionClarificationResolved: true })
    });
    return portionAddMore;
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

  if (session.status === "browsing" && Number(session.totalAmount || 0) <= 0) {
    const unavailableProduct = extractUnavailableProductName(trimmedText, menuItems);
    if (unavailableProduct) {
      const unavailableReply =
        `No veo un producto disponible con ese nombre (*${unavailableProduct}*). ` +
        "Si queres, escribi *menu* y te muestro lo que si tenemos hoy.";
      await saveInteraction({
        restaurantId: tenant.id,
        customerNumber,
        botNumber,
        messageType: "text",
        userMessage: text,
        botResponse: unavailableReply,
        metadata: { status: "browsing", unavailableProductAsked: unavailableProduct }
      });
      return unavailableReply;
    }
  }

  // Recupera el flujo si llega una opcion corta aunque el estado previo se haya desfasado.
  if (session.totalAmount > 0 && session.status === "browsing") {
    if (option === 1 || fulfillmentIntent === "delivery") {
      session.status = "awaiting_fulfillment";
    } else if (option === 2 || fulfillmentIntent === "local") {
      session.status = "awaiting_fulfillment";
    } else if (
      (option === 3 && isRestaurantDeliveryEnabled(tenant)) ||
      fulfillmentIntent === "mesa"
    ) {
      session.status = "awaiting_fulfillment";
    }
  }

  if (session.status === "awaiting_add_more") {
    // Si el cliente manda directamente otro producto del menu (uno o varios),
    // lo acumulamos sin forzar el paso intermedio de "1".
    const empanadaGateAddMore = maybeEmpanadaQuantityGate(text, menuItems, session);
    if (empanadaGateAddMore?.reply) {
      await saveInteraction({
        restaurantId: tenant.id,
        customerNumber,
        botNumber,
        messageType: "text",
        userMessage: text,
        botResponse: empanadaGateAddMore.reply,
        metadata: sessionMetadata(session, { empanadaQuantityGuidance: true })
      });
      return empanadaGateAddMore.reply;
    }
    const personGateAddMore = maybePersonPortionGate(text, menuItems, session);
    if (personGateAddMore?.reply) {
      await saveInteraction({
        restaurantId: tenant.id,
        customerNumber,
        botNumber,
        messageType: "text",
        userMessage: text,
        botResponse: personGateAddMore.reply,
        metadata: sessionMetadata(session, { personPortionQuantityGuidance: true })
      });
      return personGateAddMore.reply;
    }
    const ppExplicitAdd = tryPersonPortionDirectOrder(text, menuItems);
    if (ppExplicitAdd?.reply) {
      await saveInteraction({
        restaurantId: tenant.id,
        customerNumber,
        botNumber,
        messageType: "text",
        userMessage: text,
        botResponse: ppExplicitAdd.reply,
        metadata: sessionMetadata(session, { personPortionUnavailable: true })
      });
      return ppExplicitAdd.reply;
    }
    const directOrderWhileAddMore = pickDirectOrderAfterPersonPortionAttempt(
      text,
      restaurantContext?.menuItems || [],
      ppExplicitAdd
    );
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

    const fuzzyOfferWhileAddMore = maybeOfferFuzzyOrderClarification(
      trimmedText,
      text,
      session,
      menuItems,
      tenant
    );
    if (fuzzyOfferWhileAddMore) {
      await saveInteraction({
        restaurantId: tenant.id,
        customerNumber,
        botNumber,
        messageType: "text",
        userMessage: text,
        botResponse: fuzzyOfferWhileAddMore,
        metadata: sessionMetadata(session, { fuzzyClarificationOffered: true })
      });
      return fuzzyOfferWhileAddMore;
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
      const fulfillmentQuestion = buildFulfillmentQuestion(session.totalAmount, tenant);
      if (!hasAnyEnabledFulfillment(tenant)) {
        resetCheckoutSession(conversationKey);
      }
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
      // Mantener awaiting_add_more: si pasamos a browsing, el metadata guardado no rehidrata
      // (browsing no está en CHECKOUT_STATUSES) y el siguiente producto reemplaza el carrito.
      session.status = "awaiting_add_more";
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
      const fulfillmentQuestion = buildFulfillmentQuestion(session.totalAmount, tenant);
      if (!hasAnyEnabledFulfillment(tenant)) {
        resetCheckoutSession(conversationKey);
      }
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

    // Si el usuario manda solo numero y el contexto venia de "mesa",
    // no responder con 1/2 de "agregar/continuar": rerutear a numero de mesa.
    if (/^\d{1,3}$/.test(trimmedText)) {
      const lastTurn = recentHistory?.length ? recentHistory[recentHistory.length - 1] : null;
      const lastBot = String(lastTurn?.bot_response || "").toLowerCase();
      const looksMesaContext =
        session.fulfillmentType === "mesa" ||
        lastBot.includes("en qué mesa") ||
        lastBot.includes("en que mesa");
      if (looksMesaContext && !message.__mesaRecovered) {
        session.status = "awaiting_table_number";
        if (!session.fulfillmentType) session.fulfillmentType = "mesa";
        return handleTextMessage(
          { body: text, from: message.from, __mesaRecovered: true },
          restaurantContext,
          tenant,
          customerNumber,
          botNumber,
          recentHistory
        );
      }
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
    const deliveryOk = isRestaurantDeliveryEnabled(tenant);
    const localOk = isRestaurantLocalEnabled(tenant);
    const mesaOk = isRestaurantMesaEnabled(tenant);
    const enabledChoices = [];
    if (deliveryOk) enabledChoices.push("delivery");
    if (localOk) enabledChoices.push("local");
    if (mesaOk) enabledChoices.push("mesa");
    const numericChoice =
      option != null && option >= 1 && option <= enabledChoices.length ? enabledChoices[option - 1] : null;

    if (!enabledChoices.length) {
      const unavailable = noServiceAvailableReply();
      resetCheckoutSession(conversationKey);
      await saveInteraction({
        restaurantId: tenant.id,
        customerNumber,
        botNumber,
        messageType: "text",
        userMessage: text,
        botResponse: unavailable,
        metadata: { status: "browsing", noFulfillmentServices: true }
      });
      return unavailable;
    }

    if (!deliveryOk) {
      if (fulfillmentIntent === "delivery") {
        const pauseReply =
          "Por el momento no tomamos pedidos con delivery. Elegí una de las opciones disponibles.";
        await saveInteraction({
          restaurantId: tenant.id,
          customerNumber,
          botNumber,
          messageType: "text",
          userMessage: text,
          botResponse: pauseReply,
          metadata: sessionMetadata(session, { deliveryDisabledOffered: true })
        });
        return pauseReply;
      }

      const wantsMesa = (mesaOk && numericChoice === "mesa") || (mesaOk && fulfillmentIntent === "mesa");
      const wantsLocal =
        (localOk && numericChoice === "local") ||
        (localOk && fulfillmentIntent === "local") ||
        (!wantsMesa && /^(s[ií]|ok|dale|bueno|listo)$/i.test(trimmedText));

      if (wantsMesa) {
        session.fulfillmentType = "mesa";
        session.deliveryAddress = "";
        session.tableNumber = "";
        session.status = "awaiting_table_number";
        const askMesa = askTableNumberPrompt(tenant);
        await saveInteraction({
          restaurantId: tenant.id,
          customerNumber,
          botNumber,
          messageType: "text",
          userMessage: text,
          botResponse: askMesa,
          metadata: sessionMetadata(session)
        });
        return askMesa;
      }

      if (wantsLocal) {
        session.fulfillmentType = "local";
        session.deliveryAddress = "";
        session.tableNumber = "";
        session.status = "awaiting_payment";
        const paymentQuestion = buildPaymentQuestion(
          formatOrderDetailsForDisplay(session.items, session.details),
          session.totalAmount,
          "local",
          tenant
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

      const invalidPickupReply =
        "No entendí. Elegí una de las opciones disponibles para continuar.";
      await saveInteraction({
        restaurantId: tenant.id,
        customerNumber,
        botNumber,
        messageType: "text",
        userMessage: text,
        botResponse: invalidPickupReply,
        metadata: sessionMetadata(session, { invalidChoice: true })
      });
      return invalidPickupReply;
    }

    if ((numericChoice === "delivery") || (deliveryOk && fulfillmentIntent === "delivery")) {
      session.fulfillmentType = "delivery";
      session.tableNumber = "";
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
        session.totalAmount,
        session.fulfillmentType || "delivery",
        tenant
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

    if ((numericChoice === "local") || (localOk && fulfillmentIntent === "local")) {
      session.fulfillmentType = "local";
      session.deliveryAddress = "";
      session.tableNumber = "";
      session.status = "awaiting_payment";
      const paymentQuestion = buildPaymentQuestion(
        formatOrderDetailsForDisplay(session.items, session.details),
        session.totalAmount,
        "local",
        tenant
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

    if ((numericChoice === "mesa") || (mesaOk && fulfillmentIntent === "mesa")) {
      session.fulfillmentType = "mesa";
      session.deliveryAddress = "";
      session.tableNumber = "";
      session.status = "awaiting_table_number";
      const askMesa = askTableNumberPrompt(tenant);
      await saveInteraction({
        restaurantId: tenant.id,
        customerNumber,
        botNumber,
        messageType: "text",
        userMessage: text,
        botResponse: askMesa,
        metadata: sessionMetadata(session)
      });
      return askMesa;
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

    const invalidFulfillmentReply = "No entendí tu opción. Elegí una de las opciones disponibles.";
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

  if (session.status === "awaiting_table_number") {
    ensureSessionTotals(session, menuItems);
    if (Number(session.totalAmount || 0) <= 0) {
      const lostTableContextReply =
        "Perdí el contexto del pedido antes de asignar la mesa. Decime de nuevo qué querés pedir y lo armamos rápido.";
      resetCheckoutSession(conversationKey);
      await saveInteraction({
        restaurantId: tenant.id,
        customerNumber,
        botNumber,
        messageType: "text",
        userMessage: text,
        botResponse: lostTableContextReply,
        metadata: { status: "browsing", missingTotalBeforeTable: true }
      });
      return lostTableContextReply;
    }
    const maxT = maxTablesForRestaurant(tenant);
    const tn = parseTableNumberInput(trimmedText, maxT);
    if (tn == null) {
      const badTable = `No reconocí un número de mesa válido. ${askTableNumberPrompt(tenant)}`;
      await saveInteraction({
        restaurantId: tenant.id,
        customerNumber,
        botNumber,
        messageType: "text",
        userMessage: text,
        botResponse: badTable,
        metadata: sessionMetadata(session, { invalidTableNumber: true })
      });
      return badTable;
    }
    session.tableNumber = tn;
    session.status = "awaiting_payment";
    const paymentQuestion = buildPaymentQuestion(
      formatOrderDetailsForDisplay(session.items, session.details),
      session.totalAmount,
      "mesa",
      tenant
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

  if (session.status === "awaiting_payment") {
    if (!hasAnyEnabledPaymentMethod(tenant)) {
      const noPayReply = noPaymentMethodAvailableReply();
      await saveInteraction({
        restaurantId: tenant.id,
        customerNumber,
        botNumber,
        messageType: "text",
        userMessage: text,
        botResponse: noPayReply,
        metadata: sessionMetadata(session, { paymentMethodsDisabled: true })
      });
      return noPayReply;
    }
    if (!isRestaurantDeliveryEnabled(tenant) && session.fulfillmentType === "delivery") {
      session.fulfillmentType = "local";
      session.deliveryAddress = "";
      session.tableNumber = "";
      const coercePaymentQuestion = buildPaymentQuestion(
        formatOrderDetailsForDisplay(session.items, session.details),
        session.totalAmount,
        "local",
        tenant
      );
      await saveInteraction({
        restaurantId: tenant.id,
        customerNumber,
        botNumber,
        messageType: "text",
        userMessage: text,
        botResponse: coercePaymentQuestion,
        metadata: sessionMetadata(session, { deliveryDisabledCoercedLocal: true })
      });
      return coercePaymentQuestion;
    }

    const isLocal = session.fulfillmentType === "local";
    const isMesa = session.fulfillmentType === "mesa";
    const customerPhone = await resolveCustomerPhone(message, client);
    const sessionItems = session.items?.length ? session.items : [session.details];
    const pricedOrderItems = withItemPrices(sessionItems, menuItems);
    if (!pricedOrderItems.length) {
      const missingItemsReply =
        "No pude validar los productos del pedido con el menú actual. Revisá los productos y volvé a cerrar el pedido.";
      await saveInteraction({
        restaurantId: tenant.id,
        customerNumber,
        botNumber,
        messageType: "text",
        userMessage: text,
        botResponse: missingItemsReply,
        metadata: { paymentChoice: "invalid_items_for_checkout" }
      });
      return missingItemsReply;
    }
    const baseOrderPayload = {
      restaurantId: tenant.id,
      customerNumber,
      customerChatId,
      customerPhone,
      botNumber,
      items: pricedOrderItems,
      address: session.deliveryAddress || null,
      rawRequest: session.conversationText,
      totalAmount: session.totalAmount
    };

    const cashEnabled = isRestaurantCashEnabled(tenant);
    const mpEnabled = isRestaurantMercadoPagoEnabled(tenant);
    const cashPickupIntent =
      cashEnabled &&
      (option === 1 ||
        (hasAnyPhrase(text, INTENT_PHRASES.cash) && !hasAnyPhrase(text, INTENT_PHRASES.mercadoPago)));
    const mpPickupIntent = mpEnabled && (option === 2 || hasAnyPhrase(text, INTENT_PHRASES.mercadoPago));

    if (isLocal || isMesa) {
      const ftOrder = isMesa ? "mesa" : "local";
      const tableNum = isMesa ? session.tableNumber : null;

      if (isMesa && (session.tableNumber === "" || session.tableNumber == null)) {
        session.status = "awaiting_table_number";
        const askAgain = askTableNumberPrompt(tenant);
        await saveInteraction({
          restaurantId: tenant.id,
          customerNumber,
          botNumber,
          messageType: "text",
          userMessage: text,
          botResponse: askAgain,
          metadata: sessionMetadata(session, { mesaNumberMissing: true })
        });
        return askAgain;
      }

      if (!cashPickupIntent && !mpPickupIntent) {
        const allowedPaymentLabels = [];
        if (cashEnabled) allowedPaymentLabels.push("*1* (efectivo)");
        if (mpEnabled) allowedPaymentLabels.push("*2* (mercado pago)");
        const invalidLocalPay = isMesa
          ? `Para pedido en mesa respondé ${allowedPaymentLabels.join(" o ")}.`
          : `Para retiro en el local respondé ${allowedPaymentLabels.join(" o ")}.`;
        await saveInteraction({
          restaurantId: tenant.id,
          customerNumber,
          botNumber,
          messageType: "text",
          userMessage: text,
          botResponse: invalidLocalPay,
          metadata: { ...sessionMetadata(session), paymentChoice: "invalid", fulfillmentPickup: true }
        });
        return invalidLocalPay;
      }

      if (!session.totalAmount || session.totalAmount <= 0) {
        const missingTotalReply =
          "No pude calcular el total del pedido. Revisá los productos y volvé a cerrar el pedido.";
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

      if (cashPickupIntent && !mpPickupIntent) {
        const order = await saveOrder({
          ...baseOrderPayload,
          notes: buildCustomerOperationalNotes({
            fulfillmentType: ftOrder,
            address: null,
            customerPhone,
            paymentMethod: "efectivo",
            tableNumber: tableNum
          }),
          status: "confirmed",
          paymentMethod: "efectivo",
          paymentStatus: "pending",
          fulfillmentType: ftOrder,
          tableNumber: tableNum != null && tableNum !== "" ? tableNum : undefined
        });

        const orderCode = String(order.id || "")
          .replace(/-/g, "")
          .slice(0, 8);
        const cashReply = isMesa
          ? `Listo. Registramos tu pedido para la *mesa ${session.tableNumber}* con *efectivo en la mesa*. El equipo lo prepara y te lo acerca.`
          : `Listo. Registramos tu pedido para retiro en local con *efectivo al retirar*. Tu pedido es *#${orderCode}*.`;

        await saveInteraction({
          restaurantId: tenant.id,
          customerNumber,
          botNumber,
          messageType: "text",
          userMessage: text,
          botResponse: cashReply,
          metadata: {
            status: "browsing",
            checkoutClosed: true,
            orderId: order.id,
            paymentChoice: "cash",
            fulfillmentType: ftOrder,
            details: session.details,
            tableNumber: session.tableNumber
          }
        });

        resetCheckoutSession(conversationKey);
        conversationState.delete(conversationKey);
        return cashReply;
      }

      const order = await saveOrder({
        ...baseOrderPayload,
        notes: buildCustomerOperationalNotes({
          fulfillmentType: ftOrder,
          address: null,
          customerPhone,
          paymentMethod: "mercadopago",
          tableNumber: tableNum
        }),
        status: "confirmed",
        paymentMethod: "mercadopago",
        paymentStatus: "pending",
        fulfillmentType: ftOrder,
        tableNumber: tableNum != null && tableNum !== "" ? tableNum : undefined
      });

      let paymentUrl;
      try {
        paymentUrl = await createPaymentPreference({
          orderId: order.id,
          totalAmount: session.totalAmount,
          restaurantName: resolvePublicBrandName({ restaurant: tenant || {} })
        });
      } catch (mpError) {
        const mpErrorReply = `No pude generar el link de Mercado Pago. ${mpError.message || ""}`.trim();
        await saveInteraction({
          restaurantId: tenant.id,
          customerNumber,
          botNumber,
          messageType: "text",
          userMessage: text,
          botResponse: `${mpErrorReply} Probá de nuevo en un rato o escribí al restaurante.`,
          metadata: {
            orderId: order.id,
            paymentChoice: "mercadopago_error",
            fulfillmentType: ftOrder,
            error: String(mpError.message || mpError)
          }
        });
        return `${mpErrorReply}\nProbá de nuevo en un rato o contactá al local.`;
      }

      await updateOrderMatching(
        order.id,
        {
          payment_link: paymentUrl,
          customer_notified_at: new Date().toISOString()
        },
        { expectStatus: "confirmed", expectPaymentPendingOrNull: true }
      );

      const orderCode = String(order.id || "")
        .replace(/-/g, "")
        .slice(0, 8);
      const mpTail = isMesa
        ? `Cuando se acredite el pago, el restaurante prepara tu pedido y te lo llevan a la *mesa ${session.tableNumber}*.`
        : `Listo. Registramos tu pedido para retiro en local con *Mercado Pago*. Tu pedido es *#${orderCode}*. Cuando se acredite el pago, el restaurante prepara tu pedido.`;

      const mpReply = isMesa
        ? ["Perfecto. Para pagar con *Mercado Pago* usá este link:", paymentUrl, "", mpTail].join("\n")
        : [mpTail, "", "Para pagar con *Mercado Pago* usá este link:", paymentUrl].join("\n");

      await saveInteraction({
        restaurantId: tenant.id,
        customerNumber,
        botNumber,
        messageType: "text",
        userMessage: text,
        botResponse: mpReply,
        metadata: {
          status: "browsing",
          checkoutClosed: true,
          orderId: order.id,
          paymentChoice: "mercadopago",
          fulfillmentType: ftOrder,
          details: session.details,
          tableNumber: session.tableNumber
        }
      });

      resetCheckoutSession(conversationKey);
      conversationState.delete(conversationKey);
      return mpReply;
    }

    if (cashEnabled && (option === 1 || hasAnyPhrase(text, INTENT_PHRASES.cash))) {
      const order = await saveOrder({
        ...baseOrderPayload,
        notes: buildCustomerOperationalNotes({
          fulfillmentType: "delivery",
          address: session.deliveryAddress || null,
          customerPhone,
          paymentMethod: "efectivo"
        }),
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

    if (mpEnabled && (option === 2 || hasAnyPhrase(text, INTENT_PHRASES.mercadoPago))) {
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

      const order = await saveOrder({
        ...baseOrderPayload,
        notes: buildCustomerOperationalNotes({
          fulfillmentType: "delivery",
          address: session.deliveryAddress || null,
          customerPhone,
          paymentMethod: "mercadopago"
        }),
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

    const enabledOptions = [];
    if (cashEnabled) enabledOptions.push("*1* para Efectivo");
    if (mpEnabled) enabledOptions.push("*2* para Mercado Pago");
    const invalidOptionReply = `No entendí tu opción. Respondé ${enabledOptions.join(" o ")}.`;
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
    if (!isRestaurantDeliveryEnabled(tenant)) {
      session.fulfillmentType = "local";
      session.deliveryAddress = "";
      session.status = "awaiting_payment";
      const paymentQuestion = buildPaymentQuestion(
        formatOrderDetailsForDisplay(session.items, session.details),
        session.totalAmount,
        "local",
        tenant
      );
      await saveInteraction({
        restaurantId: tenant.id,
        customerNumber,
        botNumber,
        messageType: "text",
        userMessage: text,
        botResponse: paymentQuestion,
        metadata: sessionMetadata(session, { deliveryDisabledSkippedAddress: true })
      });
      return paymentQuestion;
    }

    if (hasConfirmedAddress) {
      session.deliveryAddress = addressCheck.normalizedAddress || text;
      session.status = "awaiting_payment";
      session.fulfillmentType = session.fulfillmentType || "delivery";

      const paymentQuestion = buildPaymentQuestion(
        formatOrderDetailsForDisplay(session.items, session.details),
        session.totalAmount,
        session.fulfillmentType || "delivery",
        tenant
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
    const deliveryOkBrowse = isRestaurantDeliveryEnabled(tenant);

    if (hasConfirmedAddress && deliveryOkBrowse) {
      session.fulfillmentType = "delivery";
      session.deliveryAddress = addressCheck.normalizedAddress || text;
      session.status = "awaiting_payment";
      const paymentQuestion = buildPaymentQuestion(
        formatOrderDetailsForDisplay(session.items, session.details),
        session.totalAmount,
        "delivery",
        tenant
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

    if (hasConfirmedAddress && !deliveryOkBrowse && isRestaurantLocalEnabled(tenant)) {
      session.fulfillmentType = "local";
      session.deliveryAddress = "";
      session.status = "awaiting_payment";
      const paymentQuestion = buildPaymentQuestion(
        formatOrderDetailsForDisplay(session.items, session.details),
        session.totalAmount,
        "local",
        tenant
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
      if (!deliveryOkBrowse) {
        const pauseBrowse = hasAnyEnabledFulfillment(tenant)
          ? "Por el momento no tomamos pedidos con delivery. Elegí una de las opciones disponibles para cerrar el pedido."
          : noServiceAvailableReply();
        await saveInteraction({
          restaurantId: tenant.id,
          customerNumber,
          botNumber,
          messageType: "text",
          userMessage: text,
          botResponse: pauseBrowse,
          metadata: sessionMetadata(session, { deliveryDisabledBrowsing: true })
        });
        return pauseBrowse;
      }
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

    if (fulfillmentIntent === "mesa") {
      session.fulfillmentType = "mesa";
      session.deliveryAddress = "";
      session.tableNumber = "";
      session.status = "awaiting_table_number";
      const askMesa = askTableNumberPrompt(tenant);
      await saveInteraction({
        restaurantId: tenant.id,
        customerNumber,
        botNumber,
        messageType: "text",
        userMessage: text,
        botResponse: askMesa,
        metadata: sessionMetadata(session)
      });
      return askMesa;
    }

    if (fulfillmentIntent === "local") {
      session.fulfillmentType = "local";
      session.deliveryAddress = "";
      session.tableNumber = "";
      session.status = "awaiting_payment";
      const paymentQuestion = buildPaymentQuestion(
        formatOrderDetailsForDisplay(session.items, session.details),
        session.totalAmount,
        "local",
        tenant
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

  const empanadaGateBrowse = maybeEmpanadaQuantityGate(text, menuItems, session);
  if (empanadaGateBrowse?.reply) {
    await saveInteraction({
      restaurantId: tenant.id,
      customerNumber,
      botNumber,
      messageType: "text",
      userMessage: text,
      botResponse: empanadaGateBrowse.reply,
      metadata: sessionMetadata(session, { empanadaQuantityGuidance: true })
    });
    return empanadaGateBrowse.reply;
  }

  const personGateBrowse = maybePersonPortionGate(text, menuItems, session);
  if (personGateBrowse?.reply) {
    await saveInteraction({
      restaurantId: tenant.id,
      customerNumber,
      botNumber,
      messageType: "text",
      userMessage: text,
      botResponse: personGateBrowse.reply,
      metadata: sessionMetadata(session, { personPortionQuantityGuidance: true })
    });
    return personGateBrowse.reply;
  }

  const ppExplicitBrowse = tryPersonPortionDirectOrder(text, menuItems);
  if (ppExplicitBrowse?.reply) {
    await saveInteraction({
      restaurantId: tenant.id,
      customerNumber,
      botNumber,
      messageType: "text",
      userMessage: text,
      botResponse: ppExplicitBrowse.reply,
      metadata: sessionMetadata(session, { personPortionUnavailable: true })
    });
    return ppExplicitBrowse.reply;
  }

  const directOrder = pickDirectOrderAfterPersonPortionAttempt(
    text,
    restaurantContext?.menuItems || [],
    ppExplicitBrowse
  );
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

  const fuzzyOfferBrowsing = maybeOfferFuzzyOrderClarification(
    trimmedText,
    text,
    session,
    menuItems,
    tenant
  );
  if (fuzzyOfferBrowsing) {
    await saveInteraction({
      restaurantId: tenant.id,
      customerNumber,
      botNumber,
      messageType: "text",
      userMessage: text,
      botResponse: fuzzyOfferBrowsing,
      metadata: sessionMetadata(session, { fuzzyClarificationOffered: true })
    });
    return fuzzyOfferBrowsing;
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
        const keepSessionReply = hasAnyEnabledFulfillment(tenant)
          ? `Ya tengo tu pedido cargado. ${buildFulfillmentQuestion(session.totalAmount, tenant)}`
          : noServiceAvailableReply();
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
    session.tableNumber = "";
    session.deliveryAddress = quote.deliveryAddress || (hasConfirmedAddress ? addressCheck.normalizedAddress || text : "");
    if (!isRestaurantDeliveryEnabled(tenant)) {
      session.deliveryAddress = "";
      session.fulfillmentType = "";
    }
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
    const lastBotLower = String(lastBot).toLowerCase();
    const isPlainTableNumber = /^\d{1,3}$/.test(trimmedText);
    if (botReplyIndicatesOrderHandedToRestaurant(lastBot) || botReplyIsStaleLoadedCartPrompt(lastBot)) {
      resetCheckoutSession(conversationKey);
      conversationState.delete(conversationKey);
      session = getOrCreateSession(conversationKey);
      updatedMessages = [text].filter(Boolean);
      conversationState.set(conversationKey, updatedMessages);
    } else if (isPlainTableNumber && (lastBotLower.includes("en qué mesa") || lastBotLower.includes("en que mesa"))) {
      // Si el ultimo prompt fue pedir numero de mesa, no forzar "1/2 agregar/continuar".
      session.status = "awaiting_table_number";
      if (!session.fulfillmentType) session.fulfillmentType = "mesa";
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

  const isNumericReply = /\b\d{1,3}\b/.test(trimmedText);
  if (isShortOptionMessage(trimmedText) || isNumericReply) {
    // Ultima red de seguridad: si llegamos aca con una respuesta corta de checkout
    // (1/2 o numero de mesa) y el ultimo turno del bot fue un prompt, intentamos
    // recuperar el estado y re-enrutar.
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
    } else if (lastBot.includes("cómo querés el pedido") || lastBot.includes("como queres el pedido")) {
      recoveredStatus = "awaiting_fulfillment";
    } else if (lastBot.includes("solo aceptamos") && lastBot.includes("retiro en el local")) {
      recoveredStatus = "awaiting_fulfillment";
    } else if (lastBot.includes("en qué mesa") || lastBot.includes("en que mesa")) {
      recoveredStatus = "awaiting_table_number";
    } else if (lastBot.includes("cómo preferís pagar") || lastBot.includes("como preferis pagar")) {
      recoveredStatus = "awaiting_payment";
    } else if (
      lastBot.includes("retiro en el local") &&
      (lastBot.includes("mercado pago") || lastBot.includes("mercadopago"))
    ) {
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

  // Saludo puro ("hola", "buenas", etc.): respuesta fija con la marca del
  // restaurante activo. Evita gastar tokens en el caso mas comun.
  if (isPureGreeting(text)) {
    const greetingReply = buildGreetingReply(restaurantContext);
    await saveInteraction({
      restaurantId: tenant.id,
      customerNumber,
      botNumber,
      messageType: "text",
      userMessage: text,
      botResponse: greetingReply,
      metadata: { status: "browsing", quickReply: "greeting" }
    });
    return greetingReply;
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
/** Referencia actual del cliente WA para el poller de MP (puede ser null hasta `ready`). */
let whatsappClientForPoller = null;

client.on("ready", () => {
  console.log("WhatsApp conectado y listo.");
  whatsappClientForPoller = client;
  try {
    if (typeof stopDeliveryNotifier === "function") {
      stopDeliveryNotifier();
    }
  } catch (_) {
    // ignore
  }
  stopDeliveryNotifier = startOrderDeliveryNotifier(client);
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

    if (!tenantBotWhatsappEnabled(tenant)) {
      return;
    }

    if (tenantEnforcesOpeningHours(tenant)) {
      const tenantBusinessHours = businessHoursForTenant(tenant);
      if (!isWithinBusinessHours(tenantBusinessHours)) {
        try {
          await saveInteraction({
            restaurantId: tenant.id,
            customerNumber,
            botNumber,
            messageType: message.type === "ptt" ? "audio" : "text",
            userMessage: message.body || null,
            botResponse: null,
            metadata: { status: "out_of_hours", businessHours: tenantBusinessHours }
          });
        } catch (logErr) {
          console.error("No pude registrar la interaccion fuera de horario:", logErr);
        }
        return;
      }
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
      const expectingShortReply = ["awaiting_payment", "awaiting_fulfillment", "awaiting_add_more", "awaiting_table_number"].includes(
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
  .then(() => {
    return cleanupChromiumProfileLocks();
  })
  .then(() => {
    stopPaymentPoller = startPaymentStatusPoller(() => whatsappClientForPoller);
    return client.initialize();
  })
  .catch((error) => {
    console.error("No se pudo inicializar el bot:", error);
    process.exit(1);
  });
