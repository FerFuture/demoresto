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

/** Ticket + pedido de confirmación al cliente (delivery + efectivo). El pedido en DB pasa a awaiting_delivery_total_confirm. */
function buildCashTotalProposalMessage(ticketBlock) {
  return (
    `${ticketBlock}\n\n` +
    `Este es el *total* de tu pedido (incluye envío a domicilio).\n` +
    `¿Confirmás el pedido con este total?\n` +
    `Respondé *SÍ* para confirmar o *NO* si no querés continuar (se cancela el pedido).`
  );
}

function buildMpFinalMessage(ticketBlock, url) {
  return `${ticketBlock}\n\nPara pagar con *Mercado Pago* usá este link:\n${url}`;
}

/** Mismo criterio que efectivo: el cliente debe confirmar el total antes de dar el pedido por cerrado. */
function buildMpFallbackToCashProposalMessage(ticketBlock) {
  return (
    `${ticketBlock}\n\n` +
    `Hubo un problema al generar el link de Mercado Pago.\n` +
    `Podés pagar en *efectivo* al recibir el pedido.\n\n` +
    `Este es el *total* (incluye envío). ¿Lo confirmás?\n` +
    `Respondé *SÍ* para confirmar o *NO* para cancelar el pedido.\n` +
    `Si preferís MP, escribinos de nuevo por acá y lo reintentamos.`
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
        const fallback = buildMpFallbackToCashProposalMessage(ticketBlock);
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
            status: "awaiting_delivery_total_confirm",
            payment_method: "efectivo",
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
            awaitingCustomerTotalConfirm: true,
            error: String(mpErr?.message || mpErr)
          }
        });
        return;
      }
    }

    let body;
    let patch;
    let interactionNote = "[sistema] total delivery confirmado";

    if (wantsMp && paymentUrl) {
      body = buildMpFinalMessage(ticketBlock, paymentUrl);
      patch = {
        customer_notified_at: new Date().toISOString(),
        status: "pending",
        payment_status: "pending",
        payment_link: paymentUrl
      };
    } else {
      body = buildCashTotalProposalMessage(ticketBlock);
      interactionNote = "[sistema] total delivery + pedido confirmación cliente";
      patch = {
        customer_notified_at: new Date().toISOString(),
        status: "awaiting_delivery_total_confirm",
        payment_status: "pending"
      };
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
      userMessage: interactionNote,
      botResponse: body,
      metadata: {
        orderId: orderRow.id,
        deliveryNotify: true,
        paymentChoice: wantsMp ? "mercadopago" : "cash",
        awaitingCustomerTotalConfirm: patch.status === "awaiting_delivery_total_confirm"
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

const pickupNotifyInflight = new Set();

/** Mismo criterio amplio que el dashboard para “es delivery”. */
function orderRowIsDelivery(orderRow) {
  const ft = String(orderRow?.fulfillment_type || "").trim().toLowerCase();
  if (ft === "delivery") return true;
  const n = String(orderRow?.notes || "").toLowerCase();
  return n.includes("modalidad: delivery") || n.includes("modalidad:delivery");
}

const deliveryEnRouteInflight = new Set();

function buildDeliveryEnRouteCustomerBody(restaurantName, orderId) {
  const brand = String(restaurantName || "").trim() || "el restaurante";
  const shortId = orderId ? String(orderId).replace(/-/g, "").slice(0, 8) : "";
  const ref = shortId ? ` · Pedido #${shortId}` : "";
  return [
    `*Tu pedido ya salió*${ref}`,
    `El repartidor de *${brand}* va en camino a tu domicilio.`,
    "Si no podés recibirlo, avisános respondiendo por este chat.",
    "¡Gracias por tu pedido!"
  ].join("\n");
}

/**
 * El repartidor tomó el pedido (`delivery_claimed_at`); avisamos al cliente por WhatsApp una sola vez.
 * Idempotente con `delivery_en_route_customer_notified_at`.
 */
async function processDeliveryEnRouteNotifyOrder(orderRow, whatsappClient) {
  if (!orderRow?.id) return;
  if (!orderRowIsDelivery(orderRow)) return;
  if (!orderRow.delivery_claimed_at) return;
  if (orderRow.delivery_en_route_customer_notified_at) return;
  const st = String(orderRow.status || "").trim().toLowerCase();
  if (st === "cancelled" || st === "delivered") return;

  if (!whatsappClient) {
    console.warn("[delivery-en-route] Sin WhatsApp, salto:", orderRow.id);
    return;
  }
  if (deliveryEnRouteInflight.has(orderRow.id)) return;
  deliveryEnRouteInflight.add(orderRow.id);

  try {
    const chatIdPreview =
      orderRow.customer_chat_id || chatIdForCustomer(orderRow.customer_number);
    if (!chatIdPreview) {
      console.warn("[delivery-en-route] Sin chatId válido:", orderRow.id);
      return;
    }

    const sendParams = {
      customerChatId: orderRow.customer_chat_id || null,
      customerNumber: orderRow.customer_number
    };

    const nameFromDb = await getRestaurantNameById(orderRow.restaurant_id);
    const body = buildDeliveryEnRouteCustomerBody(nameFromDb, orderRow.id);

    await sendWhatsAppMessageRobust(whatsappClient, sendParams, body);

    const notifiedAt = new Date().toISOString();
    const { data: updated, error } = await supabase
      .from(TABLES.orders)
      .update({ delivery_en_route_customer_notified_at: notifiedAt })
      .eq("id", orderRow.id)
      .not("delivery_claimed_at", "is", null)
      .is("delivery_en_route_customer_notified_at", null)
      .neq("status", "cancelled")
      .neq("status", "delivered")
      .select("*")
      .maybeSingle();

    if (error) {
      console.error("[delivery-en-route] Error actualizando fila:", orderRow.id, error.message);
      return;
    }
    if (!updated) {
      console.log("[delivery-en-route] Sin match al marcar notificado (carrera):", orderRow.id);
      return;
    }

    await saveInteraction({
      restaurantId: updated.restaurant_id,
      customerNumber: updated.customer_number,
      botNumber: updated.bot_number,
      messageType: "text",
      userMessage: "[sistema] repartidor en camino (tomó el pedido)",
      botResponse: body,
      metadata: {
        orderId: updated.id,
        deliveryEnRouteCustomerNotified: true
      }
    });
    console.log("[delivery-en-route] Cliente avisado, pedido:", orderRow.id);
  } catch (err) {
    console.error("[delivery-en-route] Fallo envío:", orderRow.id, err?.message || err);
    // Sin columna de “falló”: el poller reintenta mientras siga sin notified_at
  } finally {
    deliveryEnRouteInflight.delete(orderRow.id);
  }
}

async function scanDeliveryEnRoutePending(whatsappClient) {
  const { data, error } = await supabase
    .from(TABLES.orders)
    .select("*")
    .not("delivery_claimed_at", "is", null)
    .is("delivery_en_route_customer_notified_at", null)
    .neq("status", "cancelled")
    .neq("status", "delivered")
    .order("delivery_claimed_at", { ascending: true })
    .limit(40);

  if (error) {
    console.error("[delivery-en-route] Error escaneando:", error.message);
    return;
  }
  for (const row of data || []) {
    try {
      await processDeliveryEnRouteNotifyOrder(row, whatsappClient);
    } catch (err) {
      console.error("[delivery-en-route] Error procesando", row.id, err);
    }
  }
}

async function buildPickupReadyWhatsAppBody(orderRow) {
  const name = (await getRestaurantNameById(orderRow.restaurant_id)) || "el restaurante";
  const brand = String(name).trim() || "el local";
  return [
    "*Tu pedido está listo para retirar*",
    `Ya podés pasar por *${brand}* a buscarlo.`,
    "Si te piden referencia, mostrá este mensaje o decí el nombre con el que pediste.",
    "¡Gracias!"
  ].join("\n");
}

/**
 * El dashboard setea `pickup_ready_notify_requested_at`; el bot envía WhatsApp y marca `pickup_ready_customer_notified_at`.
 */
async function processPickupReadyNotifyOrder(orderRow, whatsappClient) {
  if (!orderRow?.id) return;
  if (String(orderRow.fulfillment_type || "").toLowerCase() !== "local") return;
  if (orderRow.status !== "confirmed") return;
  if (!orderRow.pickup_ready_notify_requested_at) return;
  if (orderRow.pickup_ready_customer_notified_at) return;
  const ps = String(orderRow.payment_status || "").toLowerCase();
  if (ps !== "approved" && ps !== "paid") return;
  if (!whatsappClient) {
    console.warn("[pickup-notify] Sin WhatsApp, salto:", orderRow.id);
    return;
  }
  if (pickupNotifyInflight.has(orderRow.id)) return;
  pickupNotifyInflight.add(orderRow.id);

  try {
    const body = await buildPickupReadyWhatsAppBody(orderRow);
    const sendParams = {
      customerChatId: orderRow.customer_chat_id || null,
      customerNumber: orderRow.customer_number
    };
    await sendWhatsAppMessageRobust(whatsappClient, sendParams, body);

    const notifiedAt = new Date().toISOString();
    const { data: updated, error } = await supabase
      .from(TABLES.orders)
      .update({ pickup_ready_customer_notified_at: notifiedAt })
      .eq("id", orderRow.id)
      .eq("status", "confirmed")
      .not("pickup_ready_notify_requested_at", "is", null)
      .is("pickup_ready_customer_notified_at", null)
      .select("*")
      .maybeSingle();

    if (error) {
      console.error("[pickup-notify] Error actualizando fila:", orderRow.id, error.message);
      return;
    }
    if (!updated) {
      console.log("[pickup-notify] Sin match al marcar notificado (carrera):", orderRow.id);
      return;
    }

    await saveInteraction({
      restaurantId: updated.restaurant_id,
      customerNumber: updated.customer_number,
      botNumber: updated.bot_number,
      messageType: "text",
      userMessage: "[sistema] retiro listo (dashboard)",
      botResponse: body,
      metadata: {
        orderId: updated.id,
        pickupReadyNotified: true
      }
    });
    console.log("[pickup-notify] Cliente avisado retiro listo:", orderRow.id);
  } catch (err) {
    console.error("[pickup-notify] Fallo envío:", orderRow.id, err?.message || err);
  } finally {
    pickupNotifyInflight.delete(orderRow.id);
  }
}

async function scanPickupReadyNotifyPending(whatsappClient) {
  const { data, error } = await supabase
    .from(TABLES.orders)
    .select("*")
    .eq("fulfillment_type", "local")
    .eq("status", "confirmed")
    .not("pickup_ready_notify_requested_at", "is", null)
    .is("pickup_ready_customer_notified_at", null)
    .order("pickup_ready_notify_requested_at", { ascending: true })
    .limit(25);

  if (error) {
    console.error("[pickup-notify] Error escaneando:", error.message);
    return;
  }
  for (const row of data || []) {
    try {
      await processPickupReadyNotifyOrder(row, whatsappClient);
    } catch (err) {
      console.error("[pickup-notify] Error procesando", row.id, err);
    }
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
  } else if (deniedRows?.length) {
    console.log("[delivery-notify] Pendientes denegación encontrados:", deniedRows.length);
    for (const row of deniedRows) {
      try {
        await processDeliveryDeniedOrder(row, whatsappClient);
      } catch (err) {
        console.error("[delivery-notify] Error denegación", row.id, err);
      }
    }
  }

  await scanPickupReadyNotifyPending(whatsappClient);
  await scanDeliveryEnRoutePending(whatsappClient);
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
          await processPickupReadyNotifyOrder(payload.new, whatsappClient);
          await processDeliveryEnRouteNotifyOrder(payload.new, whatsappClient);
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
  processPickupReadyNotifyOrder,
  processDeliveryEnRouteNotifyOrder,
  scanAndProcessPending,
  scanPickupReadyNotifyPending,
  scanDeliveryEnRoutePending
};
