const fs = require("fs");
const OpenAI = require("openai");

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const MAX_AUDIO_SECONDS = 45;
/** Tope para la respuesta principal del bot (texto WhatsApp). */
const ASSISTANT_MAX_TOKENS = Number(process.env.ASSISTANT_MAX_TOKENS || 350);
/** Caracteres maximos para el bloque de historial inyectado al modelo. */
const HISTORY_MAX_CHARS = Number(process.env.HISTORY_MAX_CHARS || 6000);
/** Minimo de turnos a conservar aunque excedan el tope (red de seguridad de contexto). */
const HISTORY_MIN_TURNS = Number(process.env.HISTORY_MIN_TURNS || 4);

/**
 * Precios en USD por 1.000.000 de tokens. Default: gpt-4o-mini (mayo 2025).
 * Si OpenAI sube/baja precios o usas otro modelo, ajustalo via .env.
 */
const PRICE_INPUT_PER_M = Number(process.env.AI_PRICE_INPUT_PER_M || 0.15);
const PRICE_OUTPUT_PER_M = Number(process.env.AI_PRICE_OUTPUT_PER_M || 0.6);
/** Whisper se cobra por minuto (~ $0.006/min). */
const WHISPER_PRICE_PER_MIN = Number(process.env.AI_WHISPER_PRICE_PER_MIN || 0.006);

function estimateCostUsd(promptTokens, completionTokens) {
  const inUsd = (Number(promptTokens) || 0) * (PRICE_INPUT_PER_M / 1_000_000);
  const outUsd = (Number(completionTokens) || 0) * (PRICE_OUTPUT_PER_M / 1_000_000);
  return inUsd + outUsd;
}

/**
 * Formatea un costo USD en una cadena legible. Para montos bajos usa 6 decimales,
 * para montos > 0.01 usa 4 decimales.
 */
function formatUsd(usd) {
  const value = Number(usd) || 0;
  if (value === 0) return "$0";
  if (value < 0.01) return `$${value.toFixed(6)}`;
  return `$${value.toFixed(4)}`;
}

/**
 * Acumula consumo de tokens por dia y por proceso. Se imprime en logs:
 *   - una linea por cada llamada de IA (`[ai-tokens]`)
 *   - una linea de resumen al cambiar de dia (`[ai-tokens-day]`)
 * Para ver en runtime: `docker logs restobot-whatsapp | grep ai-tokens`.
 */
const tokenCounters = {
  date: new Date().toISOString().slice(0, 10),
  in: 0,
  out: 0,
  total: 0,
  calls: 0,
  costUsd: 0,
  whisperSeconds: 0,
  whisperCostUsd: 0
};

function flushDailyCountersIfNeeded() {
  const today = new Date().toISOString().slice(0, 10);
  if (today === tokenCounters.date) return;
  const totalCostUsd = tokenCounters.costUsd + tokenCounters.whisperCostUsd;
  console.log(
    `[ai-tokens-day] ${tokenCounters.date} calls=${tokenCounters.calls} ` +
      `in=${tokenCounters.in} out=${tokenCounters.out} total=${tokenCounters.total} ` +
      `chat=${formatUsd(tokenCounters.costUsd)} ` +
      `whisper=${formatUsd(tokenCounters.whisperCostUsd)} (${tokenCounters.whisperSeconds.toFixed(1)}s) ` +
      `cost=${formatUsd(totalCostUsd)}`
  );
  tokenCounters.date = today;
  tokenCounters.in = 0;
  tokenCounters.out = 0;
  tokenCounters.total = 0;
  tokenCounters.calls = 0;
  tokenCounters.costUsd = 0;
  tokenCounters.whisperSeconds = 0;
  tokenCounters.whisperCostUsd = 0;
}

