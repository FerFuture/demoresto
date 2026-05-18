import { useEffect, useMemo, useState } from "react";

function useIsNarrowViewport() {
  const [narrow, setNarrow] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(max-width: 639px)").matches
  );
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 639px)");
    const onChange = () => setNarrow(mq.matches);
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return narrow;
}
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
import {
  STATS_LIMITS,
  STATS_PAYMENT_WINDOW_DAYS,
  STATS_QUICK_DAY_PRESETS,
  downloadCsv,
  resolveSalesWindow,
  resolveTopProductsWindow,
  salesChartTitle,
  statsFetchWindowDays,
  topProductsChartSubtitle
} from "../lib/statsConfig";

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

function isoDateLabel(key) {
  const [y, m, d] = key.split("-");
  return `${d}/${m}/${y}`;
}

function orderIsRevenue(order) {
  const st = normalizeOrderStatus(order);
  if (st === "cancelled") return false;
  if (st === "delivered") return true;
  return paymentIsApproved(order);
}

function isWithinDays(createdAt, days) {
  if (!createdAt) return false;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  return new Date(createdAt).getTime() >= cutoff;
}

function configToSalesDraft(config) {
  return {
    salesMode: config.salesMode,
    salesDays: config.salesDays,
    salesDateFrom: config.salesDateFrom,
    salesDateTo: config.salesDateTo
  };
}

function configToTopDraft(config) {
  return {
    topProductsMode: config.topProductsMode,
    topProductsDays: config.topProductsDays,
    topProductsDateFrom: config.topProductsDateFrom,
    topProductsDateTo: config.topProductsDateTo,
    topProductsLimit: config.topProductsLimit
  };
}

