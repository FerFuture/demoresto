import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "./supabaseClient";

const ORDER_STATUS_COLORS = {
  awaiting_payment_method: "bg-violet-500/20 text-violet-300 border border-violet-500/30",
  awaiting_delivery_fee: "bg-orange-500/20 text-orange-200 border border-orange-500/40",
  delivery_fee_set: "bg-cyan-500/15 text-cyan-200 border border-cyan-500/35",
  delivery_denied: "bg-amber-700/30 text-amber-100 border border-amber-600/40",
  delivery_denial_notify_failed: "bg-rose-700/30 text-rose-100 border border-rose-600/45",
  notify_failed: "bg-rose-600/25 text-rose-200 border border-rose-500/40",
  pending_payment: "bg-fuchsia-500/20 text-fuchsia-300 border border-fuchsia-500/30",
  pending: "bg-amber-500/20 text-amber-300 border border-amber-500/30",
  confirmed: "bg-blue-500/20 text-blue-300 border border-blue-500/30",
  delivered: "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30",
  cancelled: "bg-rose-500/20 text-rose-300 border border-rose-500/30"
};

function currency(value) {
  if (value === null || value === undefined) return "-";
  return new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency: "ARS"
  }).format(Number(value));
}

function normalizeOrderStatus(order) {
  return String(order?.status ?? "").trim();
}

function fulfillmentIsDelivery(order) {
  const ft = String(order?.fulfillment_type ?? "").trim().toLowerCase();
  return ft === "delivery";
}

function paymentMethodKey(order) {
  const raw = String(order?.payment_method ?? "").trim().toLowerCase();
  if (!raw) return "unknown";
  if (raw.includes("efectivo") || raw === "cash") return "cash";
  if (raw.includes("mercado") || raw === "mp" || raw === "mercadopago") return "mp";
  return "other";
}

function paymentIsApproved(order) {
  const ps = String(order?.payment_status ?? "").trim().toLowerCase();
  return ps === "approved" || ps === "paid";
}

function formatPaidAt(value) {
  if (!value) return null;
  try {
    return new Date(value).toLocaleString("es-AR");
  } catch {
    return null;
  }
}

/** Misma redacción que genera el bot en `index.js` al cerrar el pedido. */
function notesIndicateDelivery(order) {
  const n = String(order?.notes ?? "").toLowerCase();
  return n.includes("modalidad: delivery") || n.includes("modalidad:delivery");
}

function deliveryFeeStillUnset(order) {
  if (order.delivery_fee == null || order.delivery_fee === "") return true;
  const ft = order.final_total_amount;
  if (ft != null && ft !== "") return false;
  return Number(order.delivery_fee) <= 0;
}

/**
 * Muestra confirmar envío + negar delivery: estado explícito del bot o delivery pendiente de tarifa.
 */
function orderNeedsDeliveryFeeControls(order) {
  const st = normalizeOrderStatus(order);
  if (st === "awaiting_delivery_fee") return true;

  const isDelivery = fulfillmentIsDelivery(order) || notesIndicateDelivery(order);
  if (!isDelivery) return false;
  if (!deliveryFeeStillUnset(order)) return false;

  return st === "pending";
}

function playNotification() {
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
}

