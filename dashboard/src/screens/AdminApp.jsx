import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "../supabaseClient";
import {
  ORDER_STATUS_COLORS,
  callableCustomerPhone,
  currency,
  formatOrderStatusLabelEs,
  formatPaymentStatusLabelEs,
  formatPhoneLabel,
  fulfillmentIsDelivery,
  fulfillmentIsPickup,
  adminDashboardNotesBlock,
  isDeliveryOrder,
  isWaiterDeliveryOrder,
  normalizeOrderStatus,
  notesIndicateDelivery,
  orderNeedsDeliveryFeeControls,
  adminShowNotifyDeliveriesReadyButton,
  adminShowClienteNroRow,
  orderFromWaiterPanelNotes,
  orderInKitchenQueue,
  orderKitchenReady,
  paymentIsApproved,
  paymentMethodKey,
  playNotification,
  subtotalForOrder,
  formatDateTime as formatPaidAt,
  tableNumberLabel
} from "../lib/format";
import AdminStats from "./AdminStats";
import DashboardUsersPanel from "./DashboardUsersPanel";
import MaestroPanel from "./MaestroPanel";
import MesaQrLinksPanel from "../components/MesaQrLinksPanel";
import StockManagerPanel from "../components/StockManagerPanel";
import QrMenuPanel from "../components/QrMenuPanel";
import OrdersDateRangeCalendar from "../components/OrdersDateRangeCalendar";
import { fetchRestaurantForDashboard } from "../lib/restaurantTenant";
import { isValidPublicDashboardBaseUrl, normalizePublicDashboardBaseUrlInput } from "../lib/publicDashboardUrl";
import { countLowStockItems } from "../lib/stockAlerts";
import { getSession } from "../lib/auth";
import { WEEKDAY_OPTIONS } from "../lib/deliverySchedule";

const CANCEL_REVERT_WINDOW_MS = 30 * 60 * 1000;
const BUSINESS_HOUR_WEEKDAY_OPTIONS = WEEKDAY_OPTIONS.map(({ value, label }) => ({
  value: value === 0 ? 7 : value,
  label
}));
const ALL_BUSINESS_HOUR_DAY_VALUES = BUSINESS_HOUR_WEEKDAY_OPTIONS.map(({ value }) => value);
const BUSINESS_DAY_NAMES = ["Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado", "Domingo"];
const BUSINESS_DAY_ALIASES = {
  lunes: 1,
  lun: 1,
  martes: 2,
  mar: 2,
  miercoles: 3,
  mie: 3,
  mier: 3,
  jueves: 4,
  jue: 4,
  viernes: 5,
  vie: 5,
  sabado: 6,
  sab: 6,
  domingo: 7,
  dom: 7
};
const BUSINESS_DAY_ALIAS_KEYS = Object.keys(BUSINESS_DAY_ALIASES).sort((a, b) => b.length - a.length);
const BUSINESS_DAY_ALIAS_REGEX = new RegExp(`\\b(${BUSINESS_DAY_ALIAS_KEYS.join("|")})s?\\b`, "g");
const BUSINESS_DAY_RANGE_REGEX = new RegExp(
  `\\b(${BUSINESS_DAY_ALIAS_KEYS.join("|")})s?\\b\\s*(?:a|al|hasta|-)\\s*\\b(${BUSINESS_DAY_ALIAS_KEYS.join("|")})s?\\b`,
  "g"
);

function normalizeMenuCategoryInput(value) {
  const text = String(value ?? "");
  return text.toLocaleUpperCase("es-AR");
}

function normalizeMenuCategoryForStorage(value) {
  const text = normalizeMenuCategoryInput(value).trim();
  return text || null;
}

function stripDiacritics(value) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function normalizeBusinessHoursText(value) {
  return stripDiacritics(value).toLowerCase().replace(/[|]/g, " ").replace(/\s+/g, " ").trim();
}

function normalizeBusinessOpenDays(days) {
  return [...new Set((Array.isArray(days) ? days : []).map(Number))]
    .filter((day) => day >= 1 && day <= 7)
    .sort((a, b) => a - b);
}

function formatBusinessHourInput(rawValue) {
  const digits = String(rawValue || "")
    .replace(/\D/g, "")
    .slice(0, 4);
  if (!digits) return "";
  if (digits.length <= 2) return digits;
  return `${digits.slice(0, 2)}:${digits.slice(2)}`;
}

function normalizeBusinessHourValue(rawValue) {
  const digits = String(rawValue || "")
    .replace(/\D/g, "")
    .slice(0, 4);
  if (!digits) return "";
  if (digits.length === 3) return `0${digits.slice(0, 1)}:${digits.slice(1)}`;
  if (digits.length === 4) return `${digits.slice(0, 2)}:${digits.slice(2)}`;
  return digits;
}

function isValidBusinessHourValue(value) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value || ""));
}

function dayNumberFromBusinessAlias(raw) {
  const key = String(raw || "").toLowerCase().trim();
  return BUSINESS_DAY_ALIASES[key] || null;
}

function addBusinessDayRange(targetSet, fromDay, toDay) {
  if (!fromDay || !toDay) return;
  if (fromDay <= toDay) {
    for (let day = fromDay; day <= toDay; day += 1) targetSet.add(day);
    return;
  }
  for (let day = fromDay; day <= 7; day += 1) targetSet.add(day);
  for (let day = 1; day <= toDay; day += 1) targetSet.add(day);
}

function parseBusinessOpenDaysFromText(rawText) {
  const text = normalizeBusinessHoursText(rawText);
  if (!text) return null;
  if (/\btodos?\s+los?\s+dias\b/.test(text)) return [...ALL_BUSINESS_HOUR_DAY_VALUES];

  const openSet = new Set();
  BUSINESS_DAY_RANGE_REGEX.lastIndex = 0;
  let rangeMatch = BUSINESS_DAY_RANGE_REGEX.exec(text);
  while (rangeMatch) {
    addBusinessDayRange(
      openSet,
      dayNumberFromBusinessAlias(rangeMatch[1]),
      dayNumberFromBusinessAlias(rangeMatch[2])
    );
    rangeMatch = BUSINESS_DAY_RANGE_REGEX.exec(text);
  }

  BUSINESS_DAY_ALIAS_REGEX.lastIndex = 0;
  let singleMatch = BUSINESS_DAY_ALIAS_REGEX.exec(text);
  while (singleMatch) {
    const dayNum = dayNumberFromBusinessAlias(singleMatch[1]);
    if (dayNum) openSet.add(dayNum);
    singleMatch = BUSINESS_DAY_ALIAS_REGEX.exec(text);
  }

  const closedSet = new Set();
  for (const dayAlias of BUSINESS_DAY_ALIAS_KEYS) {
    const reA = new RegExp(`\\b${dayAlias}s?\\b[^.\\n\\r]{0,24}\\bcerrad`, "i");
    const reB = new RegExp(`\\bcerrad[^.\\n\\r]{0,24}\\b${dayAlias}s?\\b`, "i");
    if (reA.test(text) || reB.test(text)) {
      const dayNum = dayNumberFromBusinessAlias(dayAlias);
      if (dayNum) closedSet.add(dayNum);
    }
  }
  for (const dayNum of closedSet) openSet.delete(dayNum);

  const out = [...openSet].sort((a, b) => a - b);
  return out.length ? out : null;
}

function parseBusinessHoursFromOpeningHoursText(rawText) {
  const text = normalizeBusinessHoursText(rawText);
  if (!text) return null;

  const timeMatches = [...text.matchAll(/\b([01]?\d|2[0-3])[:.]([0-5]\d)\b/g)];
  if (timeMatches.length < 2) return null;
  const openTime = `${String(timeMatches[0][1]).padStart(2, "0")}:${timeMatches[0][2]}`;
  const closeTime = `${String(timeMatches[1][1]).padStart(2, "0")}:${timeMatches[1][2]}`;
  const openDays = parseBusinessOpenDaysFromText(text) || [...ALL_BUSINESS_HOUR_DAY_VALUES];

  return { openDays, openTime, closeTime };
}

function parseBusinessHoursFromMetadata(metadata) {
  const raw = metadata?.business_hours;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const openDays = normalizeBusinessOpenDays(raw.open_days);
  const openTime = normalizeBusinessHourValue(raw.open_time || "");
  const closeTime = normalizeBusinessHourValue(raw.close_time || "");
  if (!openDays.length || !isValidBusinessHourValue(openTime) || !isValidBusinessHourValue(closeTime)) {
    return null;
  }
  return { openDays, openTime, closeTime };
}

