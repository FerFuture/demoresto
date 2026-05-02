import { useEffect, useMemo, useState } from "react";
import { supabase } from "../supabaseClient";
import {
  currency,
  effectiveOrderTotal,
  flattenOrderItems,
  isDeliveryOrder,
  normalizeOrderStatus,
  paymentIsApproved,
  paymentMethodKey
} from "../lib/format";

const STATS_WINDOW_DAYS = 30;

function startOfDay(date = new Date()) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function dayKey(date) {
  const d = startOfDay(date);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function shortDayLabel(date) {
  const d = new Date(date);
  return d.toLocaleDateString("es-AR", { weekday: "short", day: "2-digit" });
}

/**
 * Considera un pedido como "venta efectivamente concretada" cuando ya fue
 * entregado o tiene el pago aprobado (cobrado por MP, o efectivo confirmado).
 * Nunca cuenta los cancelados.
 */
function orderIsRevenue(order) {
  const st = normalizeOrderStatus(order);
  if (st === "cancelled") return false;
  if (st === "delivered") return true;
  return paymentIsApproved(order);
}

export default function AdminStats({ restaurantId }) {
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    if (!restaurantId) return;
    let active = true;
    setLoading(true);
    setError("");

    const fromIso = new Date(Date.now() - STATS_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();

    supabase
      .from("orders")
      .select("*")
      .eq("restaurant_id", restaurantId)
      .gte("created_at", fromIso)
      .order("created_at", { ascending: false })
      .limit(2000)
      .then(({ data, error: queryError }) => {
        if (!active) return;
        if (queryError) {
          setError(`Error cargando estadísticas: ${queryError.message}`);
          setLoading(false);
          return;
        }
        setOrders(data || []);
        setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [restaurantId, reloadTick]);

  const stats = useMemo(() => computeStats(orders), [orders]);

  if (!restaurantId) {
    return (
      <div className="rounded-xl border border-slate-700 bg-slate-900 p-5 text-slate-400">
        Sin restaurante asignado todavía.
      </div>
    );
  }

  if (loading) {
    return (
      <div className="rounded-xl border border-slate-700 bg-slate-900 p-5 text-slate-400">
        Calculando estadísticas…
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-5 text-rose-200">
        {error}
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold text-slate-100">Resumen del día</h2>
          <p className="text-xs text-slate-500">
            Datos de hoy y comparativos sobre los últimos {STATS_WINDOW_DAYS} días.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setReloadTick((n) => n + 1)}
          className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-800"
        >
          Refrescar
        </button>
      </div>

      <KpiGrid today={stats.today} />

      <div className="grid gap-4 lg:grid-cols-2">
        <RevenueChart days={stats.last7Days} />
        <TopItemsChart items={stats.topItems} />
      </div>

      <PaymentMethodsTable methods={stats.paymentBreakdown} />
    </div>
  );
}

function computeStats(orders) {
  const todayKey = dayKey(new Date());

  const today = {
    revenue: 0,
    count: 0,
    cancelled: 0,
    delivered: 0,
    deliveries: 0,
    pickups: 0,
    avgTicket: 0
  };

  for (const order of orders) {
    if (!order?.created_at) continue;
    if (dayKey(order.created_at) !== todayKey) continue;
    today.count += 1;
    const status = normalizeOrderStatus(order);
    if (status === "cancelled") today.cancelled += 1;
    if (status === "delivered") today.delivered += 1;
    if (orderIsRevenue(order)) {
      today.revenue += effectiveOrderTotal(order);
      if (isDeliveryOrder(order)) today.deliveries += 1;
      else today.pickups += 1;
    }
  }
  today.avgTicket = today.delivered > 0 ? today.revenue / today.delivered : 0;

  // Últimos 7 días (incluye hoy), ordenados de más viejo a más nuevo.
  const last7Days = [];
  for (let i = 6; i >= 0; i -= 1) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    last7Days.push({ key: dayKey(d), label: shortDayLabel(d), revenue: 0, count: 0 });
  }
  const last7Index = new Map(last7Days.map((entry) => [entry.key, entry]));
  for (const order of orders) {
    const k = dayKey(order.created_at);
    const entry = last7Index.get(k);
    if (!entry) continue;
    if (normalizeOrderStatus(order) === "cancelled") continue;
    entry.count += 1;
    if (orderIsRevenue(order)) entry.revenue += effectiveOrderTotal(order);
  }

  // Top productos en la ventana de los últimos N días (no cancelados).
  const itemCounts = new Map();
  for (const order of orders) {
    if (normalizeOrderStatus(order) === "cancelled") continue;
    const items = flattenOrderItems(order);
    for (const name of items) {
      const key = name.toLowerCase();
      const prev = itemCounts.get(key) || { name, count: 0 };
      prev.count += 1;
      itemCounts.set(key, prev);
    }
  }
  const topItems = Array.from(itemCounts.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  // Desglose por método de pago entre pedidos cobrados (no cancelados).
  const paymentBreakdown = { cash: { count: 0, revenue: 0 }, mp: { count: 0, revenue: 0 }, other: { count: 0, revenue: 0 } };
  for (const order of orders) {
    if (!orderIsRevenue(order)) continue;
    const key = paymentMethodKey(order);
    const bucket = paymentBreakdown[key] ?? paymentBreakdown.other;
    bucket.count += 1;
    bucket.revenue += effectiveOrderTotal(order);
  }

  return { today, last7Days, topItems, paymentBreakdown };
}

function KpiGrid({ today }) {
  const cards = [
    { label: "Ventas hoy", value: currency(today.revenue), tone: "emerald" },
    { label: "Pedidos hoy", value: today.count, tone: "blue" },
    { label: "Entregados", value: today.delivered, tone: "emerald" },
    { label: "Cancelados", value: today.cancelled, tone: "rose" },
    { label: "Delivery", value: today.deliveries, tone: "cyan" },
    { label: "Retiro local", value: today.pickups, tone: "violet" },
    { label: "Ticket promedio", value: currency(today.avgTicket), tone: "amber" }
  ];

  return (
    <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
      {cards.map((card) => (
        <div
          key={card.label}
          className={`rounded-xl border p-4 ${kpiToneClasses(card.tone)}`}
        >
          <p className="text-[11px] font-medium uppercase tracking-wider text-slate-400">
            {card.label}
          </p>
          <p className="mt-1 text-2xl font-semibold text-slate-100 tabular-nums">{card.value}</p>
        </div>
      ))}
    </div>
  );
}

function kpiToneClasses(tone) {
  switch (tone) {
    case "emerald":
      return "border-emerald-500/30 bg-emerald-500/5";
    case "blue":
      return "border-blue-500/30 bg-blue-500/5";
    case "rose":
      return "border-rose-500/30 bg-rose-500/5";
    case "cyan":
      return "border-cyan-500/30 bg-cyan-500/5";
    case "violet":
      return "border-violet-500/30 bg-violet-500/5";
    case "amber":
      return "border-amber-500/30 bg-amber-500/5";
    default:
      return "border-slate-700 bg-slate-900";
  }
}

function RevenueChart({ days }) {
  const max = Math.max(...days.map((d) => d.revenue), 0);
  const total = days.reduce((acc, d) => acc + d.revenue, 0);

  return (
    <div className="rounded-xl border border-slate-700 bg-slate-900 p-5">
      <div className="mb-4 flex items-baseline justify-between">
        <div>
          <h3 className="text-sm font-semibold text-slate-100">Ventas últimos 7 días</h3>
          <p className="text-xs text-slate-500">Total: {currency(total)}</p>
        </div>
      </div>
      <div className="flex h-44 items-end gap-2">
        {days.map((d) => {
          const heightPct = max > 0 ? Math.max((d.revenue / max) * 100, d.revenue > 0 ? 4 : 0) : 0;
          return (
            <div key={d.key} className="flex flex-1 flex-col items-center justify-end gap-2">
              <span className="text-[10px] font-medium text-slate-400 tabular-nums">
                {d.revenue > 0 ? currency(d.revenue) : ""}
              </span>
              <div
                className="w-full rounded-t-md bg-gradient-to-t from-emerald-500/60 to-emerald-400 transition-all"
                style={{ height: `${heightPct}%`, minHeight: d.revenue > 0 ? "6px" : "0" }}
                title={`${d.label}: ${currency(d.revenue)} (${d.count} pedidos)`}
              />
              <span className="text-[10px] uppercase text-slate-500">{d.label}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function TopItemsChart({ items }) {
  if (!items.length) {
    return (
      <div className="rounded-xl border border-slate-700 bg-slate-900 p-5">
        <h3 className="text-sm font-semibold text-slate-100">Productos más vendidos</h3>
        <p className="mt-3 text-sm text-slate-400">
          Aún no hay ventas suficientes en la ventana para calcular el ranking.
        </p>
      </div>
    );
  }
  const max = Math.max(...items.map((it) => it.count));

  return (
    <div className="rounded-xl border border-slate-700 bg-slate-900 p-5">
      <h3 className="mb-1 text-sm font-semibold text-slate-100">Productos más vendidos</h3>
      <p className="mb-4 text-xs text-slate-500">
        Top {items.length} de los últimos {STATS_WINDOW_DAYS} días (excluye cancelados).
      </p>
      <ul className="space-y-3">
        {items.map((item) => {
          const pct = (item.count / max) * 100;
          return (
            <li key={item.name}>
              <div className="mb-1 flex items-center justify-between text-xs text-slate-300">
                <span className="truncate pr-2">{item.name}</span>
                <span className="tabular-nums text-slate-400">{item.count}</span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-slate-800">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-emerald-400"
                  style={{ width: `${pct}%` }}
                />
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function PaymentMethodsTable({ methods }) {
  const rows = [
    { key: "mp", label: "Mercado Pago", data: methods.mp },
    { key: "cash", label: "Efectivo", data: methods.cash },
    { key: "other", label: "Otros / sin método", data: methods.other }
  ];
  const totalCount = rows.reduce((acc, r) => acc + r.data.count, 0);
  const totalRevenue = rows.reduce((acc, r) => acc + r.data.revenue, 0);

  return (
    <div className="rounded-xl border border-slate-700 bg-slate-900 p-5">
      <h3 className="mb-1 text-sm font-semibold text-slate-100">Cobros por método de pago</h3>
      <p className="mb-4 text-xs text-slate-500">
        Pedidos cobrados en los últimos {STATS_WINDOW_DAYS} días.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-800 text-left text-xs uppercase tracking-wider text-slate-500">
              <th className="py-2 pr-3 font-medium">Método</th>
              <th className="py-2 pr-3 font-medium tabular-nums">Pedidos</th>
              <th className="py-2 pr-3 font-medium tabular-nums">Recaudado</th>
              <th className="py-2 font-medium tabular-nums">Participación</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const pct = totalRevenue > 0 ? (row.data.revenue / totalRevenue) * 100 : 0;
              return (
                <tr key={row.key} className="border-b border-slate-800/60 last:border-0">
                  <td className="py-2 pr-3 text-slate-200">{row.label}</td>
                  <td className="py-2 pr-3 text-slate-300 tabular-nums">{row.data.count}</td>
                  <td className="py-2 pr-3 text-slate-300 tabular-nums">{currency(row.data.revenue)}</td>
                  <td className="py-2 text-slate-400 tabular-nums">{pct.toFixed(1)}%</td>
                </tr>
              );
            })}
            <tr className="text-sm font-semibold text-slate-200">
              <td className="pt-2 pr-3">Total</td>
              <td className="pt-2 pr-3 tabular-nums">{totalCount}</td>
              <td className="pt-2 pr-3 tabular-nums">{currency(totalRevenue)}</td>
              <td className="pt-2 tabular-nums">100%</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