export default function App() {
  const [activeTab, setActiveTab] = useState("orders");
  const [orders, setOrders] = useState([]);
  const [menuItems, setMenuItems] = useState([]);
  const [restaurantId, setRestaurantId] = useState("");
  const [restaurantName, setRestaurantName] = useState("");
  const [loadingOrders, setLoadingOrders] = useState(true);
  const [loadingMenu, setLoadingMenu] = useState(true);
  const [savingItemId, setSavingItemId] = useState(null);
  const [savingOrderId, setSavingOrderId] = useState(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [addingItem, setAddingItem] = useState(false);
  const [newItem, setNewItem] = useState({
    name: "",
    description: "",
    category: "",
    price: ""
  });
  const [error, setError] = useState("");
  /** Borrador de costo envío por id de pedido (solo UI). */
  const [feeDraftByOrder, setFeeDraftByOrder] = useState({});
  /** Panel de negar delivery: pedido con textarea abierto + motivo por id. */
  const [denyExpandedOrderId, setDenyExpandedOrderId] = useState(null);
  const [denyReasonByOrder, setDenyReasonByOrder] = useState({});
  const [editingItemId, setEditingItemId] = useState(null);
  const [editDraft, setEditDraft] = useState({
    name: "",
    description: "",
    category: "",
    price: ""
  });
  /**
   * Modal de confirmación in-page (reemplazo estético de window.confirm).
   * `tone` controla colores ("danger" rojo, "warning" ámbar, "info" azul).
   */
  const [confirmDialog, setConfirmDialog] = useState(null);
  const confirmResolverRef = useRef(null);

  function requestConfirm({
    title = "Confirmar acción",
    message = "",
    confirmLabel = "Confirmar",
    cancelLabel = "Cancelar",
    tone = "danger"
  } = {}) {
    return new Promise((resolve) => {
      confirmResolverRef.current = resolve;
      setConfirmDialog({ title, message, confirmLabel, cancelLabel, tone });
    });
  }

  function handleConfirmDialog(value) {
    const resolver = confirmResolverRef.current;
    confirmResolverRef.current = null;
    setConfirmDialog(null);
    if (typeof resolver === "function") resolver(Boolean(value));
  }

  const sortedOrders = useMemo(
    () =>
      [...orders].sort(
        (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      ),
    [orders]
  );

  async function loadOrders(forRestaurantId) {
    const rid = forRestaurantId || restaurantId;
    if (!rid) {
      setOrders([]);
      setLoadingOrders(false);
      return;
    }

    setLoadingOrders(true);
    const { data, error: queryError } = await supabase
      .from("orders")
      .select("*")
      .eq("restaurant_id", rid)
      .order("created_at", { ascending: false })
      .limit(100);

    if (queryError) {
      setError(`Error cargando pedidos: ${queryError.message}`);
      setLoadingOrders(false);
      return;
    }

    setOrders(data || []);
    setLoadingOrders(false);
  }

  async function loadMenu() {
    if (!restaurantId) {
      setMenuItems([]);
      setLoadingMenu(false);
      return;
    }

    setLoadingMenu(true);
    const { data, error: queryError } = await supabase
      .from("menu_items")
      .select("*")
      .eq("restaurant_id", restaurantId)
      .order("category", { ascending: true })
      .order("name", { ascending: true });

    if (queryError) {
      setError(`Error cargando menu: ${queryError.message}`);
      setLoadingMenu(false);
      return;
    }

    setMenuItems(data || []);
    setLoadingMenu(false);
  }

  async function updateOrderStatus(orderId, nextStatus) {
    setSavingOrderId(orderId);
    const { error: updateError } = await supabase
      .from("orders")
      .update({ status: nextStatus })
      .eq("id", orderId);

    if (updateError) {
      setError(`Error actualizando estado del pedido: ${updateError.message}`);
      setSavingOrderId(null);
      return;
    }

    setOrders((prev) => prev.map((order) => (order.id === orderId ? { ...order, status: nextStatus } : order)));
    setSavingOrderId(null);
  }

  /**
   * Confirma el cobro en efectivo del pedido. Marca el pedido como confirmado
   * y registra el momento del pago. Solo aplica cuando `payment_method = efectivo`.
   */
  async function confirmCashPayment(order) {
    if (paymentMethodKey(order) !== "cash") {
      setError("Solo los pedidos en efectivo se confirman manualmente desde el dashboard.");
      return;
    }
    setError("");
    setSavingOrderId(order.id);
    const paidAtIso = new Date().toISOString();
    const patch = {
      status: "confirmed",
      payment_status: "paid",
      payment_paid_at: paidAtIso
    };
    const { data: updatedRow, error: updateError } = await supabase
      .from("orders")
      .update(patch)
      .eq("id", order.id)
      .select("*")
      .maybeSingle();

    if (updateError) {
      setError(`Error confirmando pago efectivo: ${updateError.message}`);
      setSavingOrderId(null);
      return;
    }
    if (!updatedRow) {
      setError("No se actualizó el pedido. Recargá la lista o probá de nuevo.");
      setSavingOrderId(null);
      return;
    }

    setOrders((prev) =>
      prev.map((row) => (row.id === order.id ? { ...row, ...updatedRow } : row))
    );
    setSavingOrderId(null);
  }

  /**
   * Revierte una confirmación de pago en efectivo hecha por error desde el
   * dashboard. Vuelve el pedido a `pending` y limpia el registro de pago.
   * Solo se permite para pedidos en efectivo que aún no fueron entregados ni
   * cancelados; si MP ya aprobó el pago, no debe usarse.
   */
  async function revertCashPayment(order) {
    if (paymentMethodKey(order) !== "cash") {
      setError("Solo se puede revertir el pago en pedidos en efectivo.");
      return;
    }
    const st = normalizeOrderStatus(order);
    if (st === "delivered" || st === "cancelled") {
      setError("No se puede revertir el pago de un pedido entregado o cancelado.");
      return;
    }
    const ok = await requestConfirm({
      title: "Revertir pago en efectivo",
      message:
        "El pedido vuelve a 'pendiente' hasta que el cliente pague o se cancele. ¿Continuar?",
      confirmLabel: "Sí, revertir pago",
      cancelLabel: "Volver",
      tone: "warning"
    });
    if (!ok) return;

    setError("");
    setSavingOrderId(order.id);
    const patch = {
      status: "pending",
      payment_status: "pending",
      payment_paid_at: null
    };
    const { data: updatedRow, error: updateError } = await supabase
      .from("orders")
      .update(patch)
      .eq("id", order.id)
      .eq("payment_status", "paid")
      .select("*")
      .maybeSingle();

    if (updateError) {
      setError(`Error revirtiendo pago efectivo: ${updateError.message}`);
      setSavingOrderId(null);
      return;
    }
    if (!updatedRow) {
      setError(
        "No se pudo revertir (quizá el pedido ya cambió de estado). Recargá la lista."
      );
      setSavingOrderId(null);
      return;
    }

    setOrders((prev) =>
      prev.map((row) => (row.id === order.id ? { ...row, ...updatedRow } : row))
    );
    setSavingOrderId(null);
  }

  /**
   * Marca el pedido como entregado y registra `delivered_at`. Solo aplica a
   * pedidos que aún no estaban entregados ni cancelados.
   */
  async function markDelivered(order) {
    const st = normalizeOrderStatus(order);
    if (st === "delivered" || st === "cancelled") {
      setError("Este pedido ya está cerrado.");
      return;
    }
    setError("");
    setSavingOrderId(order.id);
    const patch = {
      status: "delivered",
      delivered_at: new Date().toISOString()
    };
    const { data: updatedRow, error: updateError } = await supabase
      .from("orders")
      .update(patch)
      .eq("id", order.id)
      .neq("status", "delivered")
      .neq("status", "cancelled")
      .select("*")
      .maybeSingle();

    if (updateError) {
      setError(`Error marcando como entregado: ${updateError.message}`);
      setSavingOrderId(null);
      return;
    }
    if (!updatedRow) {
      setError("No se pudo marcar como entregado (el pedido cambió de estado). Recargá la lista.");
      setSavingOrderId(null);
      return;
    }

    setOrders((prev) =>
      prev.map((row) => (row.id === order.id ? { ...row, ...updatedRow } : row))
    );
    setSavingOrderId(null);
  }

  /**
   * Cancela el pedido y registra `cancelled_at`. No emite refunds ni
   * notificaciones automáticas.
   */
  async function markCancelled(order) {
    const st = normalizeOrderStatus(order);
    if (st === "cancelled") {
      setError("El pedido ya está cancelado.");
      return;
    }
    const ok = await requestConfirm({
      title: "Cancelar pedido",
      message:
        "El pedido se marcará como cancelado. Si fue pagado por Mercado Pago, el reembolso se gestiona aparte.",
      confirmLabel: "Sí, cancelar pedido",
      cancelLabel: "Volver",
      tone: "danger"
    });
    if (!ok) return;

    setError("");
    setSavingOrderId(order.id);
    const patch = {
      status: "cancelled",
      cancelled_at: new Date().toISOString()
    };
    const { data: updatedRow, error: updateError } = await supabase
      .from("orders")
      .update(patch)
      .eq("id", order.id)
      .neq("status", "cancelled")
      .select("*")
      .maybeSingle();

    if (updateError) {
      setError(`Error cancelando pedido: ${updateError.message}`);
      setSavingOrderId(null);
      return;
    }
    if (!updatedRow) {
      setError("No se pudo cancelar (el pedido ya estaba cancelado). Recargá la lista.");
      setSavingOrderId(null);
      return;
    }

    setOrders((prev) =>
      prev.map((row) => (row.id === order.id ? { ...row, ...updatedRow } : row))
    );
    setSavingOrderId(null);
  }

  /**
   * Revierte un pedido cerrado (delivered/cancelled) al estado activo previo
   * que mejor refleja la situación: `confirmed` si el pago ya estaba
   * registrado, o `pending` en caso contrario. Limpia los timestamps de cierre.
   */
  async function revertClosedOrder(order, fromStatus) {
    const st = normalizeOrderStatus(order);
    if (st !== fromStatus) {
      setError("El pedido ya no está en ese estado. Recargá la lista.");
      return;
    }
    const label = fromStatus === "delivered" ? "entrega" : "cancelación";
    const ok = await requestConfirm({
      title: fromStatus === "delivered" ? "Revertir entrega" : "Revertir cancelación",
      message: `El pedido vuelve a estar activo. ¿Revertir ${label}?`,
      confirmLabel: `Sí, revertir ${label}`,
      cancelLabel: "Volver",
      tone: "warning"
    });
    if (!ok) return;

    setError("");
    setSavingOrderId(order.id);
    const previousStatus = paymentIsApproved(order) ? "confirmed" : "pending";
    const patch = {
      status: previousStatus
    };
    if (fromStatus === "delivered") {
      patch.delivered_at = null;
    } else if (fromStatus === "cancelled") {
      patch.cancelled_at = null;
    }

    const { data: updatedRow, error: updateError } = await supabase
      .from("orders")
      .update(patch)
      .eq("id", order.id)
      .eq("status", fromStatus)
      .select("*")
      .maybeSingle();

    if (updateError) {
      setError(`Error revirtiendo ${label}: ${updateError.message}`);
      setSavingOrderId(null);
      return;
    }
    if (!updatedRow) {
      setError(`No se pudo revertir (el pedido ya cambió de estado). Recargá la lista.`);
      setSavingOrderId(null);
      return;
    }

    setOrders((prev) =>
      prev.map((row) => (row.id === order.id ? { ...row, ...updatedRow } : row))
    );
    setSavingOrderId(null);
  }

  function subtotalForOrder(order) {
    const s = Number(order.subtotal_amount ?? order.total_price ?? order.total_amount ?? 0);
    return Number.isFinite(s) ? s : 0;
  }

  async function confirmDeliveryFee(order) {
    setError("");
    const raw = feeDraftByOrder[order.id] ?? "";
    const fee = Number(String(raw).replace(",", "."));
    if (!Number.isFinite(fee) || fee <= 0) {
      setError("El costo de envío debe ser mayor a 0.");
      return;
    }
    const subtotal = subtotalForOrder(order);
    if (subtotal <= 0) {
      setError("El subtotal del pedido no es válido.");
      return;
    }
    const finalTotal = Math.round((subtotal + fee) * 100) / 100;

    setSavingOrderId(order.id);
    const patch = {
      delivery_fee: fee,
      final_total_amount: finalTotal,
      status: "delivery_fee_set"
    };
    const st = normalizeOrderStatus(order);
    let updateQuery = supabase.from("orders").update(patch).eq("id", order.id);
    if (st === "awaiting_delivery_fee") {
      updateQuery = updateQuery.eq("status", "awaiting_delivery_fee");
    } else if (st === "pending" && orderNeedsDeliveryFeeControls(order)) {
      updateQuery = updateQuery.eq("status", "pending");
      if (fulfillmentIsDelivery(order)) {
        updateQuery = updateQuery.eq("fulfillment_type", "delivery");
      } else if (notesIndicateDelivery(order)) {
        updateQuery = updateQuery.ilike("notes", "%modalidad: delivery%");
      }
    } else {
      setError("Este pedido no está esperando costo de envío (estado inesperado). Recargá la página.");
      setSavingOrderId(null);
      return;
    }

    const { data: updatedRow, error: updateError } = await updateQuery.select("*").maybeSingle();

    if (updateError) {
      setError(`Error confirmando envío: ${updateError.message}`);
      setSavingOrderId(null);
      return;
    }
    if (!updatedRow) {
      setError(
        "No se actualizó el pedido (quizá ya cambió de estado). Recargá la lista o probá de nuevo."
      );
      setSavingOrderId(null);
      return;
    }

    setOrders((prev) =>
      prev.map((row) =>
        row.id === order.id
          ? {
              ...row,
              delivery_fee: updatedRow.delivery_fee ?? fee,
              final_total_amount: updatedRow.final_total_amount ?? finalTotal,
              status: updatedRow.status ?? "delivery_fee_set"
            }
          : row
      )
    );
    setSavingOrderId(null);
  }

  async function denyDelivery(order) {
    setError("");
    const reason = String(denyReasonByOrder[order.id] ?? "").trim();
    if (reason.length < 3) {
      setError("Escribí un motivo (al menos 3 caracteres) para informar al cliente.");
      return;
    }

    setSavingOrderId(order.id);
    const patch = {
      status: "delivery_denied",
      delivery_denial_reason: reason
    };
    const st = normalizeOrderStatus(order);
    let updateQuery = supabase.from("orders").update(patch).eq("id", order.id);
    if (st === "awaiting_delivery_fee") {
      updateQuery = updateQuery.eq("status", "awaiting_delivery_fee");
    } else if (st === "pending" && orderNeedsDeliveryFeeControls(order)) {
      updateQuery = updateQuery.eq("status", "pending");
      if (fulfillmentIsDelivery(order)) {
        updateQuery = updateQuery.eq("fulfillment_type", "delivery");
      } else if (notesIndicateDelivery(order)) {
        updateQuery = updateQuery.ilike("notes", "%modalidad: delivery%");
      }
    } else {
      setError("Este pedido no permite cancelar delivery desde acá (estado inesperado). Recargá la página.");
      setSavingOrderId(null);
      return;
    }

    const { data: updatedRow, error: updateError } = await updateQuery.select("*").maybeSingle();

    if (updateError) {
      setError(`Error al cancelar delivery: ${updateError.message}`);
      setSavingOrderId(null);
      return;
    }
    if (!updatedRow) {
      setError(
        "No se actualizó el pedido (quizá ya cambió de estado). Recargá la lista o probá de nuevo."
      );
      setSavingOrderId(null);
      return;
    }

    setOrders((prev) =>
      prev.map((row) =>
        row.id === order.id
          ? {
              ...row,
              status: updatedRow.status ?? "delivery_denied",
              delivery_denial_reason: updatedRow.delivery_denial_reason ?? reason
            }
          : row
      )
    );
    setDenyExpandedOrderId(null);
    setDenyReasonByOrder((prev) => {
      const next = { ...prev };
      delete next[order.id];
      return next;
    });
    setSavingOrderId(null);
  }

  async function retryDeliveryDenialNotify(orderId) {
    setError("");
    setSavingOrderId(orderId);
    const { error: updateError } = await supabase
      .from("orders")
      .update({ status: "delivery_denied" })
      .eq("id", orderId)
      .eq("status", "delivery_denial_notify_failed");

    if (updateError) {
      setError(`Error al reintentar aviso de cancelación: ${updateError.message}`);
      setSavingOrderId(null);
      return;
    }

    setOrders((prev) =>
      prev.map((row) => (row.id === orderId ? { ...row, status: "delivery_denied" } : row))
    );
    setSavingOrderId(null);
  }

  async function retryNotifyCustomer(orderId) {
    setError("");
    setSavingOrderId(orderId);
    const { error: updateError } = await supabase
      .from("orders")
      .update({ status: "delivery_fee_set" })
      .eq("id", orderId)
      .eq("status", "notify_failed");

    if (updateError) {
      setError(`Error al reintentar: ${updateError.message}`);
      setSavingOrderId(null);
      return;
    }

    setOrders((prev) =>
      prev.map((row) => (row.id === orderId ? { ...row, status: "delivery_fee_set" } : row))
    );
    setSavingOrderId(null);
  }

  useEffect(() => {
    async function loadRestaurant() {
      const configuredBotNumber = (import.meta.env.VITE_BOT_WHATSAPP_NUMBER || "").replace(/\D/g, "");
      let query = supabase.from("restaurants").select("id, name, whatsapp_number");
      if (configuredBotNumber) {
        query = query.eq("whatsapp_number", configuredBotNumber);
      } else {
        query = query.limit(1);
      }

      const { data, error: restaurantError } = await query.maybeSingle();
      if (restaurantError) {
        setError(`Error resolviendo restaurante: ${restaurantError.message}`);
        return;
      }
      if (!data) {
        setError(
          "No se encontro el restaurante para este dashboard. Configura DASHBOARD_BOT_WHATSAPP_NUMBER en el .env principal."
        );
        return;
      }

      setRestaurantId(data.id);
      setRestaurantName(data.name || "");
    }

    loadRestaurant();
  }, []);

  useEffect(() => {
    if (!restaurantId) return undefined;

    loadOrders(restaurantId);
    loadMenu();

    const channel = supabase
      .channel(`orders-realtime-${restaurantId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "orders",
          filter: `restaurant_id=eq.${restaurantId}`
        },
        (payload) => {
          setOrders((prev) => [payload.new, ...prev]);
          playNotification();
        }
      )
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "orders",
          filter: `restaurant_id=eq.${restaurantId}`
        },
        (payload) => {
          setOrders((prev) => prev.map((row) => (row.id === payload.new.id ? payload.new : row)));
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [restaurantId]);

  async function updateMenuItem(itemId, values) {
    setSavingItemId(itemId);
    const { error: updateError } = await supabase.from("menu_items").update(values).eq("id", itemId);
    if (updateError) {
      setError(`Error guardando item: ${updateError.message}`);
      setSavingItemId(null);
      return false;
    }

    setMenuItems((prev) => prev.map((item) => (item.id === itemId ? { ...item, ...values } : item)));
    setSavingItemId(null);
    return true;
  }

  function openEditMenuItem(item) {
    setError("");
    setEditingItemId(item.id);
    setEditDraft({
      name: item.name || "",
      description: item.description || "",
      category: item.category || "",
      price: item.price != null ? String(item.price) : ""
    });
  }

  function cancelEditMenuItem() {
    setEditingItemId(null);
    setEditDraft({ name: "", description: "", category: "", price: "" });
  }

  async function saveEditedMenuItem(event) {
    event.preventDefault();
    if (!editingItemId) return;
    const price = Number(String(editDraft.price).replace(",", "."));
    if (!editDraft.name.trim()) {
      setError("El nombre del producto es obligatorio.");
      return;
    }
    if (!Number.isFinite(price)) {
      setError("El precio debe ser un numero valido.");
      return;
    }
    const ok = await updateMenuItem(editingItemId, {
      name: editDraft.name.trim(),
      description: editDraft.description.trim() || null,
      category: editDraft.category.trim() || null,
      price
    });
    if (ok) cancelEditMenuItem();
  }

  async function createMenuItem(event) {
    event.preventDefault();
    if (!restaurantId) {
      setError("No se pudo identificar el restaurante para guardar el producto.");
      return;
    }

    const price = Number(String(newItem.price).replace(",", "."));
    if (!newItem.name.trim()) {
      setError("El nombre del producto es obligatorio.");
      return;
    }
    if (!Number.isFinite(price)) {
      setError("El precio debe ser un numero valido.");
      return;
    }

    setAddingItem(true);
    const payload = {
      restaurant_id: restaurantId,
      name: newItem.name.trim(),
      description: newItem.description.trim() || null,
      category: newItem.category.trim() || null,
      price,
      available: true
    };

    const { data, error: insertError } = await supabase
      .from("menu_items")
      .insert(payload)
      .select("*")
      .single();

    if (insertError) {
      setError(`Error creando producto: ${insertError.message}`);
      setAddingItem(false);
      return;
    }

    setMenuItems((prev) => [...prev, data]);
    setNewItem({ name: "", description: "", category: "", price: "" });
    setShowAddForm(false);
    setAddingItem(false);
  }

  async function deleteMenuItem(itemId) {
    setSavingItemId(itemId);
    const { error: deleteError } = await supabase.from("menu_items").delete().eq("id", itemId);
    if (deleteError) {
      setError(`Error eliminando producto: ${deleteError.message}`);
      setSavingItemId(null);
      return;
    }

    setMenuItems((prev) => prev.filter((item) => item.id !== itemId));
    setSavingItemId(null);
  }

  return (
    <div className="dark min-h-screen bg-slate-950 text-slate-100">
      <div className="mx-auto max-w-7xl p-6">
        <header className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">RestoBot Dashboard</h1>
            <p className="text-sm text-slate-400">Gestion de pedidos y menu en tiempo real</p>
            {restaurantName ? (
              <p className="mt-1 text-xs text-slate-500">Restaurante activo: {restaurantName}</p>
            ) : null}
          </div>
          <div className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-xs text-emerald-300">
            Realtime activo
          </div>
        </header>

        <div className="mb-5 flex gap-3">
          <button
            type="button"
            onClick={() => setActiveTab("orders")}
            className={`rounded-lg px-4 py-2 text-sm font-medium transition ${
              activeTab === "orders"
                ? "bg-emerald-500 text-slate-950"
                : "border border-slate-700 bg-slate-900 text-slate-300 hover:bg-slate-800"
            }`}
          >
            Pedidos
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("menu")}
            className={`rounded-lg px-4 py-2 text-sm font-medium transition ${
              activeTab === "menu"
                ? "bg-emerald-500 text-slate-950"
                : "border border-slate-700 bg-slate-900 text-slate-300 hover:bg-slate-800"
            }`}
          >
            Gestor de Menu
          </button>
        </div>

        {error ? (
          <div className="mb-5 rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-300">
            {error}
          </div>
        ) : null}

        {activeTab === "orders" ? (
          <section className="space-y-4">
            {loadingOrders ? (
              <div className="rounded-xl border border-slate-700 bg-slate-900 p-5 text-slate-400">
                Cargando pedidos...
              </div>
            ) : sortedOrders.length === 0 ? (
              <div className="rounded-xl border border-slate-700 bg-slate-900 p-5 text-slate-400">
                Aun no hay pedidos.
              </div>
            ) : (
              sortedOrders.map((order) => (
                <article key={order.id} className="rounded-xl border border-slate-700 bg-slate-900 p-5">
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                    <h2 className="text-sm font-semibold text-slate-200">Pedido #{order.id.slice(0, 8)}</h2>
                    <span
                      className={`rounded-full px-3 py-1 text-xs font-medium ${
                        ORDER_STATUS_COLORS[normalizeOrderStatus(order) || "pending"] ||
                        "bg-slate-700 text-slate-200"
                      }`}
                    >
                      {normalizeOrderStatus(order) || "pending"}
                    </span>
                  </div>
                  <div className="grid gap-2 text-sm text-slate-300 md:grid-cols-2">
                    <p>
                      <span className="text-slate-500">Cliente:</span> {order.customer_number || "-"}
                    </p>
                    <p>
                      <span className="text-slate-500">Metodo pago:</span> {order.payment_method || "-"}
                    </p>
                    <p>
                      <span className="text-slate-500">Modalidad:</span>{" "}
                      {order.fulfillment_type || (order.address ? "delivery" : "-")}
                    </p>
                    <p>
                      <span className="text-slate-500">Estado pago:</span> {order.payment_status || "-"}
                    </p>
                    <p>
                      <span className="text-slate-500">Subtotal productos:</span>{" "}
                      {currency(subtotalForOrder(order))}
                    </p>
                    <p>
                      <span className="text-slate-500">Envío:</span>{" "}
                      {order.delivery_fee != null && order.delivery_fee !== ""
                        ? currency(order.delivery_fee)
                        : "—"}
                    </p>
                    <p>
                      <span className="text-slate-500">Total final:</span>{" "}
                      {order.final_total_amount != null && order.final_total_amount !== ""
                        ? currency(order.final_total_amount)
                        : "—"}
                    </p>
                    <p>
                      <span className="text-slate-500">Total (registro):</span>{" "}
                      {currency(order.total_price ?? order.total_amount)}
                    </p>
                    <p>
                      <span className="text-slate-500">Direccion:</span> {order.address || "-"}
                    </p>
                    {order.payment_link ? (
                      <p className="md:col-span-2 break-all">
                        <span className="text-slate-500">Link MP:</span>{" "}
                        <a
                          href={order.payment_link}
                          target="_blank"
                          rel="noreferrer"
                          className="text-emerald-400 underline"
                        >
                          {order.payment_link}
                        </a>
                      </p>
                    ) : null}
                    {order.customer_notified_at ? (
                      <p className="md:col-span-2 text-xs text-slate-500">
                        Cliente notificado:{" "}
                        {new Date(order.customer_notified_at).toLocaleString("es-AR")}
                      </p>
                    ) : null}
                    <p className="md:col-span-2">
                      <span className="text-slate-500">Fecha:</span>{" "}
                      {order.created_at ? new Date(order.created_at).toLocaleString("es-AR") : "-"}
                    </p>
                    <p className="md:col-span-2">
                      <span className="text-slate-500">Notas:</span> {order.notes || order.raw_request || "-"}
                    </p>
                    {order.delivery_denial_reason ? (
                      <p className="md:col-span-2 text-sm text-amber-100/90">
                        <span className="text-slate-500">Motivo cancelación delivery:</span>{" "}
                        {order.delivery_denial_reason}
                      </p>
                    ) : null}

                    {orderNeedsDeliveryFeeControls(order) ? (
                      <div className="md:col-span-2 space-y-3 rounded-lg border border-orange-500/35 bg-orange-950/20 p-4">
                        <p className="text-sm font-semibold text-orange-200">Esperando costo de envío</p>
                        <p className="text-xs text-slate-400">
                          Ingresá el envío en ARS (debe ser mayor a 0). Se calcula el total final y el bot avisa
                          por WhatsApp. Si no llegamos a esa zona, usá &quot;Negar delivery&quot; y el motivo.
                          {normalizeOrderStatus(order) === "pending" ? (
                            <span className="block pt-1 text-orange-200/90">
                              (Pedido en estado &quot;pending&quot; pero detectado como delivery: confirmá envío o
                              cancelá.)
                            </span>
                          ) : null}
                        </p>
                        <div className="flex flex-wrap items-center gap-2">
                          <input
                            type="text"
                            inputMode="decimal"
                            placeholder="Ej: 2500"
                            className="h-10 w-40 rounded-lg border border-slate-600 bg-slate-950 px-3 text-sm"
                            value={feeDraftByOrder[order.id] ?? ""}
                            onChange={(event) =>
                              setFeeDraftByOrder((prev) => ({
                                ...prev,
                                [order.id]: event.target.value
                              }))
                            }
                          />
                          <button
                            type="button"
                            disabled={savingOrderId === order.id}
                            onClick={() => confirmDeliveryFee(order)}
                            className="rounded-lg bg-orange-500 px-4 py-2 text-sm font-semibold text-slate-950"
                          >
                            {savingOrderId === order.id ? "Guardando…" : "Confirmar costo delivery"}
                          </button>
                          <button
                            type="button"
                            disabled={savingOrderId === order.id}
                            onClick={() =>
                              setDenyExpandedOrderId((prev) =>
                                prev === order.id ? null : order.id
                              )
                            }
                            className="rounded-lg border border-orange-400/50 bg-orange-950/40 px-4 py-2 text-sm font-semibold text-orange-100"
                          >
                            {denyExpandedOrderId === order.id ? "Cerrar" : "Negar delivery"}
                          </button>
                        </div>
                        {denyExpandedOrderId === order.id ? (
                          <div className="space-y-2 border-t border-orange-500/25 pt-3">
                            <label className="block text-xs text-slate-400">
                              Motivo (se envía por WhatsApp al cliente)
                            </label>
                            <textarea
                              rows={3}
                              placeholder="Ej: No llegamos a esa zona / dirección fuera de cobertura"
                              className="w-full max-w-lg rounded-lg border border-slate-600 bg-slate-950 px-3 py-2 text-sm text-slate-100"
                              value={denyReasonByOrder[order.id] ?? ""}
                              onChange={(event) =>
                                setDenyReasonByOrder((prev) => ({
                                  ...prev,
                                  [order.id]: event.target.value
                                }))
                              }
                            />
                            <button
                              type="button"
                              disabled={savingOrderId === order.id}
                              onClick={() => denyDelivery(order)}
                              className="rounded-lg bg-rose-600 px-4 py-2 text-sm font-semibold text-white"
                            >
                              {savingOrderId === order.id ? "Enviando…" : "Enviar cancelación al cliente"}
                            </button>
                          </div>
                        ) : null}
                      </div>
                    ) : null}

                    {order.status === "delivery_denied" && !order.customer_notified_at ? (
                      <div className="md:col-span-2 rounded-lg border border-amber-500/35 bg-amber-950/20 p-3 text-xs text-amber-100">
                        Cancelación por delivery en curso: el bot debe avisar al cliente por WhatsApp en segundos.
                      </div>
                    ) : null}

                    {order.status === "delivery_denial_notify_failed" ? (
                      <div className="md:col-span-2 flex flex-wrap items-center gap-2 rounded-lg border border-rose-500/40 bg-rose-950/25 p-3">
                        <p className="text-xs text-rose-100">
                          No se pudo enviar el aviso de cancelación por WhatsApp. Revisá el bot y reintentá.
                        </p>
                        <button
                          type="button"
                          disabled={savingOrderId === order.id}
                          onClick={() => retryDeliveryDenialNotify(order.id)}
                          className="rounded-lg bg-rose-500 px-3 py-1.5 text-xs font-semibold text-slate-950"
                        >
                          Reintentar aviso cancelación
                        </button>
                      </div>
                    ) : null}

                    {order.status === "delivery_fee_set" && !order.customer_notified_at ? (
                      <div className="md:col-span-2 rounded-lg border border-cyan-500/30 bg-cyan-950/20 p-3 text-xs text-cyan-100">
                        Costo confirmado. El bot debe enviar el total por WhatsApp en segundos. Si el contenedor
                        estaba apagado, reiniciá el bot y usá &quot;Reintentar WhatsApp&quot; si falló.
                      </div>
                    ) : null}

                    {order.status === "notify_failed" ? (
                      <div className="md:col-span-2 flex flex-wrap items-center gap-2 rounded-lg border border-rose-500/40 bg-rose-950/25 p-3">
                        <p className="text-xs text-rose-100">
                          No se pudo enviar WhatsApp al cliente. Revisá el bot y reintentá.
                        </p>
                        <button
                          type="button"
                          disabled={savingOrderId === order.id}
                          onClick={() => retryNotifyCustomer(order.id)}
                          className="rounded-lg bg-rose-500 px-3 py-1.5 text-xs font-semibold text-slate-950"
                        >
                          Reintentar WhatsApp
                        </button>
                      </div>
                    ) : null}

                    {(() => {
                      const method = paymentMethodKey(order);
                      const approved = paymentIsApproved(order);
                      const paidAtLabel = formatPaidAt(order.payment_paid_at);
                      const status = normalizeOrderStatus(order);
                      const isClosed = status === "delivered" || status === "cancelled";
                      const deliveredAtLabel = formatPaidAt(order.delivered_at);
                      const cancelledAtLabel = formatPaidAt(order.cancelled_at);

                      return (
                        <div className="md:col-span-2 mt-2 space-y-2">
                          {method === "mp" ? (
                            approved ? (
                              <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-200">
                                <span className="font-semibold">Pago realizado por Mercado Pago</span>
                                {paidAtLabel ? (
                                  <span className="block text-emerald-100/80">
                                    {paidAtLabel}
                                    {order.mp_payment_id ? ` · Ref: ${order.mp_payment_id}` : ""}
                                  </span>
                                ) : null}
                              </div>
                            ) : !isClosed ? (
                              <div className="rounded-lg border border-fuchsia-500/30 bg-fuchsia-500/10 px-3 py-2 text-xs text-fuchsia-200">
                                Esperando pago por Mercado Pago. La confirmación es automática cuando el cliente abone el link.
                              </div>
                            ) : null
                          ) : null}

                          {method === "cash" && approved ? (
                            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-200">
                              <span>
                                Pago en efectivo confirmado
                                {paidAtLabel ? ` · ${paidAtLabel}` : ""}
                              </span>
                              {!isClosed ? (
                                <button
                                  type="button"
                                  disabled={savingOrderId === order.id}
                                  onClick={() => revertCashPayment(order)}
                                  className="rounded-md border border-amber-400/50 bg-amber-500/15 px-2 py-0.5 text-[11px] font-medium text-amber-200 hover:bg-amber-500/25 disabled:opacity-50"
                                  title="Marcar el pago como no recibido y volver el pedido a pendiente"
                                >
                                  Revertir pago
                                </button>
                              ) : null}
                            </div>
                          ) : null}

                          {status === "delivered" ? (
                            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-200">
                              <span>
                                <span className="font-semibold">Pedido entregado</span>
                                {deliveredAtLabel ? ` · ${deliveredAtLabel}` : ""}
                              </span>
                              <button
                                type="button"
                                disabled={savingOrderId === order.id}
                                onClick={() => revertClosedOrder(order, "delivered")}
                                className="rounded-md border border-amber-400/50 bg-amber-500/15 px-2 py-0.5 text-[11px] font-medium text-amber-200 hover:bg-amber-500/25 disabled:opacity-50"
                                title="Volver el pedido al estado activo previo"
                              >
                                Revertir entrega
                              </button>
                            </div>
                          ) : status === "cancelled" ? (
                            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
                              <span>
                                <span className="font-semibold">Pedido cancelado</span>
                                {cancelledAtLabel ? ` · ${cancelledAtLabel}` : ""}
                              </span>
                              <button
                                type="button"
                                disabled={savingOrderId === order.id}
                                onClick={() => revertClosedOrder(order, "cancelled")}
                                className="rounded-md border border-amber-400/50 bg-amber-500/15 px-2 py-0.5 text-[11px] font-medium text-amber-200 hover:bg-amber-500/25 disabled:opacity-50"
                                title="Reabrir el pedido"
                              >
                                Revertir cancelación
                              </button>
                            </div>
                          ) : (
                            <div className="flex flex-wrap gap-2">
                              {method === "cash" && !approved ? (
                                <button
                                  type="button"
                                  disabled={savingOrderId === order.id}
                                  onClick={() => confirmCashPayment(order)}
                                  className="rounded-lg border border-blue-500/40 bg-blue-500/10 px-3 py-1 text-xs text-blue-300"
                                >
                                  Confirmar pago efectivo
                                </button>
                              ) : null}
                              <button
                                type="button"
                                disabled={savingOrderId === order.id}
                                onClick={() => markDelivered(order)}
                                className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-1 text-xs text-emerald-300"
                              >
                                Entregado
                              </button>
                              <button
                                type="button"
                                disabled={savingOrderId === order.id}
                                onClick={() => markCancelled(order)}
                                className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-1 text-xs text-rose-300"
                              >
                                Cancelar
                              </button>
                            </div>
                          )}
                        </div>
                      );
                    })()}
                  </div>
                </article>
              ))
            )}
          </section>
        ) : (
          <section className="space-y-4">
            <div className="flex items-center justify-between rounded-xl border border-slate-700 bg-slate-900 p-4">
              <div>
                <h2 className="text-sm font-semibold text-slate-200">Productos del menu</h2>
                <p className="text-xs text-slate-400">Administra precios, disponibilidad y alta de productos.</p>
              </div>
              <button
                type="button"
                onClick={() => setShowAddForm((prev) => !prev)}
                className="rounded-lg bg-emerald-500 px-3 py-2 text-sm font-semibold text-slate-950"
              >
                Añadir Producto
              </button>
            </div>

            {showAddForm ? (
              <form
                onSubmit={createMenuItem}
                className="grid gap-3 rounded-xl border border-slate-700 bg-slate-900 p-4 md:grid-cols-2"
              >
                <input
                  value={newItem.name}
                  onChange={(event) => setNewItem((prev) => ({ ...prev, name: event.target.value }))}
                  placeholder="Nombre"
                  className="h-10 rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm"
                  required
                />
                <input
                  value={newItem.category}
                  onChange={(event) => setNewItem((prev) => ({ ...prev, category: event.target.value }))}
                  placeholder="Categoria"
                  className="h-10 rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm"
                />
                <input
                  value={newItem.price}
                  onChange={(event) => setNewItem((prev) => ({ ...prev, price: event.target.value }))}
                  placeholder="Precio (ej: 5990.50)"
                  className="h-10 rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm"
                  required
                />
                <input
                  value={newItem.description}
                  onChange={(event) => setNewItem((prev) => ({ ...prev, description: event.target.value }))}
                  placeholder="Descripcion"
                  className="h-10 rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm"
                />
                <div className="md:col-span-2 flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setShowAddForm(false)}
                    className="rounded-lg border border-slate-700 px-3 py-2 text-sm"
                  >
                    Cancelar
                  </button>
                  <button
                    type="submit"
                    disabled={addingItem}
                    className="rounded-lg bg-emerald-500 px-3 py-2 text-sm font-semibold text-slate-950"
                  >
                    {addingItem ? "Guardando..." : "Guardar producto"}
                  </button>
                </div>
              </form>
            ) : null}

            {loadingMenu ? (
              <div className="rounded-xl border border-slate-700 bg-slate-900 p-5 text-slate-400">
                Cargando menu...
              </div>
            ) : menuItems.length === 0 ? (
              <div className="rounded-xl border border-slate-700 bg-slate-900 p-5 text-slate-400">
                Aun no hay items cargados en menu_items.
              </div>
            ) : (
              menuItems.map((item) => (
                <article
                  key={item.id}
                  className="rounded-xl border border-slate-700 bg-slate-900 p-5"
                >
                  <div className="flex flex-col gap-4 md:flex-row md:flex-wrap md:items-start md:justify-between">
                    <div className="min-w-0 flex-1">
                      <h3 className="font-semibold text-slate-100">{item.name}</h3>
                      <p className="text-sm text-slate-400">{item.category || "Sin categoria"}</p>
                      <p className="mt-1 text-xs text-slate-500">{item.description || "Sin descripcion"}</p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        disabled={savingItemId === item.id}
                        onClick={() => openEditMenuItem(item)}
                        className="h-10 rounded-lg border border-sky-500/50 bg-sky-500/15 px-3 text-sm font-semibold text-sky-200 hover:bg-sky-500/25"
                      >
                        Editar producto
                      </button>
                      <input
                        type="number"
                        title="Cambio rapido de precio"
                        className="h-10 w-28 rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm"
                        defaultValue={item.price || 0}
                        onBlur={(event) =>
                          updateMenuItem(item.id, {
                            price: Number(event.target.value || 0)
                          })
                        }
                      />
                      <button
                        type="button"
                        disabled={savingItemId === item.id}
                        onClick={() => updateMenuItem(item.id, { available: !item.available })}
                        className={`h-10 rounded-lg px-3 text-sm font-semibold transition ${
                          item.available
                            ? "bg-emerald-600/20 text-emerald-300 hover:bg-emerald-600/30"
                            : "bg-rose-600/20 text-rose-300 hover:bg-rose-600/30"
                        }`}
                      >
                        {item.available ? "Disponible" : "Agotado"}
                      </button>
                      <button
                        type="button"
                        disabled={savingItemId === item.id}
                        onClick={() => deleteMenuItem(item.id)}
                        className="h-10 rounded-lg bg-rose-600/20 px-3 text-sm font-semibold text-rose-300 hover:bg-rose-600/30"
                      >
                        Eliminar
                      </button>
                    </div>
                  </div>

                  {editingItemId === item.id ? (
                    <form
                      onSubmit={saveEditedMenuItem}
                      className="mt-4 grid gap-3 border-t border-slate-700 pt-4 md:grid-cols-2"
                    >
                      <div className="md:col-span-2 text-xs font-medium text-slate-400">
                        Modificar producto (nombre, categoria, descripcion, precio)
                      </div>
                      <input
                        value={editDraft.name}
                        onChange={(event) => setEditDraft((prev) => ({ ...prev, name: event.target.value }))}
                        placeholder="Nombre"
                        className="h-10 rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm"
                        required
                      />
                      <input
                        value={editDraft.category}
                        onChange={(event) =>
                          setEditDraft((prev) => ({ ...prev, category: event.target.value }))
                        }
                        placeholder="Categoria (ej: combos, pizza)"
                        className="h-10 rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm"
                      />
                      <input
                        value={editDraft.price}
                        onChange={(event) =>
                          setEditDraft((prev) => ({ ...prev, price: event.target.value }))
                        }
                        placeholder="Precio"
                        className="h-10 rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm"
                        required
                      />
                      <input
                        value={editDraft.description}
                        onChange={(event) =>
                          setEditDraft((prev) => ({ ...prev, description: event.target.value }))
                        }
                        placeholder="Descripcion"
                        className="h-10 rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm md:col-span-2"
                      />
                      <div className="flex justify-end gap-2 md:col-span-2">
                        <button
                          type="button"
                          onClick={cancelEditMenuItem}
                          className="rounded-lg border border-slate-700 px-4 py-2 text-sm"
                        >
                          Cancelar
                        </button>
                        <button
                          type="submit"
                          disabled={savingItemId === item.id}
                          className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-slate-950"
                        >
                          {savingItemId === item.id ? "Guardando..." : "Guardar cambios"}
                        </button>
                      </div>
                    </form>
                  ) : null}
                </article>
              ))
            )}
          </section>
        )}
      </div>
      {confirmDialog ? (
        <ConfirmModal dialog={confirmDialog} onResolve={handleConfirmDialog} />
      ) : null}
    </div>
  );
}

const CONFIRM_TONE_PALETTE = {
  danger: {
    accent: "border-rose-500/40",
    iconBg: "bg-rose-500/20 text-rose-300",
    confirmBtn: "bg-rose-500 hover:bg-rose-400 text-slate-950"
  },
  warning: {
    accent: "border-amber-500/40",
    iconBg: "bg-amber-500/20 text-amber-300",
    confirmBtn: "bg-amber-500 hover:bg-amber-400 text-slate-950"
  },
  info: {
    accent: "border-blue-500/40",
    iconBg: "bg-blue-500/20 text-blue-300",
    confirmBtn: "bg-blue-500 hover:bg-blue-400 text-slate-950"
  }
};

function ConfirmModal({ dialog, onResolve }) {
  const palette =
    CONFIRM_TONE_PALETTE[dialog?.tone] || CONFIRM_TONE_PALETTE.danger;

  useEffect(() => {
    function handleKey(event) {
      if (event.key === "Escape") onResolve(false);
      if (event.key === "Enter") onResolve(true);
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onResolve]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-modal-title"
    >
      <div
        className="absolute inset-0 bg-slate-950/70 backdrop-blur-sm"
        onClick={() => onResolve(false)}
      />
      <div
        className={`relative w-full max-w-md rounded-2xl border ${palette.accent} bg-slate-900/95 p-5 shadow-2xl shadow-black/40`}
      >
        <div className="flex items-start gap-3">
          <span
            className={`flex h-9 w-9 flex-none items-center justify-center rounded-full ${palette.iconBg} text-base font-bold`}
            aria-hidden="true"
          >
            !
          </span>
          <div className="flex-1">
            <h3
              id="confirm-modal-title"
              className="text-base font-semibold text-slate-100"
            >
              {dialog.title}
            </h3>
            {dialog.message ? (
              <p className="mt-1 text-sm text-slate-300">{dialog.message}</p>
            ) : null}
          </div>
        </div>
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button
            type="button"
            onClick={() => onResolve(false)}
            className="rounded-lg border border-slate-600 bg-slate-800/60 px-4 py-2 text-sm font-medium text-slate-200 hover:bg-slate-700"
          >
            {dialog.cancelLabel || "Cancelar"}
          </button>
          <button
            type="button"
            autoFocus
            onClick={() => onResolve(true)}
            className={`rounded-lg px-4 py-2 text-sm font-semibold ${palette.confirmBtn}`}
          >
            {dialog.confirmLabel || "Confirmar"}
          </button>
        </div>
      </div>
    </div>
  );
}
