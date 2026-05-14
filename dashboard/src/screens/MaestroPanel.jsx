/**
 * Panel solo visible para sesión `role === "maestro"` (contraseña VITE_MAESTRO_PASSWORD).
 */
import { useEffect, useState } from "react";
import { supabase } from "../supabaseClient";

export default function MaestroPanel({
  restaurantId,
  deliveryEnabled,
  localEnabled,
  mesaEnabled,
  mesaQrEnabled,
  waiterFulfillmentSelectorEnabled,
  botRuntimeSwitchesVisible,
  cashEnabled,
  mercadoPagoEnabled,
  statsEnabled,
  stockPanelEnabled,
  tableCount,
  loadingRestaurant,
  onServiceFlagsUpdated,
  onTableCountUpdated,
  onMesaQrModuleToggle,
  onWaiterFulfillmentSelectorToggle,
  onBotRuntimeSwitchesVisibleToggle,
  onStockPanelToggle
}) {
  const [savingDelivery, setSavingDelivery] = useState(false);
  const [savingTables, setSavingTables] = useState(false);
  const [localError, setLocalError] = useState("");
  const [localOk, setLocalOk] = useState("");
  const [copyOk, setCopyOk] = useState("");
  const [tablesDraft, setTablesDraft] = useState(String(tableCount ?? 12));
  const restartCommand = "docker compose restart restobot dashboard";

  useEffect(() => {
    setTablesDraft(String(tableCount ?? 12));
  }, [tableCount]);

  async function setServiceFlag(field, nextEnabled, successText) {
    if (!restaurantId) {
      setLocalError("No hay restaurante cargado.");
      return;
    }
    if (savingDelivery || savingTables) return;
    setLocalError("");
    setLocalOk("");
    setSavingDelivery(true);
    const { error } = await supabase
      .from("restaurants")
      .update({ [field]: nextEnabled })
      .eq("id", restaurantId);

    setSavingDelivery(false);
    if (error) {
      setLocalError(`No se pudo guardar: ${error.message}`);
      return;
    }
    setLocalOk(successText);
    if (typeof onServiceFlagsUpdated === "function") {
      try {
        await onServiceFlagsUpdated();
      } catch {
        /* no-op: el estado local ya quedó guardado */
      }
    }
  }

  async function saveTableCount() {
    if (!restaurantId) {
      setLocalError("No hay restaurante cargado.");
      return;
    }
    if (savingDelivery || savingTables) return;
    const n = parseInt(String(tablesDraft || "").trim(), 10);
    const clamped = Number.isFinite(n) && n >= 1 && n <= 500 ? n : 12;
    setLocalError("");
    setLocalOk("");
    setSavingTables(true);
    const { error } = await supabase
      .from("restaurants")
      .update({ table_count: clamped })
      .eq("id", restaurantId);
    setSavingTables(false);
    if (error) {
      setLocalError(`No se pudo guardar mesas: ${error.message}`);
      return;
    }
    setTablesDraft(String(clamped));
    setLocalOk(`Cantidad de mesas actualizada: ${clamped}.`);
    if (typeof onTableCountUpdated === "function") {
      try {
        await onTableCountUpdated();
      } catch {
        /* no-op: el estado local ya quedó guardado */
      }
    }
  }

  async function setMesaQrFlag(nextEnabled) {
    if (savingDelivery || savingTables) return;
    if (typeof onMesaQrModuleToggle !== "function") {
      setLocalError("No se pudo actualizar Carta y QR mesas.");
      return;
    }
    setLocalError("");
    setLocalOk("");
    setSavingDelivery(true);
    const result = await onMesaQrModuleToggle(Boolean(nextEnabled));
    setSavingDelivery(false);
    if (!result?.ok) {
      setLocalError("No se pudo guardar Carta y QR mesas.");
      return;
    }
    setLocalOk(nextEnabled ? "Carta y QR mesas habilitado." : "Carta y QR mesas deshabilitado.");
  }

  async function setWaiterFulfillmentSelectorFlag(nextEnabled) {
    if (savingDelivery || savingTables) return;
    if (typeof onWaiterFulfillmentSelectorToggle !== "function") {
      setLocalError("No se pudo actualizar selector de modalidad del mozo.");
      return;
    }
    setLocalError("");
    setLocalOk("");
    setSavingDelivery(true);
    const result = await onWaiterFulfillmentSelectorToggle(Boolean(nextEnabled));
    setSavingDelivery(false);
    if (!result?.ok) {
      setLocalError("No se pudo guardar selector de modalidad del mozo.");
      return;
    }
    setLocalOk(
      nextEnabled
        ? "Selector de modalidad del mozo visible."
        : "Selector de modalidad del mozo oculto."
    );
  }

  async function setBotRuntimeSwitchesVisibleFlag(nextEnabled) {
    if (savingDelivery || savingTables) return;
    if (typeof onBotRuntimeSwitchesVisibleToggle !== "function") {
      setLocalError("No se pudo actualizar controles Bot/Horario.");
      return;
    }
    setLocalError("");
    setLocalOk("");
    setSavingDelivery(true);
    const result = await onBotRuntimeSwitchesVisibleToggle(Boolean(nextEnabled));
    setSavingDelivery(false);
    if (!result?.ok) {
      setLocalError("No se pudo guardar controles Bot/Horario.");
      return;
    }
    setLocalOk(
      nextEnabled
        ? "Controles Bot/Horario visibles en Configuración."
        : "Controles Bot/Horario ocultos en Configuración."
    );
  }

  async function setStockPanelFlag(nextEnabled) {
    if (savingDelivery || savingTables) return;
    if (typeof onStockPanelToggle !== "function") {
      setLocalError("No se pudo actualizar Gestor de stock.");
      return;
    }
    setLocalError("");
    setLocalOk("");
    setSavingDelivery(true);
    const result = await onStockPanelToggle(Boolean(nextEnabled));
    setSavingDelivery(false);
    if (!result?.ok) {
      setLocalError("No se pudo guardar Gestor de stock.");
      return;
    }
    setLocalOk(nextEnabled ? "Gestor de stock visible en el dashboard." : "Gestor de stock oculto en el dashboard.");
  }

  async function copyRestartCommand() {
    try {
      await navigator.clipboard.writeText(restartCommand);
      setCopyOk("Comando copiado.");
      setTimeout(() => setCopyOk(""), 2500);
    } catch (_) {
      setCopyOk("No se pudo copiar automáticamente.");
      setTimeout(() => setCopyOk(""), 2500);
    }
  }

  const busy = savingDelivery || savingTables || !restaurantId || loadingRestaurant;

  return (
    <section className="space-y-4">
      <div className="rounded-xl border border-violet-500/30 bg-violet-950/40 p-6">
        <h2 className="text-lg font-semibold text-violet-100">Módulo Maestro</h2>
        <p className="mt-2 text-sm text-violet-200/90">
          Controles internos del negocio. Activá o desactivá delivery, retiro en local, pedido en mesa y métodos de pago
          para el bot de WhatsApp.
        </p>
        <ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-violet-200/80">
          <li>
            <strong>Delivery:</strong> muestra/oculta la opción de envío a domicilio en el flujo del bot.
          </li>
          <li>
            <strong>Retiro en local:</strong> permite o bloquea pedidos para pasar a buscar.
          </li>
          <li>
            <strong>Pedido en mesa:</strong> habilita o deshabilita la modalidad para clientes en salón.
          </li>
          <li>
            <strong>Estadísticas:</strong> muestra/oculta la pestaña de estadísticas en el panel admin.
          </li>
          <li>
            <strong>Carta y QR mesas:</strong> controla la pestaña específica del dashboard para gestión de QR por mesa.
          </li>
          <li>
            <strong>Gestor de stock:</strong> muestra/oculta la pestaña para administrar inventario y recetario.
          </li>
          <li>
            <strong>Modalidad del mozo:</strong> muestra/oculta el selector Mesa/Delivery en el panel del mozo.
          </li>
          <li>
            <strong>Controles Bot/Horario:</strong> muestra/oculta en Configuración los switches del bot de WhatsApp y
            respeto de horario.
          </li>
          <li>
            <strong>Métodos de pago:</strong> activá/desactivá efectivo y Mercado Pago en el flujo del bot.
          </li>
        </ul>
      </div>

      <div className="rounded-xl border border-slate-700 bg-slate-900 p-6 space-y-5">
        <h3 className="text-sm font-semibold text-slate-200">Servicios habilitados en el bot</h3>
        <p className="mt-1 text-xs text-slate-500">
          Si un servicio está en OFF, el bot no lo muestra como opción. Si los tres quedan en OFF, el bot responde que
          no hay servicios disponibles por el momento.
        </p>

        {loadingRestaurant ? (
          <p className="mt-4 text-sm text-slate-500">Cargando estado…</p>
        ) : !restaurantId ? (
          <p className="mt-4 text-sm text-rose-300">No hay restaurante asociado al panel.</p>
        ) : (
          <>
            <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-slate-200">Envío a domicilio</p>
              <p className="mt-1 text-xs text-slate-500">
                {deliveryEnabled
                  ? "ON · Los clientes pueden elegir delivery en el flujo del bot."
                  : "OFF · El bot no ofrece delivery."}
              </p>
            </div>

            <div className="flex shrink-0 items-center gap-3 sm:gap-4">
              <span
                className={`w-9 text-center text-xs font-bold uppercase tracking-wide ${
                  deliveryEnabled ? "text-slate-500" : "text-rose-300"
                }`}
              >
                Off
              </span>

              <button
                type="button"
                role="switch"
                aria-checked={deliveryEnabled}
                aria-label={
                  deliveryEnabled
                    ? "Delivery activado. Pulsa para desactivar."
                    : "Delivery desactivado. Pulsa para activar."
                }
                disabled={busy}
                onClick={() =>
                  setServiceFlag(
                    "delivery_enabled",
                    !deliveryEnabled,
                    !deliveryEnabled ? "Delivery habilitado." : "Delivery deshabilitado."
                  )
                }
                className={[
                  "relative h-10 w-[4.5rem] shrink-0 rounded-full border border-slate-600/80 transition-colors duration-200",
                  deliveryEnabled ? "bg-emerald-600" : "bg-slate-700",
                  busy ? "cursor-not-allowed opacity-50" : "cursor-pointer",
                  "focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-900"
                ].join(" ")}
              >
                <span
                  aria-hidden
                  className={[
                    "absolute top-1 left-1 block h-8 w-8 rounded-full bg-white shadow-md ring-1 ring-black/10 transition-transform duration-200 ease-out",
                    deliveryEnabled ? "translate-x-8" : "translate-x-0"
                  ].join(" ")}
                />
              </button>

              <span
                className={`w-9 text-center text-xs font-bold uppercase tracking-wide ${
                  deliveryEnabled ? "text-emerald-300" : "text-slate-500"
                }`}
              >
                On
              </span>
            </div>
            </div>

            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-slate-200">Retiro en local</p>
              <p className="mt-1 text-xs text-slate-500">
                {localEnabled
                  ? "ON · El bot permite pedidos para retirar en el local."
                  : "OFF · El bot no ofrece retiro en local."}
              </p>
            </div>

            <div className="flex shrink-0 items-center gap-3 sm:gap-4">
              <span className={`w-9 text-center text-xs font-bold uppercase tracking-wide ${localEnabled ? "text-slate-500" : "text-rose-300"}`}>
                Off
              </span>
              <button
                type="button"
                role="switch"
                aria-checked={localEnabled}
                aria-label={localEnabled ? "Retiro en local activado. Pulsa para desactivar." : "Retiro en local desactivado. Pulsa para activar."}
                disabled={busy}
                onClick={() =>
                  setServiceFlag(
                    "local_enabled",
                    !localEnabled,
                    !localEnabled ? "Retiro en local habilitado." : "Retiro en local deshabilitado."
                  )
                }
                className={[
                  "relative h-10 w-[4.5rem] shrink-0 rounded-full border border-slate-600/80 transition-colors duration-200",
                  localEnabled ? "bg-emerald-600" : "bg-slate-700",
                  busy ? "cursor-not-allowed opacity-50" : "cursor-pointer",
                  "focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-900"
                ].join(" ")}
              >
                <span
                  aria-hidden
                  className={[
                    "absolute top-1 left-1 block h-8 w-8 rounded-full bg-white shadow-md ring-1 ring-black/10 transition-transform duration-200 ease-out",
                    localEnabled ? "translate-x-8" : "translate-x-0"
                  ].join(" ")}
                />
              </button>
              <span className={`w-9 text-center text-xs font-bold uppercase tracking-wide ${localEnabled ? "text-emerald-300" : "text-slate-500"}`}>
                On
              </span>
            </div>
            </div>

            <div className="mt-2 border-t border-slate-800 pt-5">
              <h4 className="text-sm font-semibold text-slate-200">Métodos de pago habilitados en el bot</h4>
              <p className="mt-1 text-xs text-slate-500">
                Si un método está en OFF, el bot no lo ofrece. Si ambos quedan en OFF, responde que no hay medios de pago
                disponibles por el momento.
              </p>
            </div>

            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-slate-200">Efectivo</p>
              <p className="mt-1 text-xs text-slate-500">
                {cashEnabled
                  ? "ON · El bot ofrece pago en efectivo."
                  : "OFF · El bot no ofrece efectivo."}
              </p>
            </div>

            <div className="flex shrink-0 items-center gap-3 sm:gap-4">
              <span className={`w-9 text-center text-xs font-bold uppercase tracking-wide ${cashEnabled ? "text-slate-500" : "text-rose-300"}`}>
                Off
              </span>
              <button
                type="button"
                role="switch"
                aria-checked={cashEnabled}
                aria-label={cashEnabled ? "Efectivo activado. Pulsa para desactivar." : "Efectivo desactivado. Pulsa para activar."}
                disabled={busy}
                onClick={() =>
                  setServiceFlag(
                    "cash_enabled",
                    !cashEnabled,
                    !cashEnabled ? "Efectivo habilitado." : "Efectivo deshabilitado."
                  )
                }
                className={[
                  "relative h-10 w-[4.5rem] shrink-0 rounded-full border border-slate-600/80 transition-colors duration-200",
                  cashEnabled ? "bg-emerald-600" : "bg-slate-700",
                  busy ? "cursor-not-allowed opacity-50" : "cursor-pointer",
                  "focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-900"
                ].join(" ")}
              >
                <span
                  aria-hidden
                  className={[
                    "absolute top-1 left-1 block h-8 w-8 rounded-full bg-white shadow-md ring-1 ring-black/10 transition-transform duration-200 ease-out",
                    cashEnabled ? "translate-x-8" : "translate-x-0"
                  ].join(" ")}
                />
              </button>
              <span className={`w-9 text-center text-xs font-bold uppercase tracking-wide ${cashEnabled ? "text-emerald-300" : "text-slate-500"}`}>
                On
              </span>
            </div>
            </div>

            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-slate-200">Mercado Pago</p>
              <p className="mt-1 text-xs text-slate-500">
                {mercadoPagoEnabled
                  ? "ON · El bot ofrece pago con Mercado Pago."
                  : "OFF · El bot no ofrece Mercado Pago."}
              </p>
            </div>

            <div className="flex shrink-0 items-center gap-3 sm:gap-4">
              <span className={`w-9 text-center text-xs font-bold uppercase tracking-wide ${mercadoPagoEnabled ? "text-slate-500" : "text-rose-300"}`}>
                Off
              </span>
              <button
                type="button"
                role="switch"
                aria-checked={mercadoPagoEnabled}
                aria-label={
                  mercadoPagoEnabled
                    ? "Mercado Pago activado. Pulsa para desactivar."
                    : "Mercado Pago desactivado. Pulsa para activar."
                }
                disabled={busy}
                onClick={() =>
                  setServiceFlag(
                    "mercadopago_enabled",
                    !mercadoPagoEnabled,
                    !mercadoPagoEnabled ? "Mercado Pago habilitado." : "Mercado Pago deshabilitado."
                  )
                }
                className={[
                  "relative h-10 w-[4.5rem] shrink-0 rounded-full border border-slate-600/80 transition-colors duration-200",
                  mercadoPagoEnabled ? "bg-emerald-600" : "bg-slate-700",
                  busy ? "cursor-not-allowed opacity-50" : "cursor-pointer",
                  "focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-900"
                ].join(" ")}
              >
                <span
                  aria-hidden
                  className={[
                    "absolute top-1 left-1 block h-8 w-8 rounded-full bg-white shadow-md ring-1 ring-black/10 transition-transform duration-200 ease-out",
                    mercadoPagoEnabled ? "translate-x-8" : "translate-x-0"
                  ].join(" ")}
                />
              </button>
              <span className={`w-9 text-center text-xs font-bold uppercase tracking-wide ${mercadoPagoEnabled ? "text-emerald-300" : "text-slate-500"}`}>
                On
              </span>
            </div>
            </div>

            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-slate-200">Pedido en mesa</p>
              <p className="mt-1 text-xs text-slate-500">
                {mesaEnabled
                  ? "ON · El bot permite pedidos en mesa."
                  : "OFF · El bot no ofrece pedido en mesa."}
              </p>
            </div>

            <div className="flex shrink-0 items-center gap-3 sm:gap-4">
              <span className={`w-9 text-center text-xs font-bold uppercase tracking-wide ${mesaEnabled ? "text-slate-500" : "text-rose-300"}`}>
                Off
              </span>
              <button
                type="button"
                role="switch"
                aria-checked={mesaEnabled}
                aria-label={mesaEnabled ? "Pedido en mesa activado. Pulsa para desactivar." : "Pedido en mesa desactivado. Pulsa para activar."}
                disabled={busy}
                onClick={() =>
                  setServiceFlag(
                    "mesa_enabled",
                    !mesaEnabled,
                    !mesaEnabled ? "Pedido en mesa habilitado." : "Pedido en mesa deshabilitado."
                  )
                }
                className={[
                  "relative h-10 w-[4.5rem] shrink-0 rounded-full border border-slate-600/80 transition-colors duration-200",
                  mesaEnabled ? "bg-emerald-600" : "bg-slate-700",
                  busy ? "cursor-not-allowed opacity-50" : "cursor-pointer",
                  "focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-900"
                ].join(" ")}
              >
                <span
                  aria-hidden
                  className={[
                    "absolute top-1 left-1 block h-8 w-8 rounded-full bg-white shadow-md ring-1 ring-black/10 transition-transform duration-200 ease-out",
                    mesaEnabled ? "translate-x-8" : "translate-x-0"
                  ].join(" ")}
                />
              </button>
              <span className={`w-9 text-center text-xs font-bold uppercase tracking-wide ${mesaEnabled ? "text-emerald-300" : "text-slate-500"}`}>
                On
              </span>
            </div>
            </div>

            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-slate-200">Estadísticas</p>
              <p className="mt-1 text-xs text-slate-500">
                {statsEnabled
                  ? "ON · Se muestra la pestaña de estadísticas."
                  : "OFF · Se oculta la pestaña de estadísticas."}
              </p>
            </div>

            <div className="flex shrink-0 items-center gap-3 sm:gap-4">
              <span className={`w-9 text-center text-xs font-bold uppercase tracking-wide ${statsEnabled ? "text-slate-500" : "text-rose-300"}`}>
                Off
              </span>
              <button
                type="button"
                role="switch"
                aria-checked={statsEnabled}
                aria-label={statsEnabled ? "Estadísticas activadas. Pulsa para desactivar." : "Estadísticas desactivadas. Pulsa para activar."}
                disabled={busy}
                onClick={() =>
                  setServiceFlag(
                    "stats_enabled",
                    !statsEnabled,
                    !statsEnabled ? "Estadísticas habilitadas." : "Estadísticas deshabilitadas."
                  )
                }
                className={[
                  "relative h-10 w-[4.5rem] shrink-0 rounded-full border border-slate-600/80 transition-colors duration-200",
                  statsEnabled ? "bg-emerald-600" : "bg-slate-700",
                  busy ? "cursor-not-allowed opacity-50" : "cursor-pointer",
                  "focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-900"
                ].join(" ")}
              >
                <span
                  aria-hidden
                  className={[
                    "absolute top-1 left-1 block h-8 w-8 rounded-full bg-white shadow-md ring-1 ring-black/10 transition-transform duration-200 ease-out",
                    statsEnabled ? "translate-x-8" : "translate-x-0"
                  ].join(" ")}
                />
              </button>
              <span className={`w-9 text-center text-xs font-bold uppercase tracking-wide ${statsEnabled ? "text-emerald-300" : "text-slate-500"}`}>
                On
              </span>
            </div>
            </div>

            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-slate-200">Carta y QR mesas (Dashboard)</p>
              <p className="mt-1 text-xs text-slate-500">
                {mesaQrEnabled
                  ? "ON · Se muestra la pestaña de Carta y QR Mesas en el dashboard."
                  : "OFF · Se oculta la pestaña de Carta y QR Mesas en el dashboard."}
              </p>
            </div>

            <div className="flex shrink-0 items-center gap-3 sm:gap-4">
              <span className={`w-9 text-center text-xs font-bold uppercase tracking-wide ${mesaQrEnabled ? "text-slate-500" : "text-rose-300"}`}>
                Off
              </span>
              <button
                type="button"
                role="switch"
                aria-checked={mesaQrEnabled}
                aria-label={mesaQrEnabled ? "Carta y QR mesas activado. Pulsa para desactivar." : "Carta y QR mesas desactivado. Pulsa para activar."}
                disabled={busy}
                onClick={() => setMesaQrFlag(!mesaQrEnabled)}
                className={[
                  "relative h-10 w-[4.5rem] shrink-0 rounded-full border border-slate-600/80 transition-colors duration-200",
                  mesaQrEnabled ? "bg-emerald-600" : "bg-slate-700",
                  busy ? "cursor-not-allowed opacity-50" : "cursor-pointer",
                  "focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-900"
                ].join(" ")}
              >
                <span
                  aria-hidden
                  className={[
                    "absolute top-1 left-1 block h-8 w-8 rounded-full bg-white shadow-md ring-1 ring-black/10 transition-transform duration-200 ease-out",
                    mesaQrEnabled ? "translate-x-8" : "translate-x-0"
                  ].join(" ")}
                />
              </button>
              <span className={`w-9 text-center text-xs font-bold uppercase tracking-wide ${mesaQrEnabled ? "text-emerald-300" : "text-slate-500"}`}>
                On
              </span>
            </div>
            </div>

            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-slate-200">Gestor de stock (Dashboard)</p>
              <p className="mt-1 text-xs text-slate-500">
                {stockPanelEnabled
                  ? "ON · Se muestra la pestaña de Gestor de stock en el dashboard."
                  : "OFF · Se oculta la pestaña de Gestor de stock en el dashboard."}
              </p>
            </div>

            <div className="flex shrink-0 items-center gap-3 sm:gap-4">
              <span className={`w-9 text-center text-xs font-bold uppercase tracking-wide ${stockPanelEnabled ? "text-slate-500" : "text-rose-300"}`}>
                Off
              </span>
              <button
                type="button"
                role="switch"
                aria-checked={stockPanelEnabled}
                aria-label={stockPanelEnabled ? "Gestor de stock activado. Pulsa para desactivar." : "Gestor de stock desactivado. Pulsa para activar."}
                disabled={busy}
                onClick={() => setStockPanelFlag(!stockPanelEnabled)}
                className={[
                  "relative h-10 w-[4.5rem] shrink-0 rounded-full border border-slate-600/80 transition-colors duration-200",
                  stockPanelEnabled ? "bg-emerald-600" : "bg-slate-700",
                  busy ? "cursor-not-allowed opacity-50" : "cursor-pointer",
                  "focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-900"
                ].join(" ")}
              >
                <span
                  aria-hidden
                  className={[
                    "absolute top-1 left-1 block h-8 w-8 rounded-full bg-white shadow-md ring-1 ring-black/10 transition-transform duration-200 ease-out",
                    stockPanelEnabled ? "translate-x-8" : "translate-x-0"
                  ].join(" ")}
                />
              </button>
              <span className={`w-9 text-center text-xs font-bold uppercase tracking-wide ${stockPanelEnabled ? "text-emerald-300" : "text-slate-500"}`}>
                On
              </span>
            </div>
            </div>

            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-slate-200">Controles Bot/Horario en Configuración</p>
              <p className="mt-1 text-xs text-slate-500">
                {botRuntimeSwitchesVisible
                  ? "ON · Configuración muestra los switches Bot de WhatsApp y Respetar horario."
                  : "OFF · Configuración oculta ambos switches."}
              </p>
            </div>

            <div className="flex shrink-0 items-center gap-3 sm:gap-4">
              <span className={`w-9 text-center text-xs font-bold uppercase tracking-wide ${botRuntimeSwitchesVisible ? "text-slate-500" : "text-rose-300"}`}>
                Off
              </span>
              <button
                type="button"
                role="switch"
                aria-checked={botRuntimeSwitchesVisible}
                aria-label={botRuntimeSwitchesVisible ? "Controles Bot/Horario visibles. Pulsa para ocultar." : "Controles Bot/Horario ocultos. Pulsa para mostrar."}
                disabled={busy}
                onClick={() => setBotRuntimeSwitchesVisibleFlag(!botRuntimeSwitchesVisible)}
                className={[
                  "relative h-10 w-[4.5rem] shrink-0 rounded-full border border-slate-600/80 transition-colors duration-200",
                  botRuntimeSwitchesVisible ? "bg-emerald-600" : "bg-slate-700",
                  busy ? "cursor-not-allowed opacity-50" : "cursor-pointer",
                  "focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-900"
                ].join(" ")}
              >
                <span
                  aria-hidden
                  className={[
                    "absolute top-1 left-1 block h-8 w-8 rounded-full bg-white shadow-md ring-1 ring-black/10 transition-transform duration-200 ease-out",
                    botRuntimeSwitchesVisible ? "translate-x-8" : "translate-x-0"
                  ].join(" ")}
                />
              </button>
              <span className={`w-9 text-center text-xs font-bold uppercase tracking-wide ${botRuntimeSwitchesVisible ? "text-emerald-300" : "text-slate-500"}`}>
                On
              </span>
            </div>
            </div>

            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-slate-200">Selector modalidad mozo</p>
              <p className="mt-1 text-xs text-slate-500">
                {waiterFulfillmentSelectorEnabled
                  ? "ON · El mozo puede ver y elegir Mesa o Delivery."
                  : "OFF · El panel del mozo queda fijo en Mesa y oculta el selector."}
              </p>
            </div>

            <div className="flex shrink-0 items-center gap-3 sm:gap-4">
              <span className={`w-9 text-center text-xs font-bold uppercase tracking-wide ${waiterFulfillmentSelectorEnabled ? "text-slate-500" : "text-rose-300"}`}>
                Off
              </span>
              <button
                type="button"
                role="switch"
                aria-checked={waiterFulfillmentSelectorEnabled}
                aria-label={waiterFulfillmentSelectorEnabled ? "Selector modalidad mozo visible. Pulsa para ocultar." : "Selector modalidad mozo oculto. Pulsa para mostrar."}
                disabled={busy}
                onClick={() => setWaiterFulfillmentSelectorFlag(!waiterFulfillmentSelectorEnabled)}
                className={[
                  "relative h-10 w-[4.5rem] shrink-0 rounded-full border border-slate-600/80 transition-colors duration-200",
                  waiterFulfillmentSelectorEnabled ? "bg-emerald-600" : "bg-slate-700",
                  busy ? "cursor-not-allowed opacity-50" : "cursor-pointer",
                  "focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-900"
                ].join(" ")}
              >
                <span
                  aria-hidden
                  className={[
                    "absolute top-1 left-1 block h-8 w-8 rounded-full bg-white shadow-md ring-1 ring-black/10 transition-transform duration-200 ease-out",
                    waiterFulfillmentSelectorEnabled ? "translate-x-8" : "translate-x-0"
                  ].join(" ")}
                />
              </button>
              <span className={`w-9 text-center text-xs font-bold uppercase tracking-wide ${waiterFulfillmentSelectorEnabled ? "text-emerald-300" : "text-slate-500"}`}>
                On
              </span>
            </div>
            </div>
          </>
        )}
      </div>

      <div className="rounded-xl border border-slate-700 bg-slate-900 p-6">
        <h3 className="text-sm font-semibold text-slate-200">Mesas del salón</h3>
        <p className="mt-1 text-xs text-slate-500">
          El bot pregunta número de mesa en “pedido en mesa” y solo acepta valores del 1 al número configurado (por
          defecto 12).
        </p>

        {loadingRestaurant ? (
          <p className="mt-4 text-sm text-slate-500">Cargando…</p>
        ) : !restaurantId ? (
          <p className="mt-4 text-sm text-rose-300">No hay restaurante asociado al panel.</p>
        ) : (
          <div className="mt-4 flex flex-wrap items-end gap-3">
            <label className="space-y-1 text-sm">
              <span className="text-slate-400">Cantidad de mesas</span>
              <input
                type="number"
                min={1}
                max={500}
                disabled={busy}
                value={tablesDraft}
                onChange={(e) => setTablesDraft(e.target.value)}
                className="h-10 w-28 rounded-lg border border-slate-700 bg-slate-950 px-3 text-slate-100 disabled:opacity-50"
              />
            </label>
            <button
              type="button"
              disabled={busy}
              onClick={() => saveTableCount()}
              className="h-10 rounded-lg bg-violet-600 px-4 text-sm font-semibold text-white hover:bg-violet-500 disabled:opacity-50"
            >
              {savingTables ? "Guardando…" : "Guardar mesas"}
            </button>
          </div>
        )}
      </div>

      {localError ? (
        <p className="text-sm text-rose-300" role="alert">
          {localError}
        </p>
      ) : null}
      {localOk ? (
        <div className="space-y-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3" role="status">
          <p className="text-sm text-emerald-300">{localOk}</p>
          <p className="text-xs text-amber-100">
            No te olvides de reiniciar servicios para aplicar cambios en runtime:
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <code className="rounded bg-slate-950 px-2 py-1 text-xs text-amber-200">{restartCommand}</code>
            <button
              type="button"
              onClick={copyRestartCommand}
              className="rounded border border-amber-400/50 bg-amber-500/20 px-2 py-1 text-xs font-semibold text-amber-100 hover:bg-amber-500/30"
            >
              Copiar
            </button>
            {copyOk ? <span className="text-xs text-emerald-300">{copyOk}</span> : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}