function formatBusinessDays(days) {
  const normalized = normalizeBusinessOpenDays(days);
  if (!normalized.length) return "";
  if (normalized.length === 7) return "Todos los días";
  let run = [normalized[0]];
  const ranges = [];
  for (let i = 1; i < normalized.length; i += 1) {
    if (normalized[i] === run[run.length - 1] + 1) run.push(normalized[i]);
    else {
      ranges.push(run);
      run = [normalized[i]];
    }
  }
  ranges.push(run);
  return ranges
    .map((range) =>
      range.length === 1
        ? BUSINESS_DAY_NAMES[range[0] - 1]
        : `${BUSINESS_DAY_NAMES[range[0] - 1]} a ${BUSINESS_DAY_NAMES[range[range.length - 1] - 1]}`
    )
    .join(", ");
}

function buildOpeningHoursText(openDays, openTime, closeTime) {
  const normalizedDays = normalizeBusinessOpenDays(openDays);
  if (
    !normalizedDays.length ||
    !isValidBusinessHourValue(openTime) ||
    !isValidBusinessHourValue(closeTime)
  ) {
    return "";
  }
  return `${formatBusinessDays(normalizedDays)} de ${openTime} a ${closeTime}.`;
}

function resolveBusinessHoursFormState(openingHours, metadata) {
  const fromMetadata = parseBusinessHoursFromMetadata(metadata);
  if (fromMetadata) return fromMetadata;
  const fromText = parseBusinessHoursFromOpeningHoursText(openingHours);
  if (fromText) return fromText;
  return {
    openDays: [...ALL_BUSINESS_HOUR_DAY_VALUES],
    openTime: "",
    closeTime: ""
  };
}

