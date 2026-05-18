/** Ventana fija para la tabla de métodos de pago (no configurable por el admin). */
export const STATS_PAYMENT_WINDOW_DAYS = 30;

export const STATS_DEFAULT_SALES_DAYS = 7;
export const STATS_DEFAULT_TOP_PRODUCTS_DAYS = 30;
export const STATS_DEFAULT_TOP_PRODUCTS_LIMIT = 5;

/** Atajos de período en los paneles de configuración de estadísticas. */
export const STATS_QUICK_DAY_PRESETS = [7, 15, 30];

export const STATS_RANGE_MODES = ["last_days", "date_range"];

const MIN_SALES_DAYS = 1;
const MAX_SALES_DAYS = 90;
const MIN_TOP_DAYS = 1;
const MAX_TOP_DAYS = 365;
const MIN_TOP_LIMIT = 1;
const MAX_TOP_LIMIT = 25;

function clampInt(value, min, max, fallback) {
  const n = parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function parseDateKey(raw) {
  const s = String(raw ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m, d] = s.split("-").map(Number);
  const date = new Date(y, m - 1, d, 12, 0, 0, 0);
  return Number.isNaN(date.getTime()) ? null : date;
}

function toDateKey(date) {
  const y = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${y}-${month}-${day}`;
}

function parseRangeMode(raw) {
  return raw === "date_range" ? "date_range" : "last_days";
}

function defaultSalesDateRange() {
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - (STATS_DEFAULT_SALES_DAYS - 1));
  return { from: toDateKey(from), to: toDateKey(to) };
}

function defaultTopDateRange() {
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - (STATS_DEFAULT_TOP_PRODUCTS_DAYS - 1));
  return { from: toDateKey(from), to: toDateKey(to) };
}

/** Normaliza desde/hasta; limita span en días. Devuelve null si faltan fechas válidas. */
export function normalizeDateRange(fromRaw, toRaw, maxSpanDays) {
  let from = parseDateKey(fromRaw);
  let to = parseDateKey(toRaw);
  if (!from || !to) return null;
  if (from.getTime() > to.getTime()) {
    const swap = from;
    from = to;
    to = swap;
  }
  const maxEnd = new Date(from);
  maxEnd.setDate(maxEnd.getDate() + maxSpanDays - 1);
  if (to.getTime() > maxEnd.getTime()) to = maxEnd;
  return { from: toDateKey(from), to: toDateKey(to) };
}

export function dayKeysBetween(fromKey, toKey) {
  const from = parseDateKey(fromKey);
  const to = parseDateKey(toKey);
  if (!from || !to) return [];
  const keys = [];
  const cur = new Date(from);
  const end = to.getTime();
  while (cur.getTime() <= end) {
    keys.push(toDateKey(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return keys;
}

function labelForDayKey(key) {
  const d = parseDateKey(key);
  if (!d) return key;
  return d.toLocaleDateString("es-AR", { weekday: "short", day: "2-digit" });
}

function isoDateLabel(key) {
  const [y, m, d] = key.split("-");
  return `${d}/${m}/${y}`;
}

const LOCKED_DEFAULTS = {
  metricsConfigurable: false,
  salesMode: "last_days",
  salesDays: STATS_DEFAULT_SALES_DAYS,
  salesDateFrom: defaultSalesDateRange().from,
  salesDateTo: defaultSalesDateRange().to,
  topProductsMode: "last_days",
  topProductsDays: STATS_DEFAULT_TOP_PRODUCTS_DAYS,
  topProductsDateFrom: defaultTopDateRange().from,
  topProductsDateTo: defaultTopDateRange().to,
  topProductsLimit: STATS_DEFAULT_TOP_PRODUCTS_LIMIT
};

/** Valores guardados en `restaurants.metadata` (sin aplicar bloqueo maestro). */
export function parseStatsMetadata(metadata) {
  const m = metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata : {};
  const salesFallback = defaultSalesDateRange();
  const topFallback = defaultTopDateRange();
  return {
    metricsConfigurable: m.stats_metrics_configurable !== false,
    salesMode: parseRangeMode(m.stats_sales_mode),
    salesDays: clampInt(m.stats_sales_days, MIN_SALES_DAYS, MAX_SALES_DAYS, STATS_DEFAULT_SALES_DAYS),
    salesDateFrom:
      typeof m.stats_sales_from === "string" && m.stats_sales_from.trim()
        ? m.stats_sales_from.trim()
        : salesFallback.from,
    salesDateTo:
      typeof m.stats_sales_to === "string" && m.stats_sales_to.trim()
        ? m.stats_sales_to.trim()
        : salesFallback.to,
    topProductsMode: parseRangeMode(m.stats_top_products_mode),
    topProductsDays: clampInt(
      m.stats_top_products_days,
      MIN_TOP_DAYS,
      MAX_TOP_DAYS,
      STATS_DEFAULT_TOP_PRODUCTS_DAYS
    ),
    topProductsDateFrom:
      typeof m.stats_top_products_from === "string" && m.stats_top_products_from.trim()
        ? m.stats_top_products_from.trim()
        : topFallback.from,
    topProductsDateTo:
      typeof m.stats_top_products_to === "string" && m.stats_top_products_to.trim()
        ? m.stats_top_products_to.trim()
        : topFallback.to,
    topProductsLimit: clampInt(
      m.stats_top_products_limit,
      MIN_TOP_LIMIT,
      MAX_TOP_LIMIT,
      STATS_DEFAULT_TOP_PRODUCTS_LIMIT
    )
  };
}

/** Config efectiva mostrada en el panel de estadísticas. */
export function resolveStatsConfig(metadata) {
  const stored = parseStatsMetadata(metadata);
  if (!stored.metricsConfigurable) {
    return { ...LOCKED_DEFAULTS };
  }
  return stored;
}

export function resolveSalesWindow(config) {
  if (config.salesMode === "date_range") {
    const range = normalizeDateRange(config.salesDateFrom, config.salesDateTo, MAX_SALES_DAYS);
    if (range) {
      const keys = dayKeysBetween(range.from, range.to);
      return {
        mode: "date_range",
        from: range.from,
        to: range.to,
        dayCount: keys.length,
        dayKeys: keys,
        chartDays: keys.map((key) => ({ key, label: labelForDayKey(key), revenue: 0, count: 0 })),
        matches: (createdAt) => orderOnDayKeys(createdAt, keys)
      };
    }
  }
  const days = clampInt(config.salesDays, MIN_SALES_DAYS, MAX_SALES_DAYS, STATS_DEFAULT_SALES_DAYS);
  const chartDays = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = toDateKey(d);
    chartDays.push({ key, label: labelForDayKey(key), revenue: 0, count: 0 });
  }
  const keySet = new Set(chartDays.map((d) => d.key));
  return {
    mode: "last_days",
    days,
    dayCount: days,
    dayKeys: chartDays.map((d) => d.key),
    chartDays,
    matches: (createdAt) => {
      if (!createdAt) return false;
      const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
      if (new Date(createdAt).getTime() < cutoff) return false;
      return keySet.has(toDateKey(new Date(createdAt)));
    }
  };
}

export function resolveTopProductsWindow(config) {
  if (config.topProductsMode === "date_range") {
    const range = normalizeDateRange(
      config.topProductsDateFrom,
      config.topProductsDateTo,
      MAX_TOP_DAYS
    );
    if (range) {
      const keys = dayKeysBetween(range.from, range.to);
      return {
        mode: "date_range",
        from: range.from,
        to: range.to,
        dayCount: keys.length,
        matches: (createdAt) => orderOnDayKeys(createdAt, keys)
      };
    }
  }
  const days = clampInt(
    config.topProductsDays,
    MIN_TOP_DAYS,
    MAX_TOP_DAYS,
    STATS_DEFAULT_TOP_PRODUCTS_DAYS
  );
  return {
    mode: "last_days",
    days,
    dayCount: days,
    matches: (createdAt) => {
      if (!createdAt) return false;
      const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
      return new Date(createdAt).getTime() >= cutoff;
    }
  };
}

function orderOnDayKeys(createdAt, keys) {
  if (!createdAt || !keys.length) return false;
  const key = toDateKey(new Date(createdAt));
  return keys.includes(key);
}

function spanDaysFromRange(fromKey, toKey) {
  const keys = dayKeysBetween(fromKey, toKey);
  return keys.length || 1;
}

export function statsFetchWindowDays(config) {
  const salesSpan =
    config.salesMode === "date_range"
      ? spanDaysFromRange(config.salesDateFrom, config.salesDateTo)
      : config.salesDays;
  const topSpan =
    config.topProductsMode === "date_range"
      ? spanDaysFromRange(config.topProductsDateFrom, config.topProductsDateTo)
      : config.topProductsDays;
  return Math.max(salesSpan, topSpan, STATS_PAYMENT_WINDOW_DAYS);
}

export function salesChartTitle(config) {
  if (config.salesMode === "date_range") {
    const range = normalizeDateRange(config.salesDateFrom, config.salesDateTo, MAX_SALES_DAYS);
    if (range) {
      return `Ventas del ${isoDateLabel(range.from)} al ${isoDateLabel(range.to)}`;
    }
  }
  return `Ventas últimos ${config.salesDays} días`;
}

export function topProductsChartSubtitle(config) {
  const limit = config.topProductsLimit;
  if (config.topProductsMode === "date_range") {
    const range = normalizeDateRange(
      config.topProductsDateFrom,
      config.topProductsDateTo,
      MAX_TOP_DAYS
    );
    if (range) {
      return `Top ${limit} del ${isoDateLabel(range.from)} al ${isoDateLabel(range.to)} (excluye cancelados).`;
    }
  }
  return `Top ${limit} de los últimos ${config.topProductsDays} días (excluye cancelados).`;
}

export function buildStatsMetadataPatch(metadata, patch) {
  const base = metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata : {};
  return { ...base, ...patch };
}

/** Convierte borrador del panel a claves de metadata. Devuelve null si el rango de fechas es inválido. */
export function statsDraftToMetadata(draft) {
  const patch = {};
  const hasSales =
    draft.salesMode !== undefined ||
    draft.salesDays !== undefined ||
    draft.salesDateFrom !== undefined ||
    draft.salesDateTo !== undefined;
  const hasTop =
    draft.topProductsMode !== undefined ||
    draft.topProductsDays !== undefined ||
    draft.topProductsDateFrom !== undefined ||
    draft.topProductsDateTo !== undefined ||
    draft.topProductsLimit !== undefined;

  if (hasSales) {
    const mode = parseRangeMode(draft.salesMode);
    patch.stats_sales_mode = mode;
    if (mode === "last_days") {
      if (draft.salesDays !== undefined) {
        patch.stats_sales_days = clampInt(
          draft.salesDays,
          MIN_SALES_DAYS,
          MAX_SALES_DAYS,
          STATS_DEFAULT_SALES_DAYS
        );
      }
    } else {
      const range = normalizeDateRange(
        draft.salesDateFrom ?? "",
        draft.salesDateTo ?? "",
        MAX_SALES_DAYS
      );
      if (!range) return null;
      patch.stats_sales_from = range.from;
      patch.stats_sales_to = range.to;
    }
  }

  if (hasTop) {
    const mode = parseRangeMode(draft.topProductsMode);
    patch.stats_top_products_mode = mode;
    if (mode === "last_days") {
      if (draft.topProductsDays !== undefined) {
        patch.stats_top_products_days = clampInt(
          draft.topProductsDays,
          MIN_TOP_DAYS,
          MAX_TOP_DAYS,
          STATS_DEFAULT_TOP_PRODUCTS_DAYS
        );
      }
    } else {
      const range = normalizeDateRange(
        draft.topProductsDateFrom ?? "",
        draft.topProductsDateTo ?? "",
        MAX_TOP_DAYS
      );
      if (!range) return null;
      patch.stats_top_products_from = range.from;
      patch.stats_top_products_to = range.to;
    }
    if (draft.topProductsLimit !== undefined) {
      patch.stats_top_products_limit = clampInt(
        draft.topProductsLimit,
        MIN_TOP_LIMIT,
        MAX_TOP_LIMIT,
        STATS_DEFAULT_TOP_PRODUCTS_LIMIT
      );
    }
  }

  return patch;
}

export function escapeCsvCell(value) {
  const s = String(value ?? "");
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function downloadCsv(filename, headers, rows) {
  const lines = [
    headers.map(escapeCsvCell).join(","),
    ...rows.map((row) => row.map(escapeCsvCell).join(","))
  ];
  const blob = new Blob(["\uFEFF" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export const STATS_LIMITS = {
  salesDays: { min: MIN_SALES_DAYS, max: MAX_SALES_DAYS },
  topProductsDays: { min: MIN_TOP_DAYS, max: MAX_TOP_DAYS },
  topProductsLimit: { min: MIN_TOP_LIMIT, max: MAX_TOP_LIMIT }
};
