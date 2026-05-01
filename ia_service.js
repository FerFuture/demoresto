const fs = require("fs");
const OpenAI = require("openai");

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const MAX_AUDIO_SECONDS = 45;

function resolvePublicBrandName(restaurantContext) {
  const fromDb = restaurantContext?.restaurant?.name || "";
  return (process.env.RESTAURANT_PUBLIC_NAME || "").trim() || fromDb || "Restaurante Palermo";
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

  const { restaurant, menuItems } = context;
  const openingHours = restaurant.opening_hours || "No informado";
  const policies = restaurant.policies || "Sin politicas cargadas";
  const brandName = resolvePublicBrandName(context);
  const botName = resolveBotDisplayName();

  return [
    `Identidad del canal WhatsApp: ${botName} (asistente virtual de ${brandName}). El cliente escribe a este numero como canal oficial de ${brandName}.`,
    `Nombre en base de datos (referencia): ${restaurant.name || brandName}`,
    `Marca publica (mensajes y ticket): ${brandName}`,
    `Horario: ${openingHours}`,
    `Politicas: ${typeof policies === "string" ? policies : JSON.stringify(policies)}`,
    "Menu:",
    formatMenu(menuItems)
  ].join("\n");
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
  const historyMessages = mapHistoryToMessages(chatHistory);

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
          "Informacion fija del local: horario de atencion 8:00 a 22:00, ubicacion Plaza Independencia calle 666, atencion en local y delivery en zonas cercanas.",
          "Responde segun lo que el cliente pregunte: no des toda la informacion junta si no te la pidieron.",
          "Si preguntan por ubicacion, responde la ubicacion y tambien el horario de atencion en el mismo mensaje.",
          "Si preguntan por horario o si atienden, responde el horario (8:00 a 22:00) y de forma natural ofrece ayuda para pedir.",
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

  const raw = (completion.choices?.[0]?.message?.content || "")
    .replace(/\s+\n/g, "\n")
    .trim();
  return withRestobotHeader(raw, botName, brandName);
}

async function generateOrderQuote({ conversationText, restaurantContext, chatHistory = [] }) {
  const contextText = buildRestaurantContextText(restaurantContext);
  const historyMessages = mapHistoryToMessages(chatHistory);
  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0,
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

  const raw = (completion.choices?.[0]?.message?.content || "").trim();
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
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

async function detectAddressIntent({ customerMessage, chatHistory = [] }) {
  const historyMessages = mapHistoryToMessages(chatHistory);
  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0,
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

  const raw = (completion.choices?.[0]?.message?.content || "").trim();
  try {
    const parsed = JSON.parse(raw);
    return {
      isAddress: Boolean(parsed.isAddress),
      normalizedAddress: String(parsed.normalizedAddress || "").trim()
    };
  } catch (_) {
    return {
      isAddress: false,
      normalizedAddress: ""
    };
  }
}

module.exports = {
  MAX_AUDIO_SECONDS,
  transcribeAudioWithWhisper,
  generateProductQuestionAnswer,
  generateAssistantResponse,
  generateOrderQuote,
  detectAddressIntent
};
