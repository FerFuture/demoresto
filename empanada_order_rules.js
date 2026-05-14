/**
 * Reglas de pedido para empanadas: solo se venden por *media docena* o *1 docena*
 * (ítems separados en menú por sabor). Evita confusiones del modelo / match directo.
 */

const EMPANADA_PENDING_TTL_MS = Number(process.env.EMPANADA_PENDING_TTL_MS || 10 * 60 * 1000);

function norm(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function mentionsEmpanadas(n) {
  return /\bempanad/.test(n);
}

/** Pedido de empanadas por nombre o frases tipo "docena de pollo" / "media docena de carne". */
function isLikelyEmpanadaTopic(n) {
  if (mentionsEmpanadas(n)) return true;
  const filling = detectEmpanadaFilling(n);
  if (!filling) return false;
  return /\b(media\s+docena|una\s+docena|1\s+docena|docena|seis|doce|\b6\b|\b12\b)\b/.test(n);
}

/** @returns {'carne'|'pollo'|null} */
function detectEmpanadaFilling(n) {
  const hasPollo = /\bpollo\b/.test(n);
  const hasCarne = /\bcarne\b/.test(n);
  if (hasPollo && hasCarne) return null;
  if (hasPollo) return "pollo";
  if (hasCarne) return "carne";
  return null;
}

function hasClearEmpanadaPackPhrase(n) {
  if (/\bmedia\s+docena\b/.test(n)) return true;
  if (/\bmedia\b/.test(n) && /\bdocena\b/.test(n)) return true;
  if (/\b(una\s+docena|1\s+docena)\b/.test(n)) return true;
  if (/\bdocena\b/.test(n) && !/\bmedia\b/.test(n)) return true;
  if (/\b(doce|12)\b/.test(n)) return true;
  if (/\b(seis|6)\b/.test(n)) return true;
  return false;
}

/**
 * 6 o 12 = media docena / docena; "media docena", "1 docena", etc.
 * @returns {'media'|'docena'|null}
 */
function detectPackKind(n) {
  if (/\bmedia\s+docena\b/.test(n)) return "media";
  if (/\bmedia\b/.test(n) && /\bdocena\b/.test(n)) return "media";
  if (/\b(seis|6)\b/.test(n)) return "media";
  if (/\b(doce|12)\b/.test(n)) return "docena";
  if (/\b(una\s+docena|1\s+docena)\b/.test(n)) return "docena";
  if (/\bdocena\b/.test(n) && !/\bmedia\b/.test(n)) return "docena";
  return null;
}

/**
 * Un solo ítem de menú para "6 empanadas de carne" / "media docena de pollo", etc.
 * Evita que el match por texto repita 6 veces el producto.
 */
function tryEmpanadaPackDirectOrder(text, menuItems) {
  const n = norm(text);
  if (!isLikelyEmpanadaTopic(n)) return null;
  const filling = detectEmpanadaFilling(n);
  if (!filling) return null;
  if (hasForbiddenLooseEmpanadaQuantity(n)) return null;
  const kind = detectPackKind(n);
  if (!kind) return null;
  const item = findEmpanadaMenuItem(menuItems, filling, kind === "media");
  return buildDirectOrderFromItem(item);
}

/**
 * Cantidades sueltas no vendidas (solo packs de 6 o 12 en menú).
 * No dispara si ya hay formato claro de docena/media.
 */
function hasForbiddenLooseEmpanadaQuantity(n) {
  if (!mentionsEmpanadas(n)) return false;
  if (hasClearEmpanadaPackPhrase(n)) return false;

  if (/\bcuarta\b/.test(n)) return true;
  if (/\bcuarto\b/.test(n)) return true;
  if (/\bun(?:a)?\s+empanada\b/.test(n)) return true;

  const badWordBeforeEmp = [
    "dos",
    "tres",
    "cuatro",
    "cinco",
    "siete",
    "ocho",
    "nueve",
    "diez",
    "once"
  ];
  for (const w of badWordBeforeEmp) {
    if (new RegExp(`\\b${w}\\s+empanad`).test(n)) return true;
  }

  const digitMatch = n.match(/\b(\d{1,2})\s+empanad/);
  if (digitMatch) {
    const num = parseInt(digitMatch[1], 10);
    if (num !== 6 && num !== 12) return true;
  }

  return false;
}

/**
 * Tras pedir aclaración: interpreta respuesta corta o frase con formato.
 * @returns {'media'|'docena'|null}
 */
function parseEmpanadaPackChoice(rawText) {
  const n = norm(rawText);
  if (!n) return null;

  if (/\bmedia\s+docena\b/.test(n)) return "media";
  if (/\bmedia\b/.test(n) && /\bdocena\b/.test(n)) return "media";
  if (/\b(una\s+docena|1\s+docena)\b/.test(n)) return "docena";
  if (/\bdoce\b/.test(n) || /\b12\b/.test(n)) return "docena";
  if (/\b(seis|6)\b/.test(n)) return "media";
  if (/^media$/i.test(n.trim()) || /\bla\s+media\b/.test(n)) return "media";
  if (/\bdocena\b/.test(n) && !/\bmedia\b/.test(n)) return "docena";
  return null;
}

function findEmpanadaMenuItem(menuItems, filling, wantMediaDocena) {
  const f = norm(filling);
  for (const m of menuItems || []) {
    const name = norm(m.name || "");
    if (!name.includes("empanad") || !name.includes(f)) continue;
    const isMedia =
      name.includes("media") && name.includes("docena");
    const isOneDocena =
      name.includes("1 docena") ||
      (name.includes("docena") && !name.includes("media"));
    if (wantMediaDocena && isMedia) return m;
    if (!wantMediaDocena && isOneDocena && !isMedia) return m;
  }
  return null;
}

function buildDirectOrderFromItem(item) {
  if (!item) return null;
  const price = Number(item.price || 0);
  if (!Number.isFinite(price) || price <= 0) return null;
  const name = String(item.name || "").trim();
  return {
    details: name,
    items: [name],
    totalAmount: price
  };
}

const MSG_ONLY_PACKS =
  "Las empanadas solo se venden por *media docena* (6) o *una docena* (12), como figura en el menú. " +
  "Decime por ejemplo *empanadas de carne media docena* o *empanadas de pollo una docena*.";

function buildClarifyMessage(filling) {
  const r = filling === "pollo" ? "pollo" : "carne";
  return (
    `¿Querés *media docena* o *una docena* de empanadas de ${r}? ` +
    `Respondé *media docena*, *una docena* o como prefieras (también vale *seis* / *doce* si era esa la cantidad).`
  );
}

/**
 * Si aplica reglas de empanadas, devuelve texto de respuesta y opcionalmente deja pending en session.
 * @returns {{ reply: string } | null}
 */
function maybeEmpanadaQuantityGate(text, menuItems, session) {
  const pe = session?.pendingEmpanadaChoice;
  if (pe && Date.now() - (pe.createdAt || 0) > EMPANADA_PENDING_TTL_MS) {
    session.pendingEmpanadaChoice = null;
  }

  const n = norm(text);
  if (!isLikelyEmpanadaTopic(n)) return null;

  const filling = detectEmpanadaFilling(n);
  if (!filling) return null;

  if (hasForbiddenLooseEmpanadaQuantity(n)) {
    session.pendingEmpanadaChoice = null;
    if (session.pendingPersonPortionChoice) session.pendingPersonPortionChoice = null;
    return { reply: MSG_ONLY_PACKS };
  }

  if (hasClearEmpanadaPackPhrase(n)) {
    return null;
  }

  session.pendingEmpanadaChoice = {
    filling,
    createdAt: Date.now()
  };
  if (session.pendingPersonPortionChoice) session.pendingPersonPortionChoice = null;
  return { reply: buildClarifyMessage(filling) };
}

/**
 * Consumir aclaración docena/media pendiente.
 * @returns {{ order: ReturnType<buildDirectOrderFromItem> } | { reply: string } | null}
 */
function tryResolvePendingEmpanadaOrder(session, text, menuItems) {
  const p = session?.pendingEmpanadaChoice;
  if (!p || !p.filling) return null;
  if (Date.now() - (p.createdAt || 0) > EMPANADA_PENDING_TTL_MS) {
    session.pendingEmpanadaChoice = null;
    return null;
  }

  const pack = parseEmpanadaPackChoice(text);
  if (!pack) return null;

  const item = findEmpanadaMenuItem(
    menuItems,
    p.filling,
    pack === "media"
  );
  session.pendingEmpanadaChoice = null;
  if (!item) {
    return {
      reply:
        "No encontré empanadas de ese tipo en el menú actual. Escribí *empanadas* o *menú* para ver las opciones y precios."
    };
  }
  const order = buildDirectOrderFromItem(item);
  if (!order) {
    return {
      reply: "Hubo un problema con el precio de las empanadas en el menú. Escribí *menú* o probá de nuevo en un minuto."
    };
  }
  return { order };
}

module.exports = {
  EMPANADA_PENDING_TTL_MS,
  maybeEmpanadaQuantityGate,
  tryResolvePendingEmpanadaOrder,
  MSG_ONLY_PACKS,
  parseEmpanadaPackChoice,
  hasForbiddenLooseEmpanadaQuantity,
  findEmpanadaMenuItem,
  tryEmpanadaPackDirectOrder,
  isLikelyEmpanadaTopic
};
