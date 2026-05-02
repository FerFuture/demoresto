// Helpers compartidos entre las vistas Admin y Delivery.
// Mantengo la misma semántica de estados que ya usa el bot.

export const ORDER_STATUS_COLORS = {
  awaiting_payment_method: "bg-violet-500/20 text-violet-300 border border-violet-500/30",
  awaiting_delivery_fee: "bg-orange-500/20 text-orange-200 border border-orange-500/40",
  delivery_fee_set: "bg-cyan-500/15 text-cyan-200 border border-cyan-500/35",
  awaiting_delivery_total_confirm:
    "bg-indigo-500/15 text-indigo-200 border border-indigo-500/35",
  delivery_denied: "bg-amber-700/30 text-amber-100 border border-amber-600/40",
  delivery_denial_notify_failed: "bg-rose-700/30 text-rose-100 border border-rose-600/45",
  notify_failed: "bg-rose-600/25 text-rose-200 border border-rose-500/40",
  pending_payment: "bg-fuchsia-500/20 text-fuchsia-300 border border-fuchsia-500/30",
  pending: "bg-amber-500/20 text-amber-300 border border-amber-500/30",
  confirmed: "bg-blue-500/20 text-blue-300 border border-blue-500/30",
  delivered: "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30",
  cancelled: "bg-rose-500/20 text-rose-300 border border-rose-500/30"
};

export const ORDER_STATUS_LABELS = {
  awaiting_payment_method: "Esperando método de pago",
  awaiting_delivery_fee: "Esperando costo envío",
  delivery_fee_set: "Costo envío confirmado",
  awaiting_delivery_total_confirm: "Cliente debe confirmar total (WA)",
  delivery_denied: "Delivery cancelado",
  delivery_denial_notify_failed: "Aviso cancelación falló",
  notify_failed: "Aviso a cliente falló",
  pending_payment: "Esperando pago",
  pending: "Pendiente",
  confirmed: "Confirmado",
  delivered: "Entregado",
  cancelled: "Cancelado"
};

export function currency(value) {
  if (value === null || value === undefined) return "-";
  return new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency: "ARS"
  }).format(Number(value));
}

export function normalizeOrderStatus(order) {
  return String(order?.status ?? "").trim();
}

export function fulfillmentIsDelivery(order) {
  const ft = String(order?.fulfillment_type ?? "").trim().toLowerCase();
  return ft === "delivery";
}

/** Retiro / pickup en el local (columna `fulfillment_type = local`). */
export function fulfillmentIsPickup(order) {
  const ft = String(order?.fulfillment_type ?? "").trim().toLowerCase();
  return ft === "local";
}

/** Efectivo + delivery: el cliente aceptó el total por WhatsApp (nota que agrega el bot). */
export function notesIndicateCustomerConfirmedDeliveryTotal(order) {
  const n = String(order?.notes ?? "").toLowerCase();
  return (
    n.includes("cliente confirmó el total con envío") ||
    n.includes("cliente confirmo el total con envio") ||
    n.includes("total con envío (whatsapp)") ||
    n.includes("total con envio (whatsapp)")
  );
}

/** Pedido en pool: admin ya avisó repartidores y nadie lo tomó aún. */
export function orderInDeliveryPool(order) {
  return Boolean(order?.delivery_ready_broadcast_at) && !order?.delivery_claimed_by_user_id;
}

export function orderClaimedByDeliveryUserId(order) {
  const id = order?.delivery_claimed_by_user_id;
  return id ? String(id) : "";
}

/** Admin puede avisar a repartidores que el pedido está listo para salir (cocina terminada). */
export function adminCanNotifyDeliveriesReady(order) {
  if (!isDeliveryOrder(order)) return false;
  const st = normalizeOrderStatus(order);
  if (st === "cancelled" || st === "delivered" || st === "delivery_denied") return false;

  const method = paymentMethodKey(order);
  const approved = paymentIsApproved(order);

  if (method === "cash" && !approved) {
    if (st === "awaiting_delivery_total_confirm") return false;
    if (deliveryFeeStillUnset(order)) return false;
    if (!notesIndicateCustomerConfirmedDeliveryTotal(order)) return false;
    return st === "pending" || st === "delivery_fee_set";
  }

  if (approved) {
    return st === "confirmed" || st === "pending";
  }

  return false;
}

export function adminShowNotifyDeliveriesReadyButton(order) {
  return (
    adminCanNotifyDeliveriesReady(order) &&
    !order?.delivery_ready_broadcast_at &&
    !order?.delivery_claimed_by_user_id
  );
}

/** Repartidor (sesión con userId): el pedido está en cola y se puede intentar tomar. */
export function deliveryOrderInOpenPool(order) {
  if (!order?.delivery_ready_broadcast_at) return false;
  if (order.delivery_claimed_by_user_id) return false;
  const st = normalizeOrderStatus(order);
  return st !== "cancelled" && st !== "delivered" && st !== "delivery_denied";
}

export function paymentMethodKey(order) {
  const raw = String(order?.payment_method ?? "").trim().toLowerCase();
  if (!raw) return "unknown";
  if (raw.includes("efectivo") || raw === "cash") return "cash";
  if (raw.includes("mercado") || raw === "mp" || raw === "mercadopago") return "mp";
  return "other";
}

export function paymentIsApproved(order) {
  const ps = String(order?.payment_status ?? "").trim().toLowerCase();
  return ps === "approved" || ps === "paid";
}

export function formatDateTime(value) {
  if (!value) return null;
  try {
    return new Date(value).toLocaleString("es-AR");
  } catch {
    return null;
  }
}

