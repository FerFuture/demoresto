/**
 * Productos con variantes *(1 persona)* vs *(2 personas)* en el nombre del menú.
 * Solo se listan ítems disponibles (`menuItems` ya viene filtrado por available=true).
 * Si hay una sola variante disponible, no se pregunta; si hay dos y el texto es ambiguo, se aclara.
 */

const PERSON_PORTION_PENDING_TTL_MS = Number(
  process.env.PERSON_PORTION_PENDING_TTL_MS || 10 * 60 * 1000
);

/** Misma lógica que `extractQuantityBeforePosition` en index.js (evita dependencia circular). */
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

const QTY_FILLER_BEFORE_BASE = new Set([
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
  "un",
  "una",
  "unos",
  "unas"
]);

/**
 * Cantidad inmediatamente antes del nombre base del plato (ej. "2 costeleta de carne ...").
 */
function extractQtyBeforePersonBase(normUser, normBase) {
  const idx = normUser.indexOf(normBase);
  if (idx <= 0) return 1;
  const window = normUser.slice(Math.max(0, idx - 48), idx).trim();
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
    if (!QTY_FILLER_BEFORE_BASE.has(t)) break;
  }
  return 1;
}

function norm(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * @param {string} name
 * @returns {{ baseRaw: string, persons: 1 | 2 } | null}
 */
function parsePersonSuffix(name) {
  const raw = String(name || "").trim();
  const m1 = raw.match(/^(.+?)\s*\(\s*1\s+persona\s*\)\s*$/i);
  if (m1) return { baseRaw: m1[1].trim(), persons: 1 };
  const m2 = raw.match(/^(.+?)\s*\(\s*2\s+personas?\s*\)\s*$/i);
  if (m2) return { baseRaw: m2[1].trim(), persons: 2 };
  return null;
}

/** @returns {1 | 2 | null} intención explícita en el texto del cliente */
function detectExplicitPersonIntent(n) {
  const two =
    /\b(2\s+personas?|dos\s+personas?|para\s+dos|para\s+2\b)\b/.test(n) ||
    /\bde\s+2\b/.test(n);
  const one =
    /\b(1\s+persona|una\s+persona|para\s+uno|individual)\b/.test(n) ||
    /\bde\s+1\b/.test(n) ||
    /\bpara\s+1\b/.test(n);

  if (two && one) return null;
  if (two) return 2;
  if (one) return 1;
  return null;
}

/**
 * Agrupa ítems del menú por nombre base (sin sufijo persona).
 * @returns {Map<string, { baseRaw: string, normBase: string, items: Map<1|2, object> }>}
 */
function buildPersonPortionGroups(menuItems) {
  /** @type {Map<string, { baseRaw: string, normBase: string, items: Map<number, object> }>} */
  const groups = new Map();

  for (const item of menuItems || []) {
    const parsed = parsePersonSuffix(item?.name || "");
    if (!parsed) continue;
    const price = Number(item?.price || 0);
    if (!Number.isFinite(price) || price <= 0) continue;

    const nb = norm(parsed.baseRaw);
    if (!nb || nb.length < 4) continue;

    let g = groups.get(nb);
    if (!g) {
      g = { baseRaw: parsed.baseRaw, normBase: nb, items: new Map() };
      groups.set(nb, g);
    }
    g.items.set(parsed.persons, item);
  }

  return groups;
}

function userTextCoversBase(normUser, normBase) {
  if (!normUser || !normBase || normBase.length < 5) return false;
  return normUser.includes(normBase);
}

/**
 * Elige el grupo más específico cuya base aparece en el texto (bases más largas primero).
 */
function findBestMatchingGroup(normUser, groups) {
  const list = Array.from(groups.values()).sort(
    (a, b) => b.normBase.length - a.normBase.length
  );
  for (const g of list) {
    if (g.items.size === 0) continue;
    if (userTextCoversBase(normUser, g.normBase)) return g;
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

function clarifyMessage(baseRaw) {
  const label = baseRaw.trim();
  return (
    `¿El *${label}* es para *1 persona* o para *2 personas*? ` +
    `Respondé *1 persona*, *2 personas*, *uno* o *dos*.`
  );
}

function onlyVariantUnavailableMsg(requestedPersons, availablePersons, baseRaw) {
  const label = baseRaw.trim();
  if (requestedPersons === 2 && availablePersons === 1) {
    return (
      `Por ahora el *${label}* para *2 personas* no está disponible en el menú. ` +
      `¿Querés el de *1 persona* o preferís otro plato?`
    );
  }
  if (requestedPersons === 1 && availablePersons === 2) {
    return (
      `Por ahora tenemos el *${label}* solo para *2 personas*. ` +
      `¿Te sirve ese o preferís otro plato?`
    );
  }
  return `No encontré ese formato para *${label}*. Escribí *menú* para ver opciones.`;
}

/**
 * @returns {{ reply: string } | null}
 */
function maybePersonPortionGate(text, menuItems, session) {
  const pe = session?.pendingPersonPortionChoice;
  if (pe && Date.now() - (pe.createdAt || 0) > PERSON_PORTION_PENDING_TTL_MS) {
    session.pendingPersonPortionChoice = null;
  }

  const normUser = norm(text);
  const groups = buildPersonPortionGroups(menuItems);
  if (!groups.size) return null;

  const group = findBestMatchingGroup(normUser, groups);
  if (!group) return null;

  const intent = detectExplicitPersonIntent(normUser);
  const available = group.items;

  if (available.size === 1) {
    const onlyPersons = available.has(1) ? 1 : 2;
    const onlyItem = available.get(onlyPersons);
    if (intent != null && intent !== onlyPersons) {
      session.pendingPersonPortionChoice = null;
      if (session.pendingEmpanadaChoice) session.pendingEmpanadaChoice = null;
      return { reply: onlyVariantUnavailableMsg(intent, onlyPersons, group.baseRaw) };
    }
    return null;
  }

  if (available.size >= 2) {
    if (intent === 1 || intent === 2) {
      session.pendingPersonPortionChoice = null;
      return null;
    }
    session.pendingPersonPortionChoice = {
      normBase: group.normBase,
      baseRaw: group.baseRaw,
      createdAt: Date.now()
    };
    if (session.pendingEmpanadaChoice) session.pendingEmpanadaChoice = null;
    return { reply: clarifyMessage(group.baseRaw) };
  }

  return null;
}

/**
 * Interpretación corta tras preguntar 1 vs 2 personas.
 * @returns {1 | 2 | null}
 */
function parsePersonPortionChoice(rawText) {
  const n = norm(rawText);
  if (!n) return null;
  if (/^(1|uno|una)$/i.test(n.trim())) return 1;
  if (/^(2|dos)$/i.test(n.trim())) return 2;
  if (detectExplicitPersonIntent(n) === 1) return 1;
  if (detectExplicitPersonIntent(n) === 2) return 2;
  return null;
}

/**
 * @returns {{ order: object } | { reply: string } | null}
 */
function tryResolvePendingPersonPortion(session, text, menuItems) {
  const p = session?.pendingPersonPortionChoice;
  if (!p || !p.normBase) return null;
  if (Date.now() - (p.createdAt || 0) > PERSON_PORTION_PENDING_TTL_MS) {
    session.pendingPersonPortionChoice = null;
    return null;
  }

  const choice = parsePersonPortionChoice(text);
  if (choice == null) return null;

  const groups = buildPersonPortionGroups(menuItems);
  const group = groups.get(p.normBase);
  session.pendingPersonPortionChoice = null;

  if (!group || !group.items.size) {
    return {
      reply:
        "No encontré ese producto en el menú actual. Escribí *menú* para ver la lista."
    };
  }

  const item = group.items.get(choice);
  if (!item) {
    const has = group.items.has(1) ? 1 : group.items.has(2) ? 2 : null;
    if (has != null) {
      return {
        reply: onlyVariantUnavailableMsg(choice, has, group.baseRaw)
      };
    }
    return { reply: clarifyMessage(group.baseRaw) };
  }

  const order = buildDirectOrderFromItem(item);
  if (!order) {
    return {
      reply:
        "Hubo un problema con el precio de ese plato. Probá de nuevo o escribí *menú*."
    };
  }
  return { order };
}

/**
 * Pedido explícito con "1 persona" / "2 personas" en el mismo mensaje → un ítem.
 * @returns {{ order: object } | { reply: string } | null}
 */
function tryPersonPortionDirectOrder(text, menuItems) {
  const normUser = norm(text);
  const intent = detectExplicitPersonIntent(normUser);
  if (intent == null) return null;

  const groups = buildPersonPortionGroups(menuItems);
  const group = findBestMatchingGroup(normUser, groups);
  if (!group) return null;

  const item = group.items.get(intent);
  if (!item) {
    const only = group.items.size === 1 ? (group.items.has(1) ? 1 : 2) : null;
    if (only != null && only !== intent) {
      return { reply: onlyVariantUnavailableMsg(intent, only, group.baseRaw) };
    }
    return null;
  }

  const qty = Math.min(20, Math.max(1, extractQtyBeforePersonBase(normUser, group.normBase)));
  const single = buildDirectOrderFromItem(item);
  if (!single) return null;
  if (qty <= 1) return { order: single };

  const unit = Number(item.price || 0);
  const names = Array.from({ length: qty }, () => item.name);
  return {
    order: {
      details: names.join(", "),
      items: names,
      totalAmount: Number.isFinite(unit) && unit > 0 ? unit * qty : single.totalAmount
    }
  };
}

/**
 * Una sola variante disponible + texto menciona la base sin sufijo (sin preguntar).
 * @returns {{ order: object } | null}
 */
function tryPersonPortionImplicitSingle(text, menuItems) {
  const normUser = norm(text);
  if (detectExplicitPersonIntent(normUser) != null) return null;

  const groups = buildPersonPortionGroups(menuItems);
  const group = findBestMatchingGroup(normUser, groups);
  if (!group || group.items.size !== 1) return null;

  const onlyPersons = group.items.has(1) ? 1 : 2;
  const item = group.items.get(onlyPersons);
  const order = buildDirectOrderFromItem(item);
  return order ? { order } : null;
}

module.exports = {
  PERSON_PORTION_PENDING_TTL_MS,
  maybePersonPortionGate,
  tryResolvePendingPersonPortion,
  tryPersonPortionDirectOrder,
  tryPersonPortionImplicitSingle,
  parsePersonSuffix,
  buildPersonPortionGroups
};