export default function AdminStats({
  restaurantId,
  statsConfig,
  metricsConfigurable = false,
  onSaveStatsConfig
}) {
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [reloadTick, setReloadTick] = useState(0);
  const [savingSalesConfig, setSavingSalesConfig] = useState(false);
  const [savingTopConfig, setSavingTopConfig] = useState(false);
  const [salesDraft, setSalesDraft] = useState(() => configToSalesDraft(statsConfig));
  const [topDraft, setTopDraft] = useState(() => configToTopDraft(statsConfig));
  const [salesConfigMessage, setSalesConfigMessage] = useState("");
  const [topConfigMessage, setTopConfigMessage] = useState("");

  const fetchDays = statsFetchWindowDays(statsConfig);

  useEffect(() => {
    setSalesDraft(configToSalesDraft(statsConfig));
  }, [
    statsConfig.salesMode,
    statsConfig.salesDays,
    statsConfig.salesDateFrom,
    statsConfig.salesDateTo
  ]);

  useEffect(() => {
    setTopDraft(configToTopDraft(statsConfig));
  }, [
    statsConfig.topProductsMode,
    statsConfig.topProductsDays,
    statsConfig.topProductsDateFrom,
    statsConfig.topProductsDateTo,
    statsConfig.topProductsLimit
  ]);

  useEffect(() => {
    if (!restaurantId) return;
    let active = true;
    setLoading(true);
    setError("");

    const fromIso = new Date(Date.now() - fetchDays * 24 * 60 * 60 * 1000).toISOString();

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
  }, [restaurantId, reloadTick, fetchDays]);

  const stats = useMemo(() => computeStats(orders, statsConfig), [orders, statsConfig]);

  async function applySalesConfig(overrideDraft) {
    if (!metricsConfigurable || typeof onSaveStatsConfig !== "function") return;
    const payload = overrideDraft ?? salesDraft;
    setSavingSalesConfig(true);
    setSalesConfigMessage("");
    const result = await onSaveStatsConfig(payload);
    setSavingSalesConfig(false);
    if (result?.ok) {
      if (overrideDraft) setSalesDraft(configToSalesDraft(payload));
      setSalesConfigMessage("Configuración de ventas guardada.");
      setReloadTick((n) => n + 1);
    } else {
      setSalesConfigMessage("No se pudo guardar. Revisá las fechas.");
    }
  }

  async function applyTopConfig(overrideDraft) {
    if (!metricsConfigurable || typeof onSaveStatsConfig !== "function") return;
    const payload = overrideDraft ?? topDraft;
    setSavingTopConfig(true);
    setTopConfigMessage("");
    const result = await onSaveStatsConfig(payload);
    setSavingTopConfig(false);
    if (result?.ok) {
      if (overrideDraft) setTopDraft(configToTopDraft(payload));
      setTopConfigMessage("Configuración de productos guardada.");
      setReloadTick((n) => n + 1);
    } else {
      setTopConfigMessage("No se pudo guardar. Revisá las fechas.");
    }
  }

  function quickApplySales(days) {
    const clamped = Math.min(
      STATS_LIMITS.salesDays.max,
      Math.max(STATS_LIMITS.salesDays.min, days)
    );
    const next = { ...salesDraft, salesMode: "last_days", salesDays: clamped };
    setSalesDraft(next);
    void applySalesConfig(next);
  }

  function quickApplyTop(days) {
    const clamped = Math.min(
      STATS_LIMITS.topProductsDays.max,
      Math.max(STATS_LIMITS.topProductsDays.min, days)
    );
    const next = { ...topDraft, topProductsMode: "last_days", topProductsDays: clamped };
    setTopDraft(next);
    void applyTopConfig(next);
  }

  const salesTitle = salesChartTitle(statsConfig);
  const topSubtitle = topProductsChartSubtitle(statsConfig);

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
    <div className="w-full min-w-0 max-w-full space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold text-slate-100">Resumen del día</h2>
          <p className="text-xs text-slate-500">
            Datos de hoy y comparativos según la configuración del panel
            {!metricsConfigurable ? " (valores fijados por maestro)." : "."}
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

      <div className="grid w-full min-w-0 max-w-full grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="min-w-0 max-w-full space-y-3">
          {metricsConfigurable ? (
            <MetricRangeConfig
              title="Período de ventas"
              mode={salesDraft.salesMode}
              onModeChange={(salesMode) => setSalesDraft((prev) => ({ ...prev, salesMode }))}
              days={salesDraft.salesDays}
              onDaysChange={(salesDays) => setSalesDraft((prev) => ({ ...prev, salesDays }))}
              dateFrom={salesDraft.salesDateFrom}
              dateTo={salesDraft.salesDateTo}
              onDateFromChange={(salesDateFrom) => setSalesDraft((prev) => ({ ...prev, salesDateFrom }))}
              onDateToChange={(salesDateTo) => setSalesDraft((prev) => ({ ...prev, salesDateTo }))}
              daysLimits={STATS_LIMITS.salesDays}
              saving={savingSalesConfig}
              message={salesConfigMessage}
              onApply={() => void applySalesConfig()}
              onQuickDays={quickApplySales}
            />
          ) : null}
          <RevenueChart
            title={salesTitle}
            days={stats.salesDays}
            showCsvDownload={metricsConfigurable}
            onDownloadCsv={() => downloadSalesCsv(stats.salesDays, salesTitle)}
          />
        </div>
        <div className="min-w-0 max-w-full space-y-3">
          {metricsConfigurable ? (
            <MetricRangeConfig
              title="Período del ranking"
              mode={topDraft.topProductsMode}
              onModeChange={(topProductsMode) => setTopDraft((prev) => ({ ...prev, topProductsMode }))}
              days={topDraft.topProductsDays}
              onDaysChange={(topProductsDays) => setTopDraft((prev) => ({ ...prev, topProductsDays }))}
              dateFrom={topDraft.topProductsDateFrom}
              dateTo={topDraft.topProductsDateTo}
              onDateFromChange={(topProductsDateFrom) =>
                setTopDraft((prev) => ({ ...prev, topProductsDateFrom }))
              }
              onDateToChange={(topProductsDateTo) =>
                setTopDraft((prev) => ({ ...prev, topProductsDateTo }))
              }
              daysLimits={STATS_LIMITS.topProductsDays}
              limit={topDraft.topProductsLimit}
              onLimitChange={(topProductsLimit) =>
                setTopDraft((prev) => ({ ...prev, topProductsLimit }))
              }
              limitLabel="Top productos"
              limitLimits={STATS_LIMITS.topProductsLimit}
              saving={savingTopConfig}
              message={topConfigMessage}
              onApply={() => void applyTopConfig()}
              onQuickDays={quickApplyTop}
            />
          ) : null}
          <TopItemsChart
            items={stats.topItems}
            subtitle={topSubtitle}
            emptyHint={topSubtitle}
            showCsvDownload={metricsConfigurable}
            onDownloadCsv={() => downloadTopProductsCsv(stats.topItems, statsConfig)}
          />
        </div>
      </div>

      <PaymentMethodsTable methods={stats.paymentBreakdown} windowDays={STATS_PAYMENT_WINDOW_DAYS} />
    </div>
  );
}


