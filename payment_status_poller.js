/**
 * Poller de pagos Mercado Pago.
 *
 * Cada `MP_PAYMENT_POLL_MS` revisa los pedidos con `payment_method = mercadopago`
 * que aún no estan aprobados ni cancelados/entregados, consulta a la API de MP
 * por `external_reference = order.id` y, si encuentra un pago `approved`, marca
 * el pedido como pagado/confirmado y avisa al cliente por WhatsApp.
 *
 * No depende de webhooks (no expone HTTP). Para volumen alto conviene migrar
 * a webhook MP IPN, pero para flujos PYME el polling alcanza.
 */

const { supabase, TABLES, updateOrderMatching, saveInteraction } = require("./database");
const { searchApprovedPaymentByExternalReference } = require("./payment_service");

const POLL_INTERVAL_MS = Number(process.env.MP_PAYMENT_POLL_MS || 30_000);
/** Ciclo aparte (más frecuente) solo para cancelar MP vencidos; no pega a la API de pagos de MP. */
const EXPIRE_POLL_MS = Number(process.env.MP_EXPIRE_POLL_MS || 10_000);
const LOOKBACK_HOURS = Number(process.env.MP_PAYMENT_LOOKBACK_HOURS || 24);
const BATCH_LIMIT = Number(process.env.MP_PAYMENT_BATCH_LIMIT || 25);
/** Máx. filas por ciclo solo para vencimiento de MP pending (evita pedidos efectivo que tapen el lote). */
const EXPIRE_SCAN_LIMIT = Number(process.env.MP_PAYMENT_EXPIRE_SCAN_LIMIT || 100);
/** Tiempo máximo en estado pending esperando pago MP (desde link / creación del pedido). Default 15 min; override: MP_PAYMENT_PENDING_TIMEOUT_MS (ms). */
const MP_PENDING_TIMEOUT_MS = Number(process.env.MP_PAYMENT_PENDING_TIMEOUT_MS || 15 * 60 * 1000);
const MERCADOPAGO_LINK_MARKERS = ["mercadopago.com", "mercadolibre.com"];

const inflightOrders = new Set();

function isMpMethod(method) {
  const m = String(method || "").toLowerCase();
  return m.includes("mercado") || m === "mp" || m === "mercadopago";
}

function paymentLinkLooksMercadoPago(url) {
  const u = String(url || "").toLowerCase();
  return MERCADOPAGO_LINK_MARKERS.some((m) => u.includes(m));
}

/** Pedido que está esperando checkout MP (no efectivo colado). */
function isAwaitingMpCheckout(order) {
  if (String(order?.status || "").trim() !== "pending") return false;
  const ps = String(order?.payment_status ?? "").trim().toLowerCase();
  if (ps === "approved" || ps === "paid") return false;
  if (isMpMethod(order?.payment_method)) return true;
  if (paymentLinkLooksMercadoPago(order?.payment_link)) return true;
  return false;
}

function chatIdForCustomer(customerNumber) {
  const digits = String(customerNumber || "").replace(/\D/g, "");
  if (!digits) return null;
  return `${digits}@c.us`;
}

async function buildChatIdCandidates(whatsappClient, { customerChatId, customerNumber }) {
  const candidates = [];
  const stored = String(customerChatId || "").trim();
  if (stored) candidates.push(stored);

  const digits = String(customerNumber || "").replace(/\D/g, "");
  if (digits) {
    const looksLikeLid = digits.length >= 14;
    if (looksLikeLid) {
      candidates.push(`${digits}@lid`);
      candidates.push(`${digits}@c.us`);
    } else {
      try {
        if (typeof whatsappClient?.getNumberId === "function") {
          const numberId = await whatsappClient.getNumberId(digits);
          if (numberId?._serialized) candidates.push(numberId._serialized);
        }
      } catch (err) {
        console.warn("[mp-poll] getNumberId fallo:", err?.message || err);
      }
      candidates.push(`${digits}@c.us`);
      candidates.push(`${digits}@lid`);
    }
  }
  return [...new Set(candidates)];
}