function WeekdayToggle({ value, onChange, disabled }) {
  function toggle(day) {
    const set = new Set(normalizeBusinessOpenDays(value));
    if (set.has(day)) set.delete(day);
    else set.add(day);
    onChange([...set].sort((a, b) => a - b));
  }

  return (
    <div className="flex flex-wrap gap-1.5">
      {BUSINESS_HOUR_WEEKDAY_OPTIONS.map(({ value: dayValue, label }) => {
        const on = value.includes(dayValue);
        return (
          <button
            key={dayValue}
            type="button"
            disabled={disabled}
            onClick={() => toggle(dayValue)}
            className={`rounded-lg border px-2 py-1 text-[11px] font-medium transition disabled:opacity-50 ${
              on
                ? "border-emerald-500/60 bg-emerald-500/20 text-emerald-200"
                : "border-slate-700 bg-slate-950 text-slate-500 hover:border-slate-600"
            }`}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

function canRevertCancellation(order) {
  if (normalizeOrderStatus(order) !== "cancelled") return false;
  const at = order.cancelled_at;
  if (!at) return true;
  return Date.now() - new Date(at).getTime() <= CANCEL_REVERT_WINDOW_MS;
}

function shouldShowDeliveryRepartoSection(order) {
  if (!isDeliveryOrder(order)) return false;
  if (normalizeOrderStatus(order) === "cancelled" && !order.delivery_claimed_by_user_id) {
    return false;
  }
  return true;
}

function isLocalPickupOrder(order) {
  return String(order?.fulfillment_type ?? "").trim().toLowerCase() === "local";
}

/**
 * Coincide con la etiqueta "Pedido en mesa" del panel: cliente en salón o carga mozo.
 * No tiene sentido avisar "listo para retiro" porque ya están en el local atendidos.
 */
function isPedidoEnMesaSalon(order) {
  const ft = String(order?.fulfillment_type ?? "").trim().toLowerCase();
  return (
    ft === "mesa" ||
    (orderFromWaiterPanelNotes(order) && ft !== "delivery" && ft !== "delivery_mozo")
  );
}

/** Solo retiro pasando a buscar (modalidad distinta de pedido en mesa). */
function isRetiroLocalCustomerPickup(order) {
  if (isPedidoEnMesaSalon(order)) return false;
  return isLocalPickupOrder(order);
}

function orderCanBeMarkedDeliveredInAdmin(order) {
  return isRetiroLocalCustomerPickup(order) || isWaiterDeliveryOrder(order);
}

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
  const session = getSession();
  const isMaestro = session?.role === "maestro";
  const isEncargado = session?.role === "encargado";
  /** Admin completo o Maestro; no encargado (solo pedidos + menú). */
  const canAccessFullAdminPanel = !isEncargado;

  const [activeTab, setActiveTab] = useState(() =>
    getSession()?.role === "maestro" ? "maestro" : "orders"
  );

  useEffect(() => {
    if (activeTab === "maestro" && !isMaestro) setActiveTab("orders");
  }, [activeTab, isMaestro]);

  useEffect(() => {
    if (!isEncargado) return;
    const hidden = new Set(["settings", "users", "stats", "qrmenu", "mesaqr", "stock", "maestro"]);
    if (hidden.has(activeTab)) setActiveTab("orders");
  }, [isEncargado, activeTab]);
  const [orders, setOrders] = useState([]);
  const [deliveryUserLabels, setDeliveryUserLabels] = useState({});
  const ORDERS_PAGE_SIZE = 30;
  const [ordersPage, setOrdersPage] = useState(0);
  const [ordersTotal, setOrdersTotal] = useState(0);
  const [ordersHasMore, setOrdersHasMore] = useState(false);
  const [loadingMoreOrders, setLoadingMoreOrders] = useState(false);
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
  const [menuSearchQuery, setMenuSearchQuery] = useState("");
  const [addingItem, setAddingItem] = useState(false);
  const [newItem, setNewItem] = useState({
    name: "",
    description: "",
    category: "",
    price: ""
  });
  const [error, setError] = useState("");
  const [feeDraftByOrder, setFeeDraftByOrder] = useState({});
  const [denyExpandedOrderId, setDenyExpandedOrderId] = useState(null);
  const [denyReasonByOrder, setDenyReasonByOrder] = useState({});
  const [editingItemId, setEditingItemId] = useState(null);
  const [editDraft, setEditDraft] = useState({
    name: "",
    description: "",
    category: "",
    price: ""
  });
  const [restaurantConfig, setRestaurantConfig] = useState({
    name: "",
    public_name: "",
    address: "",
    delivery_zones: "",
    /** Cantidad de mesas numeradas (1..N) para pedidos “en mesa” por WhatsApp. */
    table_count: "12",
    opening_hours: "",
    opening_days: [...ALL_BUSINESS_HOUR_DAY_VALUES],
    opening_time_from: "",
    opening_time_to: "",
    policies: ""
  });
  /** false = bot solo retiro; ocultar UI de delivery en admin. Por defecto true si la columna aún no existe. */
  const [deliveryEnabled, setDeliveryEnabled] = useState(true);
  const [localEnabled, setLocalEnabled] = useState(true);
  const [mesaEnabled, setMesaEnabled] = useState(true);
  const [mesaQrEnabled, setMesaQrEnabled] = useState(true);
  const [qrMenuEnabled, setQrMenuEnabled] = useState(true);
  const [waiterFulfillmentSelectorEnabled, setWaiterFulfillmentSelectorEnabled] = useState(false);
  const [botRuntimeSwitchesVisible, setBotRuntimeSwitchesVisible] = useState(false);
  /** Master OFF en metadata → bot en silencio total (sin respuesta ni registro). */
  const [botWhatsappEnabled, setBotWhatsappEnabled] = useState(true);
  /** Si es false en metadata y el bot está ON → no bloquear fuera de horario. */
  const [botEnforceOpeningHours, setBotEnforceOpeningHours] = useState(true);
  const [restaurantMetadata, setRestaurantMetadata] = useState({});
  const [cashEnabled, setCashEnabled] = useState(true);
  const [mercadoPagoEnabled, setMercadoPagoEnabled] = useState(true);
  const [statsEnabled, setStatsEnabled] = useState(true);
  const [stockPanelEnabled, setStockPanelEnabled] = useState(true);
  const [lowStockAlertCount, setLowStockAlertCount] = useState(0);
  const [loadingConfig, setLoadingConfig] = useState(false);
  const [savingConfig, setSavingConfig] = useState(false);
  const [configFlash, setConfigFlash] = useState("");
  const [confirmDialog, setConfirmDialog] = useState(null);
  const confirmResolverRef = useRef(null);
  const ordersCalendarDayRef = useRef(localDateKey());

  useEffect(() => {
    if (activeTab === "stats" && !statsEnabled) setActiveTab("orders");
  }, [activeTab, statsEnabled]);

  useEffect(() => {
    if (activeTab === "qrmenu" && !qrMenuEnabled) setActiveTab("orders");
  }, [activeTab, qrMenuEnabled]);

  useEffect(() => {
    if (activeTab === "mesaqr" && !mesaQrEnabled) setActiveTab("orders");
  }, [activeTab, mesaQrEnabled]);

  useEffect(() => {
    if (activeTab === "stock" && !stockPanelEnabled) setActiveTab("orders");
  }, [activeTab, stockPanelEnabled]);

  useEffect(() => {
    if (!restaurantId || !stockPanelEnabled) {
      setLowStockAlertCount(0);
      return undefined;
    }
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from("stock_items")
        .select("id, name, current_stock, unit, low_stock_threshold")
        .eq("restaurant_id", restaurantId);
      if (cancelled) return;
      if (error) {
        setLowStockAlertCount(0);
        return;
      }
      setLowStockAlertCount(countLowStockItems(data || []));
    })();
    return () => {
      cancelled = true;
    };
  }, [restaurantId, stockPanelEnabled]);

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

  /** Lista menú A→Z por nombre (tras alta/edición local también queda ordenada). */
  const menuItemsAlphabetical = useMemo(
    () =>
      [...menuItems].sort((a, b) =>
        String(a.name || "").localeCompare(String(b.name || ""), "es", {
          sensitivity: "base",
          numeric: true
        })
      ),
    [menuItems]
  );

  const menuItemsFiltered = useMemo(() => {
    const raw = String(menuSearchQuery || "").trim().toLowerCase();
    if (!raw) return menuItemsAlphabetical;
    const words = raw.split(/\s+/).filter(Boolean);
    return menuItemsAlphabetical.filter((item) => {
      const hay = [
        item.name,
        item.category,
        item.description,
        item.price != null ? String(item.price) : ""
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }, [menuItemsAlphabetical, menuSearchQuery]);

  const deliveryIssueCount = useMemo(
    () =>
      sortedOrders.filter((o) => Boolean(o.delivery_issue_reason) && !o.delivery_issue_acknowledged_at)
        .length,
    [sortedOrders]
  );

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
          String(order.notes || ""),
          order.table_number != null && order.table_number !== ""
            ? String(order.table_number)
            : ""
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
      .order("name", { ascending: true });

    if (queryError) {
      setError(`Error cargando menu: ${queryError.message}`);
      setLoadingMenu(false);
      return;
    }

    setMenuItems(
      (data || []).map((item) => ({
        ...item,
        category: normalizeMenuCategoryForStorage(item.category)
      }))
    );
    setLoadingMenu(false);
  }

  async function loadRestaurantConfig(forRestaurantId) {
    const rid = forRestaurantId || restaurantId;
    if (!rid) return;
    setLoadingConfig(true);
    const { data, error: queryError } = await supabase
      .from("restaurants")
      .select(
        "name, public_name, address, delivery_zones, delivery_enabled, local_enabled, mesa_enabled, cash_enabled, mercadopago_enabled, stats_enabled, table_count, opening_hours, policies, metadata"
      )
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
    const metadataObj =
      data.metadata && typeof data.metadata === "object" && !Array.isArray(data.metadata)
        ? data.metadata
        : {};
    const businessHoursState = resolveBusinessHoursFormState(data.opening_hours || "", metadataObj);

    setRestaurantConfig({
      name: data.name || "",
      public_name: data.public_name || "",
      address: data.address || "",
      delivery_zones: data.delivery_zones || "",
      table_count:
        data.table_count != null && data.table_count !== ""
          ? String(data.table_count)
          : "12",
      opening_hours: data.opening_hours || "",
      opening_days: businessHoursState.openDays,
      opening_time_from: businessHoursState.openTime,
      opening_time_to: businessHoursState.closeTime,
      policies: policiesAsText
    });

    setDeliveryEnabled(data.delivery_enabled !== false);
    setLocalEnabled(data.local_enabled !== false);
    setMesaEnabled(data.mesa_enabled !== false);
    setRestaurantMetadata(metadataObj);
    setMesaQrEnabled(metadataObj.mesa_qr_enabled !== false);
    setQrMenuEnabled(metadataObj.qr_menu_enabled !== false);
    setWaiterFulfillmentSelectorEnabled(metadataObj.waiter_fulfillment_selector_enabled === true);
    setBotRuntimeSwitchesVisible(metadataObj.bot_runtime_switches_visible === true);
    setBotWhatsappEnabled(metadataObj.bot_whatsapp_enabled !== false);
    setBotEnforceOpeningHours(metadataObj.bot_enforce_opening_hours !== false);
    setCashEnabled(data.cash_enabled !== false);
    setMercadoPagoEnabled(data.mercadopago_enabled !== false);
    setStatsEnabled(data.stats_enabled !== false);
    setStockPanelEnabled(metadataObj.stock_panel_enabled !== false);
    setLoadingConfig(false);
  }

  async function saveRestaurantConfig(event) {
    if (event?.preventDefault) event.preventDefault();
    if (!restaurantId) {
      setError(
        "No hay restaurante seleccionado. Verificá BOT_WHATSAPP_NUMBER o VITE_BOT_WHATSAPP_NUMBER (.env) para que coincida con restaurants.whatsapp_number (solo dígitos o mismo formato), o que exista al menos una fila en restaurants."
      );
      return;
    }
    setError("");
    setConfigFlash("");
    setSavingConfig(true);

    const nameTrimmed = restaurantConfig.name.trim();
    if (!nameTrimmed) {
      setError("El nombre interno es obligatorio (columna name en la base de datos).");
      setSavingConfig(false);
      return;
    }

    const tcRaw = parseInt(String(restaurantConfig.table_count || "").trim(), 10);
    const tableCountDb =
      Number.isFinite(tcRaw) && tcRaw >= 1 && tcRaw <= 500 ? tcRaw : 12;
    const openingDays = normalizeBusinessOpenDays(restaurantConfig.opening_days);
    const openingTimeFrom = normalizeBusinessHourValue(restaurantConfig.opening_time_from);
    const openingTimeTo = normalizeBusinessHourValue(restaurantConfig.opening_time_to);
    const hasBusinessHoursInput =
      openingDays.length !== ALL_BUSINESS_HOUR_DAY_VALUES.length || openingTimeFrom || openingTimeTo;
    const canBuildBusinessHours =
      openingDays.length > 0 &&
      isValidBusinessHourValue(openingTimeFrom) &&
      isValidBusinessHourValue(openingTimeTo);

    if (hasBusinessHoursInput && !canBuildBusinessHours) {
      setError("Completá los días de atención y las horas Desde / Hasta en formato HH:MM.");
      setSavingConfig(false);
      return;
    }

    const openingHoursText = canBuildBusinessHours
      ? buildOpeningHoursText(openingDays, openingTimeFrom, openingTimeTo)
      : restaurantConfig.opening_hours.trim() || null;

    const patch = {
      name: nameTrimmed,
      public_name: restaurantConfig.public_name.trim() || null,
      address: restaurantConfig.address.trim() || null,
      delivery_zones: restaurantConfig.delivery_zones.trim() || null,
      table_count: tableCountDb,
      opening_hours: openingHoursText,
      policies: restaurantConfig.policies.trim() || null
    };

    const metadataBase =
      restaurantMetadata && typeof restaurantMetadata === "object" && !Array.isArray(restaurantMetadata)
        ? restaurantMetadata
        : {};
    const nextMetadata = {
      ...metadataBase,
      bot_runtime_switches_visible: Boolean(botRuntimeSwitchesVisible),
      bot_whatsapp_enabled: Boolean(botWhatsappEnabled),
      bot_enforce_opening_hours: Boolean(botEnforceOpeningHours),
      business_hours: canBuildBusinessHours
        ? {
            open_days: openingDays,
            open_time: openingTimeFrom,
            close_time: openingTimeTo
          }
        : metadataBase.business_hours ?? null
    };

    // `.single()` obliga error cuando UPDATE no devuelve exactamente 1 fila (0 por RLS, UUID mal, etc.).
    const { data, error: updateError } = await supabase
      .from("restaurants")
      .update({ ...patch, metadata: nextMetadata })
      .eq("id", restaurantId)
      .select("name, public_name, address, delivery_zones, table_count, opening_hours, policies")
      .single();

    if (updateError) {
      const msg = updateError.message || "";
      const code = updateError.code || "";
      const combined = `${msg} ${code}`;
      let hint = "";
      if (
        /row-level security|RLS|42501|permission denied|PGRST116|JSON object requested|No rows|0 rows/i.test(
          combined
        )
      ) {
        hint =
          " Ejecutá en Supabase → SQL: dashboard/sql/rls_policies_restobot.sql y dashboard/sql/restaurants_config_columns.sql. Si ya aplicaste RLS, ejecutá dashboard/sql/grants_api_roles_restobot.sql (permisos anon/authenticated).";
      } else if (/42703|column/i.test(combined)) {
        hint = " Falta una columna en restaurants (ej. public_name). Ejecutá dashboard/sql/restaurants_config_columns.sql.";
      } else if (/invalid.*json|jsonb|22P02/i.test(combined)) {
        hint =
          " El campo políticas no coincide con el tipo en la base (text vs jsonb). Ajustá el tipo de restaurants.policies o el contenido.";
      }
      setError(`Error guardando configuración: ${msg}${hint}`);
      setSavingConfig(false);
      return;
    }

    if (!data) {
      setError(
        "No se guardó la configuración (sin fila devuelta). Revisá RLS y permisos: dashboard/sql/rls_policies_restobot.sql y dashboard/sql/grants_api_roles_restobot.sql."
      );
      setSavingConfig(false);
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
      table_count:
        data.table_count != null && data.table_count !== ""
          ? String(data.table_count)
          : "12",
      opening_hours: data.opening_hours || openingHoursText || "",
      opening_days: canBuildBusinessHours ? openingDays : restaurantConfig.opening_days,
      opening_time_from: canBuildBusinessHours ? openingTimeFrom : restaurantConfig.opening_time_from,
      opening_time_to: canBuildBusinessHours ? openingTimeTo : restaurantConfig.opening_time_to,
      policies: policiesAsText
    });
    if (data.name) setRestaurantName(data.name);
    setRestaurantMetadata(nextMetadata);

    setConfigFlash("Configuración guardada. Los cambios se aplican en los próximos mensajes al cliente.");
    setSavingConfig(false);
    setTimeout(() => setConfigFlash(""), 6000);
  }

  async function setQrMenuModuleEnabled(nextEnabled) {
    if (!restaurantId) {
      setError("No hay restaurante cargado.");
      return { ok: false };
    }
    setError("");
    const nextMetadata = {
      ...(restaurantMetadata && typeof restaurantMetadata === "object" ? restaurantMetadata : {}),
      qr_menu_enabled: Boolean(nextEnabled)
    };
    const { error: updateError } = await supabase
      .from("restaurants")
      .update({ metadata: nextMetadata })
      .eq("id", restaurantId);
    if (updateError) {
      setError(`No se pudo guardar módulo QR Menú: ${updateError.message}`);
      return { ok: false, error: updateError };
    }
    setRestaurantMetadata(nextMetadata);
    setQrMenuEnabled(Boolean(nextEnabled));
    return { ok: true };
  }

  async function setMesaQrModuleEnabled(nextEnabled) {
    if (!restaurantId) {
      setError("No hay restaurante cargado.");
      return { ok: false };
    }
    setError("");
    const nextMetadata = {
      ...(restaurantMetadata && typeof restaurantMetadata === "object" ? restaurantMetadata : {}),
      mesa_qr_enabled: Boolean(nextEnabled)
    };
    const { error: updateError } = await supabase
      .from("restaurants")
      .update({ metadata: nextMetadata })
      .eq("id", restaurantId);
    if (updateError) {
      setError(`No se pudo guardar módulo Carta y QR mesas: ${updateError.message}`);
      return { ok: false, error: updateError };
    }
    setRestaurantMetadata(nextMetadata);
    setMesaQrEnabled(Boolean(nextEnabled));
    return { ok: true };
  }

  async function savePublicDashboardBaseUrl(urlRaw) {
    if (!restaurantId) {
      setError("No hay restaurante cargado.");
      return { ok: false };
    }
    const normalized = normalizePublicDashboardBaseUrlInput(urlRaw);
    if (!isValidPublicDashboardBaseUrl(normalized)) {
      setError("URL base inválida. Usá http:// o https:// (sin barra final).");
      return { ok: false };
    }
    setError("");
    const nextMetadata = {
      ...(restaurantMetadata && typeof restaurantMetadata === "object" ? restaurantMetadata : {}),
      public_dashboard_base_url: normalized || null
    };
    const { error: updateError } = await supabase
      .from("restaurants")
      .update({ metadata: nextMetadata })
      .eq("id", restaurantId);
    if (updateError) {
      setError(`No se pudo guardar URL base del panel: ${updateError.message}`);
      return { ok: false, error: updateError };
    }
    setRestaurantMetadata(nextMetadata);
    return { ok: true, value: normalized };
  }

  async function setWaiterFulfillmentSelectorFlag(nextEnabled) {
    if (!restaurantId) {
      setError("No hay restaurante cargado.");
      return { ok: false };
    }
    setError("");
    const nextMetadata = {
      ...(restaurantMetadata && typeof restaurantMetadata === "object" ? restaurantMetadata : {}),
      waiter_fulfillment_selector_enabled: Boolean(nextEnabled)
    };
    const { error: updateError } = await supabase
      .from("restaurants")
      .update({ metadata: nextMetadata })
      .eq("id", restaurantId);
    if (updateError) {
      setError(`No se pudo guardar selector modalidad mozo: ${updateError.message}`);
      return { ok: false, error: updateError };
    }
    setRestaurantMetadata(nextMetadata);
    setWaiterFulfillmentSelectorEnabled(Boolean(nextEnabled));
    return { ok: true };
  }

  async function setBotRuntimeSwitchesVisibleFlag(nextEnabled) {
    if (!restaurantId) {
      setError("No hay restaurante cargado.");
      return { ok: false };
    }
    setError("");
    const nextMetadata = {
      ...(restaurantMetadata && typeof restaurantMetadata === "object" ? restaurantMetadata : {}),
      bot_runtime_switches_visible: Boolean(nextEnabled)
    };
    const { error: updateError } = await supabase
      .from("restaurants")
      .update({ metadata: nextMetadata })
      .eq("id", restaurantId);
    if (updateError) {
      setError(`No se pudo guardar visibilidad de controles Bot/Horario: ${updateError.message}`);
      return { ok: false, error: updateError };
    }
    setRestaurantMetadata(nextMetadata);
    setBotRuntimeSwitchesVisible(Boolean(nextEnabled));
    return { ok: true };
  }

  async function setStockPanelEnabledFlag(nextEnabled) {
    if (!restaurantId) {
      setError("No hay restaurante cargado.");
      return { ok: false };
    }
    setError("");
    const nextMetadata = {
      ...(restaurantMetadata && typeof restaurantMetadata === "object" ? restaurantMetadata : {}),
      stock_panel_enabled: Boolean(nextEnabled)
    };
    const { error: updateError } = await supabase
      .from("restaurants")
      .update({ metadata: nextMetadata })
      .eq("id", restaurantId);
    if (updateError) {
      setError(`No se pudo guardar Gestor de stock: ${updateError.message}`);
      return { ok: false, error: updateError };
    }
    setRestaurantMetadata(nextMetadata);
    setStockPanelEnabled(Boolean(nextEnabled));
    return { ok: true };
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

  async function confirmCashPayment(order) {
    if (paymentMethodKey(order) !== "cash") {
      setError("Solo los pedidos en efectivo se confirman manualmente desde este panel.");
      return;
    }
    if (normalizeOrderStatus(order) === "cancelled") {
      setError("No se puede confirmar el pago de un pedido cancelado.");
      return;
    }
    setError("");
    setSavingOrderId(order.id);
    const paidAtIso = new Date().toISOString();
    const patch = {
      payment_status: "paid",
      payment_paid_at: paidAtIso
    };
    if (normalizeOrderStatus(order) !== "delivered") {
      patch.status = "confirmed";
    }
    const { data: updatedRow, error: updateError } = await supabase
      .from("orders")
      .update(patch)
      .eq("id", order.id)
      .neq("status", "cancelled")
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

  async function requestPickupReadyNotify(order) {
    const st = normalizeOrderStatus(order);
    if (st === "cancelled" || st === "delivered") {
      setError("No se puede avisar retiro en pedidos cerrados.");
      return;
    }
    if (!isRetiroLocalCustomerPickup(order)) {
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

  async function markDelivered(order) {
    if (isPedidoEnMesaSalon(order)) {
      setError("La acción entregar no aplica a pedidos en mesa.");
      return;
    }
    if (!orderCanBeMarkedDeliveredInAdmin(order)) {
      setError("La entrega manual solo aplica a retiro local o delivery mozo.");
      return;
    }
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

  async function revertClosedOrder(order, fromStatus) {
    const st = normalizeOrderStatus(order);
    if (st !== fromStatus) {
      setError("El pedido ya no está en ese estado. Recargá la lista.");
      return;
    }
    if (fromStatus === "cancelled" && !canRevertCancellation(order)) {
      setError(
        "Solo podés revertir la cancelación dentro de los primeros 30 minutos desde que se canceló."
      );
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

  async function notifyDeliveriesOrderReady(order) {
    if (!adminShowNotifyDeliveriesReadyButton(order)) {
      setError(
        "Solo podés avisar cuando el cliente confirmó el total (efectivo) o el pago ya está aprobado, y el costo de envío está cargado."
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
      const { data, error: restaurantError } = await fetchRestaurantForDashboard(supabase);
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
                setHiddenUpdatesCount((c) => c + 1);
                return prev.filter((row) => row.id !== payload.new.id);
              }
              return prev.map((row) => (row.id === payload.new.id ? payload.new : row));
            }
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restaurantId, orderFilters, ordersTodayOnly]);

  useEffect(() => {
    if (ordersTodayOnly) {
      ordersCalendarDayRef.current = localDateKey();
    }
  }, [ordersTodayOnly]);

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
    const nextValues =
      Object.prototype.hasOwnProperty.call(values, "category")
        ? { ...values, category: normalizeMenuCategoryForStorage(values.category) }
        : values;
    const { error: updateError } = await supabase.from("menu_items").update(nextValues).eq("id", itemId);
    if (updateError) {
      setError(`Error guardando item: ${updateError.message}`);
      setSavingItemId(null);
      return false;
    }

    setMenuItems((prev) => prev.map((item) => (item.id === itemId ? { ...item, ...nextValues } : item)));
    setSavingItemId(null);
    return true;
  }

  function openEditMenuItem(item) {
    setError("");
    setEditingItemId(item.id);
    setEditDraft({
      name: item.name || "",
      description: item.description || "",
      category: normalizeMenuCategoryInput(item.category || ""),
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
      category: normalizeMenuCategoryForStorage(editDraft.category),
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
      category: normalizeMenuCategoryForStorage(newItem.category),
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

    setMenuItems((prev) => [
      ...prev,
      { ...data, category: normalizeMenuCategoryForStorage(data.category) }
    ]);
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
            <h1 className="text-2xl font-bold">Mesafood</h1>
            <p className="text-sm text-slate-400">
              {isEncargado
                ? "Encargado · pedidos y carta (sin configuración ni usuarios)"
                : "Gestion de pedidos y menu en tiempo real"}
            </p>
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
          {canAccessFullAdminPanel && qrMenuEnabled ? (
            <button
              type="button"
              onClick={() => setActiveTab("qrmenu")}
              className={`rounded-lg px-4 py-2 text-sm font-medium transition ${
                activeTab === "qrmenu"
                  ? "bg-emerald-500 text-slate-950"
                  : "border border-slate-700 bg-slate-900 text-slate-300 hover:bg-slate-800"
              }`}
            >
              QR Menú
            </button>
          ) : null}
          {canAccessFullAdminPanel && mesaQrEnabled ? (
            <button
              type="button"
              onClick={() => setActiveTab("mesaqr")}
              className={`rounded-lg px-4 py-2 text-sm font-medium transition ${
                activeTab === "mesaqr"
                  ? "bg-emerald-500 text-slate-950"
                  : "border border-slate-700 bg-slate-900 text-slate-300 hover:bg-slate-800"
              }`}
            >
              Carta y QR Mesas
            </button>
          ) : null}
          {canAccessFullAdminPanel && stockPanelEnabled ? (
            <button
              type="button"
              onClick={() => setActiveTab("stock")}
              className={`inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition ${
                activeTab === "stock"
                  ? "bg-emerald-500 text-slate-950"
                  : "border border-slate-700 bg-slate-900 text-slate-300 hover:bg-slate-800"
              }`}
            >
              {lowStockAlertCount > 0 ? (
                <span
                  className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-rose-500 text-white"
                  title={`${lowStockAlertCount} ingrediente(s) con stock bajo`}
                  aria-hidden
                >
                  <svg viewBox="0 0 24 24" className="h-3 w-3" fill="currentColor" aria-hidden>
                    <path d="M12 2L1 21h22L12 2zm0 6.5a1 1 0 011 1v5a1 1 0 11-2 0v-5a1 1 0 011-1zm0 9a1.25 1.25 0 100 2.5 1.25 1.25 0 000-2.5z" />
                  </svg>
                </span>
              ) : null}
              Gestor de stock
            </button>
          ) : null}
          {canAccessFullAdminPanel && statsEnabled ? (
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
          ) : null}
          {canAccessFullAdminPanel ? (
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
          ) : null}
          {canAccessFullAdminPanel ? (
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
          ) : null}
          {isMaestro ? (
            <button
              type="button"
              onClick={() => setActiveTab("maestro")}
              className={`rounded-lg px-4 py-2 text-sm font-medium transition ${
                activeTab === "maestro"
                  ? "bg-violet-500 text-slate-950"
                  : "border border-violet-700/60 bg-violet-950/50 text-violet-100 hover:bg-violet-900/60"
              }`}
            >
              Maestro
            </button>
          ) : null}
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
              deliveryEnabled={deliveryEnabled}
            />

            {hiddenUpdatesCount > 0 ? (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-cyan-500/30 bg-cyan-500/10 px-3 py-2 text-xs text-cyan-200">
                <span>
                  Hay cambios o pedidos nuevos que no coinciden con el filtro actual. Podés recargar la lista.
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

            {deliveryEnabled && deliveryIssueCount > 0 ? (
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
                  {deliveryEnabled && deliveryIssueAlertOpen ? (
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
                    <div className="flex flex-wrap items-center gap-2">
                      {tableNumberLabel(order) ? (
                        <span className="rounded-full bg-violet-500/25 px-2.5 py-1 text-xs font-semibold text-violet-200">
                          Mesa {tableNumberLabel(order)}
                        </span>
                      ) : null}
                      {orderKitchenReady(order) ? (
                        <span className="rounded-full border border-emerald-500/40 bg-emerald-500/15 px-2.5 py-1 text-xs font-medium text-emerald-200">
                          Listo cocina
                          {formatPaidAt(order.kitchen_ready_at)
                            ? ` · ${formatPaidAt(order.kitchen_ready_at)}`
                            : ""}
                        </span>
                      ) : orderInKitchenQueue(order) ? (
                        <span className="rounded-full border border-amber-500/35 bg-amber-500/10 px-2.5 py-1 text-xs font-medium text-amber-200">
                          En cocina
                        </span>
                      ) : null}
                      <span
                        className={`rounded-full px-3 py-1 text-xs font-medium ${
                          ORDER_STATUS_COLORS[normalizeOrderStatus(order) || "pending"] ||
                          "bg-slate-700 text-slate-200"
                        }`}
                      >
                        {formatOrderStatusLabelEs(order)}
                      </span>
                    </div>
                  </div>
                  <div className="grid gap-2 text-sm text-slate-300 md:grid-cols-2">
                    <div>
                      <p>
                        <span className="text-slate-500">Cliente:</span>{" "}
                        <span className="break-all text-slate-200">{order.customer_number || "—"}</span>
                      </p>
                      {adminShowClienteNroRow(order) ? (
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
                      ) : null}
                    </div>
                    <p>
                      <span className="text-slate-500">Metodo pago:</span> {order.payment_method || "-"}
                    </p>
                    <p>
                      <span className="text-slate-500">Modalidad:</span>{" "}
                      {isWaiterDeliveryOrder(order)
                        ? "Delivery mozo"
                        : fulfillmentIsDelivery(order)
                        ? "Delivery"
                        : orderFromWaiterPanelNotes(order) || order.fulfillment_type === "mesa"
                        ? "Pedido en mesa"
                        : order.fulfillment_type === "local"
                          ? "Retiro local"
                          : order.fulfillment_type || (order.address ? "delivery" : "-")}
                    </p>
                    <p>
                      <span className="text-slate-500">Estado pago:</span>{" "}
                      {formatPaymentStatusLabelEs(order.payment_status)}
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
                    {order.scheduled_delivery_at ? (
                      <p>
                        <span className="text-slate-500">Horario delivery:</span>{" "}
                        {formatPaidAt(order.scheduled_delivery_at) || "-"}
                      </p>
                    ) : null}
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
                      {adminDashboardNotesBlock(order) || "-"}
                    </p>
                    {deliveryEnabled && shouldShowDeliveryRepartoSection(order) ? (
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
                            Cliente avisado (en camino) ·{" "}
                            {formatPaidAt(order.delivery_en_route_customer_notified_at)}
                          </p>
                        ) : null}
                      </div>
                    ) : null}
                    {deliveryEnabled && order.delivery_denial_reason ? (
                      <p className="md:col-span-2 text-sm text-amber-100/90">
                        <span className="text-slate-500">Motivo cancelación delivery:</span>{" "}
                        {order.delivery_denial_reason}
                      </p>
                    ) : null}
                    {deliveryEnabled && order.delivery_issue_reason && order.delivery_issue_acknowledged_at ? (
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

                    {deliveryEnabled && orderNeedsDeliveryFeeControls(order) ? (
                      <div className="md:col-span-2 space-y-3 rounded-lg border border-orange-500/35 bg-orange-950/20 p-4">
                        <p className="text-sm font-semibold text-orange-200">Esperando costo de envío</p>
                        <p className="text-xs text-slate-400">
                          Si no llegamos a esa zona, usá &quot;Negar delivery&quot; y el motivo.
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
                              Motivo (se comunica al cliente)
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

                    {deliveryEnabled && order.status === "delivery_denied" && !order.customer_notified_at ? (
                      <div className="md:col-span-2 rounded-lg border border-amber-500/35 bg-amber-950/20 p-3 text-xs text-amber-100">
                        Se está avisando al cliente sobre la cancelación del delivery.
                      </div>
                    ) : null}

                    {deliveryEnabled && order.status === "delivery_denial_notify_failed" ? (
                      <div className="md:col-span-2 flex flex-wrap items-center gap-2 rounded-lg border border-rose-500/40 bg-rose-950/25 p-3">
                        <p className="text-xs text-rose-100">
                          No se pudo enviar el aviso de cancelación al cliente. Reintentá o contactá soporte si sigue
                          fallando.
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

                    {deliveryEnabled && order.status === "delivery_fee_set" && !order.customer_notified_at ? (
                      <div className="md:col-span-2 rounded-lg border border-cyan-500/30 bg-cyan-950/20 p-3 text-xs text-cyan-100">
                        Costo confirmado. El total se envía al cliente.
                      </div>
                    ) : null}

                    {deliveryEnabled && order.status === "awaiting_delivery_total_confirm" ? (
                      <div className="md:col-span-2 rounded-lg border border-indigo-500/35 bg-indigo-950/25 p-3 text-xs text-indigo-100">
                        <span className="font-semibold text-indigo-50">Efectivo + delivery:</span> el cliente ya
                        recibió el ticket con el total. Estamos esperando que responda{" "}
                        <span className="font-medium">SÍ</span> o <span className="font-medium">NO</span> por el canal
                        de mensajes. Si acepta, el pedido pasa a pendiente y verás en notas:{" "}
                        <span className="italic">&quot;Cliente confirmó el total con envío&quot;</span>. Si rechaza,
                        el pedido se cancela solo.
                      </div>
                    ) : null}

                    {order.status === "notify_failed" ? (
                      <div className="md:col-span-2 flex flex-wrap items-center gap-2 rounded-lg border border-rose-500/40 bg-rose-950/25 p-3">
                        <p className="text-xs text-rose-100">
                          No se pudo enviar el mensaje al cliente. Reintentá o contactá soporte si sigue fallando.
                        </p>
                        <button
                          type="button"
                          disabled={savingOrderId === order.id}
                          onClick={() => retryNotifyCustomer(order.id)}
                          className="rounded-lg bg-rose-500 px-3 py-1.5 text-xs font-semibold text-slate-950"
                        >
                          Reintentar aviso
                        </button>
                      </div>
                    ) : null}

                    {(() => {
                      const method = paymentMethodKey(order);
                      const approved = paymentIsApproved(order);
                      const paidAtLabel = formatPaidAt(order.payment_paid_at);
                      const status = normalizeOrderStatus(order);
                      const isClosed = status === "delivered" || status === "cancelled";
                      const canConfirmCash = method === "cash" && !approved && status !== "cancelled";
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

                          {canConfirmCash && status !== "delivered" ? (
                            <button
                              type="button"
                              disabled={savingOrderId === order.id}
                              onClick={() => confirmCashPayment(order)}
                              className="rounded-lg border border-blue-500/40 bg-blue-500/10 px-3 py-1 text-xs text-blue-300"
                            >
                              Confirmar pago efectivo
                            </button>
                          ) : null}

                          {status === "delivered" ? (
                            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-200">
                              <span>
                                <span className="font-semibold">Pedido entregado</span>
                                {deliveredAtLabel ? ` · ${deliveredAtLabel}` : ""}
                                {deliveryEnabled && isDeliveryOrder(order) && order.delivery_claimed_by_user_id ? (
                                  <span className="mt-0.5 block text-[11px] text-emerald-100/85">
                                    Repartidor:{" "}
                                    <span className="font-medium text-emerald-50">
                                      {deliveryUserLabels[order.delivery_claimed_by_user_id] ||
                                        order.delivery_claimed_by_user_id}
                                    </span>
                                  </span>
                                ) : null}
                              </span>
                              <div className="flex flex-wrap gap-2">
                                {canConfirmCash ? (
                                  <button
                                    type="button"
                                    disabled={savingOrderId === order.id}
                                    onClick={() => confirmCashPayment(order)}
                                    className="rounded-md border border-blue-400/50 bg-blue-500/15 px-2 py-0.5 text-[11px] font-medium text-blue-200 hover:bg-blue-500/25 disabled:opacity-50"
                                  >
                                    Confirmar pago efectivo
                                  </button>
                                ) : null}
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
                            </div>
                          ) : status === "cancelled" ? (
                            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
                              <span>
                                <span className="font-semibold">Pedido cancelado</span>
                                {cancelledAtLabel ? ` · ${cancelledAtLabel}` : ""}
                                {deliveryEnabled && isDeliveryOrder(order) && order.delivery_claimed_by_user_id ? (
                                  <span className="mt-0.5 block text-[11px] text-rose-100/85">
                                    Había tomado el pedido:{" "}
                                    <span className="font-medium text-rose-50">
                                      {deliveryUserLabels[order.delivery_claimed_by_user_id] ||
                                        order.delivery_claimed_by_user_id}
                                    </span>
                                  </span>
                                ) : null}
                              </span>
                              {canRevertCancellation(order) ? (
                                <button
                                  type="button"
                                  disabled={savingOrderId === order.id}
                                  onClick={() => revertClosedOrder(order, "cancelled")}
                                  className="rounded-md border border-amber-400/50 bg-amber-500/15 px-2 py-0.5 text-[11px] font-medium text-amber-200 hover:bg-amber-500/25 disabled:opacity-50"
                                  title="Reabrir el pedido"
                                >
                                  Revertir cancelación
                                </button>
                              ) : null}
                            </div>
                          ) : (
                            <div className="flex flex-wrap gap-2">
                              {deliveryEnabled && adminShowNotifyDeliveriesReadyButton(order) ? (
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
                              {deliveryEnabled && isDeliveryOrder(order) && order.delivery_ready_broadcast_at ? (
                                <span className="text-[11px] text-amber-200/90">
                                  Repartidores avisados
                                  {formatPaidAt(order.delivery_ready_broadcast_at)
                                    ? ` · ${formatPaidAt(order.delivery_ready_broadcast_at)}`
                                    : ""}
                                </span>
                              ) : null}
                              {deliveryEnabled && isDeliveryOrder(order) && order.delivery_claimed_by_user_id ? (
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
                              {deliveryEnabled &&
                              isDeliveryOrder(order) &&
                              order.delivery_en_route_customer_notified_at ? (
                                <span className="text-[11px] font-medium text-sky-200/95">
                                  Cliente avisado (repartidor en camino)
                                  {formatPaidAt(order.delivery_en_route_customer_notified_at)
                                    ? ` · ${formatPaidAt(order.delivery_en_route_customer_notified_at)}`
                                    : ""}
                                </span>
                              ) : null}
                              {isRetiroLocalCustomerPickup(order) &&
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
                              {isRetiroLocalCustomerPickup(order) &&
                              order.pickup_ready_notify_requested_at &&
                              !order.pickup_ready_customer_notified_at ? (
                                <span className="text-[11px] text-slate-400">
                                  Enviando aviso al cliente…
                                </span>
                              ) : null}
                              {isRetiroLocalCustomerPickup(order) && order.pickup_ready_customer_notified_at ? (
                                <span className="text-[11px] text-emerald-200/80">
                                  Cliente avisado (retiro)
                                  {formatPaidAt(order.pickup_ready_customer_notified_at)
                                    ? ` · ${formatPaidAt(order.pickup_ready_customer_notified_at)}`
                                    : ""}
                                </span>
                              ) : null}
                              {orderCanBeMarkedDeliveredInAdmin(order) ? (
                                <button
                                  type="button"
                                  disabled={savingOrderId === order.id}
                                  onClick={() => markDelivered(order)}
                                  className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-1 text-xs text-emerald-300"
                                >
                                  Entregado
                                </button>
                              ) : null}
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
            <div className="rounded-xl border border-slate-700 bg-slate-900 p-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <h2 className="text-sm font-semibold text-slate-200">Productos del menu</h2>
                  <p className="text-xs text-slate-400">Administra precios, disponibilidad y alta de productos.</p>
                </div>
                <button
                  type="button"
                  onClick={() => setShowAddForm((prev) => !prev)}
                  className="shrink-0 rounded-lg bg-emerald-500 px-3 py-2 text-sm font-semibold text-slate-950"
                >
                  Añadir Producto
                </button>
              </div>
              <label className="mt-4 block">
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
              {menuItems.length > 0 && menuSearchQuery.trim() ? (
                <p className="mt-2 text-xs text-slate-500">
                  {menuItemsFiltered.length === menuItemsAlphabetical.length
                    ? `${menuItemsAlphabetical.length} productos`
                    : `${menuItemsFiltered.length} de ${menuItemsAlphabetical.length} productos`}
                </p>
              ) : null}
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
                  onChange={(event) =>
                    setNewItem((prev) => ({
                      ...prev,
                      category: normalizeMenuCategoryInput(event.target.value)
                    }))
                  }
                  placeholder="CATEGORIA"
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
            ) : menuItemsFiltered.length === 0 ? (
              <div className="rounded-xl border border-slate-700 bg-slate-900 p-5 text-slate-400">
                No hay productos que coincidan con &quot;{menuSearchQuery.trim()}&quot;. Probá otra palabra o limpiá el buscador.
              </div>
            ) : (
              menuItemsFiltered.map((item) => (
                <article
                  key={item.id}
                  className="rounded-xl border border-slate-700 bg-slate-900 p-5"
                >
                  <div className="flex flex-col gap-4 md:flex-row md:flex-wrap md:items-start md:justify-between">
                    <div className="min-w-0 flex-1">
                      <h3 className="font-semibold text-slate-100">{item.name}</h3>
                      <p className="text-sm text-slate-400">
                        {normalizeMenuCategoryForStorage(item.category) || "Sin categoria"}
                      </p>
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
                          setEditDraft((prev) => ({
                            ...prev,
                            category: normalizeMenuCategoryInput(event.target.value)
                          }))
                        }
                        placeholder="CATEGORIA (ej: COMBOS, PIZZA)"
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
        ) : activeTab === "qrmenu" && qrMenuEnabled ? (
          <QrMenuPanel
            restaurantId={restaurantId}
            restaurantMetadata={restaurantMetadata}
            restaurantName={restaurantConfig.public_name || restaurantConfig.name || restaurantName}
          />
        ) : activeTab === "mesaqr" ? (
          <section className="space-y-4">
            <div className="rounded-xl border border-slate-700 bg-slate-900 p-4">
              <h2 className="text-sm font-semibold text-slate-200">Carta y QR Mesas</h2>
              <p className="text-xs text-slate-400">
                Administrá enlaces y QR por mesa para la carta web. Este módulo es independiente del flujo de chat.
              </p>
            </div>
            <MesaQrLinksPanel
              restaurantId={restaurantId}
              qrModuleEnabled={mesaQrEnabled}
              restaurantMetadata={restaurantMetadata}
              onRestaurantMetadataChange={setRestaurantMetadata}
              tableCount={Math.min(
                500,
                Math.max(1, parseInt(String(restaurantConfig.table_count || "12").trim(), 10) || 12)
              )}
            />
          </section>
        ) : activeTab === "stock" && stockPanelEnabled ? (
          <StockManagerPanel restaurantId={restaurantId} onLowStockCountChange={setLowStockAlertCount} />
        ) : activeTab === "stats" && statsEnabled ? (
          <AdminStats restaurantId={restaurantId} />
        ) : activeTab === "users" ? (
          <DashboardUsersPanel />
        ) : activeTab === "maestro" && isMaestro ? (
          <MaestroPanel
            restaurantId={restaurantId}
            deliveryEnabled={deliveryEnabled}
            localEnabled={localEnabled}
            mesaEnabled={mesaEnabled}
            mesaQrEnabled={mesaQrEnabled}
            qrMenuEnabled={qrMenuEnabled}
            waiterFulfillmentSelectorEnabled={waiterFulfillmentSelectorEnabled}
            botRuntimeSwitchesVisible={botRuntimeSwitchesVisible}
            cashEnabled={cashEnabled}
            mercadoPagoEnabled={mercadoPagoEnabled}
            statsEnabled={statsEnabled}
            stockPanelEnabled={stockPanelEnabled}
            tableCount={Math.min(
              500,
              Math.max(1, parseInt(String(restaurantConfig.table_count || "12").trim(), 10) || 12)
            )}
            loadingRestaurant={loadingConfig}
            onServiceFlagsUpdated={() => loadRestaurantConfig(restaurantId)}
            onTableCountUpdated={() => loadRestaurantConfig(restaurantId)}
            onMesaQrModuleToggle={setMesaQrModuleEnabled}
            onQrMenuPanelToggle={setQrMenuModuleEnabled}
            onWaiterFulfillmentSelectorToggle={setWaiterFulfillmentSelectorFlag}
            onBotRuntimeSwitchesVisibleToggle={setBotRuntimeSwitchesVisibleFlag}
            onStockPanelToggle={setStockPanelEnabledFlag}
            restaurantMetadata={restaurantMetadata}
            onPublicDashboardBaseUrlSave={savePublicDashboardBaseUrl}
          />
        ) : (
          <section className="space-y-4">
            <div className="rounded-xl border border-slate-700 bg-slate-900 p-5">
              <h2 className="text-sm font-semibold text-slate-200">
                Configuración del restaurante
              </h2>
              <p className="text-xs text-slate-400">
                Horario, ubicación, zonas de delivery y políticas que el negocio usa al atender consultas de clientes.
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
                    Si está vacío, se informará que la dirección del local no está cargada.
                  </span>
                </label>

                <div className="block space-y-3 text-sm">
                  <span className="text-slate-300">Horario de atención</span>
                  <div className="rounded-lg border border-slate-700 bg-slate-950/60 p-4 space-y-4">
                    <div className="space-y-1">
                      <span className="text-xs font-medium uppercase tracking-wider text-slate-400">
                        Días de atención
                      </span>
                      <WeekdayToggle
                        value={restaurantConfig.opening_days}
                        onChange={(days) =>
                          setRestaurantConfig((prev) => ({
                            ...prev,
                            opening_days: days
                          }))
                        }
                        disabled={savingConfig}
                      />
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <label className="space-y-1">
                        <span className="text-xs font-medium uppercase tracking-wider text-slate-400">
                          Desde
                        </span>
                        <input
                          type="text"
                          inputMode="numeric"
                          autoComplete="off"
                          maxLength={5}
                          value={restaurantConfig.opening_time_from}
                          onChange={(event) =>
                            setRestaurantConfig((prev) => ({
                              ...prev,
                              opening_time_from: formatBusinessHourInput(event.target.value)
                            }))
                          }
                          onBlur={(event) =>
                            setRestaurantConfig((prev) => ({
                              ...prev,
                              opening_time_from: normalizeBusinessHourValue(event.target.value)
                            }))
                          }
                          placeholder="HH:MM"
                          className="h-10 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm"
                        />
                      </label>
                      <label className="space-y-1">
                        <span className="text-xs font-medium uppercase tracking-wider text-slate-400">
                          Hasta
                        </span>
                        <input
                          type="text"
                          inputMode="numeric"
                          autoComplete="off"
                          maxLength={5}
                          value={restaurantConfig.opening_time_to}
                          onChange={(event) =>
                            setRestaurantConfig((prev) => ({
                              ...prev,
                              opening_time_to: formatBusinessHourInput(event.target.value)
                            }))
                          }
                          onBlur={(event) =>
                            setRestaurantConfig((prev) => ({
                              ...prev,
                              opening_time_to: normalizeBusinessHourValue(event.target.value)
                            }))
                          }
                          placeholder="HH:MM"
                          className="h-10 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm"
                        />
                      </label>
                    </div>
                    <span className="block text-xs text-slate-500">
                      El bot seguirá en silencio fuera de este horario si el switch
                      <strong className="text-slate-400"> Respetar horario de atención </strong>
                      está en ON.
                    </span>
                    {buildOpeningHoursText(
                      restaurantConfig.opening_days,
                      normalizeBusinessHourValue(restaurantConfig.opening_time_from),
                      normalizeBusinessHourValue(restaurantConfig.opening_time_to)
                    ) ? (
                      <span className="block text-xs text-slate-500">
                        Resumen:{" "}
                        <strong className="text-slate-300">
                          {buildOpeningHoursText(
                            restaurantConfig.opening_days,
                            normalizeBusinessHourValue(restaurantConfig.opening_time_from),
                            normalizeBusinessHourValue(restaurantConfig.opening_time_to)
                          )}
                        </strong>
                      </span>
                    ) : restaurantConfig.opening_hours ? (
                      <span className="block text-xs text-amber-300">
                        Horario actual heredado: {restaurantConfig.opening_hours}
                      </span>
                    ) : null}
                  </div>
                </div>

                {botRuntimeSwitchesVisible ? (
                  <div className="space-y-3 rounded-lg border border-slate-700 bg-slate-950/60 p-4 text-sm">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <p className="font-medium text-slate-200">Bot de WhatsApp</p>
                        <p className="mt-1 text-xs leading-relaxed text-slate-500">
                          OFF: silencio total (sin respuestas ni registro de mensajes). ON: el bot funciona según la
                          configuración de horario de abajo.
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <span
                          className={`text-xs font-bold uppercase tabular-nums ${
                            botWhatsappEnabled ? "text-emerald-400" : "text-slate-500"
                          }`}
                        >
                          {botWhatsappEnabled ? "On" : "Off"}
                        </span>
                        <button
                          type="button"
                          role="switch"
                          aria-checked={botWhatsappEnabled}
                          aria-label={
                            botWhatsappEnabled ? "Desactivar bot de WhatsApp" : "Activar bot de WhatsApp"
                          }
                          onClick={() => setBotWhatsappEnabled((v) => !v)}
                          className={`relative h-9 w-[3.25rem] shrink-0 rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/50 ${
                            botWhatsappEnabled ? "bg-emerald-600" : "bg-slate-600"
                          }`}
                        >
                          <span
                            className={`absolute top-1 h-7 w-7 rounded-full bg-white shadow transition-transform ${
                              botWhatsappEnabled ? "translate-x-[1.35rem]" : "translate-x-1"
                            }`}
                          />
                        </button>
                      </div>
                    </div>
                    <div className="border-t border-slate-700/80 pt-3">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <p className="font-medium text-slate-200">Respetar horario de atención</p>
                          <p className="mt-1 text-xs leading-relaxed text-slate-500">
                            Solo aplica con el bot en ON. On: fuera del horario no procesa mensajes (como antes). Off:
                            responde en cualquier momento; el texto de horario sigue disponible para la IA.
                          </p>
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          <span
                            className={`text-xs font-bold uppercase tabular-nums ${
                              botEnforceOpeningHours ? "text-emerald-400" : "text-slate-500"
                            }`}
                          >
                            {botEnforceOpeningHours ? "On" : "Off"}
                          </span>
                          <button
                            type="button"
                            role="switch"
                            aria-checked={botEnforceOpeningHours}
                            aria-label={
                              botEnforceOpeningHours
                                ? "No aplicar cierre por horario"
                                : "Aplicar cierre por horario"
                            }
                            onClick={() => setBotEnforceOpeningHours((v) => !v)}
                            className={`relative h-9 w-[3.25rem] shrink-0 rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/50 ${
                              botEnforceOpeningHours ? "bg-emerald-600" : "bg-slate-600"
                            }`}
                          >
                            <span
                              className={`absolute top-1 h-7 w-7 rounded-full bg-white shadow transition-transform ${
                                botEnforceOpeningHours ? "translate-x-[1.35rem]" : "translate-x-1"
                              }`}
                            />
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                ) : null}

                <label className="block space-y-1 text-sm md:max-w-xs">
                  <span className="text-slate-300">Mesas del salón (numeradas)</span>
                  <input
                    type="number"
                    min={1}
                    max={500}
                    inputMode="numeric"
                    value={restaurantConfig.table_count}
                    onChange={(event) =>
                      setRestaurantConfig((prev) => ({
                        ...prev,
                        table_count: event.target.value
                      }))
                    }
                    className="h-10 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm"
                  />
                  <span className="block text-xs text-slate-500">
                    El bot solo acepta números de mesa entre 1 y este valor (por defecto 12). Rango permitido 1–500.
                  </span>
                </label>

                {deliveryEnabled ? (
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
                ) : null}

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
                    Información adicional para las respuestas automáticas a clientes.
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

const DELIVERY_PIPELINE_ORDER_STATUSES = [
  "awaiting_delivery_fee",
  "delivery_fee_set",
  "awaiting_delivery_total_confirm",
  "delivery_denied",
  "delivery_denial_notify_failed"
];

function OrdersFilterBar({ filters, todayOnly, onApply, onReset, total, shown, deliveryEnabled = true }) {
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState(filters);
  const [draftTodayOnly, setDraftTodayOnly] = useState(todayOnly);

  useEffect(() => {
    setDraft(filters);
  }, [filters]);

  useEffect(() => {
    setDraftTodayOnly(todayOnly);
  }, [todayOnly]);

  useEffect(() => {
    if (deliveryEnabled) return;
    setDraft((prev) => {
      let next = prev;
      if (DELIVERY_PIPELINE_ORDER_STATUSES.includes(prev.status)) {
        next = { ...next, status: "all" };
      }
      if (prev.fulfillmentType === "delivery") {
        next = { ...next, fulfillmentType: "all" };
      }
      return next === prev ? prev : next;
    });
  }, [deliveryEnabled]);

  function update(key, value) {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }

  function handleSubmit(event) {
    event.preventDefault();
    onApply(draft, draftTodayOnly);
  }

  const STATUS_OPTIONS_ALL = [
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
    { value: "notify_failed", label: "Falló aviso al cliente" },
    { value: "confirmed", label: "Confirmados" },
    { value: "delivered", label: "Entregados" },
    { value: "cancelled", label: "Cancelados" }
  ];

  const STATUS_OPTIONS = deliveryEnabled
    ? STATUS_OPTIONS_ALL
    : STATUS_OPTIONS_ALL.filter((o) => !DELIVERY_PIPELINE_ORDER_STATUSES.includes(o.value));

  const PAYMENT_OPTIONS = [
    { value: "all", label: "Todos" },
    { value: "efectivo", label: "Efectivo" },
    { value: "mercadopago", label: "Mercado Pago" }
  ];

  const FULFILLMENT_OPTIONS = deliveryEnabled
    ? [
        { value: "all", label: "Todas" },
        { value: "delivery", label: "Delivery" },
        { value: "delivery_mozo", label: "Delivery mozo" },
        { value: "local", label: "Retiro en local" },
        { value: "mesa", label: "Pedido en mesa" }
      ]
    : [
        { value: "all", label: "Todas" },
        { value: "delivery_mozo", label: "Delivery mozo" },
        { value: "local", label: "Retiro en local" },
        { value: "mesa", label: "Pedido en mesa" }
      ];

  const appliedSummaryParts = [];
  if (todayOnly) {
    appliedSummaryParts.push("Solo hoy");
  } else if (filters.dateFrom && filters.dateTo) {
    appliedSummaryParts.push(`${filters.dateFrom} → ${filters.dateTo}`);
  } else if (filters.dateFrom || filters.dateTo) {
    appliedSummaryParts.push("Rango de fechas");
  }
  if (filters.status !== "all") {
    appliedSummaryParts.push(STATUS_OPTIONS.find((o) => o.value === filters.status)?.label ?? filters.status);
  }
  if (filters.paymentMethod !== "all") {
    appliedSummaryParts.push(
      PAYMENT_OPTIONS.find((o) => o.value === filters.paymentMethod)?.label ?? filters.paymentMethod
    );
  }
  if (filters.fulfillmentType !== "all") {
    appliedSummaryParts.push(
      FULFILLMENT_OPTIONS.find((o) => o.value === filters.fulfillmentType)?.label ?? filters.fulfillmentType
    );
  }
  const searchTrim = String(filters.search || "").trim();
  if (searchTrim) {
    appliedSummaryParts.push(
      searchTrim.length > 28 ? `Buscar: "${searchTrim.slice(0, 28)}…"` : `Buscar: "${searchTrim}"`
    );
  }
  const appliedSummary =
    appliedSummaryParts.length > 0 ? appliedSummaryParts.join(" · ") : "Filtros por defecto";

  return (
    <div className="overflow-hidden rounded-xl border border-slate-700 bg-slate-900">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((prev) => !prev)}
        className="flex w-full items-center gap-3 px-4 py-3 text-left transition hover:bg-slate-800/60"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 20 20"
          fill="currentColor"
          aria-hidden="true"
          className={`h-5 w-5 shrink-0 text-slate-400 transition-transform ${expanded ? "rotate-0" : "-rotate-90"}`}
        >
          <path
            fillRule="evenodd"
            d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.94a.75.75 0 111.08 1.04l-4.24 4.5a.75.75 0 01-1.08 0l-4.24-4.5a.75.75 0 01.02-1.06z"
            clipRule="evenodd"
          />
        </svg>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-slate-100">Filtros de pedidos</div>
          {!expanded ? (
            <div className="mt-0.5 truncate text-xs text-slate-400">{appliedSummary}</div>
          ) : null}
        </div>
        <span className="shrink-0 tabular-nums text-xs text-slate-500">
          {shown} / {total}
        </span>
      </button>

      {expanded ? (
        <form
          onSubmit={handleSubmit}
          className="grid gap-3 border-t border-slate-700 p-4 md:grid-cols-6"
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