function logUsage(fnName, usage) {
  if (!usage) return;
  flushDailyCountersIfNeeded();
  const promptTokens = Number(usage.prompt_tokens || 0);
  const completionTokens = Number(usage.completion_tokens || 0);
  const totalTokens = Number(usage.total_tokens || promptTokens + completionTokens);
  const costUsd = estimateCostUsd(promptTokens, completionTokens);
  tokenCounters.in += promptTokens;
  tokenCounters.out += completionTokens;
  tokenCounters.total += totalTokens;
  tokenCounters.calls += 1;
  tokenCounters.costUsd += costUsd;
  console.log(
    `[ai-tokens] ${fnName} in=${promptTokens} out=${completionTokens} total=${totalTokens} ` +
      `cost=${formatUsd(costUsd)} day=${formatUsd(tokenCounters.costUsd + tokenCounters.whisperCostUsd)}`
  );
}

/**
 * Loguea un uso de Whisper (transcripcion de audio). El costo se estima por
 * duracion en segundos contra `WHISPER_PRICE_PER_MIN`.
 */
function logWhisperUsage(durationSeconds) {
  flushDailyCountersIfNeeded();
  const seconds = Math.max(0, Number(durationSeconds) || 0);
  const costUsd = (seconds / 60) * WHISPER_PRICE_PER_MIN;
  tokenCounters.whisperSeconds += seconds;
  tokenCounters.whisperCostUsd += costUsd;
  console.log(
    `[ai-tokens] whisperTranscribe seconds=${seconds.toFixed(1)} ` +
      `cost=${formatUsd(costUsd)} day=${formatUsd(tokenCounters.costUsd + tokenCounters.whisperCostUsd)}`
  );
}

/**
 * Recorta el historial mas viejo si excede `HISTORY_MAX_CHARS`, conservando
 * siempre los ultimos `HISTORY_MIN_TURNS` turnos. Retorna nuevo array.
 */
function trimHistoryByChars(history = [], { maxChars = HISTORY_MAX_CHARS, minTurns = HISTORY_MIN_TURNS } = {}) {
  if (!Array.isArray(history) || history.length <= minTurns) return history || [];
  const out = [];
  let used = 0;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const entry = history[i];
    const txt = `${entry?.user_message || ""}${entry?.bot_response || ""}`;
    if (out.length >= minTurns && used + txt.length > maxChars) break;
    out.unshift(entry);
    used += txt.length;
  }
  return out;
}

/**
 * Cache en memoria para `buildRestaurantContextText`. El context cambia poco
 * (datos del restaurante + menu disponible). Cache invalidable manualmente.
 */
const CONTEXT_CACHE_TTL_MS = Number(process.env.CONTEXT_CACHE_TTL_MS || 5 * 60 * 1000);
const contextTextCache = new Map(); // restaurantId -> { signature, text, expiresAt }

function cacheSignatureForContext(context) {
  const restaurant = context?.restaurant || {};
  const menu = Array.isArray(context?.menuItems) ? context.menuItems : [];
  const menuKey = menu.map((m) => `${m.id}:${m.price}:${m.available ? 1 : 0}`).join("|");
  return [
    restaurant.id || "",
    restaurant.name || "",
    restaurant.opening_hours || "",
    restaurant.address || "",
    restaurant.delivery_zones || "",
    restaurant.public_name || "",
    typeof restaurant.policies === "string" ? restaurant.policies : JSON.stringify(restaurant.policies || ""),
    menuKey
  ].join("::");
}

function invalidateContextCache(restaurantId) {
  if (restaurantId) contextTextCache.delete(restaurantId);
  else contextTextCache.clear();
}

/**
 * Limpia fences de markdown / texto extra alrededor de un JSON y parsea.
 * Devuelve null si no se puede parsear.
 */
