import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "../supabaseClient";
import { getSession } from "../lib/auth";
import { fetchRestaurantForDashboard } from "../lib/restaurantTenant";
import {
  currency,
  formatDateTime,
  formatOrderStatusLabelEs,
  formatPaymentStatusLabelEs,
  groupOrderItemRows,
  isWaiterDeliveryOrder,
  normalizeOrderStatus,
  paymentIsApproved,
  playNotification,
  subtotalForOrder,
  tableNumberLabel
} from "../lib/format";

const HISTORY_HOURS = 18;
/** El contador del tab "Pedidos realizados" se oculta tras este tiempo (ms). */
const PEDIDOS_REALIZADOS_BADGE_MS = 60_000;

function localDateInputValue(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function scheduledDeliveryIso(dateValue, timeValue) {
  const date = String(dateValue || "").trim();
  const time = String(timeValue || "").trim();
  if (!time) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) return "";
  const [year, month, day] = date.split("-").map(Number);
  const [hours, minutes] = time.split(":").map(Number);
  const scheduled = new Date(year, month - 1, day, hours, minutes, 0, 0);
  if (Number.isNaN(scheduled.getTime())) return "";
  return scheduled.toISOString();
}

function formatScheduledDeliveryTimeInput(rawValue) {
  const digits = String(rawValue || "")
    .replace(/\D/g, "")
    .slice(0, 4);
  if (!digits) return "";
  if (digits.length <= 2) return digits;
  return `${digits.slice(0, 2)}:${digits.slice(2)}`;
}

function normalizeScheduledDeliveryTimeInput(rawValue) {
  const digits = String(rawValue || "")
    .replace(/\D/g, "")
    .slice(0, 4);
  if (!digits) return "";
  if (digits.length === 3) return `0${digits.slice(0, 1)}:${digits.slice(1)}`;
  if (digits.length === 4) return `${digits.slice(0, 2)}:${digits.slice(2)}`;
  return digits;
}

/** Pedido originado en el panel Mozo (notas típicas), sin usar solo payment_method. */
function orderFromWaiterPanel(order) {
  const notes = String(order?.notes || "").trim();
  if (/^Mozo\s*·\s*Mesa:/i.test(notes)) return true;
  if (/^Mozo\s*·\s*Delivery\b/i.test(notes)) return true;
  if (/Origen:\s*mozo\b/i.test(notes)) return true;
  return false;
}

function buildCartLines(cartById, menuById) {
  const lines = [];
  for (const [id, qty] of Object.entries(cartById)) {
    const item = menuById.get(id);
    if (!item || qty < 1) continue;
    const name = String(item.name || "").trim();
    const price = Number(item.price);
    if (!name || !Number.isFinite(price) || price <= 0) continue;
    for (let i = 0; i < qty; i += 1) lines.push({ name, price });
  }
  return lines;
}

function cartTotal(cartById, menuById) {
  let t = 0;
  for (const [id, qty] of Object.entries(cartById)) {
    const item = menuById.get(id);
    if (!item || qty < 1) continue;
    const p = Number(item.price);
    if (!Number.isFinite(p)) continue;
    t += p * qty;
  }
  return Math.round(t * 100) / 100;
}

