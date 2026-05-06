import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "../supabaseClient";
import { getSession } from "../lib/auth";
import {
  currency,
  formatDateTime,
  groupOrderItemRows,
  isDeliveryOrder,
  normalizeOrderStatus,
  orderKitchenReady,
  paymentIsApproved,
  paymentMethodKey,
  playNotification,
  subtotalForOrder,
  tableNumberLabel
} from "../lib/format";

const HISTORY_HOURS = 18;

function buildCartLines(cartById, menuById) {
  const names = [];
  for (const [id, qty] of Object.entries(cartById)) {
    const item = menuById.get(id);
    if (!item || qty < 1) continue;
    const label = String(item.name || "").trim();
    if (!label) continue;
    for (let i = 0; i < qty; i += 1) names.push(label);
  }
  return names;
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
  const [menuItems, setMenuItems] = useState([]);
  const [orders, setOrders] = useState([]);
  const [cartById, setCartById] = useState({});
  const [tableNumber, setTableNumber] = useState("");
  const [mesaWarning, setMesaWarning] = useState("");
  const tableInputRef = useRef(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [tab, setTab] = useState("order");
  const [savingOrderId, setSavingOrderId] = useState(null);
  const [confirmDialog, setConfirmDialog] = useState(null);
  const confirmResolverRef = useRef(null);
  const [toast, setToast] = useState(null);
  const toastTimerRef = useRef(null);

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
      const configuredBotNumber = (import.meta.env.VITE_BOT_WHATSAPP_NUMBER || "").replace(/\D/g, "");
      let query = supabase.from("restaurants").select("id, name, whatsapp_number");
      if (configuredBotNumber) {
        query = query.eq("whatsapp_number", configuredBotNumber);
      } else {
        query = query.limit(1);
      }
      const { data, error: queryError } = await query.maybeSingle();
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
    }
    loadRestaurant();
  }, []);

  useEffect(() => {
    if (!restaurantId) return undefined;
    let active = true;

    async function loadMenu() {
      const { data, error: queryError } = await supabase
        .from("menu_items")
        .select("id, name, price, category")
        .eq("restaurant_id", restaurantId)
        .order("category", { ascending: true })
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

  const readyForHandoff = useMemo(() => {
    return orders.filter((o) => {
      const st = normalizeOrderStatus(o);
      if (st === "delivered" || st === "cancelled") return false;
      return st === "confirmed" && orderKitchenReady(o);
    });
  }, [orders]);

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

  async function applyDelivered(order) {
    const st = normalizeOrderStatus(order);
    if (st === "delivered" || st === "cancelled") {
      return { ok: false, reason: "closed" };
    }
    const nowIso = new Date().toISOString();
    const patch = {
      status: "delivered",
      delivered_at: nowIso
    };
    const cashPending = paymentMethodKey(order) === "cash" && !paymentIsApproved(order);
    if (cashPending) {
      patch.payment_status = "paid";
      patch.payment_paid_at = nowIso;
    }

    const { data: updatedRow, error: updateError } = await supabase
      .from("orders")
      .update(patch)
      .eq("id", order.id)
      .neq("status", "delivered")
      .neq("status", "cancelled")
      .select("*")
      .maybeSingle();

    if (updateError) {
      return { ok: false, error: updateError.message };
    }
    if (!updatedRow) {
      return { ok: false, reason: "stale" };
    }
    return { ok: true, updatedRow };
  }

  async function markDelivered(order) {
    const st = normalizeOrderStatus(order);
    if (st === "delivered" || st === "cancelled") {
      setError("Este pedido ya está cerrado.");
      return;
    }
    const cashOnDelivery = paymentMethodKey(order) === "cash" && !paymentIsApproved(order);
    const ok = await requestConfirm({
      title: cashOnDelivery ? "Cobrado y entregado" : "Marcar entregado",
      message: cashOnDelivery
        ? "¿Confirmás que cobraste en efectivo en mesa y entregaste el pedido?"
        : "¿Confirmás que el pedido ya fue entregado en mesa?",
      confirmLabel: cashOnDelivery ? "Sí, cobrado y entregado" : "Sí, marcar entregado",
      cancelLabel: "Volver",
      tone: "info"
    });
    if (!ok) return;

    setError("");
    setSavingOrderId(order.id);
    const result = await applyDelivered(order);
    setSavingOrderId(null);

    if (!result.ok) {
      if (result.reason === "closed") {
        setError("Este pedido ya está cerrado.");
      } else if (result.reason === "stale") {
        setError("No se pudo marcar como entregado (el pedido cambió de estado). Refrescá la lista.");
      } else {
        setError(`Error al marcar entregado: ${result.error || "desconocido"}`);
      }
      return;
    }
    setOrders((prev) =>
      prev.map((row) => (row.id === result.updatedRow.id ? { ...row, ...result.updatedRow } : row))
    );
  }

  async function markAllDelivered() {
    const list = [...readyForHandoff];
    if (list.length === 0) return;

    const anyCashPending = list.some(
      (o) => paymentMethodKey(o) === "cash" && !paymentIsApproved(o)
    );
    const ok = await requestConfirm({
      title: "Entregar todos",
      message:
        list.length === 1
          ? anyCashPending
            ? "¿Marcar este pedido como entregado? Si el pago en mesa era efectivo pendiente, también se registrará el cobro."
            : "¿Marcar este pedido como entregado?"
          : anyCashPending
            ? `¿Marcar como entregados los ${list.length} pedidos listos? Donde el pago era efectivo pendiente, se registrará también el cobro.`
            : `¿Marcar como entregados los ${list.length} pedidos listos?`,
      confirmLabel: "Sí, entregar todos",
      cancelLabel: "Volver",
      tone: "info"
    });
    if (!ok) return;

    setError("");
    let failures = 0;
    for (const order of list) {
      setSavingOrderId(order.id);
      const result = await applyDelivered(order);
      if (result.ok && result.updatedRow) {
        setOrders((prev) =>
          prev.map((row) =>
            row.id === result.updatedRow.id ? { ...row, ...result.updatedRow } : row
          )
        );
      } else {
        failures += 1;
      }
    }
    setSavingOrderId(null);
    if (failures > 0) {
      setError(
        `No se pudieron actualizar ${failures} de ${list.length} pedido(s). Refrescá si hace falta.`
      );
    }
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

  async function performSubmitOrder(tableNum) {
    const session = getSession();
    const userPart = session?.username ? ` · Mozo: ${session.username}` : "";
    const notes = `Mozo · Mesa: ${tableNum}${userPart}`;

    const row = {
      restaurant_id: restaurantId,
      customer_number: botNumber,
      bot_number: botNumber,
      items: cartLines,
      notes,
      status: "confirmed",
      payment_method: "efectivo_mesa",
      payment_status: "pending",
      fulfillment_type: "local",
      total_price: totalAmount,
      total_amount: totalAmount,
      subtotal_amount: totalAmount,
      table_number: tableNum,
      created_at: new Date().toISOString()
    };

    setSubmitting(true);
    let { data, error: insErr } = await supabase.from("orders").insert(row).select("*").single();

    if (insErr && /table_number/i.test(insErr.message || "")) {
      const fallback = { ...row };
      delete fallback.table_number;
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
      setTab("ready");
      setToast("Listo · enviado a cocina");
    }
    setSubmitting(false);
  }

  async function submitOrder() {
    setError("");
    setMesaWarning("");
    const table = String(tableNumber || "").trim();
    const tableNum = parseInt(table, 10);
    const mesaMissing = !table;
    const mesaInvalid = Boolean(table) && (!Number.isFinite(tableNum) || tableNum < 1);
    if (mesaMissing || mesaInvalid) {
      const msg = mesaMissing
        ? "Te olvidaste de indicar la mesa. Ingresá el número antes de enviar a cocina."
        : "Ingresá un número de mesa válido (1 o más).";
      setError(msg);
      setMesaWarning(msg);
      tableInputRef.current?.focus();
      tableInputRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
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
            <span className="text-slate-500">Mesa</span>{" "}
            <span className="font-semibold text-white">{tableNum}</span>
          </p>
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

    await performSubmitOrder(tableNum);
  }

  const groupedMenu = useMemo(() => {
    const byCat = new Map();
    for (const it of menuItems) {
      const cat = String(it.category || "Otros").trim() || "Otros";
      if (!byCat.has(cat)) byCat.set(cat, []);
      byCat.get(cat).push(it);
    }
    return Array.from(byCat.entries());
  }, [menuItems]);

  return (
    <div className="dark min-h-screen bg-slate-950 text-slate-100">
      <header className="sticky top-0 z-10 border-b border-slate-800 bg-slate-950/95 backdrop-blur">
        <div className="mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div>
            <h1 className="text-lg font-semibold text-white">Mozo</h1>
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
            onClick={() => setTab("ready")}
            className={`relative flex-1 rounded-lg py-2 text-sm font-medium ${
              tab === "ready"
                ? "bg-emerald-500/20 text-emerald-200"
                : "text-slate-400 hover:bg-slate-800/60"
            }`}
          >
            Listos para entregar
            {readyForHandoff.length > 0 ? (
              <span className="absolute -right-1 -top-1 flex h-5 min-w-[1.25rem] items-center justify-center rounded-full bg-emerald-500 px-1 text-[10px] font-bold text-slate-950">
                {readyForHandoff.length}
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
            <div
              className={`rounded-xl border bg-slate-900/60 p-4 ${
                mesaWarning
                  ? "border-amber-500/50 ring-1 ring-amber-500/25"
                  : "border-slate-700"
              }`}
            >
              <label className="block text-xs font-medium uppercase tracking-wider text-slate-400">
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
            </div>

            {loading ? (
              <p className="text-slate-400">Cargando menú…</p>
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
            {readyForHandoff.length === 0 ? (
              <p className="rounded-xl border border-slate-800 bg-slate-900/40 px-4 py-10 text-center text-slate-400">
                No hay pedidos listos para retirar en mesa todavía.
              </p>
            ) : (
              <>
                {readyForHandoff.length > 1 ? (
                  <div className="flex justify-end">
                    <button
                      type="button"
                      disabled={savingOrderId !== null}
                      onClick={() => markAllDelivered()}
                      className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-emerald-500 disabled:opacity-50"
                    >
                      Entregar todos ({readyForHandoff.length})
                    </button>
                  </div>
                ) : null}
                {readyForHandoff.map((order) => {
                const mesa = tableNumberLabel(order);
                const rows = groupOrderItemRows(order);
                const cashPending =
                  paymentMethodKey(order) === "cash" && !paymentIsApproved(order);
                const saving = savingOrderId === order.id;
                return (
                  <article
                    key={order.id}
                    className="rounded-xl border border-emerald-500/25 bg-slate-900/70 p-4"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <p className="font-mono text-xs text-slate-500">
                          #{String(order.id).slice(0, 8)} · listo{" "}
                          {formatDateTime(order.kitchen_ready_at)}
                        </p>
                        {mesa ? (
                          <p className="mt-2 text-2xl font-bold text-emerald-200">Mesa {mesa}</p>
                        ) : (
                          <p className="mt-2 text-sm text-slate-400">
                            {isDeliveryOrder(order) ? "Delivery" : "Sin mesa en sistema"}
                          </p>
                        )}
                      </div>
                      <span className="rounded-full bg-emerald-500/20 px-2 py-0.5 text-xs text-emerald-200">
                        Listo cocina
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
                    <div className="mt-4 flex flex-wrap justify-end gap-2">
                      <button
                        type="button"
                        disabled={savingOrderId !== null}
                        onClick={() => markDelivered(order)}
                        className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-emerald-400 disabled:opacity-50"
                      >
                        {saving
                          ? "Guardando…"
                          : cashPending
                            ? "Cobrado y entregado"
                            : "Marcar entregado"}
                      </button>
                    </div>
                  </article>
                );
              })}
              </>
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
