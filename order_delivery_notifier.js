const { createPaymentPreference } = require("./payment_service");
const {
  saveInteraction,
  updateOrderMatching,
  getRestaurantNameById,
  supabase,
  TABLES
} = require("./database");

const POLL_INTERVAL_MS = Number(process.env.DELIVERY_NOTIFIER_POLL_MS || 10_000);

function formatArs(amount) {
  return new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency: "ARS",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(Number(amount) || 0);
}

/**
 * Ticket tipo recibo en bloque monoespaciado (WhatsApp ```).
 */
function buildDeliveryTicketBlock({ restaurantName, subtotal, deliveryFee, finalTotal }) {
  const name = String(restaurantName || "Restaurante").trim() || "Restaurante";
  const sub = Number(subtotal) || 0;
  const del = Number(deliveryFee) || 0;
  const tot = Number(finalTotal) || 0;
  const fmt = (n) => formatArs(n).replace(/\s+/g, " ").trim();
  const colW = 14;
  const row = (label, valueStr) => `${label.padEnd(10, " ")} ${valueStr.padStart(colW, " ")}`;
  const sep = "─".repeat(26);
  return [
    `*${name}*`,
    "```",
    row("Pedido", fmt(sub)),
    row("Envío", fmt(del)),
    sep,
    row("TOTAL", fmt(tot)),
    "```"
  ].join("\n");
}

function resolveSubtotalForTicket(orderRow, finalTotal, deliveryFee) {
  const fromCol = Number(orderRow?.subtotal_amount);
  if (Number.isFinite(fromCol) && fromCol > 0) return fromCol;
  const ft = Number(finalTotal);
  const df = Number(deliveryFee);
  if (Number.isFinite(ft) && Number.isFinite(df)) return Math.round((ft - df) * 100) / 100;
  return 0;
}

function buildCashFinalMessage(ticketBlock) {
  return (
    `${ticketBlock}\n\n` +
    `Confirmamos pago en *efectivo* al recibir el pedido.\n` +
    `¡Gracias por tu pedido!`
  );
}

function buildMpFinalMessage(ticketBlock, url) {
  return `${ticketBlock}\n\nPara pagar con *Mercado Pago* usá este link:\n${url}`;
}

function buildMpFallbackToCashMessage(ticketBlock) {
  return (
    `${ticketBlock}\n\n` +
    `Hubo un problema al generar el link de Mercado Pago.\n` +
    `Podés pagar en *efectivo* al recibir el pedido.\n` +
    `Si preferís MP, avisá al local o escribinos de nuevo por acá y lo reintentamos.`
  );
}

function chatIdForCustomer(customerNumber) {
  const digits = String(customerNumber || "").replace(/\D/g, "");
  if (!digits) return null;
  return `${digits}@c.us`;
}

/**
 * Construye los candidatos de chatId para mandar el mensaje.
 * Prioriza el `customer_chat_id` que viene tal cual de WhatsApp (incluye sufijo
 * @c.us o @lid). Si no esta, cae a los formatos derivados del telefono / lid.
 */
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
        console.warn("[delivery-notify] getNumberId falló:", err?.message || err);
      }
      candidates.push(`${digits}@c.us`);
      candidates.push(`${digits}@lid`);
    }
  }

  return [...new Set(candidates)];
}

/**
 * Envía un mensaje probando los chatIds disponibles. Si el primero (el guardado
 * en la orden) funciona, ni siquiera intenta los demás.
 */
async function sendWhatsAppMessageRobust(whatsappClient, params, body) {
  const candidates = await buildChatIdCandidates(whatsappClient, params);
  if (!candidates.length) throw new Error("Sin chatId válido para el cliente");

  let lastErr;
  for (const id of candidates) {
    try {
      const sent = await whatsappClient.sendMessage(id, body);
      console.log("[delivery-notify] sendMessage OK con chatId:", id);
      return sent;
    } catch (err) {
      lastErr = err;
      console.warn(
        "[delivery-notify] sendMessage falló con",
        id,
        "→",
        err?.message || err
      );
    }
  }
  throw lastErr || new Error("No se pudo enviar WhatsApp con ningún formato de chatId");
}