export default function WaiterApp({ onLogout }) {
  const [restaurantId, setRestaurantId] = useState("");
  const [restaurantName, setRestaurantName] = useState("");
  const [botNumber, setBotNumber] = useState("");
  const [waiterFulfillmentSelectorEnabled, setWaiterFulfillmentSelectorEnabled] = useState(false);
  const [menuItems, setMenuItems] = useState([]);
  const [menuSearchQuery, setMenuSearchQuery] = useState("");
  const [orders, setOrders] = useState([]);
  const [cartById, setCartById] = useState({});
  const [fulfillmentType, setFulfillmentType] = useState("mesa");
  const [tableNumber, setTableNumber] = useState("");
  const [mesaWarning, setMesaWarning] = useState("");
  const [deliveryAddress, setDeliveryAddress] = useState("");
  const [deliveryWarning, setDeliveryWarning] = useState("");
  const [scheduledDeliveryDate, setScheduledDeliveryDate] = useState(() => localDateInputValue());
  const [scheduledDeliveryTime, setScheduledDeliveryTime] = useState("");
  const tableInputRef = useRef(null);
  const addressInputRef = useRef(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [savingOrderId, setSavingOrderId] = useState(null);
  const [error, setError] = useState("");
  const [tab, setTab] = useState("order");
  const [confirmDialog, setConfirmDialog] = useState(null);
  const confirmResolverRef = useRef(null);
  const [toast, setToast] = useState(null);
  const toastTimerRef = useRef(null);
  /** Oculta el numerito del tab tras 1 min (se reinicia si cambia la cantidad del día). */
  const [hidePedidosRealizadosBadge, setHidePedidosRealizadosBadge] = useState(false);

  const menuById = useMemo(() => {
    const m = new Map();
    for (const it of menuItems) {
      if (it?.id) m.set(it.id, it);
    }
    return m;
  }, [menuItems]);

  const cartLines = useMemo(
    () => buildCartLines(cartById, menuById),
    [cartById, menuById]
  );
  const totalAmount = useMemo(() => cartTotal(cartById, menuById), [cartById, menuById]);

  useEffect(() => {
    if (!toast) return undefined;
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => {
      setToast(null);
      toastTimerRef.current = null;
    }, 3400);
    return () => {
      if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    };
  }, [toast]);

  useEffect(() => {
    async function loadRestaurant() {
      const { data, error: queryError } = await fetchRestaurantForDashboard(supabase);
      if (queryError) {
        setError(`Error resolviendo restaurante: ${queryError.message}`);
        return;
      }
      if (!data) {
        setError("No se encontró el restaurante asociado a este panel.");
        return;
      }
      setRestaurantId(data.id);
      setRestaurantName(data.name || "");
      setBotNumber(String(data.whatsapp_number || "").replace(/\D/g, "") || "0");
      const metadataObj =
        data?.metadata && typeof data.metadata === "object" && !Array.isArray(data.metadata)
          ? data.metadata
          : {};
      setWaiterFulfillmentSelectorEnabled(metadataObj.waiter_fulfillment_selector_enabled === true);
    }
    loadRestaurant();
  }, []);

  useEffect(() => {
    if (waiterFulfillmentSelectorEnabled) return;
    setFulfillmentType("mesa");
    setDeliveryWarning("");
  }, [waiterFulfillmentSelectorEnabled]);

  useEffect(() => {
    if (!restaurantId) return undefined;
    let active = true;

    async function loadMenu() {
      const { data, error: queryError } = await supabase
        .from("menu_items")
        .select("id, name, price, category, description")
        .eq("restaurant_id", restaurantId)
        .eq("available", true)
        .order("name", { ascending: true });
      if (!active) return;
      if (queryError) {
        setError(`Error cargando menú: ${queryError.message}`);
        return;
      }
      setMenuItems(data || []);
    }

    async function loadOrders() {
      setLoading(true);
      const sinceIso = new Date(Date.now() - HISTORY_HOURS * 60 * 60 * 1000).toISOString();
      const { data, error: queryError } = await supabase
        .from("orders")
        .select("*")
        .eq("restaurant_id", restaurantId)
        .gte("created_at", sinceIso)
        .order("created_at", { ascending: false })
        .limit(200);
      if (!active) return;
      if (queryError) {
        setError(`Error cargando pedidos: ${queryError.message}`);
        setLoading(false);
        return;
      }
      setOrders(data || []);
      setLoading(false);
    }

    loadMenu();
    loadOrders();

    const channel = supabase
      .channel(`waiter-orders-${restaurantId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "orders",
          filter: `restaurant_id=eq.${restaurantId}`
        },
        (payload) => {
          if (payload.eventType === "INSERT") {
            setOrders((prev) => [payload.new, ...prev.filter((o) => o.id !== payload.new.id)]);
            return;
          }
          if (payload.eventType === "UPDATE") {
            const row = payload.new;
            setOrders((prev) => {
              const oldRow = prev.find((o) => o.id === row.id);
              const next = prev.map((o) => (o.id === row.id ? row : o));
              if (!oldRow?.kitchen_ready_at && row.kitchen_ready_at) playNotification();
              return next;
            });
          }
        }
      )
      .subscribe();

    return () => {
      active = false;
      supabase.removeChannel(channel);
    };
  }, [restaurantId]);

  /** Usuario de BD o texto corto si entraron solo con contraseña de rol (.env). */
  const waiterIdentityLabel = useMemo(() => {
    const s = getSession();
    if (!s) return "";
    if (s.username) return s.username;
    if (s.loginSource === "env") return "Acceso mozo (sin usuario)";
    return "Mozo";
  }, []);

  /** Pedidos cargados desde este panel hoy (hora local del dispositivo). Con usuario en BD, solo los propios. */
  const myOrdersToday = useMemo(() => {
    const s = getSession();
    const userTag = s?.username ? String(s.username).trim().toLowerCase() : "";

    const now = new Date();
    const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0).getTime();
    const dayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999).getTime();

    return orders
      .filter((o) => {
        if (!orderFromWaiterPanel(o)) return false;
        const t = new Date(o.created_at).getTime();
        if (Number.isNaN(t) || t < dayStart || t > dayEnd) return false;
        if (!userTag) return true;
        return String(o.notes || "")
          .toLowerCase()
          .includes(` · mozo: ${userTag}`);
      })
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  }, [orders]);

  useEffect(() => {
    if (myOrdersToday.length === 0) {
      setHidePedidosRealizadosBadge(false);
      return undefined;
    }
    setHidePedidosRealizadosBadge(false);
    const id = window.setTimeout(
      () => setHidePedidosRealizadosBadge(true),
      PEDIDOS_REALIZADOS_BADGE_MS
    );
    return () => window.clearTimeout(id);
  }, [myOrdersToday.length]);

  function requestConfirm({
    title = "Confirmar acción",
    message = "",
    body = null,
    confirmLabel = "Confirmar",
    cancelLabel = "Cancelar",
    tone = "info"
  } = {}) {
    return new Promise((resolve) => {
      confirmResolverRef.current = resolve;
      setConfirmDialog({ title, message, body, confirmLabel, cancelLabel, tone });
    });
  }

  function handleConfirmDialog(value) {
    const resolver = confirmResolverRef.current;
    confirmResolverRef.current = null;
    setConfirmDialog(null);
    if (typeof resolver === "function") resolver(Boolean(value));
  }

  function addToCart(itemId) {
    setCartById((prev) => ({
      ...prev,
      [itemId]: (prev[itemId] || 0) + 1
    }));
  }

  function removeFromCart(itemId) {
    setCartById((prev) => {
      const next = { ...prev };
      const q = (next[itemId] || 0) - 1;
      if (q < 1) delete next[itemId];
      else next[itemId] = q;
      return next;
    });
  }

  async function performSubmitOrder(tableNum, deliveryDetails = null) {
    const session = getSession();
    const waiterName = session?.username ? String(session.username).trim() : "";
    const userPart = waiterName ? ` · Mozo: ${waiterName}` : "";
    const deliveryAddressTrimmed = String(deliveryDetails?.address || "").trim();
    const scheduledAt = deliveryDetails?.scheduledAt || null;
    const notes = deliveryDetails
      ? `Mozo · Delivery${userPart}`
      : `Mozo · Mesa: ${tableNum}${userPart}`;

    const row = {
      restaurant_id: restaurantId,
      customer_number: botNumber,
      bot_number: botNumber,
      items: cartLines,
      notes,
      status: "confirmed",
      payment_method: deliveryDetails ? "efectivo" : "efectivo_mesa",
      payment_status: "pending",
      fulfillment_type: deliveryDetails ? "delivery_mozo" : "mesa",
      total_price: totalAmount,
      total_amount: totalAmount,
      subtotal_amount: totalAmount,
      created_at: new Date().toISOString()
    };
    if (deliveryDetails) {
      row.address = deliveryAddressTrimmed;
      row.scheduled_delivery_at = scheduledAt;
    } else {
      row.table_number = tableNum;
    }

    setSubmitting(true);
    let { data, error: insErr } = await supabase.from("orders").insert(row).select("*").single();

    if (insErr && /table_number/i.test(insErr.message || "")) {
      const fallback = { ...row };
      delete fallback.table_number;
      const retry = await supabase.from("orders").insert(fallback).select("*").single();
      data = retry.data;
      insErr = retry.error;
    }
    if (insErr && /scheduled_delivery_at/i.test(insErr.message || "")) {
      const fallback = { ...row };
      delete fallback.scheduled_delivery_at;
      const retry = await supabase.from("orders").insert(fallback).select("*").single();
      data = retry.data;
      insErr = retry.error;
    }

    if (insErr) {
      setError(`No se pudo crear el pedido: ${insErr.message}`);
      setSubmitting(false);
      return;
    }

    if (data) {
      setOrders((prev) => [data, ...prev.filter((o) => o.id !== data.id)]);
      setCartById({});
      setTableNumber("");
      setDeliveryAddress("");
      setScheduledDeliveryDate(localDateInputValue());
      setScheduledDeliveryTime("");
      setTab("history");
      setToast(deliveryDetails ? "Listo · delivery enviado a cocina" : "Listo · enviado a cocina");
    }
    setSubmitting(false);
  }

  async function submitOrder() {
    setError("");
    setMesaWarning("");
    setDeliveryWarning("");
    const isDelivery = fulfillmentType === "delivery";
    const table = String(tableNumber || "").trim();
    const tableNum = parseInt(table, 10);
    const mesaMissing = !table;
    const mesaInvalid = Boolean(table) && (!Number.isFinite(tableNum) || tableNum < 1);
    if (!isDelivery && (mesaMissing || mesaInvalid)) {
      const msg = mesaMissing
        ? "Te olvidaste de indicar la mesa. Ingresá el número antes de enviar a cocina."
        : "Ingresá un número de mesa válido (1 o más).";
      setError(msg);
      setMesaWarning(msg);
      tableInputRef.current?.focus();
      tableInputRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    const address = String(deliveryAddress || "").trim();
    const scheduledAt = scheduledDeliveryIso(scheduledDeliveryDate, scheduledDeliveryTime);
    if (isDelivery && !address) {
      const msg = "Ingresá la dirección del delivery antes de enviar el pedido.";
      setError(msg);
      setDeliveryWarning(msg);
      addressInputRef.current?.focus();
      addressInputRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    if (isDelivery && scheduledAt === "") {
      const msg = "Revisá la fecha y hora programada del delivery.";
      setError(msg);
      setDeliveryWarning(msg);
      return;
    }
    if (cartLines.length === 0) {
      setError("Agregá al menos un producto al pedido.");
      return;
    }
    if (!restaurantId || !botNumber) {
      setError("Falta configuración del restaurante.");
      return;
    }

    const summaryLines = [];
    for (const [itemId, qty] of Object.entries(cartById)) {
      const item = menuById.get(itemId);
      if (!item || qty < 1) continue;
      const p = Number(item.price);
      const lineTotal = Number.isFinite(p) ? Math.round(p * qty * 100) / 100 : 0;
      summaryLines.push({
        key: itemId,
        name: String(item.name || "").trim() || "Ítem",
        qty,
        lineTotal
      });
    }

    const confirmed = await requestConfirm({
      title: "Confirmar envío a cocina",
      message: "Revisá el pedido. Si está bien, tocá enviar para mandarlo a cocina.",
      confirmLabel: "Sí, enviar a cocina",
      cancelLabel: "Volver a editar",
      tone: "info",
      body: (
        <div className="mt-3 space-y-3 border-t border-slate-700/80 pt-3 text-left">
          <p className="text-sm">
            <span className="text-slate-500">Modalidad</span>{" "}
            <span className="font-semibold text-white">{isDelivery ? "Delivery" : `Mesa ${tableNum}`}</span>
          </p>
          {isDelivery ? (
            <div className="space-y-1 text-sm">
              <p>
                <span className="text-slate-500">Dirección</span>{" "}
                <span className="font-semibold text-white">{address}</span>
              </p>
              <p>
                <span className="text-slate-500">Horario</span>{" "}
                <span className="font-semibold text-white">
                  {scheduledAt ? formatDateTime(scheduledAt) : "Sin horario programado"}
                </span>
              </p>
            </div>
          ) : null}
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Ítems</p>
            <ul className="mt-1 max-h-52 space-y-1 overflow-y-auto rounded-lg border border-slate-700/60 bg-slate-950/50 px-3 py-2 text-sm text-slate-200">
              {summaryLines.map(({ key, name, qty, lineTotal }) => (
                <li key={key} className="flex flex-wrap justify-between gap-x-2 gap-y-0.5">
                  <span>
                    <span className="font-medium text-emerald-100/90">{name}</span>
                    <span className="text-slate-500"> × {qty}</span>
                  </span>
                  <span className="tabular-nums text-slate-400">{currency(lineTotal)}</span>
                </li>
              ))}
            </ul>
          </div>
          <p className="flex flex-wrap items-baseline justify-between gap-2 border-t border-slate-700/60 pt-2 text-sm">
            <span className="text-slate-500">Total del pedido</span>
            <span className="text-lg font-bold tabular-nums text-emerald-300">{currency(totalAmount)}</span>
          </p>
        </div>
      )
    });

    if (!confirmed) return;

    await performSubmitOrder(
      isDelivery ? null : tableNum,
      isDelivery ? { address, scheduledAt } : null
    );
  }

  async function confirmOrderPayment(order) {
    if (!order?.id) return;
    if (paymentIsApproved(order)) {
      setError("El pago de este pedido ya figura confirmado.");
      return;
    }
    if (normalizeOrderStatus(order) === "cancelled") {
      setError("No se puede confirmar el pago de un pedido cancelado.");
      return;
    }

    const ok = await requestConfirm({
      title: "Confirmar pago",
      message: "El pedido quedará marcado como pagado. ¿Confirmás la operación?",
      confirmLabel: "Sí, confirmar pago",
      cancelLabel: "Volver",
      tone: "info"
    });
    if (!ok) return;

    setError("");
    setSavingOrderId(order.id);
    const paidAt = new Date().toISOString();
    const { data: updatedRow, error: updateError } = await supabase
      .from("orders")
      .update({
        payment_status: "paid",
        payment_paid_at: paidAt
      })
      .eq("id", order.id)
      .neq("status", "cancelled")
      .select("*")
      .maybeSingle();

    if (updateError) {
      setError(`No se pudo confirmar el pago: ${updateError.message}`);
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
    setToast("Pago confirmado");
  }

  async function markOrderDelivered(order) {
    if (!order?.id) return;
    if (!isWaiterDeliveryOrder(order)) {
      setError("La entrega manual del mozo solo está disponible para pedidos delivery mozo.");
      return;
    }
    const st = normalizeOrderStatus(order);
    if (st === "delivered") {
      setError("Este pedido ya figura entregado.");
      return;
    }
    if (st === "cancelled") {
      setError("No se puede entregar un pedido cancelado.");
      return;
    }

    const ok = await requestConfirm({
      title: "Marcar delivery entregado",
      message: "El pedido delivery quedará cerrado como entregado. ¿Confirmás la entrega?",
      confirmLabel: "Sí, marcar entregado",
      cancelLabel: "Volver",
      tone: "info"
    });
    if (!ok) return;

    setError("");
    setSavingOrderId(order.id);
    const deliveredAt = new Date().toISOString();
    const { data: updatedRow, error: updateError } = await supabase
      .from("orders")
      .update({
        status: "delivered",
        delivered_at: deliveredAt
      })
      .eq("id", order.id)
      .eq("fulfillment_type", "delivery_mozo")
      .neq("status", "delivered")
      .neq("status", "cancelled")
      .select("*")
      .maybeSingle();

    if (updateError) {
      setError(`No se pudo marcar entregado: ${updateError.message}`);
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
    setToast("Delivery marcado como entregado");
  }

  const groupedMenu = useMemo(() => {
    const raw = String(menuSearchQuery || "").trim().toLowerCase();
    const words = raw ? raw.split(/\s+/).filter(Boolean) : [];
    const filteredItems =
      words.length === 0
        ? menuItems
        : menuItems.filter((item) => {
            const haystack = [
              item.name,
              item.category,
              item.description,
              item.price != null ? String(item.price) : ""
            ]
              .filter(Boolean)
              .join(" ")
              .toLowerCase();
            return words.every((word) => haystack.includes(word));
          });
    const byCat = new Map();
    for (const it of filteredItems) {
      const cat = String(it.category || "Otros").trim() || "Otros";
      if (!byCat.has(cat)) byCat.set(cat, []);
      byCat.get(cat).push(it);
    }
    const entries = Array.from(byCat.entries()).map(([cat, items]) => [
      cat,
      [...items].sort((a, b) =>
        String(a.name || "").localeCompare(String(b.name || ""), "es", {
          sensitivity: "base",
          numeric: true
        })
      )
    ]);
    entries.sort((a, b) =>
      String(a[0]).localeCompare(String(b[0]), "es", { sensitivity: "base", numeric: true })
    );
    return entries;
  }, [menuItems, menuSearchQuery]);

  const filteredMenuItemsCount = useMemo(
    () => groupedMenu.reduce((acc, [, items]) => acc + items.length, 0),
    [groupedMenu]
  );

  return (
    <div className="dark min-h-screen bg-slate-950 text-slate-100">
      <header className="sticky top-0 z-10 border-b border-slate-800 bg-slate-950/95 backdrop-blur">
        <div className="mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div>
            <h1 className="text-lg font-semibold text-white">Mozo</h1>
            {waiterIdentityLabel ? (
              <p className="text-xs font-medium text-slate-200">{waiterIdentityLabel}</p>
            ) : null}
            <p className="text-xs text-slate-400">{restaurantName || "…"}</p>
          </div>
          <button
            type="button"
            onClick={() => onLogout?.()}
            className="rounded-lg border border-slate-600 px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-800"
          >
            Salir
          </button>
        </div>
        <div className="mx-auto flex max-w-3xl gap-1 border-t border-slate-800/80 px-2 pb-2">
          <button
            type="button"
            onClick={() => setTab("order")}
            className={`flex-1 rounded-lg py-2 text-sm font-medium ${
              tab === "order"
                ? "bg-emerald-500/20 text-emerald-200"
                : "text-slate-400 hover:bg-slate-800/60"
            }`}
          >
            Nuevo pedido
          </button>
          <button
            type="button"
            onClick={() => setTab("history")}
            className={`relative flex-1 rounded-lg py-2 text-sm font-medium ${
              tab === "history"
                ? "bg-emerald-500/20 text-emerald-200"
                : "text-slate-400 hover:bg-slate-800/60"
            }`}
          >
            Pedidos realizados
            {myOrdersToday.length > 0 && !hidePedidosRealizadosBadge ? (
              <span className="absolute -right-1 -top-1 flex h-5 min-w-[1.25rem] items-center justify-center rounded-full bg-sky-500 px-1 text-[10px] font-bold text-slate-950">
                {myOrdersToday.length}
              </span>
            ) : null}
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-4 py-5">
        {error ? (
          <div className="mb-4 rounded-lg border border-rose-500/35 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">
            {error}
          </div>
        ) : null}

        {tab === "order" ? (
          <div className="space-y-5">
            {waiterFulfillmentSelectorEnabled ? (
            <div className="rounded-xl border border-slate-700 bg-slate-900/60 p-4">
              <p className="block text-xs font-medium uppercase tracking-wider text-slate-400">
                Modalidad
              </p>
              <div className="mt-2 grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setFulfillmentType("mesa");
                    setDeliveryWarning("");
                    setError("");
                  }}
                  className={`rounded-lg border px-3 py-2 text-sm font-semibold ${
                    fulfillmentType === "mesa"
                      ? "border-violet-500/50 bg-violet-500/20 text-violet-100"
                      : "border-slate-600 bg-slate-950 text-slate-300 hover:bg-slate-800"
                  }`}
                  translate="no"
                >
                  Mesa
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setFulfillmentType("delivery");
                    setMesaWarning("");
                    setError("");
                  }}
                  className={`rounded-lg border px-3 py-2 text-sm font-semibold ${
                    fulfillmentType === "delivery"
                      ? "border-sky-500/50 bg-sky-500/20 text-sky-100"
                      : "border-slate-600 bg-slate-950 text-slate-300 hover:bg-slate-800"
                  }`}
                  translate="no"
                >
                  Delivery
                </button>
              </div>
            </div>
            ) : null}

            <div
              className={`rounded-xl border bg-slate-900/60 p-4 ${
                mesaWarning
                  ? "border-amber-500/50 ring-1 ring-amber-500/25"
                  : "border-slate-700"
              }`}
            >
              {fulfillmentType === "delivery" ? (
                <div className="space-y-3">
                  <div>
                    <label className="block text-xs font-medium uppercase tracking-wider text-slate-400">
                      Dirección
                    </label>
                    <input
                      ref={addressInputRef}
                      type="text"
                      placeholder="Ej: Av. Siempre Viva 742"
                      value={deliveryAddress}
                      onChange={(e) => {
                        setDeliveryAddress(e.target.value);
                        setDeliveryWarning("");
                        setError("");
                      }}
                      className={`mt-2 h-12 w-full rounded-lg border bg-slate-950 px-3 text-base font-semibold text-white outline-none focus:border-emerald-500/50 ${
                        deliveryWarning ? "border-amber-500/60" : "border-slate-600"
                      }`}
                    />
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div>
                      <label className="block text-xs font-medium uppercase tracking-wider text-slate-400">
                        Fecha programada
                      </label>
                      <input
                        type="date"
                        value={scheduledDeliveryDate}
                        onChange={(e) => {
                          setScheduledDeliveryDate(e.target.value);
                          setDeliveryWarning("");
                          setError("");
                        }}
                        className="mt-2 h-12 w-full rounded-lg border border-slate-600 bg-slate-950 px-3 text-base font-semibold text-white outline-none focus:border-emerald-500/50"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium uppercase tracking-wider text-slate-400">
                        Hora programada
                      </label>
                      <input
                        type="text"
                        value={scheduledDeliveryTime}
                        inputMode="numeric"
                        placeholder="HH:MM"
                        autoComplete="off"
                        maxLength={5}
                        onChange={(e) => {
                          setScheduledDeliveryTime(formatScheduledDeliveryTimeInput(e.target.value));
                          setDeliveryWarning("");
                          setError("");
                        }}
                        onBlur={(e) => {
                          setScheduledDeliveryTime(normalizeScheduledDeliveryTimeInput(e.target.value));
                          setDeliveryWarning("");
                          setError("");
                        }}
                        className="mt-2 h-12 w-full rounded-lg border border-slate-600 bg-slate-950 px-3 text-base font-semibold text-white outline-none focus:border-emerald-500/50"
                      />
                    </div>
                  </div>
                  {deliveryWarning ? (
                    <p className="text-sm font-medium text-amber-200" role="alert">
                      {deliveryWarning}
                    </p>
                  ) : (
                    <p className="text-xs text-slate-500">
                      La hora es opcional. Si queda vacía, el delivery sale sin horario programado.
                    </p>
                  )}
                </div>
              ) : (
                <>
                  <label
                    className="block text-xs font-medium uppercase tracking-wider text-slate-400"
                    translate="no"
                  >
                    Mesa
                  </label>
                  <input
                    ref={tableInputRef}
                    type="number"
                    min={1}
                    inputMode="numeric"
                    placeholder="Ej: 12"
                    value={tableNumber}
                    onChange={(e) => {
                      setTableNumber(e.target.value);
                      setMesaWarning("");
                      setError("");
                    }}
                    className={`mt-2 h-12 w-full rounded-lg border bg-slate-950 px-3 text-lg font-semibold text-white outline-none focus:border-emerald-500/50 ${
                      mesaWarning ? "border-amber-500/60" : "border-slate-600"
                    }`}
                  />
                  {mesaWarning ? (
                    <p className="mt-2 text-sm font-medium text-amber-200" role="alert">
                      {mesaWarning}
                    </p>
                  ) : (
                    <p className="mt-2 text-xs text-slate-500">Obligatorio para enviar el pedido a cocina.</p>
                  )}
                </>
              )}
            </div>

            {menuItems.length > 0 ? (
              <div className="rounded-xl border border-slate-700 bg-slate-900/60 p-4">
                <label className="block">
                  <span className="sr-only">Buscar productos</span>
                  <input
                    type="search"
                    value={menuSearchQuery}
                    onChange={(e) => setMenuSearchQuery(e.target.value)}
                    placeholder="Buscar por nombre, categoria, descripcion o precio..."
                    autoComplete="off"
                    className="h-10 w-full rounded-lg border border-slate-600 bg-slate-950 px-3 text-sm text-slate-100 placeholder:text-slate-500 focus:border-emerald-500/50 focus:outline-none focus:ring-1 focus:ring-emerald-500/30"
                  />
                </label>
                {menuSearchQuery.trim() ? (
                  <p className="mt-2 text-xs text-slate-500">
                    {filteredMenuItemsCount === menuItems.length
                      ? `${menuItems.length} productos`
                      : `${filteredMenuItemsCount} de ${menuItems.length} productos`}
                  </p>
                ) : null}
              </div>
            ) : null}

            {loading ? (
              <p className="text-slate-400">Cargando menú…</p>
            ) : menuItems.length === 0 ? (
              <div className="rounded-xl border border-slate-700 bg-slate-900/60 p-4 text-sm text-slate-400">
                No hay productos disponibles en este momento.
              </div>
            ) : filteredMenuItemsCount === 0 ? (
              <div className="rounded-xl border border-slate-700 bg-slate-900/60 p-4 text-sm text-slate-400">
                No hay productos que coincidan con &quot;{menuSearchQuery.trim()}&quot;.
              </div>
            ) : (
              groupedMenu.map(([category, items]) => (
                <section key={category}>
                  <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">
                    {category}
                  </h2>
                  <div className="space-y-2">
                    {items.map((item) => {
                      const q = cartById[item.id] || 0;
                      return (
                        <div
                          key={item.id}
                          className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-700/80 bg-slate-900/40 px-3 py-2"
                        >
                          <div className="min-w-0 flex-1">
                            <p className="font-medium text-slate-100">{item.name}</p>
                            <p className="text-sm text-emerald-300/90">{currency(item.price)}</p>
                          </div>
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              disabled={q < 1}
                              onClick={() => removeFromCart(item.id)}
                              className="h-10 w-10 rounded-lg border border-slate-600 text-lg leading-none text-slate-300 hover:bg-slate-800 disabled:opacity-30"
                            >
                              −
                            </button>
                            <span className="w-8 text-center tabular-nums text-lg font-semibold">{q}</span>
                            <button
                              type="button"
                              onClick={() => addToCart(item.id)}
                              className="h-10 w-10 rounded-lg bg-emerald-600 text-lg font-semibold leading-none text-white hover:bg-emerald-500"
                            >
                              +
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </section>
              ))
            )}

            <div className="sticky bottom-0 border-t border-slate-800 bg-slate-950/95 py-4 backdrop-blur">
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-emerald-500/30 bg-emerald-950/20 px-4 py-3">
                <div>
                  <p className="text-xs text-slate-400">Total</p>
                  <p className="text-xl font-bold text-emerald-200">{currency(totalAmount)}</p>
                  <p className="text-[11px] text-slate-500">{cartLines.length} ítem(s)</p>
                </div>
                <button
                  type="button"
                  disabled={submitting || cartLines.length === 0}
                  onClick={() => submitOrder()}
                  className="rounded-lg bg-emerald-500 px-6 py-3 text-sm font-semibold text-slate-950 hover:bg-emerald-400 disabled:opacity-50"
                >
                  {submitting ? "Enviando…" : "Enviar a cocina"}
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-xs text-slate-500">
              {getSession()?.username
                ? "Pedidos que cargaste hoy desde este dispositivo (hora local)."
                : "Pedidos mozo registrados hoy con esta sesión (incluye todos los mozos si entraron solo con contraseña compartida)."}
            </p>
            {myOrdersToday.length === 0 ? (
              <p className="rounded-xl border border-slate-800 bg-slate-900/40 px-4 py-10 text-center text-slate-400">
                Todavía no hay pedidos mozo registrados hoy.
              </p>
            ) : (
              myOrdersToday.map((order) => {
                const mesa = tableNumberLabel(order);
                const rows = groupOrderItemRows(order);
                const delivery = isWaiterDeliveryOrder(order);
                const scheduledLabel = formatDateTime(order.scheduled_delivery_at);
                const orderStatus = normalizeOrderStatus(order);
                const isClosed = orderStatus === "delivered" || orderStatus === "cancelled";
                const paid = paymentIsApproved(order);
                const savingThisOrder = savingOrderId === order.id;
                return (
                  <article
                    key={order.id}
                    className="rounded-xl border border-slate-700/80 bg-slate-900/70 p-4"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <p className="font-mono text-xs text-slate-500">
                          #{String(order.id).slice(0, 8)} · {formatDateTime(order.created_at)}
                        </p>
                        {delivery ? (
                          <div className="mt-2 space-y-1">
                            <p className="text-xl font-bold text-sky-100">Delivery mozo</p>
                            <p className="text-sm text-slate-300">{order.address || "Sin dirección"}</p>
                            {scheduledLabel ? (
                              <p className="text-xs font-medium text-amber-200">
                                Programado: {scheduledLabel}
                              </p>
                            ) : null}
                          </div>
                        ) : mesa ? (
                          <p className="mt-2 text-xl font-bold text-slate-100">Mesa {mesa}</p>
                        ) : (
                          <p className="mt-2 text-sm text-slate-400">Sin mesa en sistema</p>
                        )}
                      </div>
                      <span className="shrink-0 rounded-full bg-slate-700/80 px-2 py-0.5 text-xs text-slate-200">
                        {formatOrderStatusLabelEs(order)}
                      </span>
                    </div>
                    <ul className="mt-3 space-y-0.5 text-sm text-slate-200">
                      {rows.map((r) => (
                        <li key={`${order.id}-${r.name}`}>
                          {r.name}
                          {r.count > 1 ? ` ×${r.count}` : ""}
                        </li>
                      ))}
                    </ul>
                    <p className="mt-2 text-xs text-slate-500">
                      Total: {currency(subtotalForOrder(order))}
                    </p>
                    <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-slate-800 pt-3">
                      <span
                        className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                          paid
                            ? "bg-emerald-500/15 text-emerald-200"
                            : "bg-amber-500/15 text-amber-200"
                        }`}
                      >
                        Pago: {formatPaymentStatusLabelEs(order.payment_status)}
                      </span>
                      {!paid && orderStatus !== "cancelled" ? (
                        <button
                          type="button"
                          disabled={savingThisOrder}
                          onClick={() => confirmOrderPayment(order)}
                          className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-1.5 text-xs font-semibold text-emerald-200 hover:bg-emerald-500/20 disabled:opacity-50"
                        >
                          {savingThisOrder ? "Guardando…" : "Confirmar pago"}
                        </button>
                      ) : null}
                      {delivery && !isClosed ? (
                        <button
                          type="button"
                          disabled={savingThisOrder}
                          onClick={() => markOrderDelivered(order)}
                          className="rounded-lg border border-sky-500/40 bg-sky-500/10 px-3 py-1.5 text-xs font-semibold text-sky-200 hover:bg-sky-500/20 disabled:opacity-50"
                        >
                          {savingThisOrder ? "Guardando…" : "Entregar"}
                        </button>
                      ) : null}
                    </div>
                  </article>
                );
              })
            )}
          </div>
        )}
      </main>
      {toast ? (
        <div
          className="pointer-events-none fixed bottom-6 left-1/2 z-[60] -translate-x-1/2 px-4"
          role="status"
          aria-live="polite"
        >
          <div className="pointer-events-none rounded-full border border-emerald-500/35 bg-emerald-950/90 px-4 py-2 text-center text-sm font-medium text-emerald-100 shadow-lg shadow-emerald-950/30 backdrop-blur-sm">
            {toast}
          </div>
        </div>
      ) : null}
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
    CONFIRM_TONE_PALETTE[dialog?.tone] || CONFIRM_TONE_PALETTE.info;

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
      aria-labelledby="waiter-confirm-modal-title"
    >
      <div
        className="absolute inset-0 bg-slate-950/70 backdrop-blur-sm"
        onClick={() => onResolve(false)}
      />
      <div
        className={`relative max-h-[90vh] w-full max-w-md overflow-y-auto rounded-2xl border ${palette.accent} bg-slate-900/95 p-5 shadow-2xl shadow-black/40`}
      >
        <div className="flex items-start gap-3">
          <span
            className={`flex h-9 w-9 flex-none items-center justify-center rounded-full ${palette.iconBg} text-base font-bold`}
            aria-hidden="true"
          >
            !
          </span>
          <div className="min-w-0 flex-1">
            <h3
              id="waiter-confirm-modal-title"
              className="text-base font-semibold text-slate-100"
            >
              {dialog.title}
            </h3>
            {dialog.message ? (
              <p className="mt-1 text-sm text-slate-300">{dialog.message}</p>
            ) : null}
            {dialog.body ? dialog.body : null}
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
