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

const {
  supabase,
  TABLES,
  updateOrderMatching,
  saveInteraction
} = require("./database");
const { searchApprovedPaymentByExternalReference } = require("./payment_service");

const POLL_INTERVAL_MS = Number(process.env.MP_PAYMENT_POLL_MS || 30_000);
const LOOKBACK_HOURS = Number(process.env.MP_PAYMENT_LOOKBACK_HOURS || 24);
const BATCH_LIMIT = Number(process.env.MP_PAYMENT_BATCH_LIMIT || 25);

const inflightOrders = new Set();

function isMpMethod(method) {
  const m = String(method || "").toLowerCase();
  return m.includes("mercado") || m === "mp" || m === "mercadopago";
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
  return lines.join("\n");
}

async function processOrder(order, whatsappClient) {
  if (!order?.id) return;
  if (inflightOrders.has(order.id)) return;
  inflightOrders.add(order.id);

  try {
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

async function scanAndProcess(whatsappClient) {
  const sinceIso = new Date(Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from(TABLES.orders)
    .select("*")
    .gte("created_at", sinceIso)
    .not("payment_method", "is", null)
    .neq("status", "cancelled")
    .neq("status", "delivered")
    .or("payment_status.is.null,payment_status.neq.approved")
    .order("created_at", { ascending: true })
    .limit(BATCH_LIMIT);

  if (error) {
    console.error("[mp-poll] Error escaneando pedidos:", error.message);
    return;
  }
  if (!data?.length) return;

  const candidates = data.filter((row) => isMpMethod(row.payment_method));
  if (!candidates.length) return;

  for (const row of candidates) {
    try {
      await processOrder(row, whatsappClient);
    } catch (err) {
      console.error("[mp-poll] Error procesando", row.id, err?.message || err);
    }
  }
}

function startPaymentStatusPoller(whatsappClient) {
  if (!process.env.MP_ACCESS_TOKEN) {
    console.warn("[mp-poll] MP_ACCESS_TOKEN no configurado, poller deshabilitado.");
    return () => {};
  }

  scanAndProcess(whatsappClient).catch((err) =>
    console.error("[mp-poll] scan inicial:", err?.message || err)
  );
  const handle = setInterval(() => {
    scanAndProcess(whatsappClient).catch((err) =>
      console.error("[mp-poll] poll:", err?.message || err)
    );
  }, POLL_INTERVAL_MS);
  if (handle.unref) handle.unref();

  console.log("[mp-poll] Poller MP activo. Cada", POLL_INTERVAL_MS, "ms (lookback", LOOKBACK_HOURS, "h).");

  return () => {
    clearInterval(handle);
  };
}

module.exports = {
  startPaymentStatusPoller,
  scanAndProcess
};