const inflightOrders = new Set();

/**
 * Procesa pedidos en status delivery_fee_set: genera link MP si aplica, envía WhatsApp,
 * marca customer_notified_at y pasa a pending. Idempotente.
 */
async function processDeliveryFeeReadyOrder(orderRow, whatsappClient) {
  if (!orderRow?.id) return;
  if (orderRow.status !== "delivery_fee_set") return;
  if (orderRow.customer_notified_at) return;
  if (inflightOrders.has(orderRow.id)) {
    console.log("[delivery-notify] Ya en proceso, salto:", orderRow.id);
    return;
  }
  inflightOrders.add(orderRow.id);

  try {
    const fee = Number(orderRow.delivery_fee);
    const finalTotal = Number(orderRow.final_total_amount);
    if (!Number.isFinite(fee) || fee <= 0) {
      console.warn("[delivery-notify] delivery_fee inválido, salto:", orderRow.id, fee);
      return;
    }
    if (!Number.isFinite(finalTotal) || finalTotal <= 0) {
      console.warn("[delivery-notify] final_total_amount inválido, salto:", orderRow.id, finalTotal);
      return;
    }

    if (!whatsappClient) {
      console.warn("[delivery-notify] Sin cliente WhatsApp activo:", orderRow.id);
      return;
    }
    const chatIdPreview =
      orderRow.customer_chat_id || chatIdForCustomer(orderRow.customer_number);
    if (!chatIdPreview) {
      console.warn("[delivery-notify] Sin chatId válido:", orderRow.id);
      return;
    }
    const sendParams = {
      customerChatId: orderRow.customer_chat_id || null,
      customerNumber: orderRow.customer_number
    };

    console.log("[delivery-notify] Procesando pedido:", orderRow.id, {
      method: orderRow.payment_method,
      finalTotal
    });

    const nameFromDb = await getRestaurantNameById(orderRow.restaurant_id);
    const restaurantName =
      (process.env.RESTAURANT_PUBLIC_NAME || "").trim() || nameFromDb || "Restaurante Palermo";
    const subtotalResolved = resolveSubtotalForTicket(orderRow, finalTotal, fee);
    const ticketBlock = buildDeliveryTicketBlock({
      restaurantName,
      subtotal: subtotalResolved,
      deliveryFee: fee,
      finalTotal
    });
    const method = String(orderRow.payment_method || "").toLowerCase();
    const wantsMp = method.includes("mercado") || method === "mp" || method === "mercadopago";

    let paymentUrl = orderRow.payment_link || null;
    if (wantsMp && !paymentUrl) {
      try {
        paymentUrl = await createPaymentPreference({
          orderId: orderRow.id,
          totalAmount: finalTotal,
          restaurantName: nameFromDb
        });
        console.log("[delivery-notify] Preferencia MP generada:", orderRow.id);
      } catch (mpErr) {
        const fallback = buildMpFallbackToCashMessage(ticketBlock);
        try {
          await sendWhatsAppMessageRobust(whatsappClient, sendParams, fallback);
        } catch (waErr) {
          console.error("[delivery-notify] MP falló y WhatsApp también:", mpErr, waErr);
          await supabase
            .from(TABLES.orders)
            .update({ status: "notify_failed" })
            .eq("id", orderRow.id)
            .eq("status", "delivery_fee_set");
          return;
        }

        const updated = await updateOrderMatching(
          orderRow.id,
          {
            customer_notified_at: new Date().toISOString(),
            status: "pending",
            payment_link: null,
            payment_status: "pending"
          },
          { expectStatus: "delivery_fee_set", requireCustomerNotifiedNull: true }
        );
        if (!updated) return;

        await saveInteraction({
          restaurantId: orderRow.restaurant_id,
          customerNumber: orderRow.customer_number,
          botNumber: orderRow.bot_number,
          messageType: "text",
          userMessage: "[sistema] total delivery + fallback MP",
          botResponse: fallback,
          metadata: {
            orderId: orderRow.id,
            deliveryNotify: true,
            mercadopagoFallback: true,
            error: String(mpErr?.message || mpErr)
          }
        });
        return;
      }
    }

    let body;
    if (wantsMp && paymentUrl) {
      body = buildMpFinalMessage(ticketBlock, paymentUrl);
    } else {
      body = buildCashFinalMessage(ticketBlock);
    }

    try {
      await sendWhatsAppMessageRobust(whatsappClient, sendParams, body);
      console.log("[delivery-notify] WhatsApp enviado:", orderRow.id, "→", chatIdPreview);
    } catch (waErr) {
      console.error("[delivery-notify] Fallo WhatsApp:", waErr);
      await supabase
        .from(TABLES.orders)
        .update({ status: "notify_failed" })
        .eq("id", orderRow.id)
        .eq("status", "delivery_fee_set");
      return;
    }

    const patch = {
      customer_notified_at: new Date().toISOString(),
      status: "pending",
      payment_status: "pending"
    };
    if (wantsMp && paymentUrl) {
      patch.payment_link = paymentUrl;
    }

    const updated = await updateOrderMatching(orderRow.id, patch, {
      expectStatus: "delivery_fee_set",
      requireCustomerNotifiedNull: true
    });
    if (!updated) {
      console.log("[delivery-notify] Update sin match (carrera/idempotencia):", orderRow.id);
      return;
    }

    await saveInteraction({
      restaurantId: orderRow.restaurant_id,
      customerNumber: orderRow.customer_number,
      botNumber: orderRow.bot_number,
      messageType: "text",
      userMessage: "[sistema] total delivery confirmado",
      botResponse: body,
      metadata: {
        orderId: orderRow.id,
        deliveryNotify: true,
        paymentChoice: wantsMp ? "mercadopago" : "cash"
      }
    });
  } finally {
    inflightOrders.delete(orderRow.id);
  }
}