function downloadSalesCsv(days, titleSlug) {
  const stamp = new Date().toISOString().slice(0, 10);
  const slug = String(titleSlug)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  downloadCsv(
    `ventas-${slug || "periodo"}-${stamp}.csv`,
    ["fecha", "dia", "ingresos", "pedidos"],
    days.map((d) => [d.key, d.label, d.revenue.toFixed(2), String(d.count)])
  );
}

function downloadTopProductsCsv(items, config) {
  const stamp = new Date().toISOString().slice(0, 10);
  const label = topProductsChartSubtitle(config);
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  downloadCsv(
    `productos-${slug || "ranking"}-${stamp}.csv`,
    ["ranking", "producto", "unidades"],
    items.map((item, index) => [String(index + 1), item.name, String(item.count)])
  );
}

function computeStats(orders, config) {
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

  const salesWindow = resolveSalesWindow(config);
  const salesDays = salesWindow.chartDays.map((entry) => ({ ...entry }));
  const salesIndex = new Map(salesDays.map((entry) => [entry.key, entry]));
  for (const order of orders) {
    if (!salesWindow.matches(order.created_at)) continue;
    const k = dayKey(order.created_at);
    const entry = salesIndex.get(k);
    if (!entry) continue;
    if (normalizeOrderStatus(order) === "cancelled") continue;
    entry.count += 1;
    if (orderIsRevenue(order)) entry.revenue += effectiveOrderTotal(order);
  }

  const topWindow = resolveTopProductsWindow(config);
  const itemCounts = new Map();
  for (const order of orders) {
    if (!topWindow.matches(order.created_at)) continue;
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
    .slice(0, config.topProductsLimit);

  const paymentBreakdown = { cash: { count: 0, revenue: 0 }, mp: { count: 0, revenue: 0 }, other: { count: 0, revenue: 0 } };
  for (const order of orders) {
    if (!isWithinDays(order.created_at, STATS_PAYMENT_WINDOW_DAYS)) continue;
    if (!orderIsRevenue(order)) continue;
    const key = paymentMethodKey(order);
    const bucket = paymentBreakdown[key] ?? paymentBreakdown.other;
    bucket.count += 1;
    bucket.revenue += effectiveOrderTotal(order);
  }

  return { today, salesDays, topItems, paymentBreakdown };
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
    <div className="grid min-w-0 grid-cols-2 gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
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

function MetricRangeConfig({
  title,
  mode,
  onModeChange,
  days,
  onDaysChange,
  dateFrom,
  dateTo,
  onDateFromChange,
  onDateToChange,
  daysLimits,
  limit,
  onLimitChange,
  limitLabel,
  limitLimits,
  saving,
  message,
  onApply,
  onQuickDays
}) {
  const inputClass =
    "block h-9 rounded-lg border border-slate-700 bg-slate-950 px-2 text-sm text-slate-100";
  const applyBtnClass =
    "rounded-lg bg-emerald-600 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-50";
  const quickBtnClass =
    "rounded-md bg-emerald-600 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-emerald-500 disabled:opacity-50";
  const quickPresets = STATS_QUICK_DAY_PRESETS.filter(
    (n) => n >= daysLimits.min && n <= daysLimits.max
  );

  return (
    <div className="min-w-0 max-w-full overflow-hidden rounded-xl border border-slate-700 bg-slate-900 p-3 sm:p-4">
      <p className="mb-3 text-xs font-medium uppercase tracking-wider text-slate-500">{title}</p>
      <div className="space-y-3">
        {onQuickDays && quickPresets.length > 0 ? (
          <div>
            <p className="mb-2 text-xs text-slate-500">Acceso rápido</p>
            <div className="flex flex-wrap gap-1.5">
              {quickPresets.map((preset) => {
                const active = mode === "last_days" && days === preset;
                return (
                  <button
                    key={preset}
                    type="button"
                    disabled={saving}
                    onClick={() => onQuickDays(preset)}
                    className={[
                      quickBtnClass,
                      active ? "ring-1 ring-emerald-300/80 ring-offset-1 ring-offset-slate-900" : ""
                    ].join(" ")}
                  >
                    {preset} días
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}
        <div className="flex flex-wrap gap-4 text-xs text-slate-300">
          <label className="inline-flex cursor-pointer items-center gap-2">
            <input
              type="radio"
              name={`${title}-mode`}
              checked={mode === "last_days"}
              onChange={() => onModeChange("last_days")}
              className="accent-emerald-500"
            />
            Últimos X días
          </label>
          <label className="inline-flex cursor-pointer items-center gap-2">
            <input
              type="radio"
              name={`${title}-mode`}
              checked={mode === "date_range"}
              onChange={() => onModeChange("date_range")}
              className="accent-emerald-500"
            />
            Desde / hasta
          </label>
        </div>

        {mode === "last_days" ? (
          <label className="block space-y-1 text-xs text-slate-400">
            <span>Cantidad de días</span>
            <input
              type="number"
              min={daysLimits.min}
              max={daysLimits.max}
              value={days}
              onChange={(e) => onDaysChange(Number(e.target.value))}
              className={`${inputClass} w-24`}
            />
          </label>
        ) : (
          <div className="flex flex-wrap items-end gap-3">
            <label className="space-y-1 text-xs text-slate-400">
              <span>Desde</span>
              <input
                type="date"
                value={dateFrom}
                onChange={(e) => onDateFromChange(e.target.value)}
                className={inputClass}
              />
            </label>
            <label className="space-y-1 text-xs text-slate-400">
              <span>Hasta</span>
              <input
                type="date"
                value={dateTo}
                onChange={(e) => onDateToChange(e.target.value)}
                className={inputClass}
              />
            </label>
          </div>
        )}

        {limit !== undefined && onLimitChange && limitLimits ? (
          <label className="block space-y-1 text-xs text-slate-400">
            <span>{limitLabel || "Cantidad"}</span>
            <input
              type="number"
              min={limitLimits.min}
              max={limitLimits.max}
              value={limit}
              onChange={(e) => onLimitChange(Number(e.target.value))}
              className={`${inputClass} w-24`}
            />
          </label>
        ) : null}

        <div className="flex flex-wrap items-center gap-3">
          <button type="button" disabled={saving} onClick={onApply} className={applyBtnClass}>
            {saving ? "Guardando…" : "Aplicar"}
          </button>
          {message ? <p className="text-xs text-emerald-400">{message}</p> : null}
        </div>
      </div>
    </div>
  );
}

function CsvDownloadButton({ onClick, label = "Descargar CSV" }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-lg border border-slate-600 bg-slate-800 px-2.5 py-1 text-[11px] font-medium text-slate-200 hover:bg-slate-700"
    >
      {label}
    </button>
  );
}

const REVENUE_CHART_SCROLL_THRESHOLD = 19;
const REVENUE_BAR_WIDTH_PX = 44;

function RevenueChart({ days, title, showCsvDownload = false, onDownloadCsv }) {
  const isNarrow = useIsNarrowViewport();
  const max = Math.max(...days.map((d) => d.revenue), 0);
  const total = days.reduce((acc, d) => acc + d.revenue, 0);
  const scrollThreshold = isNarrow ? 6 : REVENUE_CHART_SCROLL_THRESHOLD;
  const scrollable = days.length > scrollThreshold;

  return (
    <div className="min-w-0 max-w-full overflow-hidden rounded-xl border border-slate-700 bg-slate-900 p-3 sm:p-5">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1 pr-1">
          <h3 className="text-sm font-semibold leading-snug text-slate-100 break-words">{title}</h3>
          <p className="text-xs text-slate-500">Total: {currency(total)}</p>
        </div>
        {showCsvDownload ? <CsvDownloadButton onClick={onDownloadCsv} /> : null}
      </div>
      <div
        className={[
          "w-full min-w-0 max-w-full overflow-x-auto overflow-y-hidden",
          "[scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden"
        ].join(" ")}
      >
        <div
          className={[
            "flex h-40 items-end gap-1.5 sm:h-44",
            scrollable ? "w-max" : "w-full min-w-0"
          ].join(" ")}
        >
          {days.map((d) => {
            const heightPct = max > 0 ? Math.max((d.revenue / max) * 100, d.revenue > 0 ? 4 : 0) : 0;
            return (
              <div
                key={d.key}
                className={[
                  "flex flex-col items-center justify-end gap-1.5",
                  scrollable ? "w-11 shrink-0" : "min-w-0 flex-1"
                ].join(" ")}
              >
                <span
                  className={[
                    "max-w-full truncate text-center font-medium text-slate-400 tabular-nums",
                    scrollable ? "text-[9px] leading-tight" : "text-[10px]"
                  ].join(" ")}
                  title={d.revenue > 0 ? currency(d.revenue) : undefined}
                >
                  {d.revenue > 0 ? currency(d.revenue) : ""}
                </span>
                <div className="flex h-28 w-full flex-col justify-end">
                  <div
                    className="w-full rounded-t-md bg-gradient-to-t from-emerald-500/60 to-emerald-400 transition-all"
                    style={{ height: `${heightPct}%`, minHeight: d.revenue > 0 ? "6px" : "0" }}
                    title={`${isoDateLabel(d.key)} (${d.label}): ${currency(d.revenue)} (${d.count} pedidos)`}
                  />
                </div>
                <span
                  className={[
                    "max-w-full truncate text-center uppercase text-slate-500",
                    scrollable ? "text-[9px]" : "text-[10px]"
                  ].join(" ")}
                  title={d.label}
                >
                  {d.label}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function TopItemsChart({ items, subtitle, emptyHint, showCsvDownload = false, onDownloadCsv }) {
  if (!items.length) {
    return (
      <div className="min-w-0 max-w-full overflow-hidden rounded-xl border border-slate-700 bg-slate-900 p-3 sm:p-5">
        <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
          <h3 className="text-sm font-semibold text-slate-100">Productos más vendidos</h3>
          {showCsvDownload ? <CsvDownloadButton onClick={onDownloadCsv} /> : null}
        </div>
        <p className="text-sm text-slate-400">
          Aún no hay ventas suficientes en el período ({emptyHint}) para calcular el ranking.
        </p>
      </div>
    );
  }
  const max = Math.max(...items.map((it) => it.count));

  return (
    <div className="min-w-0 max-w-full overflow-hidden rounded-xl border border-slate-700 bg-slate-900 p-3 sm:p-5">
      <div className="mb-1 flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1 pr-1">
          <h3 className="text-sm font-semibold text-slate-100">Productos más vendidos</h3>
          <p className="break-words text-xs text-slate-500">{subtitle}</p>
        </div>
        {showCsvDownload ? <CsvDownloadButton onClick={onDownloadCsv} /> : null}
      </div>
      <ul className="mt-3 space-y-3">
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

function PaymentMethodsTable({ methods, windowDays }) {
  const rows = [
    { key: "mp", label: "Mercado Pago", data: methods.mp },
    { key: "cash", label: "Efectivo", data: methods.cash },
    { key: "other", label: "Otros / sin método", data: methods.other }
  ];
  const totalCount = rows.reduce((acc, r) => acc + r.data.count, 0);
  const totalRevenue = rows.reduce((acc, r) => acc + r.data.revenue, 0);

  return (
    <div className="min-w-0 max-w-full overflow-hidden rounded-xl border border-slate-700 bg-slate-900 p-3 sm:p-5">
      <h3 className="mb-1 text-sm font-semibold text-slate-100">Cobros por método de pago</h3>
      <p className="mb-4 text-xs text-slate-500">
        Pedidos cobrados en los últimos {windowDays} días.
      </p>
      <div className="w-full min-w-0 max-w-full overflow-x-auto">
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