async function sendWhatsAppMessageRobust(whatsappClient, params, body) {
  if (!whatsappClient) return false;
  const candidates = await buildChatIdCandidates(whatsappClient, params);
  if (!candidates.length) return false;

  let lastErr;
  for (const chatId of candidates) {
    try {
      await whatsappClient.sendMessage(chatId, body);
      return true;
    } catch (err) {
      lastErr = err;
    }
  }
  if (lastErr) {
    console.warn("[mp-poll] No se pudo enviar WhatsApp al cliente:", lastErr?.message || lastErr);
  }
  return false;
}

function mpPendingDeadlineMs(order) {
  const raw = order?.customer_notified_at || order?.created_at;
  if (!raw) return null;
  const t = new Date(raw).getTime();
  return Number.isFinite(t) ? t : null;
}

function isPastMpPendingPaymentTimeout(order) {
  if (!isAwaitingMpCheckout(order)) return false;
  const ps = String(order.payment_status || "").toLowerCase();
  if (ps === "approved") return false;
  const start = mpPendingDeadlineMs(order);
  if (start == null) return false;
  return Date.now() - start >= MP_PENDING_TIMEOUT_MS;
}

function buildMpPaymentExpiredMessage() {
  const mins = Math.max(1, Math.round(MP_PENDING_TIMEOUT_MS / 60_000));
  const minLabel = mins === 1 ? "1 minuto" : `${mins} minutos`;
  return [
    "*Pedido cancelado por falta de pago*",
    `No registramos el pago por Mercado Pago dentro de ${minLabel}. Por eso *tu pedido quedó cancelado* (no lo tomamos como confirmado).`,
    "",
    "*No hace falta que respondas* a este aviso: es un mensaje automático del sistema.",
    "",
    "Si querés *un pedido nuevo*, escribinos cuando quieras y lo armamos desde cero con normalidad."
  ].join("\n");
}

/**
 * Cancela solo si sigue pending y payment_status es null o pending.
 * Dos updates evitan ambigüedad del operador or() encadenado con eq() en PostgREST.
 */
async function cancelPendingMpOrderByTimeout(orderId) {
  const patch = {
    status: "cancelled",
    payment_status: "cancelled",
    cancelled_at: new Date().toISOString()
  };
  const base = () =>
    supabase.from(TABLES.orders).update(patch).eq("id", orderId).eq("status", "pending");

  let { data, error } = await base().is("payment_status", null).select("*").maybeSingle();
  if (error) throw new Error(error.message);
  if (data) return data;

  ({ data, error } = await base().eq("payment_status", "pending").select("*").maybeSingle());
  if (error) throw new Error(error.message);
  return data || null;
}

async function maybeAutoCancelExpiredMpOrder(order, whatsappClient) {
  if (!isPastMpPendingPaymentTimeout(order)) return false;

  let updated;
  try {
    updated = await cancelPendingMpOrderByTimeout(order.id);
  } catch (err) {
    console.error("[mp-poll] Error DB cancelando por timeout", order.id, err?.message || err);
    return false;
  }
  if (!updated) return false;

  console.log("[mp-poll] Pedido MP cancelado por timeout:", order.id);

  const body = buildMpPaymentExpiredMessage();
  const sendParams = {
    customerChatId: order.customer_chat_id || null,
    customerNumber: order.customer_number
  };
  const previewChat = order.customer_chat_id || chatIdForCustomer(order.customer_number);
  let whatsappSent = false;
  if (previewChat && whatsappClient) {
    whatsappSent = await sendWhatsAppMessageRobust(whatsappClient, sendParams, body);
    if (!whatsappSent) {
      console.warn("[mp-poll] Pedido cancelado por timeout pero no se pudo avisar por WA:", order.id);
    }
  }

  await saveInteraction({
    restaurantId: updated.restaurant_id,
    customerNumber: updated.customer_number,
    botNumber: updated.bot_number,
    messageType: "text",
    userMessage: "[sistema] pago MP expiró (timeout)",
    botResponse: body,
    metadata: {
      orderId: updated.id,
      mpPaymentTimeoutCancelled: true,
      timeoutMs: MP_PENDING_TIMEOUT_MS,
      whatsappNotifySent: whatsappSent
    }
  });

  return true;
}

