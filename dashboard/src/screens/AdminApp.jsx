import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "../supabaseClient";
import {
  ORDER_STATUS_COLORS,
  callableCustomerPhone,
  currency,
  formatPhoneLabel,
  fulfillmentIsDelivery,
  fulfillmentIsPickup,
  isDeliveryOrder,
  normalizeOrderStatus,
  notesIndicateDelivery,
  orderNeedsDeliveryFeeControls,
  adminShowNotifyDeliveriesReadyButton,
  paymentIsApproved,
  paymentMethodKey,
  playNotification,
  subtotalForOrder,
  formatDateTime as formatPaidAt,
  formatOrderNotesForDisplay
} from "../lib/format";
import AdminStats from "./AdminStats";
import DashboardUsersPanel from "./DashboardUsersPanel";
import OrdersDateRangeCalendar from "../components/OrdersDateRangeCalendar";

/** Fecha local yyyy-mm-dd (zona horaria del navegador). */
function localDateKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function effectiveOrderFilters(filters, todayOnly) {
  if (!todayOnly) return filters;
  const t = localDateKey();
  return { ...filters, dateFrom: t, dateTo: t };
}

/**
 * Límites del día calendario **local del navegador** para filtrar `created_at`
 * (timestamptz en Supabase). Sin esto, `yyyy-mm-ddT00:00:00` sin offset se
 * interpreta mal y aparecen pedidos del día anterior (ej. 30/4 viendo “solo hoy” 1/5).
 */
function localDateKeyBoundsMs(dateKey) {
  const [y, m, d] = String(dateKey || "")
    .split("-")
    .map(Number);
  if (!y || !m || !d) return null;
  return {
    start: new Date(y, m - 1, d, 0, 0, 0, 0).getTime(),
    end: new Date(y, m - 1, d, 23, 59, 59, 999).getTime()
  };
}

function localDateKeyStartIso(dateKey) {
  const b = localDateKeyBoundsMs(dateKey);
  return b ? new Date(b.start).toISOString() : null;
}

function localDateKeyEndIso(dateKey) {
  const b = localDateKeyBoundsMs(dateKey);
  return b ? new Date(b.end).toISOString() : null;
}