function safeParseJson(raw) {
  if (!raw) return null;
  let s = String(raw).trim();
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  const firstBrace = s.search(/[{[]/);
  const lastBrace = Math.max(s.lastIndexOf("}"), s.lastIndexOf("]"));
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    s = s.slice(firstBrace, lastBrace + 1);
  }
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function resolvePublicBrandName(restaurantContext) {
  const fromPublic = String(restaurantContext?.restaurant?.public_name || "").trim();
  if (fromPublic) return fromPublic;
  const fromEnv = (process.env.RESTAURANT_PUBLIC_NAME || "").trim();
  if (fromEnv) return fromEnv;
  const fromDb = String(restaurantContext?.restaurant?.name || "").trim();
  return fromDb || "Tu restaurante";
}

function resolveBotDisplayName() {
  return (process.env.BOT_DISPLAY_NAME || "RestoBot").trim() || "RestoBot";
}

/**
 * Fuerza visibilidad de marca en WhatsApp: primera línea *Bot · Marca* si el modelo no la puso.
 */
function withRestobotHeader(body, botName, brandName) {
  const t = String(body || "").trim();
  if (!t) return t;
  const firstLine = t.split("\n")[0].toLowerCase();
  const botLower = botName.toLowerCase();
  const brandLower = brandName.toLowerCase();
  if (firstLine.includes(botLower) || firstLine.includes(brandLower.split(/\s+/)[0] || "")) {
    return t;
  }
  return `*${botName} · ${brandName}*\n\n${t}`;
}

function formatMenu(menuItems) {
  if (!menuItems || !menuItems.length) return "Menu no disponible.";

  return menuItems
    .map((item) => {
      const price = item.price != null ? `$${item.price}` : "precio a consultar";
      const description = item.description ? ` - ${item.description}` : "";
      const tags = item.tags?.length ? ` [${item.tags.join(", ")}]` : "";
      return `- ${item.name} (${price})${description}${tags}`;
    })
    .join("\n");
}

function buildRestaurantContextText(context) {
  if (!context || !context.restaurant) {
    return "No se encontro contexto del restaurante.";
  }

  const restaurantId = context.restaurant.id || "";
  const signature = cacheSignatureForContext(context);
  const cached = contextTextCache.get(restaurantId);
  if (cached && cached.signature === signature && cached.expiresAt > Date.now()) {
    return cached.text;
  }

  const { restaurant, menuItems } = context;
  const openingHours = String(restaurant.opening_hours || "").trim() || "No informado";
  const address = String(restaurant.address || "").trim();
  const deliveryZones = String(restaurant.delivery_zones || "").trim();
  const policiesRaw = restaurant.policies;
  const policies =
    typeof policiesRaw === "string"
      ? policiesRaw.trim()
      : policiesRaw
        ? JSON.stringify(policiesRaw)
        : "";
  const brandName = resolvePublicBrandName(context);
  const botName = resolveBotDisplayName();

  const lines = [
    `Identidad del canal WhatsApp: ${botName} (asistente virtual de ${brandName}). El cliente escribe a este numero como canal oficial de ${brandName}.`,
    `Nombre en base de datos (referencia): ${restaurant.name || brandName}`,
    `Marca publica (mensajes y ticket): ${brandName}`,
    `Horario de atencion: ${openingHours}`,
    address ? `Direccion / ubicacion del local: ${address}` : "Direccion / ubicacion del local: no cargada en el sistema (no inventes una).",
    deliveryZones ? `Zonas de delivery cubiertas: ${deliveryZones}` : "Zonas de delivery: no especificadas en el sistema.",
    policies ? `Politicas: ${policies}` : "Politicas: sin politicas adicionales cargadas.",
    "Menu:",
    formatMenu(menuItems)
  ];
  const text = lines.join("\n");

  if (restaurantId) {
    contextTextCache.set(restaurantId, {
      signature,
      text,
      expiresAt: Date.now() + CONTEXT_CACHE_TTL_MS
    });
  }
  return text;
}

// Estados de interacciones que NO queremos que la IA tome como ejemplo de respuesta.
// - out_of_hours: para que no copie "estamos cerrados" cuando ya estamos abiertos de nuevo.
// - order_handed_off: para que un pedido finalizado no contamine el armado del proximo pedido.
const NON_CONVERSATIONAL_STATUSES = new Set(["out_of_hours", "order_handed_off"]);

function mapHistoryToMessages(history = []) {
  const messages = [];
  history.forEach((entry) => {
    const status = entry?.metadata?.status;
    if (status && NON_CONVERSATIONAL_STATUSES.has(status)) {
      return;
    }
    if (entry.user_message) {
      messages.push({ role: "user", content: entry.user_message });
    }
    if (entry.bot_response) {
      messages.push({ role: "assistant", content: entry.bot_response });
    }
  });
  return messages;
}

async function transcribeAudioWithWhisper({ filePath, durationSeconds }) {
  if (!filePath) {
    throw new Error("filePath es obligatorio para transcribir.");
  }

  if (durationSeconds > MAX_AUDIO_SECONDS) {
    return {
      tooLong: true,
      transcript: null,
      maxSeconds: MAX_AUDIO_SECONDS
    };
  }

  const result = await openai.audio.transcriptions.create({
    file: fs.createReadStream(filePath),
    model: "whisper-1",
    language: "es"
  });

  logWhisperUsage(durationSeconds);

  return {
    tooLong: false,
    transcript: (result.text || "").trim(),
    maxSeconds: MAX_AUDIO_SECONDS
  };
}

/**
 * Respuesta corta y a medida sobre un producto (ingredientes vs "como es" vs definicion).
 * No pega la descripcion cruda entera.
 */
async function generateProductQuestionAnswer({ customerMessage, menuItem, restaurantContext }) {
  const brandName = resolvePublicBrandName(restaurantContext);
  const botName = resolveBotDisplayName();
  const rawDesc = String(menuItem?.description || "").trim();
  const payload = {
    pregunta_cliente: customerMessage,
    producto_nombre_menu: menuItem?.name || "",
    descripcion_cargada_en_base: rawDesc || null,
    precio_numero: menuItem?.price != null ? Number(menuItem.price) : null,
    categoria: menuItem?.category || null
  };

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.35,
    max_tokens: 380,
    messages: [
      {
        role: "system",
        content: [
          `Eres ${botName}, asistente de ${brandName} en WhatsApp.`,
          "Recibis datos JSON con la pregunta del cliente y la ficha del producto.",
          "La descripcion en base puede ser larga o incompleta: es solo material de trabajo.",
          "REGLAS OBLIGATORIAS:",
          "- NO copies ni pegues la descripcion entera. No uses formato 'Nombre: texto largo'.",
          "- Contesta SOLO lo que la pregunta pide:",
          "  * Preguntas de contenido (que trae, que tiene, que lleva, incluye, ingredientes, de que esta hecho): lista en pocas palabras lo que indique el texto o lo inferible; si no hay datos, decilo en una frase. No inventes ingredientes.",
          "  * 'Como es', 'como viene', presentacion: resume formato/presentacion si aparece; si no, una frase honesta.",
          "  * 'Que es', definicion breve: una o dos oraciones.",
          "- Si no hay descripcion cargada: deci que el detalle no esta cargado, menciona el precio si hay numero, y ofrece ayuda para pedir.",
          "- Maximo 4 oraciones cortas. Tono conversacional. Podes usar el nombre del producto en negrita con * asi *nombre*.",
          "- No inventes alergenos ni datos medicos."
        ].join(" ")
      },
      {
        role: "user",
        content: JSON.stringify(payload)
      }
    ]
  });

  logUsage("generateProductQuestionAnswer", completion.usage);
  const raw = (completion.choices?.[0]?.message?.content || "").trim();
  const withHeader = withRestobotHeader(raw, botName, brandName);
  return withHeader;
}