function buildPaymentReceivedMessage(order, payment) {
  const total =
    payment?.transactionAmount ?? order?.final_total_amount ?? order?.total_amount ?? null;
  const totalStr = total != null
    ? new Intl.NumberFormat("es-AR", {
        style: "currency",
        currency: "ARS",
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
      }).format(Number(total))
    : null;
  const lines = [
    "*Pago recibido* ✅",
    "Confirmamos tu pago por Mercado Pago. Tu pedido queda confirmado y en preparación."
  ];
  if (totalStr) lines.push(`Total: ${totalStr}`);
  if (payment?.id) lines.push(`Ref. MP: ${payment.id}`);
  const ft = String(order?.fulfillment_type ?? "").trim().toLowerCase();
  if (ft === "local") {
    lines.push("Te avisamos por acá cuando esté *listo para retirar* en el local.");
  }
  return lines.join("\n");
}

async function processOrder(order, whatsappClient) {
  if (!order?.id) return;
  if (inflightOrders.has(order.id)) return;
  inflightOrders.add(order.id);

  try {
    if (isAwaitingMpCheckout(order)) {
      const timedOut = await maybeAutoCancelExpiredMpOrder(order, whatsappClient);
      if (timedOut) return;
    }

    let payment;
    try {
      payment = await searchApprovedPaymentByExternalReference(order.id);
    } catch (err) {
      console.error("[mp-poll] Error consultando MP para", order.id, err?.message || err);
      return;
    }
    if (!payment) return;

    const paidAtIso = payment.dateApproved
      ? new Date(payment.dateApproved).toISOString()
      : new Date().toISOString();

    const patch = {
      status: "confirmed",
      payment_status: "approved",
      payment_paid_at: paidAtIso,
      mp_payment_id: payment.id || null
    };

    const updated = await updateOrderMatching(order.id, patch, {
      expectStatus: order.status
    });
    if (!updated) {
      // El pedido cambió de estado mientras consultabamos MP (ej: cancelado o ya confirmado).
      return;
    }

    console.log("[mp-poll] Pago aprobado para", order.id, "(MP id:", payment.id, ")");

    const sendParams = {
      customerChatId: order.customer_chat_id || null,
      customerNumber: order.customer_number
    };
    const previewChat = order.customer_chat_id || chatIdForCustomer(order.customer_number);
    if (previewChat) {
      const body = buildPaymentReceivedMessage(updated, payment);
      const sent = await sendWhatsAppMessageRobust(whatsappClient, sendParams, body);
      if (sent) {
        await saveInteraction({
          restaurantId: updated.restaurant_id,
          customerNumber: updated.customer_number,
          botNumber: updated.bot_number,
          messageType: "text",
          userMessage: "[sistema] pago MP aprobado",
          botResponse: body,
          metadata: {
            orderId: updated.id,
            mpPaymentId: payment.id,
            paymentApproved: true
          }
        });
      }
    }
  } finally {
    inflightOrders.delete(order.id);
  }
}

/**
 * Vencimiento de pedidos MP en pending.
 * Consultas simples (.eq) + unión en JS: evita filtros anidados and/or/ilike que PostgREST a veces rechaza o interpreta mal.
 */
async function scanAndExpireOverdueMpPending(whatsappClient) {
  const sinceIso = new Date(Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000).toISOString();
  const base = () =>
    supabase
      .from(TABLES.orders)
      .select("*")
      .gte("created_at", sinceIso)
      .eq("status", "pending")
      .or("payment_status.is.null,payment_status.eq.pending")
      .order("created_at", { ascending: true })
      .limit(EXPIRE_SCAN_LIMIT);

  const [byMethod, byLink] = await Promise.all([
    base().eq("payment_method", "mercadopago"),
    base().not("payment_link", "is", null)
  ]);

  const err = byMethod.error || byLink.error;
  if (err) {
    console.error("[mp-poll] Error escaneando vencimientos MP:", err.message);
    return;
  }

  const byId = new Map();
  for (const row of [...(byMethod.data || []), ...(byLink.data || [])]) {
    if (!isAwaitingMpCheckout(row)) continue;
    byId.set(row.id, row);
  }

  if (!byId.size) return;

  for (const row of byId.values()) {
    try {
      await maybeAutoCancelExpiredMpOrder(row, whatsappClient);
    } catch (e) {
      console.error("[mp-poll] Error vencimiento MP", row.id, e?.message || e);
    }
  }
}