export default function AdminApp({ onLogout }) {
  const [activeTab, setActiveTab] = useState("orders");
  const [orders, setOrders] = useState([]);
  const [deliveryUserLabels, setDeliveryUserLabels] = useState({});
  /** Tamano de pagina del listado de pedidos (cargar mas). */
  const ORDERS_PAGE_SIZE = 30;
  const [ordersPage, setOrdersPage] = useState(0);
  const [ordersTotal, setOrdersTotal] = useState(0);
  const [ordersHasMore, setOrdersHasMore] = useState(false);
  const [loadingMoreOrders, setLoadingMoreOrders] = useState(false);
  /**
   * Filtros aplicados al listado y a las suscripciones realtime.
   * `dateFrom`/`dateTo` son strings ISO (yyyy-mm-dd).
   */
  const [orderFilters, setOrderFilters] = useState({
    status: "all",
    paymentMethod: "all",
    fulfillmentType: "all",
    dateFrom: "",
    dateTo: "",
    search: ""
  });

  const [ordersTodayOnly, setOrdersTodayOnly] = useState(true);
  const [hiddenUpdatesCount, setHiddenUpdatesCount] = useState(0);
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
  /** Configuracion editable del restaurante (pestana "Configuración"). */
  const [restaurantConfig, setRestaurantConfig] = useState({
    name: "",
    public_name: "",
    address: "",
    delivery_zones: "",
    opening_hours: "",
    policies: ""
  });
  const [loadingConfig, setLoadingConfig] = useState(false);
  const [savingConfig, setSavingConfig] = useState(false);
  const [configFlash, setConfigFlash] = useState("");
  /**
   * Modal de confirmación in-page (reemplazo estético de window.confirm).
   * `tone` controla colores ("danger" rojo, "warning" ámbar, "info" azul).
   */
  const [confirmDialog, setConfirmDialog] = useState(null);
  const confirmResolverRef = useRef(null);
  /** Para pasar de día sin recargar la pestaña cuando la vista es "solo hoy". */
  const ordersCalendarDayRef = useRef(localDateKey());

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

  const deliveryIssueCount = useMemo(
    () =>
      sortedOrders.filter((o) => Boolean(o.delivery_issue_reason) && !o.delivery_issue_acknowledged_at)
        .length,
    [sortedOrders]
  );

  /**
   * Aplica los filtros activos a una query Supabase de la tabla `orders`.
   * Devuelve la query mutada (la API es chainable).
   */
  function applyOrderFilters(query, filters = orderFilters) {
    let q = query;
    if (filters.status && filters.status !== "all") {
      q = q.eq("status", filters.status);
    }
    if (filters.paymentMethod && filters.paymentMethod !== "all") {
      q = q.eq("payment_method", filters.paymentMethod);
    }
    if (filters.fulfillmentType && filters.fulfillmentType !== "all") {
      q = q.eq("fulfillment_type", filters.fulfillmentType);
    }
    if (filters.dateFrom) {
      const startIso = localDateKeyStartIso(filters.dateFrom);
      if (startIso) q = q.gte("created_at", startIso);
    }
    if (filters.dateTo) {
      const endIso = localDateKeyEndIso(filters.dateTo);
      if (endIso) q = q.lte("created_at", endIso);
    }
    if (filters.search) {
      const term = filters.search.replace(/[%_]/g, "").trim();
      if (term) {
        q = q.or(
          `customer_number.ilike.%${term}%,address.ilike.%${term}%,notes.ilike.%${term}%`
        );
      }
    }
    return q;
  }

  /**
   * Verifica en cliente si una fila cumple los filtros activos. Permite que el
   * realtime decida si una fila entra o sale de la vista paginada.
   */
  function orderMatchesFilters(order, filters = orderFilters) {
    if (!order) return false;
    if (filters.status !== "all" && String(order.status || "") !== filters.status) return false;
    if (
      filters.paymentMethod !== "all" &&
      String(order.payment_method || "") !== filters.paymentMethod
    )
      return false;
    if (
      filters.fulfillmentType !== "all" &&
      String(order.fulfillment_type || "") !== filters.fulfillmentType
    )
      return false;
    if (filters.dateFrom) {
      const bounds = localDateKeyBoundsMs(filters.dateFrom);
      const created = new Date(order.created_at).getTime();
      if (bounds && Number.isFinite(created) && created < bounds.start) return false;
    }
    if (filters.dateTo) {
      const bounds = localDateKeyBoundsMs(filters.dateTo);
      const created = new Date(order.created_at).getTime();
      if (bounds && Number.isFinite(created) && created > bounds.end) return false;
    }
    if (filters.search) {
      const term = filters.search.toLowerCase().trim();
      if (term) {
        const haystack = [
          String(order.customer_number || ""),
          String(order.address || ""),
          String(order.notes || "")
        ]
          .join(" ")
          .toLowerCase();
        if (!haystack.includes(term)) return false;
      }
    }
    return true;
  }

  async function loadOrders(forRestaurantId, { page = 0, append = false, filters, todayOnly } = {}) {
    const rid = forRestaurantId || restaurantId;
    if (!rid) {
      setOrders([]);
      setOrdersTotal(0);
      setOrdersHasMore(false);
      setLoadingOrders(false);
      return;
    }

    if (append) setLoadingMoreOrders(true);
    else setLoadingOrders(true);

    const from = page * ORDERS_PAGE_SIZE;
    const to = from + ORDERS_PAGE_SIZE - 1;
    const baseFilters = filters !== undefined ? filters : orderFilters;
    const useTodayOnly = todayOnly !== undefined ? todayOnly : ordersTodayOnly;
    const filtersForQuery = effectiveOrderFilters(baseFilters, useTodayOnly);
    let query = supabase
      .from("orders")
      .select("*", { count: "exact" })
      .eq("restaurant_id", rid)
      .order("created_at", { ascending: false })
      .range(from, to);
    query = applyOrderFilters(query, filtersForQuery);

    const { data, error: queryError, count } = await query;

    if (queryError) {
      setError(`Error cargando pedidos: ${queryError.message}`);
      setLoadingOrders(false);
      setLoadingMoreOrders(false);
      return;
    }

    const fetched = data || [];
    setOrders((prev) => (append ? [...prev, ...fetched] : fetched));
    setOrdersTotal(typeof count === "number" ? count : 0);
    setOrdersHasMore(fetched.length === ORDERS_PAGE_SIZE);
    if (!append) setHiddenUpdatesCount(0);
    setLoadingOrders(false);
    setLoadingMoreOrders(false);
  }

  function applyFiltersAndReload(nextFilters, nextTodayOnly) {
    const useToday =
      typeof nextTodayOnly === "boolean" ? nextTodayOnly : ordersTodayOnly;
    setOrdersTodayOnly(useToday);
    setOrderFilters(nextFilters);
    setOrdersPage(0);
    loadOrders(restaurantId, { page: 0, filters: nextFilters, todayOnly: useToday });
  }

  function resetOrderFilters() {
    const next = {
      status: "all",
      paymentMethod: "all",
      fulfillmentType: "all",
      dateFrom: "",
      dateTo: "",
      search: ""
    };
    applyFiltersAndReload(next, true);
  }

  function loadMoreOrders() {
    const nextPage = ordersPage + 1;
    setOrdersPage(nextPage);
    loadOrders(restaurantId, { page: nextPage, append: true, todayOnly: ordersTodayOnly });
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

  async function loadRestaurantConfig(forRestaurantId) {
    const rid = forRestaurantId || restaurantId;
    if (!rid) return;
    setLoadingConfig(true);
    const { data, error: queryError } = await supabase
      .from("restaurants")
      .select("name, public_name, address, delivery_zones, opening_hours, policies")
      .eq("id", rid)
      .maybeSingle();

    if (queryError) {
      setError(`Error cargando configuración: ${queryError.message}`);
      setLoadingConfig(false);
      return;
    }
    if (!data) {
      setLoadingConfig(false);
      return;
    }

    const policiesAsText =
      typeof data.policies === "string"
        ? data.policies
        : data.policies
          ? JSON.stringify(data.policies, null, 2)
          : "";

    setRestaurantConfig({
      name: data.name || "",
      public_name: data.public_name || "",
      address: data.address || "",
      delivery_zones: data.delivery_zones || "",
      opening_hours: data.opening_hours || "",
      policies: policiesAsText
    });
    setLoadingConfig(false);
  }

  async function saveRestaurantConfig(event) {
    if (event?.preventDefault) event.preventDefault();
    if (!restaurantId) return;
    setError("");
    setConfigFlash("");
    setSavingConfig(true);

    const patch = {
      name: restaurantConfig.name.trim() || null,
      public_name: restaurantConfig.public_name.trim() || null,
      address: restaurantConfig.address.trim() || null,
      delivery_zones: restaurantConfig.delivery_zones.trim() || null,
      opening_hours: restaurantConfig.opening_hours.trim() || null,
      policies: restaurantConfig.policies.trim() || null
    };

    const { data, error: updateError } = await supabase
      .from("restaurants")
      .update(patch)
      .eq("id", restaurantId)
      .select("name, public_name, address, delivery_zones, opening_hours, policies")
      .maybeSingle();

    if (updateError) {
      setError(`Error guardando configuración: ${updateError.message}`);
      setSavingConfig(false);
      return;
    }
    if (data) {
      const policiesAsText =
        typeof data.policies === "string"
          ? data.policies
          : data.policies
            ? JSON.stringify(data.policies, null, 2)
            : "";
      setRestaurantConfig({
        name: data.name || "",
        public_name: data.public_name || "",
        address: data.address || "",
        delivery_zones: data.delivery_zones || "",
        opening_hours: data.opening_hours || "",
        policies: policiesAsText
      });
      if (data.name) setRestaurantName(data.name);
    }
    setConfigFlash("Configuración guardada. Los cambios aplican al próximo mensaje (cache de IA refresca a los 5 minutos).");
    setSavingConfig(false);
    setTimeout(() => setConfigFlash(""), 6000);
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
   * Retiro en local: el admin solicita avisar al cliente; el bot envía WhatsApp al procesar la cola.
   */
  async function requestPickupReadyNotify(order) {
    const st = normalizeOrderStatus(order);
    if (st !== "confirmed") {
      setError('Solo pedidos confirmados (pagados) pueden avisar “listo para retiro”.');
      return;
    }
    if (!fulfillmentIsPickup(order)) {
      setError("Este aviso solo aplica a pedidos de retiro en el local.");
      return;
    }
    if (order.pickup_ready_customer_notified_at) {
      setError("El cliente ya fue avisado que puede retirar.");
      return;
    }
    setError("");
    setSavingOrderId(order.id);
    const requestedAt = new Date().toISOString();
    const { data: updatedRow, error: updateError } = await supabase
      .from("orders")
      .update({ pickup_ready_notify_requested_at: requestedAt })
      .eq("id", order.id)
      .eq("status", "confirmed")
      .is("pickup_ready_customer_notified_at", null)
      .select("*")
      .maybeSingle();

    if (updateError) {
      setError(`Error solicitando aviso: ${updateError.message}`);
      setSavingOrderId(null);
      return;
    }
    if (!updatedRow) {
      setError("No se pudo actualizar el pedido (¿ya estaba avisado?). Recargá la lista.");
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
    if (order.delivery_issue_reason && !order.delivery_issue_acknowledged_at) {
      patch.delivery_issue_acknowledged_at = patch.cancelled_at;
    }
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
   * Cierra el aviso rojo de incidencia de reparto. Si el pedido sigue activo, lo cancela
   * y deja constancia en `delivery_issue_acknowledged_at` (flujo distinto del «Cancelar» genérico).
   */
  async function resolveDeliveryIssueAsAdmin(order) {
    if (!order.delivery_issue_reason || order.delivery_issue_acknowledged_at) return;

    const st = normalizeOrderStatus(order);
    const closeOnly = st === "cancelled" || st === "delivered";

    const ok = await requestConfirm({
      title: closeOnly ? "Cerrar aviso de incidencia" : "Cancelar por incidencia de reparto",
      message: closeOnly
        ? st === "delivered"
          ? "El pedido ya figura entregado. Solo se oculta el aviso rojo; el texto de la incidencia queda en el pedido."
          : "El pedido ya figura cancelado. Solo se oculta el aviso rojo; la incidencia sigue en el historial."
        : "Se cancela el pedido por la incidencia reportada. Si hubo pago con Mercado Pago, el reembolso se gestiona aparte.",
      confirmLabel: closeOnly ? "Cerrar aviso" : "Sí, cancelar por incidencia",
      cancelLabel: "Volver",
      tone: "danger"
    });
    if (!ok) return;

    setError("");
    setSavingOrderId(order.id);
    const ackAt = new Date().toISOString();

    try {
      if (closeOnly) {
        const { data: updatedRow, error: updateError } = await supabase
          .from("orders")
          .update({ delivery_issue_acknowledged_at: ackAt })
          .eq("id", order.id)
          .is("delivery_issue_acknowledged_at", null)
          .select("*")
          .maybeSingle();

        if (updateError) {
          setError(`Error al cerrar aviso: ${updateError.message}`);
          return;
        }
        if (!updatedRow) {
          setError("No se actualizó el pedido. Refrescá la lista.");
          return;
        }
        setOrders((prev) =>
          prev.map((row) => (row.id === order.id ? { ...row, ...updatedRow } : row))
        );
      } else {
        const patch = {
          status: "cancelled",
          cancelled_at: ackAt,
          delivery_issue_acknowledged_at: ackAt
        };
        const { data: updatedRow, error: updateError } = await supabase
          .from("orders")
          .update(patch)
          .eq("id", order.id)
          .neq("status", "cancelled")
          .neq("status", "delivered")
          .is("delivery_issue_acknowledged_at", null)
          .select("*")
          .maybeSingle();

        if (updateError) {
          setError(`Error: ${updateError.message}`);
          return;
        }
        if (!updatedRow) {
          setError("No se pudo cancelar (el estado cambió). Refrescá la lista.");
          return;
        }
        setOrders((prev) =>
          prev.map((row) => (row.id === order.id ? { ...row, ...updatedRow } : row))
        );
      }
    } finally {
      setSavingOrderId((cur) => (cur === order.id ? null : cur));
    }
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
      patch.delivery_issue_acknowledged_at = null;
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

  /**
   * Envía un pedido cash-on-delivery al repartidor sin marcar el pago.
   * El cobro lo hace el delivery al entregar (botón "Cobrado y entregado").
   * Aplica solo a pedidos de delivery, en efectivo, sin pago aprobado y con el
   * costo de envío ya pactado (estado pending o delivery_fee_set).
   */
  /**
   * Avisa a los repartidores que el pedido está listo para salir (ej. ya cocinado).
   * No cambia el estado del pedido ni el pago: efectivo sigue pendiente hasta que el reparto cobre al entregar.
   */
  async function notifyDeliveriesOrderReady(order) {
    if (!adminShowNotifyDeliveriesReadyButton(order)) {
      setError(
        "Solo se puede avisar cuando el cliente confirmó el total por WhatsApp (efectivo) o el pago ya está aprobado (Mercado Pago), y el costo de envío está definido."
      );
      return;
    }
    setError("");
    setSavingOrderId(order.id);
    const broadcastAt = new Date().toISOString();
    const { data: updatedRow, error: updateError } = await supabase
      .from("orders")
      .update({ delivery_ready_broadcast_at: broadcastAt })
      .eq("id", order.id)
      .is("delivery_ready_broadcast_at", null)
      .is("delivery_claimed_by_user_id", null)
      .select("*")
      .maybeSingle();
    if (updateError) {
      setError(`Error avisando a repartidores: ${updateError.message}`);
      setSavingOrderId(null);
      return;
    }
    if (!updatedRow) {
      setError("No se pudo avisar (el pedido ya fue avisado o tomado). Refrescá la lista.");
      setSavingOrderId(null);
      return;
    }
    setOrders((prev) => prev.map((row) => (row.id === order.id ? { ...row, ...updatedRow } : row)));
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
    const ids = new Set();
    for (const o of orders) {
      if (o?.delivery_claimed_by_user_id) ids.add(o.delivery_claimed_by_user_id);
      if (o?.delivery_issue_reported_by_user_id) ids.add(o.delivery_issue_reported_by_user_id);
    }
    if (ids.size === 0) return undefined;
    const idList = [...ids];
    let cancelled = false;
    (async () => {
      const { data } = await supabase.from("dashboard_users").select("id,username").in("id", idList);
      if (cancelled) return;
      setDeliveryUserLabels((prev) => {
        const next = { ...prev };
        let changed = false;
        for (const row of data || []) {
          const label = row.username || row.id;
          if (next[row.id] !== label) {
            next[row.id] = label;
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [orders]);

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
        setError("No se encontró el restaurante para este panel.");
        return;
      }

      setRestaurantId(data.id);
      setRestaurantName(data.name || "");
    }

    loadRestaurant();
  }, []);

  useEffect(() => {
    if (!restaurantId) return;
    loadOrders(restaurantId, { page: 0, filters: orderFilters });
    loadMenu();
    loadRestaurantConfig(restaurantId);
    // Cargas iniciales: solo cuando cambia el restaurante.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restaurantId]);

  useEffect(() => {
    if (!restaurantId) return undefined;

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
          const liveFilters = effectiveOrderFilters(orderFilters, ordersTodayOnly);
          if (!orderMatchesFilters(payload.new, liveFilters)) {
            setHiddenUpdatesCount((c) => c + 1);
            return;
          }
          setOrders((prev) => {
            if (prev.some((row) => row.id === payload.new.id)) return prev;
            return [payload.new, ...prev];
          });
          setOrdersTotal((c) => c + 1);
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
          const liveFilters = effectiveOrderFilters(orderFilters, ordersTodayOnly);
          const matches = orderMatchesFilters(payload.new, liveFilters);
          setOrders((prev) => {
            const exists = prev.some((row) => row.id === payload.new.id);
            if (exists) {
              if (!matches) {
                // Cambió de estado y ya no entra en la vista actual: lo retiramos.
                setHiddenUpdatesCount((c) => c + 1);
                return prev.filter((row) => row.id !== payload.new.id);
              }
              return prev.map((row) => (row.id === payload.new.id ? payload.new : row));
            }
            // No estaba en el array: si ahora matchea Y es mas reciente, prependeamos.
            if (matches && prev.length) {
              const newCreated = new Date(payload.new.created_at).getTime();
              const topCreated = new Date(prev[0].created_at).getTime();
              if (newCreated >= topCreated) {
                return [payload.new, ...prev];
              }
            }
            if (matches) setHiddenUpdatesCount((c) => c + 1);
            return prev;
          });
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
    // Re-suscribirse cuando cambian filtros para que las closures usen los
    // filtros vigentes (incluye "solo hoy").
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restaurantId, orderFilters, ordersTodayOnly]);

  useEffect(() => {
    if (ordersTodayOnly) {
      ordersCalendarDayRef.current = localDateKey();
    }
  }, [ordersTodayOnly]);

  /** Si la vista es "solo hoy", al cambiar la fecha local vaciamos la lista al nuevo día. */
  useEffect(() => {
    if (!restaurantId || !ordersTodayOnly) return undefined;

    function maybeRollNewDay() {
      const today = localDateKey();
      if (today !== ordersCalendarDayRef.current) {
        ordersCalendarDayRef.current = today;
        setOrdersPage(0);
        loadOrders(restaurantId, { page: 0, filters: orderFilters, todayOnly: true });
      }
    }

    const id = setInterval(maybeRollNewDay, 60_000);
    function onVisibility() {
      if (document.visibilityState === "visible") maybeRollNewDay();
    }
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisibility);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restaurantId, ordersTodayOnly, orderFilters]);

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
          <div className="flex items-center gap-2">
            <div className="hidden rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-xs text-emerald-300 sm:block">
              Realtime activo
            </div>
            {onLogout ? (
              <button
                type="button"
                onClick={onLogout}
                className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-800"
              >
                Salir
              </button>
            ) : null}
          </div>
        </header>

        <div className="mb-5 flex flex-wrap gap-3">
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
          <button
            type="button"
            onClick={() => setActiveTab("stats")}
            className={`rounded-lg px-4 py-2 text-sm font-medium transition ${
              activeTab === "stats"
                ? "bg-emerald-500 text-slate-950"
                : "border border-slate-700 bg-slate-900 text-slate-300 hover:bg-slate-800"
            }`}
          >
            Estadísticas
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("users")}
            className={`rounded-lg px-4 py-2 text-sm font-medium transition ${
              activeTab === "users"
                ? "bg-emerald-500 text-slate-950"
                : "border border-slate-700 bg-slate-900 text-slate-300 hover:bg-slate-800"
            }`}
          >
            Usuarios
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("settings")}
            className={`rounded-lg px-4 py-2 text-sm font-medium transition ${
              activeTab === "settings"
                ? "bg-emerald-500 text-slate-950"
                : "border border-slate-700 bg-slate-900 text-slate-300 hover:bg-slate-800"
            }`}
          >
            Configuración
          </button>
        </div>

        {error ? (
          <div className="mb-5 rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-300">
            {error}
          </div>
        ) : null}

        {activeTab === "orders" ? (
          <section className="space-y-4">
            <OrdersFilterBar
              filters={orderFilters}
              todayOnly={ordersTodayOnly}
              onApply={applyFiltersAndReload}
              onReset={resetOrderFilters}
              total={ordersTotal}
              shown={orders.length}
            />

            {hiddenUpdatesCount > 0 ? (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-cyan-500/30 bg-cyan-500/10 px-3 py-2 text-xs text-cyan-200">
                <span>
                  {hiddenUpdatesCount} actualización(es) no visible(s) con los filtros actuales.
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setHiddenUpdatesCount(0);
                    setOrdersPage(0);
                    loadOrders(restaurantId, {
                      page: 0,
                      filters: orderFilters,
                      todayOnly: ordersTodayOnly
                    });
                  }}
                  className="rounded-md border border-cyan-400/40 bg-cyan-500/10 px-3 py-1 text-xs font-medium text-cyan-100 hover:bg-cyan-500/20"
                >
                  Recargar lista
                </button>
              </div>
            ) : null}

            {deliveryIssueCount > 0 ? (
              <div
                className="flex flex-wrap items-start gap-3 rounded-xl border-2 border-rose-500 bg-gradient-to-r from-rose-950 via-rose-900/95 to-rose-950 px-4 py-4 shadow-lg shadow-rose-950/50 ring-2 ring-rose-500/40"
                role="alert"
              >
                <span className="text-2xl leading-none" aria-hidden="true">
                  ⚠️
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-bold uppercase tracking-wide text-rose-100">
                    Alerta de reparto · {deliveryIssueCount}{" "}
                    {deliveryIssueCount === 1 ? "pedido" : "pedidos"}
                  </p>
                  <p className="mt-1 text-xs leading-relaxed text-rose-200/95">
                    Hay incidencias de reparto pendientes de gestión. En cada pedido en rojo usá{" "}
                    <span className="font-semibold text-rose-50">
                      «Cancelar por incidencia de reparto» o «Cerrar aviso de incidencia»
                    </span>{" "}
                    para ocultar la alerta.
                  </p>
                </div>
              </div>
            ) : null}

            {loadingOrders ? (
              <div className="rounded-xl border border-slate-700 bg-slate-900 p-5 text-slate-400">
                Cargando pedidos...
              </div>
            ) : sortedOrders.length === 0 ? (
              <div className="rounded-xl border border-slate-700 bg-slate-900 p-5 text-slate-400">
                No hay pedidos para los filtros aplicados.
              </div>
            ) : (
              sortedOrders.map((order) => {
                const deliveryIssueAlertOpen =
                  Boolean(order.delivery_issue_reason) && !order.delivery_issue_acknowledged_at;
                const stForIssue = normalizeOrderStatus(order);
                const deliveryIssueCloseOnly =
                  deliveryIssueAlertOpen &&
                  (stForIssue === "cancelled" || stForIssue === "delivered");

                return (
                <article
                  key={order.id}
                  className={`rounded-xl bg-slate-900 p-5 ${
                    deliveryIssueAlertOpen
                      ? "border-2 border-rose-500 shadow-xl shadow-rose-950/40 ring-2 ring-rose-500/35"
                      : "border border-slate-700"
                  }`}
                >
                  {deliveryIssueAlertOpen ? (
                    <div
                      className="mb-4 flex flex-col gap-3 rounded-lg border-2 border-rose-400/70 bg-rose-600/20 p-4 sm:flex-row sm:items-start sm:justify-between sm:gap-4"
                      role="alert"
                    >
                      <div className="flex min-w-0 gap-3">
                        <span className="shrink-0 text-2xl leading-none" aria-hidden="true">
                          🛑
                        </span>
                        <div className="min-w-0">
                          <p className="text-xs font-bold uppercase tracking-wider text-rose-200">
                            Problema reportado por reparto — revisar
                          </p>
                          <p className="mt-2 text-base font-semibold leading-snug text-rose-50">
                            {order.delivery_issue_reason}
                          </p>
                          <p className="mt-2 text-[11px] text-rose-200/85">
                            {order.delivery_issue_reported_at && formatPaidAt(order.delivery_issue_reported_at)
                              ? formatPaidAt(order.delivery_issue_reported_at)
                              : "—"}
                            {order.delivery_issue_reported_by_user_id ? (
                              <>
                                {" "}
                                · Repartidor:{" "}
                                <span className="font-medium text-rose-100">
                                  {deliveryUserLabels[order.delivery_issue_reported_by_user_id] ||
                                    order.delivery_issue_reported_by_user_id}
                                </span>
                              </>
                            ) : null}
                          </p>
                        </div>
                      </div>
                      <button
                        type="button"
                        disabled={savingOrderId === order.id}
                        onClick={() => resolveDeliveryIssueAsAdmin(order)}
                        className="shrink-0 rounded-lg border-2 border-rose-200/80 bg-rose-600/35 px-4 py-2.5 text-center text-sm font-bold text-white shadow-md hover:bg-rose-600/50 disabled:opacity-50 sm:self-center"
                      >
                        {deliveryIssueCloseOnly
                          ? "Cerrar aviso de incidencia"
                          : "Cancelar por incidencia de reparto"}
                      </button>
                    </div>
                  ) : null}
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
                    <div>
                      <p>
                        <span className="text-slate-500">Cliente:</span>{" "}
                        <span className="break-all text-slate-200">{order.customer_number || "—"}</span>
                      </p>
                      <p className="mt-1">
                        <span className="text-slate-500">Cliente nro:</span>{" "}
                        <span className="tabular-nums text-slate-200">
                          {(() => {
                            const digits = callableCustomerPhone(order);
                            if (digits) return formatPhoneLabel(digits);
                            return "—";
                          })()}
                        </span>
                      </p>
                    </div>
                    <p>
                      <span className="text-slate-500">Metodo pago:</span> {order.payment_method || "-"}
                    </p>
                    <p>
                      <span className="text-slate-500">Modalidad:</span>{" "}
                      {order.fulfillment_type === "local"
                        ? "Retiro local"
                        : order.fulfillment_type || (order.address ? "delivery" : "-")}
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
                      <span className="text-slate-500">Notas:</span>{" "}
                      {formatOrderNotesForDisplay(order.notes) || order.raw_request || "-"}
                    </p>
                    {isDeliveryOrder(order) ? (
                      <div
                        className={`md:col-span-2 rounded-lg border px-3 py-2.5 text-sm ${
                          order.delivery_claimed_by_user_id
                            ? "border-emerald-500/40 bg-emerald-950/25 text-emerald-100"
                            : "border-slate-600/50 bg-slate-800/35 text-slate-400"
                        }`}
                      >
                        <p className="font-medium text-slate-200">
                          Reparto{" "}
                          <span className="text-slate-500 font-normal">(quién tomó el pedido)</span>
                        </p>
                        {order.delivery_claimed_by_user_id ? (
                          <p className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-1">
                            <span>
                              <span className="text-slate-500">Repartidor:</span>{" "}
                              <span className="font-semibold text-emerald-100">
                                {deliveryUserLabels[order.delivery_claimed_by_user_id] ||
                                  order.delivery_claimed_by_user_id}
                              </span>
                            </span>
                            {order.delivery_claimed_at && formatPaidAt(order.delivery_claimed_at) ? (
                              <span className="text-xs text-emerald-200/85">
                                Tomó el pedido · {formatPaidAt(order.delivery_claimed_at)}
                              </span>
                            ) : null}
                            <button
                              type="button"
                              className="rounded border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-200 hover:bg-emerald-500/20"
                              onClick={() => {
                                const label =
                                  deliveryUserLabels[order.delivery_claimed_by_user_id] ||
                                  order.delivery_claimed_by_user_id;
                                navigator.clipboard?.writeText(String(label)).catch(() => {});
                              }}
                            >
                              Copiar nombre
                            </button>
                          </p>
                        ) : (
                          <p className="mt-1 text-xs leading-relaxed text-slate-400">
                            Sin repartidor asignado.
                          </p>
                        )}
                        {order.delivery_en_route_customer_notified_at &&
                        formatPaidAt(order.delivery_en_route_customer_notified_at) ? (
                          <p className="mt-2 border-t border-emerald-500/20 pt-2 text-xs text-sky-200/90">
                            Cliente avisado por WhatsApp (en camino) ·{" "}
                            {formatPaidAt(order.delivery_en_route_customer_notified_at)}
                          </p>
                        ) : null}
                      </div>
                    ) : null}
                    {order.delivery_denial_reason ? (
                      <p className="md:col-span-2 text-sm text-amber-100/90">
                        <span className="text-slate-500">Motivo cancelación delivery:</span>{" "}
                        {order.delivery_denial_reason}
                      </p>
                    ) : null}
                    {order.delivery_issue_reason && order.delivery_issue_acknowledged_at ? (
                      <p className="md:col-span-2 rounded-lg border border-slate-700/80 bg-slate-800/40 px-3 py-2 text-xs text-slate-400">
                        <span className="text-slate-500">Incidencia de reparto (historial):</span>{" "}
                        <span className="text-slate-300">{order.delivery_issue_reason}</span>
                        <span className="mt-1 block text-slate-500">
                          Aviso cerrado en panel
                          {formatPaidAt(order.delivery_issue_acknowledged_at)
                            ? ` · ${formatPaidAt(order.delivery_issue_acknowledged_at)}`
                            : ""}
                        </span>
                        {order.delivery_issue_reported_by_user_id ? (
                          <span className="mt-1 block text-slate-500">
                            Reportado por:{" "}
                            <span className="text-slate-400">
                              {deliveryUserLabels[order.delivery_issue_reported_by_user_id] ||
                                order.delivery_issue_reported_by_user_id}
                            </span>
                          </span>
                        ) : null}
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

                    {order.status === "awaiting_delivery_total_confirm" ? (
                      <div className="md:col-span-2 rounded-lg border border-indigo-500/35 bg-indigo-950/25 p-3 text-xs text-indigo-100">
                        <span className="font-semibold text-indigo-50">Efectivo + delivery:</span> el cliente ya
                        recibió el ticket con el total. Estado interno: esperando que responda{" "}
                        <span className="font-medium">SÍ</span> o <span className="font-medium">NO</span> por
                        WhatsApp. Si acepta, el pedido pasa a pendiente y verás en notas:{" "}
                        <span className="italic">&quot;Cliente confirmó el total con envío&quot;</span>. Si rechaza,
                        el pedido se cancela solo.
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
                                {isDeliveryOrder(order) && order.delivery_claimed_by_user_id ? (
                                  <span className="mt-0.5 block text-[11px] text-emerald-100/85">
                                    Repartidor:{" "}
                                    <span className="font-medium text-emerald-50">
                                      {deliveryUserLabels[order.delivery_claimed_by_user_id] ||
                                        order.delivery_claimed_by_user_id}
                                    </span>
                                  </span>
                                ) : null}
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
                                {isDeliveryOrder(order) && order.delivery_claimed_by_user_id ? (
                                  <span className="mt-0.5 block text-[11px] text-rose-100/85">
                                    Había tomado el pedido:{" "}
                                    <span className="font-medium text-rose-50">
                                      {deliveryUserLabels[order.delivery_claimed_by_user_id] ||
                                        order.delivery_claimed_by_user_id}
                                    </span>
                                  </span>
                                ) : null}
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
                              {method === "cash" && !approved && !isDeliveryOrder(order) ? (
                                <button
                                  type="button"
                                  disabled={savingOrderId === order.id}
                                  onClick={() => confirmCashPayment(order)}
                                  className="rounded-lg border border-blue-500/40 bg-blue-500/10 px-3 py-1 text-xs text-blue-300"
                                >
                                  Confirmar pago efectivo
                                </button>
                              ) : null}
                              {adminShowNotifyDeliveriesReadyButton(order) ? (
                                <button
                                  type="button"
                                  disabled={savingOrderId === order.id}
                                  onClick={() => notifyDeliveriesOrderReady(order)}
                                  className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-1 text-xs text-amber-300"
                                  title="Pedido listo para reparto"
                                >
                                  Avisar repartidores: pedido listo
                                </button>
                              ) : null}
                              {isDeliveryOrder(order) && order.delivery_ready_broadcast_at ? (
                                <span className="text-[11px] text-amber-200/90">
                                  Repartidores avisados
                                  {formatPaidAt(order.delivery_ready_broadcast_at)
                                    ? ` · ${formatPaidAt(order.delivery_ready_broadcast_at)}`
                                    : ""}
                                </span>
                              ) : null}
                              {isDeliveryOrder(order) && order.delivery_claimed_by_user_id ? (
                                <span className="text-[11px] text-emerald-200/90">
                                  Toma el pedido:{" "}
                                  <span className="font-medium text-emerald-100">
                                    {deliveryUserLabels[order.delivery_claimed_by_user_id] ||
                                      order.delivery_claimed_by_user_id}
                                  </span>
                                  {order.delivery_claimed_at && formatPaidAt(order.delivery_claimed_at)
                                    ? ` · ${formatPaidAt(order.delivery_claimed_at)}`
                                    : ""}
                                </span>
                              ) : null}
                              {isDeliveryOrder(order) && order.delivery_en_route_customer_notified_at ? (
                                <span className="text-[11px] font-medium text-sky-200/95">
                                  Cliente avisado por WhatsApp (repartidor en camino)
                                  {formatPaidAt(order.delivery_en_route_customer_notified_at)
                                    ? ` · ${formatPaidAt(order.delivery_en_route_customer_notified_at)}`
                                    : ""}
                                </span>
                              ) : null}
                              {fulfillmentIsPickup(order) &&
                              status === "confirmed" &&
                              approved &&
                              !order.pickup_ready_customer_notified_at ? (
                                <button
                                  type="button"
                                  disabled={savingOrderId === order.id}
                                  onClick={() => requestPickupReadyNotify(order)}
                                  className="rounded-lg border border-violet-500/40 bg-violet-500/10 px-3 py-1 text-xs text-violet-200"
                                  title="Avisar retiro listo al cliente"
                                >
                                  Avisar: listo para retiro
                                </button>
                              ) : null}
                              {fulfillmentIsPickup(order) &&
                              order.pickup_ready_notify_requested_at &&
                              !order.pickup_ready_customer_notified_at ? (
                                <span className="text-[11px] text-slate-400">
                                  Enviando aviso al cliente por WhatsApp…
                                </span>
                              ) : null}
                              {fulfillmentIsPickup(order) && order.pickup_ready_customer_notified_at ? (
                                <span className="text-[11px] text-emerald-200/80">
                                  Cliente avisado (retiro)
                                  {formatPaidAt(order.pickup_ready_customer_notified_at)
                                    ? ` · ${formatPaidAt(order.pickup_ready_customer_notified_at)}`
                                    : ""}
                                </span>
                              ) : null}
                              {isDeliveryOrder(order) ? null : (
                                <button
                                  type="button"
                                  disabled={savingOrderId === order.id}
                                  onClick={() => markDelivered(order)}
                                  className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-1 text-xs text-emerald-300"
                                >
                                  Entregado
                                </button>
                              )}
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
                );
              })
            )}

            {!loadingOrders && sortedOrders.length > 0 ? (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-700 bg-slate-900 p-3 text-xs text-slate-400">
                <span>
                  Mostrando {orders.length} de {ordersTotal} pedidos
                  {ordersHasMore ? "" : " (todos los que matchean filtros)"}
                </span>
                {ordersHasMore ? (
                  <button
                    type="button"
                    onClick={loadMoreOrders}
                    disabled={loadingMoreOrders}
                    className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-1 font-medium text-emerald-200 hover:bg-emerald-500/20 disabled:opacity-50"
                  >
                    {loadingMoreOrders ? "Cargando..." : "Cargar más pedidos"}
                  </button>
                ) : null}
              </div>
            ) : null}
          </section>
        ) : activeTab === "menu" ? (
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
        ) : activeTab === "stats" ? (
          <AdminStats restaurantId={restaurantId} />
        ) : activeTab === "users" ? (
          <DashboardUsersPanel />
        ) : (
          <section className="space-y-4">
            <div className="rounded-xl border border-slate-700 bg-slate-900 p-5">
              <h2 className="text-sm font-semibold text-slate-200">
                Configuración del restaurante
              </h2>
              <p className="text-xs text-slate-400">
                Horario, ubicación, zonas de delivery y políticas que usa el canal de WhatsApp del negocio.
              </p>
            </div>

            {loadingConfig ? (
              <div className="rounded-xl border border-slate-700 bg-slate-900 p-5 text-slate-400">
                Cargando configuración...
              </div>
            ) : (
              <form
                onSubmit={saveRestaurantConfig}
                className="space-y-4 rounded-xl border border-slate-700 bg-slate-900 p-5"
              >
                <div className="grid gap-4 md:grid-cols-2">
                  <label className="space-y-1 text-sm">
                    <span className="text-slate-300">Nombre interno</span>
                    <input
                      value={restaurantConfig.name}
                      onChange={(event) =>
                        setRestaurantConfig((prev) => ({ ...prev, name: event.target.value }))
                      }
                      placeholder="Ej: Bar del Sur"
                      className="h-10 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm"
                    />
                    <span className="block text-xs text-slate-500">Uso interno; si no hay marca pública, se muestra este.</span>
                  </label>
                  <label className="space-y-1 text-sm">
                    <span className="text-slate-300">Marca pública (lo que ve el cliente)</span>
                    <input
                      value={restaurantConfig.public_name}
                      onChange={(event) =>
                        setRestaurantConfig((prev) => ({
                          ...prev,
                          public_name: event.target.value
                        }))
                      }
                      placeholder="Ej: Don Mario · Pizzería"
                      className="h-10 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm"
                    />
                    <span className="block text-xs text-slate-500">
                      Aparece en el encabezado de los mensajes y en el ticket. Si está vacío,
                      se usa el nombre interno.
                    </span>
                  </label>
                </div>

                <label className="block space-y-1 text-sm">
                  <span className="text-slate-300">Dirección / ubicación del local</span>
                  <input
                    value={restaurantConfig.address}
                    onChange={(event) =>
                      setRestaurantConfig((prev) => ({ ...prev, address: event.target.value }))
                    }
                    placeholder="Ej: Av. Siempre Viva 742, Mendoza"
                    className="h-10 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm"
                  />
                  <span className="block text-xs text-slate-500">
                    Si está vacío, el bot le dirá al cliente que la dirección no está cargada
                    en lugar de inventar una.
                  </span>
                </label>

                <label className="block space-y-1 text-sm">
                  <span className="text-slate-300">Horario de atención</span>
                  <input
                    value={restaurantConfig.opening_hours}
                    onChange={(event) =>
                      setRestaurantConfig((prev) => ({
                        ...prev,
                        opening_hours: event.target.value
                      }))
                    }
                    placeholder="Ej: Lunes a Sábado de 12:00 a 23:30. Domingos cerrado."
                    className="h-10 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm"
                  />
                  <span className="block text-xs text-slate-500">
                    Texto libre. El bot lo lee tal cual cuando le preguntan por el horario.
                  </span>
                </label>

                <label className="block space-y-1 text-sm">
                  <span className="text-slate-300">Zonas de delivery</span>
                  <textarea
                    rows={2}
                    value={restaurantConfig.delivery_zones}
                    onChange={(event) =>
                      setRestaurantConfig((prev) => ({
                        ...prev,
                        delivery_zones: event.target.value
                      }))
                    }
                    placeholder="Ej: Centro, Godoy Cruz, Las Heras (hasta calle Paso de los Andes)"
                    className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
                  />
                  <span className="block text-xs text-slate-500">
                    Lista o descripción libre de las zonas que cubrís.
                  </span>
                </label>

                <label className="block space-y-1 text-sm">
                  <span className="text-slate-300">Políticas internas</span>
                  <textarea
                    rows={3}
                    value={restaurantConfig.policies}
                    onChange={(event) =>
                      setRestaurantConfig((prev) => ({ ...prev, policies: event.target.value }))
                    }
                    placeholder="Ej: Tiempo estimado de delivery 30-45 min. No aceptamos cambios una vez confirmado el pedido. Demora extra los viernes a la noche."
                    className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
                  />
                  <span className="block text-xs text-slate-500">
                    Información adicional que querés que el bot tenga en cuenta al responder.
                  </span>
                </label>

                {configFlash ? (
                  <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-200">
                    {configFlash}
                  </div>
                ) : null}

                <div className="flex flex-wrap items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => loadRestaurantConfig(restaurantId)}
                    disabled={savingConfig || loadingConfig}
                    className="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-200 hover:bg-slate-800 disabled:opacity-50"
                  >
                    Recargar
                  </button>
                  <button
                    type="submit"
                    disabled={savingConfig || loadingConfig}
                    className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-slate-950 disabled:opacity-50"
                  >
                    {savingConfig ? "Guardando..." : "Guardar configuración"}
                  </button>
                </div>
              </form>
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

function OrdersFilterBar({ filters, todayOnly, onApply, onReset, total, shown }) {
  const [draft, setDraft] = useState(filters);
  const [draftTodayOnly, setDraftTodayOnly] = useState(todayOnly);

  useEffect(() => {
    setDraft(filters);
  }, [filters]);

  useEffect(() => {
    setDraftTodayOnly(todayOnly);
  }, [todayOnly]);

  function update(key, value) {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }

  function handleSubmit(event) {
    event.preventDefault();
    onApply(draft, draftTodayOnly);
  }

  const STATUS_OPTIONS = [
    { value: "all", label: "Todos" },
    { value: "pending", label: "Pendientes" },
    { value: "awaiting_delivery_fee", label: "Esperando envío" },
    { value: "delivery_fee_set", label: "Envío confirmado" },
    {
      value: "awaiting_delivery_total_confirm",
      label: "Esperando OK cliente (total)"
    },
    { value: "delivery_denied", label: "Delivery negado" },
    { value: "delivery_denial_notify_failed", label: "Falló aviso cancelación" },
    { value: "notify_failed", label: "Falló WhatsApp" },
    { value: "confirmed", label: "Confirmados" },
    { value: "delivered", label: "Entregados" },
    { value: "cancelled", label: "Cancelados" }
  ];

  const PAYMENT_OPTIONS = [
    { value: "all", label: "Todos" },
    { value: "efectivo", label: "Efectivo" },
    { value: "mercadopago", label: "Mercado Pago" }
  ];

  const FULFILLMENT_OPTIONS = [
    { value: "all", label: "Todas" },
    { value: "delivery", label: "Delivery" },
    { value: "local", label: "Retiro en local" }
  ];

  return (
    <form
      onSubmit={handleSubmit}
      className="grid gap-3 rounded-xl border border-slate-700 bg-slate-900 p-4 md:grid-cols-6"
    >
      <div className="md:col-span-6 flex flex-col gap-2 rounded-lg border border-slate-800 bg-slate-950/50 p-3">
        <label className="flex cursor-pointer items-start gap-3 text-sm text-slate-200">
          <input
            type="checkbox"
            checked={draftTodayOnly}
            onChange={(event) => {
              const checked = event.target.checked;
              setDraftTodayOnly(checked);
              if (checked) {
                const t = localDateKey();
                setDraft((prev) => ({ ...prev, dateFrom: t, dateTo: t }));
              }
            }}
            className="mt-1 rounded border-slate-600 bg-slate-950"
          />
          <span>
            <span className="font-medium text-emerald-300">Solo pedidos de hoy</span>
          </span>
        </label>
        {draftTodayOnly ? (
          <p className="text-xs text-slate-400">
            Mostrando{" "}
            <span className="font-medium text-slate-200">
              {new Date(`${localDateKey()}T12:00:00`).toLocaleDateString("es-AR", {
                weekday: "long",
                day: "numeric",
                month: "long",
                year: "numeric"
              })}
            </span>
          </p>
        ) : null}
      </div>
      <label className="space-y-1 text-xs">
        <span className="text-slate-400">Estado</span>
        <select
          value={draft.status}
          onChange={(event) => update("status", event.target.value)}
          className="h-9 w-full rounded-lg border border-slate-700 bg-slate-950 px-2 text-sm text-slate-100"
        >
          {STATUS_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </label>
      <label className="space-y-1 text-xs">
        <span className="text-slate-400">Pago</span>
        <select
          value={draft.paymentMethod}
          onChange={(event) => update("paymentMethod", event.target.value)}
          className="h-9 w-full rounded-lg border border-slate-700 bg-slate-950 px-2 text-sm text-slate-100"
        >
          {PAYMENT_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </label>
      <label className="space-y-1 text-xs">
        <span className="text-slate-400">Modalidad</span>
        <select
          value={draft.fulfillmentType}
          onChange={(event) => update("fulfillmentType", event.target.value)}
          className="h-9 w-full rounded-lg border border-slate-700 bg-slate-950 px-2 text-sm text-slate-100"
        >
          {FULFILLMENT_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </label>
      <label className="space-y-1 text-xs md:col-span-3">
        <span className="text-slate-400">Buscar (cliente / dirección / notas)</span>
        <input
          type="text"
          value={draft.search}
          onChange={(event) => update("search", event.target.value)}
          placeholder="Ej: 5491156... o calle"
          className="h-9 w-full rounded-lg border border-slate-700 bg-slate-950 px-2 text-sm text-slate-100"
        />
      </label>
      {!draftTodayOnly ? (
        <div className="md:col-span-6">
          <OrdersDateRangeCalendar
            dateFrom={draft.dateFrom}
            dateTo={draft.dateTo}
            onRangeChange={(from, to) => {
              setDraftTodayOnly(false);
              setDraft((prev) => ({ ...prev, dateFrom: from, dateTo: to }));
            }}
          />
        </div>
      ) : null}
      <div className="md:col-span-6 flex flex-wrap items-center justify-between gap-2 pt-1">
        <span className="text-xs text-slate-500">
          {shown} de {total} resultados con los filtros actuales
        </span>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onReset}
            className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-800"
          >
            Limpiar
          </button>
          <button
            type="submit"
            className="rounded-lg bg-emerald-500 px-3 py-1.5 text-xs font-semibold text-slate-950"
          >
            Aplicar filtros
          </button>
        </div>
      </div>
    </form>
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