async function generateAssistantResponse({
  customerMessage,
  restaurantContext,
  chatHistory = [],
  isFirstContact = false
}) {
  const contextText = buildRestaurantContextText(restaurantContext);
  const brandName = resolvePublicBrandName(restaurantContext);
  const botName = resolveBotDisplayName();
  const trimmedHistory = trimHistoryByChars(chatHistory);
  const historyMessages = mapHistoryToMessages(trimmedHistory);

  const identityIntro =
    `Tu nombre es ${botName}. Representas unicamente a ${brandName} en WhatsApp. ` +
    `Nunca hables como un asistente generico de OpenAI ni digas que eres una IA sin marca. ` +
    `Voz: cordial, del canal oficial del restaurante.`;

  const styleRule =
    `Prohibido abrir con frases genericas tipo "Hola, en que puedo ayudarte hoy" sin decir quien sos. ` +
    `Si saludan, menciona ${botName} y ${brandName} en la primera oracion o dos.`;

  const firstVisitRule =
    `IMPORTANTE: Es el PRIMER mensaje de esta conversacion con este cliente. Saluda con ${botName} de ${brandName}, y ofrece menu, pedidos, horario o ubicacion (breve). No listes el menu entero salvo que pidan verlo.`;

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.3,
    max_tokens: ASSISTANT_MAX_TOKENS,
    messages: [
      {
        role: "system",
        content: [
          identityIntro,
          styleRule,
          ...(isFirstContact ? [firstVisitRule] : []),
          "Tenes este menu disponible segun contexto.",
          "Si el cliente pide algo que no esta en la lista, decile amablemente que no contamos con eso.",
          "No limites cantidades salvo que el producto este disponible=false en el contexto.",
          "Si el cliente dice algo de seguimiento como 'quiero dos' o 'si, quiero una', interpreta que se refiere al ultimo producto en conversacion.",
          "Nunca preguntes por alergias. Nunca menciones alergias salvo que el cliente lo pida explicitamente.",
          "El canal YA es WhatsApp: nunca pidas 'enviame por WhatsApp' ni digas que luego escribiras por WhatsApp.",
          "No inventes precios ni productos.",
          "Datos del local (horario, direccion, zonas de delivery, politicas) estan en el bloque 'Contexto del restaurante'. Si un dato no esta cargado, decilo con honestidad: NO inventes ubicacion, horario ni zona de cobertura.",
          "Responde segun lo que el cliente pregunte: no des toda la informacion junta si no te la pidieron.",
          "Si preguntan por ubicacion, usa exactamente la direccion del contexto y suma el horario en el mismo mensaje.",
          "Si preguntan por horario o si atienden, usa el horario del contexto y de forma natural ofrece ayuda para pedir.",
          "IMPORTANTE: NO confirmes pedidos vos mismo. Nunca digas '¡Listo!', 'Perfecto, un X por $Y' ni frases que simulen que tomaste el pedido. El sistema se encarga de registrar y totalizar. Si el cliente menciona un producto del menu, limitate a confirmar que existe y esta disponible, repetir el nombre EXACTO como figura en el menu, y pedirle que confirme con ese nombre para armar el pedido.",
          "Nunca preguntes '¿Querés agregar algo más?' ni uses un formato que imite un carrito. Eso lo hace el sistema.",
          "Si el cliente pide ver el menu o responde 'si' a '¿Queres ver el menu?', listá los productos disponibles con su precio tal como figuran en el contexto (sin inventar descripciones).",
          "Cada producto tiene una categoria en el contexto (ej. combos, pizza). Si preguntan por combos, pizzas u otra seccion, deciles que pueden escribir 'combos', 'pizzas' o 'menu' para ver listados; no inventes categorias que no aparezcan en el menu.",
          "Responde en espanol claro, breve y comercial."
        ].join(" ")
      },
      {
        role: "system",
        content: `Contexto del restaurante y lista_de_productos:\n${contextText}`
      },
      ...historyMessages,
      {
        role: "user",
        content: customerMessage
      }
    ]
  });

  logUsage("generateAssistantResponse", completion.usage);
  const raw = (completion.choices?.[0]?.message?.content || "")
    .replace(/\s+\n/g, "\n")
    .trim();
  return withRestobotHeader(raw, botName, brandName);
}

