import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "../supabaseClient";
import { getSession, logout } from "../lib/auth";
import { resolveRestaurantForDashboard } from "../lib/restaurantTenant";
import { useDemoTenant } from "../lib/DemoTenantContext";
import { deliveryMayLoginToday } from "../lib/deliverySchedule";
import {
  callableCustomerPhone,
  currency,
  deliveryOrderInOpenPool,
  effectiveOrderTotal,
  flattenOrderItems,
  formatDateTime,
  kitchenMetaBoxContent,
  formatPhoneLabel,
  groupOrderItemRows,
  isDeliveryOrder,
  normalizeOrderStatus,
  paymentIsApproved,
  paymentMethodKey,
  playNotification
} from "../lib/format";

const TODAY_HISTORY_HOURS = 18;
const REVERT_DELIVERY_WINDOW_MS = 15 * 60 * 1000;

export default function DeliveryApp({ onLogout }) {
  const { demoSlug } = useDemoTenant();
  const [restaurantId, setRestaurantId] = useState("");
  const [restaurantName, setRestaurantName] = useState("");
  const [deliveryGloballyDisabled, setDeliveryGloballyDisabled] = useState(false);
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [savingOrderId, setSavingOrderId] = useState(null);
  const lastLoadedAtRef = useRef(null);
  const [confirmDialog, setConfirmDialog] = useState(null);
  const confirmResolverRef = useRef(null);
  const [issueDialog, setIssueDialog] = useState(null);
  const [issueDialogError, setIssueDialogError] = useState("");
  const [scheduleGate, setScheduleGate] = useState(() => {
    const s = getSession();
    if (s?.loginSource === "db" && s?.role === "delivery" && s?.userId) return "loading";
    return "ok";
  });

  useEffect(() => {
    let cancelled = false;
    const s = getSession();
    if (!s || s.loginSource !== "db" || s.role !== "delivery" || !s.userId) {
      setScheduleGate("ok");
      return undefined;
    }
    (async () => {
      const { data, error } = await supabase
        .from("dashboard_users")
        .select("delivery_work_weekdays, is_active, role")
        .eq("id", s.userId)
        .maybeSingle();
      if (cancelled) return;
      if (error) {
        setScheduleGate("ok");
        return;
      }
      if (!data || !data.is_active || data.role !== "delivery") {
        logout();
        onLogout();
        return;
      }
      if (!deliveryMayLoginToday(data.delivery_work_weekdays)) {
        setScheduleGate("blocked");
      } else {
        setScheduleGate("ok");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [onLogout]);

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

  useEffect(() => {
    async function loadRestaurant() {
      const { data, error: queryError } = await resolveRestaurantForDashboard(supabase, { demoSlug });
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
      setDeliveryGloballyDisabled(data.delivery_enabled === false);
    }
    loadRestaurant();
  }, [demoSlug]);

  useEffect(() => {
    if (!restaurantId) return undefined;
    let active = true;

    async function loadOrders() {
      setLoading(true);
      const sinceIso = new Date(Date.now() - TODAY_HISTORY_HOURS * 60 * 60 * 1000).toISOString();
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
      lastLoadedAtRef.current = Date.now();
      setOrders(data || []);
      setLoading(false);
    }

    loadOrders();

    const channel = supabase
      .channel(`delivery-orders-${restaurantId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "orders",
          filter: `restaurant_id=eq.${restaurantId}`
        },
        (payload) => {
          if (!isDeliveryOrder(payload.new)) return;
          setOrders((prev) => [payload.new, ...prev.filter((row) => row.id !== payload.new.id)]);
          if (deliveryOrderInOpenPool(payload.new)) playNotification();
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
          setOrders((prev) => {
            const existing = prev.find((row) => row.id === payload.new.id);
            const oldRow = existing;
            const userId = getSession()?.userId;
            let shouldPlay = false;
            if (isDeliveryOrder(payload.new)) {
              if (!oldRow?.delivery_ready_broadcast_at && payload.new.delivery_ready_broadcast_at) {
                shouldPlay = true;
              }
              if (
                userId &&
                payload.new.delivery_claimed_by_user_id === userId &&
                oldRow?.delivery_claimed_by_user_id !== userId
              ) {
                shouldPlay = true;
              }
              if (
                !userId &&
                normalizeOrderStatus(payload.new) === "confirmed" &&
                (!oldRow || normalizeOrderStatus(oldRow) !== "confirmed")
              ) {
                shouldPlay = true;
              }
            }
            if (shouldPlay) playNotification();

            const next = prev.map((row) => (row.id === payload.new.id ? payload.new : row));
            if (!existing && isDeliveryOrder(payload.new)) next.unshift(payload.new);
            return next;
          });
        }
      )
      .subscribe();

    return () => {
      active = false;
      supabase.removeChannel(channel);
    };
  }, [restaurantId]);

  const partitioned = useMemo(() => {
    const session = getSession();
    const userId = session?.userId;
    const pool = [];
    const pending = [];
    const doneToday = [];

    for (const order of orders) {
      if (!isDeliveryOrder(order)) continue;
      const st = normalizeOrderStatus(order);

      if (st === "delivered") {
        if (
          (!userId || order.delivery_claimed_by_user_id === userId) &&
          canRevertDeliveredWithinWindow(order)
        ) {
          doneToday.push(order);
        }
        continue;
      }
      if (st === "cancelled" || st === "delivery_denied") continue;

      if (userId) {
        if (order.delivery_claimed_by_user_id === userId) {
          pending.push(order);
          continue;
        }
        if (deliveryOrderInOpenPool(order)) {
          pool.push(order);
        }
      } else {
        if (st === "confirmed") {
          pending.push(order);
        }
      }
    }

    pool.sort((a, b) => {
      const ta = new Date(a.delivery_ready_broadcast_at || a.created_at).getTime();
      const tb = new Date(b.delivery_ready_broadcast_at || b.created_at).getTime();
      return ta - tb;
    });
    pending.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
    doneToday.sort((a, b) => {
      const ta = new Date(a.delivered_at || a.created_at).getTime();
      const tb = new Date(b.delivered_at || b.created_at).getTime();
      return tb - ta;
    });
    return { pool, pending, doneToday, deliveryUserId: userId || null, legacyEnv: !userId };
  }, [orders]);

  async function claimOrder(order) {
    const session = getSession();
    if (!session?.userId) {
      setError("Iniciá sesión con tu usuario de repartidor para tomar pedidos.");
      return;
    }
    setError("");
    setSavingOrderId(order.id);
    const claimedAt = new Date().toISOString();
    const { data: updatedRow, error: updateError } = await supabase
      .from("orders")
      .update({
        delivery_claimed_by_user_id: session.userId,
        delivery_claimed_at: claimedAt
      })
      .eq("id", order.id)
      .is("delivery_claimed_by_user_id", null)
      .not("delivery_ready_broadcast_at", "is", null)
      .select("*")
      .maybeSingle();

    if (updateError) {
      setError(`Error al tomar el pedido: ${updateError.message}`);
      setSavingOrderId(null);
      return;
    }
    if (!updatedRow) {
      setError("Otro repartidor ya tomó este pedido. Refrescá la lista.");
      setSavingOrderId(null);
      return;
    }
    setOrders((prev) => prev.map((row) => (row.id === order.id ? { ...row, ...updatedRow } : row)));
    setSavingOrderId(null);
  }

  async function submitDeliveryIssue(order, reason) {
    const session = getSession();
    const trimmed = String(reason || "").trim();
    if (!session?.userId || !trimmed) {
      setIssueDialogError("Escribí el motivo del problema.");
      return;
    }
    setIssueDialogError("");
    setError("");
    setSavingOrderId(order.id);
    try {
      const claimId = order.delivery_claimed_by_user_id
        ? String(order.delivery_claimed_by_user_id)
        : null;
      const myId = String(session.userId);
      if (claimId && claimId !== myId) {
        setIssueDialogError(
          "Este pedido ya no está asignado a tu usuario. Cerrá y refrescá la lista (F5)."
        );
        return;
      }

      let query = supabase
        .from("orders")
        .update({
          delivery_issue_reported_at: new Date().toISOString(),
          delivery_issue_reason: trimmed,
          delivery_issue_reported_by_user_id: session.userId
        })
        .eq("id", order.id);

      if (claimId) {
        query = query.eq("delivery_claimed_by_user_id", session.userId);
      }

      const { data: updatedRow, error: updateError } = await query
        .select(
          "id,notes,status,delivery_issue_reported_at,delivery_issue_reason,delivery_issue_reported_by_user_id"
        )
        .maybeSingle();

      if (updateError) {
        setIssueDialogError(`No se pudo guardar: ${updateError.message}`);
        return;
      }
      if (!updatedRow) {
        setIssueDialogError("No se pudo actualizar. Refrescá la página e intentá de nuevo.");
        return;
      }
      setOrders((prev) => prev.map((row) => (row.id === order.id ? { ...row, ...updatedRow } : row)));
      setIssueDialog(null);
      setIssueDialogError("");
    } catch (err) {
      setIssueDialogError(err?.message || "Error inesperado al enviar. Probá de nuevo.");
    } finally {
      setSavingOrderId((cur) => (cur === order.id ? null : cur));
    }
  }

  async function cancelOrderAfterDeliveryIssue(order) {
    const session = getSession();
    if (!session?.userId) {
      setError("Tenés que iniciar sesión con tu usuario de repartidor.");
      return;
    }
    if (!order.delivery_issue_reason) {
      setError("Primero reportá el problema antes de cancelar por incidencia.");
      return;
    }
    if (String(order.delivery_issue_reported_by_user_id || "") !== String(session.userId)) {
      setError("Solo podés cancelar por incidencia los pedidos que reportaste vos.");
      return;
    }
    const st = normalizeOrderStatus(order);
    if (st === "cancelled") {
      setError("Este pedido ya está cancelado.");
      return;
    }
    if (st === "delivered") {
      setError("Este pedido ya está marcado como entregado.");
      return;
    }

    const ok = await requestConfirm({
      title: "Cancelar pedido por incidencia",
      message:
        "El pedido quedará cancelado y lo verán en administración. Esta acción no envía un mensaje al cliente sola. ¿Confirmás la cancelación?",
      confirmLabel: "Sí, cancelar pedido",
      cancelLabel: "Volver",
      tone: "danger"
    });
    if (!ok) return;

    setError("");
    setSavingOrderId(order.id);
    try {
      const patch = {
        status: "cancelled",
        cancelled_at: new Date().toISOString()
      };
      const { data: updatedRow, error: updateError } = await supabase
        .from("orders")
        .update(patch)
        .eq("id", order.id)
        .eq("delivery_claimed_by_user_id", session.userId)
        .eq("delivery_issue_reported_by_user_id", session.userId)
        .neq("status", "cancelled")
        .neq("status", "delivered")
        .select("*")
        .maybeSingle();

      if (updateError) {
        setError(`Error al cancelar: ${updateError.message}`);
        return;
      }
      if (!updatedRow) {
        setError(
          "No se pudo cancelar (el pedido cambió o ya no está asignado a vos). Refrescá la lista."
        );
        return;
      }
      setOrders((prev) => prev.map((row) => (row.id === order.id ? { ...row, ...updatedRow } : row)));
    } catch (err) {
      setError(err?.message || "Error inesperado al cancelar.");
    } finally {
      setSavingOrderId((cur) => (cur === order.id ? null : cur));
    }
  }

  async function markDelivered(order) {
    const st = normalizeOrderStatus(order);
    if (st === "delivered" || st === "cancelled") {
      setError("Este pedido ya está cerrado.");
      return;
    }
    const session = getSession();
    if (session?.userId && order.delivery_ready_broadcast_at) {
      if (order.delivery_claimed_by_user_id !== session.userId) {
        setError("Este pedido no está asignado a tu usuario.");
        return;
      }
    }
    const cashOnDelivery = paymentMethodKey(order) === "cash" && !paymentIsApproved(order);
    const ok = await requestConfirm({
      title: cashOnDelivery ? "Cobrado y entregado" : "Marcar entregado",
      message: cashOnDelivery
        ? "¿Confirmás que cobraste en efectivo y entregaste el pedido? Se registrarán el cobro y la entrega."
        : "¿Confirmás que el pedido ya fue entregado?",
      confirmLabel: cashOnDelivery ? "Sí, cobrado y entregado" : "Sí, marcar entregado",
      cancelLabel: "Volver",
      tone: "info"
    });
    if (!ok) return;

    setError("");
    setSavingOrderId(order.id);
    const nowIso = new Date().toISOString();
    const patch = {
      status: "delivered",
      delivered_at: nowIso
    };
    if (cashOnDelivery) {
      patch.payment_status = "paid";
      patch.payment_paid_at = nowIso;
    }

    let updateQuery = supabase
      .from("orders")
      .update(patch)
      .eq("id", order.id)
      .neq("status", "delivered")
      .neq("status", "cancelled");
    if (session?.userId && order.delivery_ready_broadcast_at) {
      updateQuery = updateQuery.eq("delivery_claimed_by_user_id", session.userId);
    }
    const { data: updatedRow, error: updateError } = await updateQuery.select("*").maybeSingle();

    if (updateError) {
      setError(`Error marcando entrega: ${updateError.message}`);
      setSavingOrderId(null);
      return;
    }
    if (!updatedRow) {
      setError("No se pudo marcar como entregado (el pedido cambió de estado). Refrescá la lista.");
      setSavingOrderId(null);
      return;
    }

    setOrders((prev) => prev.map((row) => (row.id === order.id ? { ...row, ...updatedRow } : row)));
    setSavingOrderId(null);
  }

  async function revertDelivered(order) {
    if (normalizeOrderStatus(order) !== "delivered") {
      setError("Este pedido no está marcado como entregado.");
      return;
    }
    if (!canRevertDeliveredWithinWindow(order)) {
      setError(
        "Ya no se puede revertir esta entrega (pasaron más de 15 minutos). Contactá al administrador si hace falta corregirlo."
      );
      return;
    }
    const ok = await requestConfirm({
      title: "Revertir entrega",
      message:
        "El pedido vuelve a la lista de pendientes (estado confirmado). ¿Revertir esta entrega?",
      confirmLabel: "Sí, revertir entrega",
      cancelLabel: "Volver",
      tone: "warning"
    });
    if (!ok) return;

    setError("");
    setSavingOrderId(order.id);

    const paidAtMs = order.payment_paid_at ? new Date(order.payment_paid_at).getTime() : null;
    const delAtMs = order.delivered_at ? new Date(order.delivered_at).getTime() : null;
    const codMarkedWithDelivery =
      paymentMethodKey(order) === "cash" &&
      paidAtMs != null &&
      delAtMs != null &&
      Math.abs(paidAtMs - delAtMs) < 15_000;

    const patch = {
      status: "confirmed",
      delivered_at: null,
      delivery_claimed_by_user_id: null,
      delivery_claimed_at: null
    };
    if (codMarkedWithDelivery) {
      patch.payment_status = "pending";
      patch.payment_paid_at = null;
    }

    const { data: updatedRow, error: updateError } = await supabase
      .from("orders")
      .update(patch)
      .eq("id", order.id)
      .eq("status", "delivered")
      .select("*")
      .maybeSingle();

    if (updateError) {
      setError(`Error revirtiendo entrega: ${updateError.message}`);
      setSavingOrderId(null);
      return;
    }
    if (!updatedRow) {
      setError("No se pudo revertir (el pedido cambió de estado). Refrescá la lista.");
      setSavingOrderId(null);
      return;
    }

    setOrders((prev) => prev.map((row) => (row.id === order.id ? { ...row, ...updatedRow } : row)));
    setSavingOrderId(null);
  }

  if (scheduleGate === "loading") {
    return (
      <div className="dark flex min-h-screen items-center justify-center bg-slate-950 px-6 text-slate-300">
        <p className="text-sm">Comprobando acceso al panel…</p>
      </div>
    );
  }

  if (deliveryGloballyDisabled) {
    return (
      <div className="dark flex min-h-screen flex-col items-center justify-center bg-slate-950 px-6 text-center">
        <div className="max-w-md rounded-2xl border border-amber-800/50 bg-slate-900/90 p-8 shadow-xl">
          <h2 className="text-lg font-semibold text-slate-100">Delivery pausado</h2>
          <p className="mt-3 text-sm leading-relaxed text-slate-400">
            El local desactivó los pedidos con envío a domicilio. Cuando lo reactiven vas a poder usar este panel de
            nuevo.
          </p>
          <button
            type="button"
            onClick={() => {
              logout();
              onLogout();
            }}
            className="mt-6 w-full rounded-lg bg-emerald-500 px-4 py-2.5 text-sm font-semibold text-slate-950 hover:bg-emerald-400"
          >
            Salir
          </button>
        </div>
      </div>
    );
  }

  if (scheduleGate === "blocked") {
    return (
      <div className="dark flex min-h-screen flex-col items-center justify-center bg-slate-950 px-6 text-center">
        <div className="max-w-md rounded-2xl border border-slate-800 bg-slate-900/90 p-8 shadow-xl">
          <h2 className="text-lg font-semibold text-slate-100">Hoy no tenés turno en reparto</h2>
          <p className="mt-3 text-sm leading-relaxed text-slate-400">
            Contactá a quien administra el sistema para habilitar tus días de trabajo.
          </p>
          <button
            type="button"
            onClick={() => {
              logout();
              onLogout();
            }}
            className="mt-6 w-full rounded-lg bg-emerald-500 px-4 py-2.5 text-sm font-semibold text-slate-950 hover:bg-emerald-400"
          >
            Salir
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="dark min-h-screen bg-slate-950 text-slate-100">
      <div className="mx-auto max-w-3xl p-5">
        <header className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold">Repartos</h1>
            <p className="text-xs text-slate-400">
              {restaurantName ? restaurantName : ""}
              {!partitioned.legacyEnv && getSession()?.username ? (
                <>
                  {restaurantName ? " · " : ""}
                  <span className="text-slate-300">{getSession()?.username || ""}</span>
                </>
              ) : null}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span className="hidden rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-xs text-emerald-300 sm:inline">
              En vivo
            </span>
            <button
              type="button"
              onClick={onLogout}
              className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-800"
            >
              Salir
            </button>
          </div>
        </header>

        {error ? (
          <div className="mb-4 rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-200">
            {error}
          </div>
        ) : null}

        {!partitioned.legacyEnv ? (
          <section className="mb-6 space-y-3">
            <SectionHeader title="Disponibles para tomar" count={partitioned.pool.length} tone="active" />
            {loading ? (
              <div className="rounded-xl border border-slate-700 bg-slate-900 p-5 text-slate-400">
                Cargando pedidos…
              </div>
            ) : partitioned.pool.length === 0 ? (
              <div className="rounded-xl border border-slate-700 bg-slate-900 p-5 text-slate-400">
                No hay pedidos en cola. Aparecen cuando el admin avisa que están listos para salir.
              </div>
            ) : (
              partitioned.pool.map((order) => (
                <DeliveryOrderCard
                  key={order.id}
                  variant="pool"
                  order={order}
                  saving={savingOrderId === order.id}
                  onClaim={() => claimOrder(order)}
                />
              ))
            )}
          </section>
        ) : null}

        <section className="mb-6 space-y-3">
          <SectionHeader
            title={partitioned.legacyEnv ? "Pendientes de entrega" : "Mis entregas activas"}
            count={partitioned.pending.length}
            tone="active"
          />
          {loading ? (
            <div className="rounded-xl border border-slate-700 bg-slate-900 p-5 text-slate-400">
              Cargando pedidos…
            </div>
          ) : partitioned.pending.length === 0 ? (
            <div className="rounded-xl border border-slate-700 bg-slate-900 p-5 text-slate-400">
              {partitioned.legacyEnv
                ? "No hay pedidos pendientes en este momento."
                : "No tenés pedidos asignados. Revisá la cola arriba."}
            </div>
          ) : (
            partitioned.pending.map((order) => (
              <DeliveryOrderCard
                key={order.id}
                variant="active"
                order={order}
                saving={savingOrderId === order.id}
                onDelivered={() => markDelivered(order)}
                onReportIssue={
                  partitioned.deliveryUserId
                    ? () => {
                        setIssueDialogError("");
                        setIssueDialog({ order });
                      }
                    : undefined
                }
                canCancelAfterOwnIssue={
                  Boolean(
                    partitioned.deliveryUserId &&
                      order.delivery_issue_reason &&
                      String(order.delivery_issue_reported_by_user_id || "") ===
                        String(partitioned.deliveryUserId)
                  )
                }
                onCancelAfterIssue={() => cancelOrderAfterDeliveryIssue(order)}
              />
            ))
          )}
        </section>

        {partitioned.doneToday.length > 0 ? (
          <section className="space-y-3">
            <SectionHeader
              title="Entrega reciente (deshacer)"
              count={partitioned.doneToday.length}
              tone="done"
            />
            {partitioned.doneToday.map((order) => (
              <DeliveryOrderCard
                key={order.id}
                order={order}
                compact
                saving={savingOrderId === order.id}
                canRevertDelivered
                onRevertDelivered={() => revertDelivered(order)}
              />
            ))}
          </section>
        ) : null}
      </div>
      {confirmDialog ? (
        <ConfirmModal dialog={confirmDialog} onResolve={handleConfirmDialog} />
      ) : null}
      {issueDialog?.order ? (
        <IssueReportModal
          order={issueDialog.order}
          saving={savingOrderId === issueDialog.order.id}
          errorMessage={issueDialogError}
          onDismissError={() => setIssueDialogError("")}
          onClose={() => {
            setIssueDialog(null);
            setIssueDialogError("");
          }}
          onSubmit={(reason) => submitDeliveryIssue(issueDialog.order, reason)}
        />
      ) : null}
    </div>
  );
}

function canRevertDeliveredWithinWindow(order) {
  if (normalizeOrderStatus(order) !== "delivered") return false;
  const t = order.delivered_at ? new Date(order.delivered_at).getTime() : NaN;
  if (!Number.isFinite(t)) return false;
  return Date.now() - t <= REVERT_DELIVERY_WINDOW_MS;
}

function SectionHeader({ title, count, tone }) {
  const palette =
    tone === "active"
      ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-200"
      : "border-slate-700 bg-slate-800/40 text-slate-300";
  return (
    <div className="flex items-center justify-between">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-300">{title}</h2>
      <span className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${palette}`}>
        {count}
      </span>
    </div>
  );
}

function DeliveryOrderCard({
  order,
  saving,
  onDelivered,
  onClaim,
  onReportIssue,
  onCancelAfterIssue,
  canCancelAfterOwnIssue = false,
  onRevertDelivered,
  variant = "active",
  compact,
  canRevertDelivered = true
}) {
  const items = flattenOrderItems(order);
  const groupedRows = groupOrderItemRows(order);
  const total = effectiveOrderTotal(order);
  const cashOnDelivery = paymentMethodKey(order) === "cash" && !paymentIsApproved(order);
  const status = normalizeOrderStatus(order);
  const phoneDigits = callableCustomerPhone(order);
  const phoneLabel = phoneDigits
    ? formatPhoneLabel(phoneDigits)
    : "Sin teléfono disponible";
  const address = order.address || extractAddressFromNotes(order.notes);
  const mapsHref = address
    ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`
    : null;
  const whatsappHref = phoneDigits ? `https://wa.me/${phoneDigits}` : null;
  const telHref = phoneDigits ? `tel:+${phoneDigits}` : null;

  if (compact) {
    return (
      <article className="rounded-xl border border-slate-800 bg-slate-900/60 p-3 text-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0 flex-1">
            <p className="truncate text-slate-200">
              {address || "Sin dirección"}{" "}
              <span className="text-slate-500">· {currency(total)}</span>
            </p>
            <p className="truncate text-xs text-slate-500">
              Entregado{" "}
              {order.delivered_at ? formatDateTime(order.delivered_at) : "recientemente"}
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-300">
              ✓ entregado
            </span>
            {typeof onRevertDelivered === "function" && canRevertDelivered ? (
              <button
                type="button"
                disabled={saving}
                onClick={onRevertDelivered}
                className="rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[11px] font-medium text-amber-200 hover:bg-amber-500/20 disabled:opacity-50"
              >
                {saving ? "…" : "Revertir entrega"}
              </button>
            ) : null}
          </div>
        </div>
      </article>
    );
  }

  return (
    <article className="rounded-2xl border border-slate-700 bg-slate-900 p-5 shadow-lg shadow-black/20">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[11px] uppercase tracking-wider text-slate-500">Pedido</p>
          <h3 className="truncate text-base font-semibold text-slate-100">#{order.id.slice(0, 8)}</h3>
        </div>
        <div className="text-right">
          <p className="text-[11px] uppercase tracking-wider text-slate-500">A cobrar</p>
          <p
            className={`text-xl font-semibold tabular-nums ${
              cashOnDelivery ? "text-amber-300" : "text-emerald-300"
            }`}
          >
            {currency(total)}
          </p>
          <p className={`text-[11px] ${cashOnDelivery ? "text-amber-300/80" : "text-emerald-300/80"}`}>
            {cashOnDelivery ? "Cobrar al entregar (efectivo)" : "Ya pagado"}
          </p>
        </div>
      </div>

      <div className="space-y-3">
        <InfoRow label="Dirección" value={address || "Sin dirección"} accent>
          {mapsHref ? (
            <a
              href={mapsHref}
              target="_blank"
              rel="noreferrer"
              className="ml-2 rounded-md border border-blue-500/40 bg-blue-500/10 px-2 py-0.5 text-[11px] font-medium text-blue-300 hover:bg-blue-500/20"
            >
              Abrir mapa
            </a>
          ) : null}
        </InfoRow>

        <InfoRow label="Cliente" value={phoneLabel}>
          {telHref ? (
            <a
              href={telHref}
              className="ml-2 rounded-md border border-slate-600 bg-slate-800 px-2 py-0.5 text-[11px] font-medium text-slate-200 hover:bg-slate-700"
            >
              Llamar
            </a>
          ) : null}
          {whatsappHref ? (
            <a
              href={whatsappHref}
              target="_blank"
              rel="noreferrer"
              className="ml-2 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-300 hover:bg-emerald-500/20"
            >
              WhatsApp
            </a>
          ) : null}
        </InfoRow>

        <div>
          <p className="text-[11px] uppercase tracking-wider text-slate-500">Items</p>
          {items.length ? (
            <ul className="mt-1 space-y-0.5 text-sm text-slate-200">
              {groupedRows.map(({ name, count }) => (
                <li key={name}>
                  · {count > 1 ? `${name} x${count}` : name}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-1 text-sm text-slate-400">{order.notes || order.raw_request || "—"}</p>
          )}
        </div>

        {order.delivery_fee != null && order.delivery_fee !== "" ? (
          <p className="text-xs text-slate-500">
            Envío: <span className="text-slate-300">{currency(order.delivery_fee)}</span>
            {order.subtotal_amount != null
              ? `  ·  Subtotal: ${currency(order.subtotal_amount)}`
              : ""}
          </p>
        ) : null}

        {kitchenMetaBoxContent(order) ? (
          <p className="rounded-lg border border-slate-800 bg-slate-950/50 p-2 text-xs text-slate-400">
            <span className="font-medium text-slate-300">Notas:</span>{" "}
            {kitchenMetaBoxContent(order)}
          </p>
        ) : null}

        {variant === "active" && order.delivery_en_route_customer_notified_at ? (
          <p className="rounded-lg border border-sky-500/40 bg-sky-500/10 px-3 py-2 text-[11px] leading-snug text-sky-100/95">
            El cliente recibió aviso de que el pedido va en camino
            {formatDateTime(order.delivery_en_route_customer_notified_at)
              ? ` · ${formatDateTime(order.delivery_en_route_customer_notified_at)}`
              : ""}
            .
          </p>
        ) : null}
      </div>

      <div className="mt-5 flex flex-wrap items-center justify-between gap-2 border-t border-slate-800 pt-4">
        <p className="text-xs text-slate-500">
          {variant === "pool"
            ? `Listo desde ${formatDateTime(order.delivery_ready_broadcast_at) || "—"}`
            : `Tomado / actualizado ${formatDateTime(order.delivery_claimed_at || order.payment_paid_at || order.customer_notified_at || order.created_at)}`}
        </p>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {variant === "active" && typeof onReportIssue === "function" && !order.delivery_issue_reason ? (
            <button
              type="button"
              disabled={saving}
              onClick={onReportIssue}
              className="rounded-xl border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-sm font-medium text-rose-200 hover:bg-rose-500/20 disabled:opacity-60"
            >
              Reportar problema
            </button>
          ) : null}
          {variant === "active" && order.delivery_issue_reason && canCancelAfterOwnIssue ? (
            <div className="flex w-full max-w-full flex-col gap-2 sm:items-end">
              <span className="max-w-[20rem] text-[11px] leading-snug text-rose-200/85 sm:text-right">
                Incidencia enviada al administrador. Podés cancelar el pedido si no puede completarse la entrega.
              </span>
              {typeof onCancelAfterIssue === "function" ? (
                <button
                  type="button"
                  disabled={saving}
                  onClick={onCancelAfterIssue}
                  className="rounded-xl border-2 border-rose-500 bg-rose-600/20 px-3 py-2 text-sm font-semibold text-rose-100 hover:bg-rose-600/35 disabled:opacity-60"
                >
                  Cancelar pedido (incidencia)
                </button>
              ) : null}
            </div>
          ) : variant === "active" && order.delivery_issue_reason ? (
            <span className="max-w-[14rem] text-[11px] leading-snug text-rose-200/85">
              Incidencia enviada al administrador
            </span>
          ) : null}
          {variant === "pool" ? (
            <button
              type="button"
              disabled={saving || typeof onClaim !== "function"}
              onClick={onClaim}
              className="rounded-xl bg-cyan-500 px-4 py-2.5 text-sm font-semibold text-slate-950 hover:bg-cyan-400 disabled:opacity-60"
            >
              {saving ? "Guardando…" : "Tomar pedido"}
            </button>
          ) : (
            <button
              type="button"
              disabled={saving || typeof onDelivered !== "function"}
              onClick={onDelivered}
              className={`rounded-xl px-4 py-2.5 text-sm font-semibold transition disabled:opacity-60 ${
                cashOnDelivery
                  ? "bg-amber-500 text-slate-950 hover:bg-amber-400"
                  : "bg-emerald-500 text-slate-950 hover:bg-emerald-400"
              }`}
            >
              {saving
                ? "Guardando…"
                : cashOnDelivery
                  ? "Cobrado y entregado"
                  : "Marcar entregado"}
            </button>
          )}
        </div>
      </div>
    </article>
  );
}

function InfoRow({ label, value, children, accent }) {
  return (
    <div>
      <p className="text-[11px] uppercase tracking-wider text-slate-500">{label}</p>
      <p
        className={`mt-0.5 flex flex-wrap items-center text-sm ${
          accent ? "text-slate-100" : "text-slate-200"
        }`}
      >
        <span className="break-words">{value}</span>
        {children}
      </p>
    </div>
  );
}

function extractAddressFromNotes(notes) {
  if (!notes) return "";
  const m = String(notes).match(/direcci[oó]n:\s*([^\n|]+)/i);
  return m ? m[1].trim() : "";
}

function IssueReportModal({ order, saving, errorMessage, onDismissError, onClose, onSubmit }) {
  const [text, setText] = useState("");
  useEffect(() => {
    setText("");
  }, [order?.id]);

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center px-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="delivery-issue-modal-title"
    >
      <button
        type="button"
        className="absolute inset-0 z-0 cursor-default bg-slate-950/70 backdrop-blur-sm"
        aria-label="Cerrar"
        onClick={onClose}
      />
      <div
        className="relative z-10 w-full max-w-md rounded-2xl border border-rose-500/35 bg-slate-900/95 p-5 shadow-2xl shadow-black/40"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 id="delivery-issue-modal-title" className="text-base font-semibold text-slate-100">
          Reportar problema · pedido #{order.id.slice(0, 8)}
        </h3>
        <p className="mt-1 text-sm text-slate-400">
          Contale al restaurante qué pasó (cliente no atiende, dirección incorrecta, etc.).
        </p>
        <textarea
          className="mt-3 min-h-[100px] w-full rounded-lg border border-slate-600 bg-slate-950 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600"
          placeholder="Ej: el cliente no salió a abrir, timbre roto, nadie responde…"
          value={text}
          maxLength={2000}
          onChange={(e) => {
            setText(e.target.value);
            onDismissError?.();
          }}
        />
        {errorMessage ? (
          <p className="mt-3 rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-100">
            {errorMessage}
          </p>
        ) : null}
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-slate-600 bg-slate-800/60 px-4 py-2 text-sm font-medium text-slate-200 hover:bg-slate-700"
          >
            Cancelar
          </button>
          <button
            type="button"
            disabled={saving || !text.trim()}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onSubmit(text);
            }}
            className="rounded-lg bg-rose-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-rose-400 disabled:opacity-50"
          >
            {saving ? "Enviando…" : "Enviar al admin"}
          </button>
        </div>
      </div>
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
      aria-labelledby="delivery-confirm-modal-title"
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
              id="delivery-confirm-modal-title"
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