/** Misma redacción que genera el bot al cerrar el pedido (histórico); también confía en fulfillment_type. */
export function notesIndicateDelivery(order) {
  if (fulfillmentIsDelivery(order)) return true;
  const n = String(order?.notes ?? "").toLowerCase();
  return n.includes("modalidad: delivery") || n.includes("modalidad:delivery");
}

export function isDeliveryOrder(order) {
  return fulfillmentIsDelivery(order) || notesIndicateDelivery(order);
}

export function deliveryFeeStillUnset(order) {
  if (order.delivery_fee == null || order.delivery_fee === "") return true;
  const ft = order.final_total_amount;
  if (ft != null && ft !== "") return false;
  return Number(order.delivery_fee) <= 0;
}

export function orderNeedsDeliveryFeeControls(order) {
  const st = normalizeOrderStatus(order);
  if (st === "awaiting_delivery_fee") return true;
  if (!isDeliveryOrder(order)) return false;
  if (!deliveryFeeStillUnset(order)) return false;
  return st === "pending";
}

export function subtotalForOrder(order) {
  const s = Number(order.subtotal_amount ?? order.total_price ?? order.total_amount ?? 0);
  return Number.isFinite(s) ? s : 0;
}

/**
 * Total a cobrar/registrar al cerrar el pedido.
 * Si hay total final (con envío), prevalece. Si no, el subtotal.
 */
export function effectiveOrderTotal(order) {
  const ft = Number(order.final_total_amount);
  if (Number.isFinite(ft) && ft > 0) return ft;
  return subtotalForOrder(order);
}

export function playNotification() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    oscillator.type = "triangle";
    oscillator.frequency.value = 880;
    gain.gain.value = 0.08;
    oscillator.connect(gain);
    gain.connect(ctx.destination);
    oscillator.start();
    oscillator.stop(ctx.currentTime + 0.15);
  } catch {
    // El usuario aún no interactuó con el tab; el browser bloquea audio.
  }
}

/**
 * Lista plana de items normalizados a string. El bot guarda `items` como
 * array de nombres (string), pero por compat aceptamos también objetos.
 */
/**
 * Devuelve un telefono "llamable" (string de digitos) priorizando
 * `customer_phone` (resuelto por el bot via Contact) y cayendo al
 * `customer_number`. Si nada parece telefono real (tipico cuando el cliente
 * usa @lid y WhatsApp no expone el numero), devuelve null.
 */
export function callableCustomerPhone(order) {
  const candidates = [order?.customer_phone, order?.customer_number];
  for (const raw of candidates) {
    const digits = String(raw || "").replace(/\D/g, "");
    if (!digits) continue;
    // E.164 valido razonable: 8 a 15 digitos. LIDs tipicos son ~15 sin
    // estructura de pais; siendo cautos, dejamos pasar hasta 14.
    if (digits.length >= 8 && digits.length <= 14) return digits;
  }
  return null;
}

/** Presentacion legible de digitos (ARG movil u otros). Solo display. */
export function formatPhoneLabel(digits) {
  const d = String(digits || "").replace(/\D/g, "");
  if (!d) return "";
  if (d.startsWith("549") && d.length === 13) {
    return `+54 9 ${d.slice(3, 5)} ${d.slice(5, 9)}-${d.slice(9)}`;
  }
  if (d.startsWith("54") && d.length === 12) {
    return `+54 ${d.slice(2, 4)} ${d.slice(4, 8)}-${d.slice(8)}`;
  }
  return `+${d}`;
}

export function flattenOrderItems(order) {
  const raw = order?.items;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((it) => {
      if (typeof it === "string") return it.trim();
      if (it && typeof it === "object") {
        return String(it.name || it.title || "").trim();
      }
      return "";
    })
    .filter(Boolean);
}

function groupPlainNames(names) {
  const counts = new Map();
  const order = [];
  for (const raw of names) {
    const n = String(raw || "").trim();
    if (!n) continue;
    if (!counts.has(n)) {
      counts.set(n, 0);
      order.push(n);
    }
    counts.set(n, counts.get(n) + 1);
  }
  return { order, counts };
}

/** Una línea tipo "mariolis x6, pizza x2" a partir de nombres repetidos. */
export function formatGroupedItemLine(names) {
  const { order, counts } = groupPlainNames(names);
  return order
    .map((name) => {
      const c = counts.get(name);
      return c > 1 ? `${name} x${c}` : name;
    })
    .join(", ");
}

/** Para UI de delivery/admin: filas con nombre y cantidad. */
export function groupOrderItemRows(order) {
  const names = flattenOrderItems(order);
  const { order: ord, counts } = groupPlainNames(names);
  return ord.map((name) => ({ name, count: counts.get(name) }));
}

/**
 * Notas legibles: agrupa ítems en Detalle, saca modalidad y dirección (ya están en otros campos).
 */
export function formatOrderNotesForDisplay(rawNotes) {
  const s = String(rawNotes || "").trim();
  if (!s) return "";

  const segments = s.split(/\s*\|\s*/).map((x) => x.trim()).filter(Boolean);
  const out = [];
  for (const seg of segments) {
    if (/^modalidad:/i.test(seg)) continue;
    if (/^direcci[oó]n:/i.test(seg)) continue;
    if (/^detalle:/i.test(seg)) {
      const body = seg.replace(/^detalle:\s*/i, "").trim();
      const pieces = body.split(",").map((x) => x.trim()).filter(Boolean);
      out.push(`Detalle: ${formatGroupedItemLine(pieces)}`);
    } else {
      out.push(seg);
    }
  }
  return out.join(" | ");
}