async function generateOrderQuote({ conversationText, restaurantContext, chatHistory = [] }) {
  const contextText = buildRestaurantContextText(restaurantContext);
  const trimmedHistory = trimHistoryByChars(chatHistory);
  const historyMessages = mapHistoryToMessages(trimmedHistory);
  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0,
    response_format: { type: "json_object" },
    max_tokens: 400,
    messages: [
      {
        role: "system",
        content: [
          "Analiza la conversacion del cliente y arma un resumen del pedido solo con productos del menu disponible.",
          "Si el cliente pide algo fuera del menu, no lo incluyas y marca hasOrder=false si no queda ningun item valido.",
          "Si el usuario usa referencias como 'quiero dos' o 'si, quiero una', asocia esa cantidad al ultimo producto discutido en la charla.",
          "No inventes productos ni precios.",
          "Responde SOLO JSON valido con esta estructura:",
          '{"hasOrder": boolean, "details": string, "items": string[], "totalAmount": number, "deliveryAddress": string, "missingItemsMessage": string}'
        ].join(" ")
      },
      {
        role: "system",
        content: `Menu y contexto:\n${contextText}`
      },
      ...historyMessages,
      {
        role: "user",
        content: `Conversacion:\n${conversationText}`
      }
    ]
  });

  logUsage("generateOrderQuote", completion.usage);
  const raw = (completion.choices?.[0]?.message?.content || "").trim();
  const parsed = safeParseJson(raw);
  if (!parsed) {
    return {
      hasOrder: false,
      details: "",
      items: [],
      totalAmount: 0,
      deliveryAddress: "",
      missingItemsMessage: "No logre interpretar el pedido con claridad. Confirmame nuevamente los productos."
    };
  }

  return {
    hasOrder: Boolean(parsed.hasOrder),
    details: String(parsed.details || "").trim(),
    items: Array.isArray(parsed.items) ? parsed.items.map((item) => String(item)) : [],
    totalAmount: Number(parsed.totalAmount || 0),
    deliveryAddress: String(parsed.deliveryAddress || "").trim(),
    missingItemsMessage: String(parsed.missingItemsMessage || "").trim()
  };
}

