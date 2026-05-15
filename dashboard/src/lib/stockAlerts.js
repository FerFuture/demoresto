const EPSILON = 0.0001;

export const DEFAULT_STOCK_LOW_THRESHOLDS_BY_UNIT = {
  KG: 10,
  G: 1000,
  L: 10,
  ML: 1000,
  UNIDAD: 30,
  PAQUETE: 10
};

export function normalizeStockUnit(value) {
  const text = String(value ?? "")
    .trim()
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  if (!text) return "UNIDAD";
  if (["KG", "KILO", "KILOGRAMO", "KILOGRAMOS"].includes(text)) return "KG";
  if (["G", "GR", "GRAMO", "GRAMOS"].includes(text)) return "G";
  if (["L", "LT", "LITRO", "LITROS"].includes(text)) return "L";
  if (["ML", "MILILITRO", "MILILITROS"].includes(text)) return "ML";
  if (["UNIDAD", "UNIDADES", "U"].includes(text)) return "UNIDAD";
  if (["PAQUETE", "PAQUETES", "PACK"].includes(text)) return "PAQUETE";
  return ["KG", "G", "L", "ML", "UNIDAD", "PAQUETE"].includes(text) ? text : "UNIDAD";
}

function normalizeDecimalInput(value) {
  const raw = String(value ?? "").replace(",", ".");
  let out = "";
  let seenDot = false;
  for (const char of raw) {
    if (/\d/.test(char)) {
      out += char;
      continue;
    }
    if (char === "." && !seenDot) {
      out += char;
      seenDot = true;
    }
  }
  return out;
}

export function parseQuantityValueByUnit(value, unit, fallback = 0) {
  const normalized = normalizeDecimalInput(value);
  if (!normalized || normalized === ".") return fallback;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  const rounded = Math.round(parsed * 1000) / 1000;
  if (normalizeStockUnit(unit) === "UNIDAD") {
    return Math.max(0, Math.floor(rounded + EPSILON));
  }
  return rounded;
}

export function formatQuantity(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "0";
  if (Math.abs(numeric - Math.round(numeric)) < EPSILON) return String(Math.round(numeric));
  return numeric.toFixed(3).replace(/\.?0+$/, "");
}

export function defaultThresholdForUnit(unit) {
  const u = normalizeStockUnit(unit);
  const t = DEFAULT_STOCK_LOW_THRESHOLDS_BY_UNIT[u];
  return t != null ? t : null;
}

/** Umbral efectivo: personalizado en `low_stock_threshold` o default por unidad. */
export function getEffectiveLowStockThreshold(item) {
  const unit = normalizeStockUnit(item?.unit);
  const raw = item?.low_stock_threshold;
  if (raw != null && raw !== "" && Number.isFinite(Number(raw))) {
    return parseQuantityValueByUnit(raw, unit, 0);
  }
  return defaultThresholdForUnit(unit);
}

export function isStockItemLow(item) {
  const threshold = getEffectiveLowStockThreshold(item);
  if (threshold == null) return false;
  const unit = normalizeStockUnit(item?.unit);
  const current = parseQuantityValueByUnit(item?.current_stock, unit, 0);
  return current <= threshold + EPSILON;
}

export function countLowStockItems(items) {
  return (items || []).filter(isStockItemLow).length;
}

export function formatStockThresholdLabel(item) {
  const unit = normalizeStockUnit(item?.unit);
  const t = getEffectiveLowStockThreshold(item);
  if (t == null) return "";
  if (unit === "KG") return `≤ ${formatQuantity(t)} kg`;
  if (unit === "G") return `≤ ${formatQuantity(t)} g`;
  if (unit === "L") return `≤ ${formatQuantity(t)} L`;
  if (unit === "ML") return `≤ ${formatQuantity(t)} ml`;
  if (unit === "UNIDAD") return `≤ ${formatQuantity(t)} unidades`;
  if (unit === "PAQUETE") return `≤ ${formatQuantity(t)} paquetes`;
  return `≤ ${formatQuantity(t)} ${unit}`;
}

/** Vacío → null (usar default por unidad en BD). */
export function parseLowStockThresholdForStorage(value, unit) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return null;
  return parseQuantityValueByUnit(trimmed, unit, 0);
}

export const STOCK_ALERT_DEFAULTS_HINT =
  "Por defecto: KG ≤ 10 · G ≤ 1000 · L ≤ 10 · ML ≤ 1000 · UNIDAD ≤ 30 · PAQUETE ≤ 10.";
