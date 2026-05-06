import { useEffect, useMemo, useState } from "react";
import { supabase } from "../supabaseClient";
import {
  formatDateTime,
  groupOrderItemRows,
  isDeliveryOrder,
  kitchenMetaBoxContent,
  normalizeOrderStatus,
  orderInKitchenQueue,
  orderPlacedByWaiter,
  playNotification,
  tableNumberLabel
} from "../lib/format";

const HISTORY_HOURS = 18;

export default function KitchenApp({ onLogout }) {
  const [restaurantId, setRestaurantId] = useState("");
  const [restaurantName, setRestaurantName] = useState("");
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [savingOrderId, setSavingOrderId] = useState(null);

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
    }
    loadRestaurant();
  }, []);

  useEffect(() => {
    if (!restaurantId) return undefined;
    let active = true;

    async function loadOrders() {
      setLoading(true);
      const sinceIso = new Date(Date.now() - HISTORY_HOURS * 60 * 60 * 1000).toISOString();
      const { data, error: queryError } = await supabase
        .from("orders")
        .select("*")
        .eq("restaurant_id", restaurantId)
        .gte("created_at", sinceIso)
        .order("created_at", { ascending: true })
        .limit(300);
      if (!active) return;
      if (queryError) {
        setError(`Error cargando pedidos: ${queryError.message}`);
        setLoading(false);
        return;
      }
      setOrders(data || []);
      setLoading(false);
    }

    loadOrders();

    const channel = supabase
      .channel(`kitchen-orders-${restaurantId}`)
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
            const row = payload.new;
            setOrders((prev) => {
              if (prev.some((o) => o.id === row.id)) return prev;
              const next = [...prev, row].sort(
                (a, b) => new Date(a.created_at) - new Date(b.created_at)
              );
              if (orderInKitchenQueue(row)) playNotification();
              return next;
            });
            return;
          }
          if (payload.eventType === "UPDATE") {
            const row = payload.new;
            setOrders((prev) => {
              const oldRow = prev.find((o) => o.id === row.id);
              const merged = prev.map((o) => (o.id === row.id ? row : o));
              const next = oldRow
                ? merged
                : [...prev, row].sort(
                    (a, b) => new Date(a.created_at) - new Date(b.created_at)
                  );
              if (orderInKitchenQueue(row) && (!oldRow || !orderInKitchenQueue(oldRow))) {
                playNotification();
              }
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

  const queue = useMemo(
    () => orders.filter((o) => orderInKitchenQueue(o)).sort(
      (a, b) => new Date(a.created_at) - new Date(b.created_at)
    ),
    [orders]
  );

  async function markKitchenReady(order) {
    if (!orderInKitchenQueue(order)) return;
    setError("");
    setSavingOrderId(order.id);
    const readyAt = new Date().toISOString();
    const { data: updatedRow, error: updateError } = await supabase
      .from("orders")
      .update({ kitchen_ready_at: readyAt })
      .eq("id", order.id)
      .is("kitchen_ready_at", null)
      .select("*")
      .maybeSingle();

    if (updateError) {
      setError(
        updateError.message?.includes("kitchen_ready_at") || updateError.message?.includes("column")
          ? `Falta aplicar la migración SQL (kitchen_ready_at). ${updateError.message}`
          : `Error: ${updateError.message}`
      );
      setSavingOrderId(null);
      return;
    }
    if (!updatedRow) {
      setError("Otro dispositivo ya marcó este pedido o no está disponible.");
      setSavingOrderId(null);
      return;
    }
    setOrders((prev) => prev.map((row) => (row.id === order.id ? { ...row, ...updatedRow } : row)));
    setSavingOrderId(null);
  }

  return (
    <div className="dark min-h-screen bg-slate-950 text-slate-100">
      <header className="sticky top-0 z-10 border-b border-slate-800 bg-slate-950/95 backdrop-blur">
        <div className="mx-auto flex max-w-4xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div>
            <h1 className="text-lg font-semibold text-white">Cocina</h1>
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
      </header>

      <main className="mx-auto max-w-4xl px-4 py-6">
        {error ? (
          <div className="mb-4 rounded-lg border border-rose-500/35 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">
            {error}
          </div>
        ) : null}

        {loading ? (
          <p className="text-slate-400">Cargando pedidos…</p>
        ) : queue.length === 0 ? (
          <div className="rounded-xl border border-slate-800 bg-slate-900/60 px-6 py-12 text-center text-slate-400">
            No hay pedidos confirmados pendientes de elaboración.
          </div>
        ) : (
          <ul className="space-y-4">
            {queue.map((order) => {
              const rows = groupOrderItemRows(order);
              const mesa = tableNumberLabel(order);
              const st = normalizeOrderStatus(order);
              const fromCustomer = !orderPlacedByWaiter(order);
              const kitchenMeta = kitchenMetaBoxContent(order);
              return (
                <li
                  key={order.id}
                  className="rounded-xl border border-amber-500/25 bg-slate-900/80 p-4 shadow-lg shadow-black/20"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="font-mono text-xs text-slate-500">
                        #{String(order.id).slice(0, 8)} · {formatDateTime(order.created_at)}
                      </p>
                      <p className="mt-1 text-sm text-slate-300">
                        {fromCustomer ? (
                          isDeliveryOrder(order) ? (
                            <span className="font-medium text-sky-300">Delivery</span>
                          ) : (
                            <span className="font-medium text-violet-300">Retiro en local</span>
                          )
                        ) : (
                          <>
                            {isDeliveryOrder(order) ? (
                              <span className="text-sky-300">Delivery</span>
                            ) : (
                              <span className="text-violet-300">Local / retiro</span>
                            )}
                            {mesa ? (
                              <span className="ml-2 rounded-full bg-violet-500/25 px-2 py-0.5 text-xs font-semibold text-violet-200">
                                Mesa {mesa}
                              </span>
                            ) : null}
                          </>
                        )}
                      </p>
                    </div>
                    <span className="rounded-full bg-blue-500/20 px-2 py-0.5 text-xs text-blue-200">
                      {st}
                    </span>
                  </div>

                  <ul className="mt-3 space-y-1 text-sm text-slate-100">
                    {rows.map((r) => (
                      <li key={`${order.id}-${r.name}`}>
                        <span className="font-medium text-emerald-200/90">{r.name}</span>
                        {r.count > 1 ? (
                          <span className="text-slate-400"> ×{r.count}</span>
                        ) : null}
                      </li>
                    ))}
                  </ul>

                  {kitchenMeta ? (
                    <p className="mt-2 whitespace-pre-wrap rounded-lg border border-slate-700/80 bg-slate-950/50 px-2 py-1.5 text-xs text-slate-300">
                      {kitchenMeta}
                    </p>
                  ) : null}

                  <button
                    type="button"
                    disabled={savingOrderId === order.id}
                    onClick={() => markKitchenReady(order)}
                    className="mt-4 w-full rounded-lg bg-emerald-600 py-3 text-sm font-semibold text-white shadow hover:bg-emerald-500 disabled:opacity-50 sm:w-auto sm:px-8"
                  >
                    {savingOrderId === order.id ? "Guardando…" : "Marcar listo"}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </main>
    </div>
  );
}