/**
 * Delivery rechazado por dirección: avisa al cliente por WhatsApp y cancela el pedido.
 * Idempotente (customer_notified_at / expectStatus).
 */
async function processDeliveryDeniedOrder(orderRow, whatsappClient) {
  if (!orderRow?.id) return;
  if (orderRow.status !== "delivery_denied") return;
  if (orderRow.customer_notified_at) return;

  const reason = String(orderRow.delivery_denial_reason || "").trim();
  if (!reason) {
    console.warn("[delivery-notify] delivery_denied sin motivo, salto:", orderRow.id);
    return;
  }

  if (inflightOrders.has(orderRow.id)) {
    console.log("[delivery-notify] Ya en proceso, salto:", orderRow.id);
    return;
  }
  inflightOrders.add(orderRow.id);

  try {
    if (!whatsappClient) {
      console.warn("[delivery-notify] Sin cliente WhatsApp activo (denegación):", orderRow.id);
      return;
    }

    const chatIdPreview =
      orderRow.customer_chat_id || chatIdForCustomer(orderRow.customer_number);
    if (!chatIdPreview) {
      console.warn("[delivery-notify] Sin chatId válido (denegación):", orderRow.id);
      return;
    }

    const sendParams = {
      customerChatId: orderRow.customer_chat_id || null,
      customerNumber: orderRow.customer_number
    };

    const body =
      `Lo siento, tu pedido con delivery se canceló por este motivo: ${reason}`;

    try {
      await sendWhatsAppMessageRobust(whatsappClient, sendParams, body);
      console.log("[delivery-notify] WhatsApp denegación enviado:", orderRow.id, "→", chatIdPreview);
    } catch (waErr) {
      console.error("[delivery-notify] Fallo WhatsApp (denegación):", waErr);
      await supabase
        .from(TABLES.orders)
        .update({ status: "delivery_denial_notify_failed" })
        .eq("id", orderRow.id)
        .eq("status", "delivery_denied");
      return;
    }

    const updated = await updateOrderMatching(
      orderRow.id,
      {
        customer_notified_at: new Date().toISOString(),
        status: "cancelled",
        payment_status: "cancelled"
      },
      { expectStatus: "delivery_denied", requireCustomerNotifiedNull: true }
    );
    if (!updated) {
      console.log("[delivery-notify] Update denegación sin match (carrera/idempotencia):", orderRow.id);
      return;
    }

    await saveInteraction({
      restaurantId: orderRow.restaurant_id,
      customerNumber: orderRow.customer_number,
      botNumber: orderRow.bot_number,
      messageType: "text",
      userMessage: "[sistema] delivery denegado por dirección",
      botResponse: body,
      metadata: {
        orderId: orderRow.id,
        deliveryDenial: true
      }
    });
  } finally {
    inflightOrders.delete(orderRow.id);
  }
}