/**
 * Polling API MP para marcar pagos aprobados (requiere MP_ACCESS_TOKEN).
 * El límite se aplica solo a filas de Mercado Pago.
 */
async function scanAndPollMpApprovals(whatsappClient) {
  if (!process.env.MP_ACCESS_TOKEN) return;

  const sinceIso = new Date(Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from(TABLES.orders)
    .select("*")
    .gte("created_at", sinceIso)
    .not("payment_method", "is", null)
    .neq("status", "cancelled")
    .neq("status", "delivered")
    .or("payment_status.is.null,payment_status.neq.approved")
    .eq("payment_method", "mercadopago")
    .order("created_at", { ascending: true })
    .limit(BATCH_LIMIT);

  if (error) {
    console.error("[mp-poll] Error escaneando pedidos (aprobaciones):", error.message);
    return;
  }
  if (!data?.length) return;

  for (const row of data) {
    if (!isMpMethod(row.payment_method)) continue;
    try {
      await processOrder(row, whatsappClient);
    } catch (err) {
      console.error("[mp-poll] Error procesando", row.id, err?.message || err);
    }
  }
}

function resolveWhatsapp(clientOrGetter) {
  return typeof clientOrGetter === "function" ? clientOrGetter() : clientOrGetter;
}

async function scanAndProcess(whatsappClientOrGetter) {
  const whatsapp = resolveWhatsapp(whatsappClientOrGetter);
  await scanAndExpireOverdueMpPending(whatsapp);
  await scanAndPollMpApprovals(whatsapp);
}

function startPaymentStatusPoller(whatsappClientOrGetter) {
  if (!process.env.MP_ACCESS_TOKEN) {
    console.warn(
      "[mp-poll] MP_ACCESS_TOKEN no configurado: no se consultan pagos en la API de MP; sí se aplican vencimientos de pedidos MP pending."
    );
  }

  scanAndExpireOverdueMpPending(resolveWhatsapp(whatsappClientOrGetter)).catch((err) =>
    console.error("[mp-poll] scan inicial vencimientos:", err?.message || err)
  );
  scanAndPollMpApprovals(resolveWhatsapp(whatsappClientOrGetter)).catch((err) =>
    console.error("[mp-poll] scan inicial aprobaciones:", err?.message || err)
  );

  const expireHandle = setInterval(() => {
    scanAndExpireOverdueMpPending(resolveWhatsapp(whatsappClientOrGetter)).catch((err) =>
      console.error("[mp-poll] poll vencimientos:", err?.message || err)
    );
  }, EXPIRE_POLL_MS);
  if (expireHandle.unref) expireHandle.unref();

  const approvalHandle = setInterval(() => {
    scanAndPollMpApprovals(resolveWhatsapp(whatsappClientOrGetter)).catch((err) =>
      console.error("[mp-poll] poll aprobaciones:", err?.message || err)
    );
  }, POLL_INTERVAL_MS);
  if (approvalHandle.unref) approvalHandle.unref();

  console.log(
    "[mp-poll] Mantenimiento MP: vencimientos cada",
    EXPIRE_POLL_MS,
    "ms, API pagos cada",
    POLL_INTERVAL_MS,
    "ms (lookback",
    LOOKBACK_HOURS,
    "h, timeout pending",
    MP_PENDING_TIMEOUT_MS,
    "ms). API:",
    process.env.MP_ACCESS_TOKEN ? "sí" : "no"
  );

  return () => {
    clearInterval(expireHandle);
    clearInterval(approvalHandle);
  };
}

module.exports = {
  startPaymentStatusPoller,
  scanAndProcess,
  scanAndExpireOverdueMpPending,
  scanAndPollMpApprovals,
  maybeAutoCancelExpiredMpOrder,
  MP_PENDING_TIMEOUT_MS
};