/**
 * Cache LRU simple por texto de mensaje. Evita pagar OpenAI cuando el cliente
 * repite la misma direccion (typo, doble envio). Capado para no consumir RAM.
 */
const ADDRESS_INTENT_CACHE_MAX = 200;
const addressIntentCache = new Map();

function addressIntentCacheKey(text) {
  return String(text || "").trim().toLowerCase().slice(0, 80);
}

async function detectAddressIntent({ customerMessage, chatHistory = [] }) {
  const cacheKey = addressIntentCacheKey(customerMessage);
  if (cacheKey && addressIntentCache.has(cacheKey)) {
    return addressIntentCache.get(cacheKey);
  }

  // Solo el ultimo turno (1 ida y vuelta) — el detector no necesita mas contexto
  // y reducimos ~70% el costo por llamada.
  const trimmedHistory = trimHistoryByChars(chatHistory, { maxChars: 400, minTurns: 1 });
  const historyMessages = mapHistoryToMessages(trimmedHistory);
  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0,
    response_format: { type: "json_object" },
    max_tokens: 120,
    messages: [
      {
        role: "system",
        content:
          'Detecta si el mensaje del cliente contiene direccion de entrega. Responde SOLO JSON: {"isAddress": boolean, "normalizedAddress": string}.'
      },
      ...historyMessages,
      { role: "user", content: customerMessage }
    ]
  });

  logUsage("detectAddressIntent", completion.usage);
  const raw = (completion.choices?.[0]?.message?.content || "").trim();
  const parsed = safeParseJson(raw);
  const result = parsed
    ? {
        isAddress: Boolean(parsed.isAddress),
        normalizedAddress: String(parsed.normalizedAddress || "").trim()
      }
    : { isAddress: false, normalizedAddress: "" };

  if (cacheKey) {
    if (addressIntentCache.size >= ADDRESS_INTENT_CACHE_MAX) {
      const firstKey = addressIntentCache.keys().next().value;
      addressIntentCache.delete(firstKey);
    }
    addressIntentCache.set(cacheKey, result);
  }
  return result;
}

module.exports = {
  MAX_AUDIO_SECONDS,
  transcribeAudioWithWhisper,
  generateProductQuestionAnswer,
  generateAssistantResponse,
  generateOrderQuote,
  detectAddressIntent,
  invalidateContextCache,
  resolvePublicBrandName,
  resolveBotDisplayName
};
