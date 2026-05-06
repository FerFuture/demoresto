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
  awaiting_delivery_total_confirm: "Cliente debe confirmar total con envío",
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

/** Pedido cargado desde el panel Mozo (no desde WhatsApp del cliente). */
export function orderPlacedByWaiter(order) {
  const notes = String(order?.notes || "");
  if (/Origen:\s*mozo\b/i.test(notes)) return true;
  if (/^Mozo\s*·\s*Mesa:/i.test(notes.trim())) return true;
  const pm = String(order?.payment_method ?? "").toLowerCase();
  if (pm.includes("efectivo_mesa")) return true;
  return false;
}

/** Solo UI (dashboard): estado del pedido en español; la BD no cambia. */
export function formatOrderStatusLabelEs(orderOrStatus) {
  const st =
    typeof orderOrStatus === "string"
      ? String(orderOrStatus).trim()
      : normalizeOrderStatus(orderOrStatus);
  const key = st || "pending";
  return ORDER_STATUS_LABELS[key] ?? key;
}

const PAYMENT_STATUS_LABELS_ES = {
  pending: "Pendiente",
  approved: "Aprobado",
  paid: "Pagado",
  cancelled: "Cancelado"
};

/** Solo UI (dashboard): estado de pago en español; la BD no cambia. */
export function formatPaymentStatusLabelEs(value) {
  const key = String(value ?? "").trim().toLowerCase();
  if (!key) return "—";
  return PAYMENT_STATUS_LABELS_ES[key] ?? String(value).trim();
}

export function fulfillmentIsDelivery(order) {
  const ft = String(order?.fulfillment_type ?? "").trim().toLowerCase();
  return ft === "delivery";
}

export function fulfillmentIsPickup(order) {
  const ft = String(order?.fulfillment_type ?? "").trim().toLowerCase();
  return ft === "local";
}

export function notesIndicateCustomerConfirmedDeliveryTotal(order) {
  if (order?.delivery_total_confirmed_at) return true;
  const n = String(order?.notes ?? "").toLowerCase();
  return (
    n.includes("cliente confirmó el total con envío") ||
    n.includes("cliente confirmo el total con envio") ||
    n.includes("total con envío (whatsapp)") ||
    n.includes("total con envio (whatsapp)")
  );
}

export function orderInDeliveryPool(order) {
  return Boolean(order?.delivery_ready_broadcast_at) && !order?.delivery_claimed_by_user_id;
}

export function orderClaimedByDeliveryUserId(order) {
  const id = order?.delivery_claimed_by_user_id;
  return id ? String(id) : "";
}

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
    return st === "pending" || st === "confirmed" || st === "delivery_fee_set";
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
  }
}

export function callableCustomerPhone(order) {
  const candidates = [order?.customer_phone, order?.customer_number];
  for (const raw of candidates) {
    const digits = String(raw || "").replace(/\D/g, "");
    if (!digits) continue;
    if (digits.length >= 8 && digits.length <= 14) return digits;
  }
  return null;
}

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

export function formatGroupedItemLine(names) {
  const { order, counts } = groupPlainNames(names);
  return order
    .map((name) => {
      const c = counts.get(name);
      return c > 1 ? `${name} x${c}` : name;
    })
    .join(", ");
}

export function groupOrderItemRows(order) {
  const names = flattenOrderItems(order);
  const { order: ord, counts } = groupPlainNames(names);
  return ord.map((name) => ({ name, count: counts.get(name) }));
}

/** Pedido en cola de cocina: confirmado, aún sin marcar listo. */
export function orderInKitchenQueue(order) {
  const st = normalizeOrderStatus(order);
  if (st === "delivered" || st === "cancelled") return false;
  if (st !== "confirmed") return false;
  if (order?.kitchen_ready_at) return false;
  return true;
}

/** Cocina ya marcó listo (listo para entregar / avisar). */
export function orderKitchenReady(order) {
  return Boolean(order?.kitchen_ready_at);
}

/** Mesa: columna table_number o texto en notas "Mesa: N". */
export function tableNumberLabel(order) {
  const n = order?.table_number;
  if (n != null && n !== "" && Number.isFinite(Number(n))) return String(Number(n));
  const notes = String(order?.notes || "");
  const m = notes.match(/Mesa:\s*(\d+)/i);
  return m ? m[1] : "";
}

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

/** Método de pago legible para cocina (pedidos del cliente). */
export function kitchenPaymentMethodLabelEs(order) {
  const key = paymentMethodKey(order);
  if (key === "mp") return "Mercado Pago";
  if (key === "cash") return "Efectivo al recibir";
  const raw = String(order?.payment_method ?? "").trim();
  return raw || "—";
}

/**
 * Texto del recuadro informativo en cocina: sin detalle de ítems ni confirmaciones de WhatsApp.
 * Mozo: notas operativas (sin prefijo "Origen"). Cliente delivery: dirección + pago. Cliente local: teléfono + retiro.
 */
export function kitchenMetaBoxContent(order) {
  if (orderPlacedByWaiter(order)) {
    let raw = String(order?.notes || "").trim();
    if (!raw) return "";
    raw = raw.replace(/^Origen:\s*mozo\s*\|\s*/i, "").replace(/^Origen:\s*mozo\b\s*/i, "");
    const formatted = formatOrderNotesForDisplay(raw);
    return formatted || raw;
  }
  if (isDeliveryOrder(order)) {
    const addr = String(order?.address ?? "").trim();
    const pay = kitchenPaymentMethodLabelEs(order);
    return `Dirección: ${addr || "—"} | Pago: ${pay}`;
  }
  const digits = callableCustomerPhone(order);
  const phone = digits ? formatPhoneLabel(digits) : "—";
  return `Teléfono: ${phone} | Retiro en local`;
}

/**
 * Bloque "Notas" del admin: ítems // confirmación por WhatsApp del total delivery (si aplica).
 * Dirección, pago y demás datos operativos no van aquí (figuran en el resto del panel).
 */
export function adminDashboardNotesBlock(order) {
  const chunks = [];

  const itemsLine = formatGroupedItemLine(flattenOrderItems(order));
  if (itemsLine) {
    chunks.push(`Items: ${itemsLine}`);
  }

  if (order?.delivery_total_confirmed_at) {
    const dt = formatDateTime(order.delivery_total_confirmed_at);
    chunks.push(
      dt
        ? `Cliente confirmó el total con envío (WhatsApp) · ${dt}`
        : "Cliente confirmó el total con envío (WhatsApp)."
    );
  } else if (notesIndicateCustomerConfirmedDeliveryTotal(order)) {
    chunks.push("Cliente confirmó el total con envío (WhatsApp).");
  }

  const joined = chunks.filter(Boolean).join(" // ");
  if (joined) return joined;
  return (
    formatOrderNotesForDisplay(order?.notes) ||
    String(order?.raw_request || "").trim() ||
    ""
  );
}