/** Busca pedidos delivery_fee_set sin notificar y los procesa (poller / startup scan). */
async function scanAndProcessPending(whatsappClient) {
  const { data, error } = await supabase
    .from(TABLES.orders)
    .select("*")
    .eq("status", "delivery_fee_set")
    .is("customer_notified_at", null)
    .order("created_at", { ascending: true })
    .limit(20);

  if (error) {
    console.error("[delivery-notify] Error escaneando pedidos fee:", error.message);
  } else if (data?.length) {
    console.log("[delivery-notify] Pendientes fee encontrados:", data.length);
    for (const row of data) {
      try {
        await processDeliveryFeeReadyOrder(row, whatsappClient);
      } catch (err) {
        console.error("[delivery-notify] Error procesando", row.id, err);
      }
    }
  }

  const { data: deniedRows, error: deniedErr } = await supabase
    .from(TABLES.orders)
    .select("*")
    .eq("status", "delivery_denied")
    .is("customer_notified_at", null)
    .not("delivery_denial_reason", "is", null)
    .order("created_at", { ascending: true })
    .limit(20);

  if (deniedErr) {
    console.error("[delivery-notify] Error escaneando denegaciones:", deniedErr.message);
    return;
  }

  if (!deniedRows?.length) return;

  console.log("[delivery-notify] Pendientes denegación encontrados:", deniedRows.length);
  for (const row of deniedRows) {
    try {
      await processDeliveryDeniedOrder(row, whatsappClient);
    } catch (err) {
      console.error("[delivery-notify] Error denegación", row.id, err);
    }
  }
}

function startOrderDeliveryNotifier(whatsappClient) {
  const channel = supabase
    .channel("restobot-delivery-fee")
    .on(
      "postgres_changes",
      { event: "UPDATE", schema: "public", table: TABLES.orders },
      async (payload) => {
        console.log("[delivery-notify] UPDATE recibido vía Realtime:", payload?.new?.id, "status:", payload?.new?.status);
        try {
          await processDeliveryFeeReadyOrder(payload.new, whatsappClient);
          await processDeliveryDeniedOrder(payload.new, whatsappClient);
        } catch (err) {
          console.error("[delivery-notify]", err);
        }
      }
    )
    .subscribe((status, err) => {
      if (err) console.error("[delivery-notify] subscribe error:", err);
      else console.log("[delivery-notify] Realtime:", status);
    });

  // Escaneo inmediato + poller de respaldo (por si Realtime no llega).
  scanAndProcessPending(whatsappClient).catch((err) =>
    console.error("[delivery-notify] scan inicial:", err)
  );
  const pollHandle = setInterval(() => {
    scanAndProcessPending(whatsappClient).catch((err) =>
      console.error("[delivery-notify] poll:", err)
    );
  }, POLL_INTERVAL_MS);
  if (pollHandle.unref) pollHandle.unref();

  console.log("[delivery-notify] Notifier activo. Poll cada", POLL_INTERVAL_MS, "ms.");

  return () => {
    clearInterval(pollHandle);
    supabase.removeChannel(channel).catch(() => null);
  };
}

module.exports = {
  startOrderDeliveryNotifier,
  processDeliveryFeeReadyOrder,
  processDeliveryDeniedOrder,
  scanAndProcessPending
};
