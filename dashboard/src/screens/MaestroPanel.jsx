/**
 * Panel solo visible para sesión `role === "maestro"` (contraseña VITE_MAESTRO_PASSWORD).
 */
import { useEffect, useMemo, useState } from "react";
import { supabase } from "../supabaseClient";
import { resolvePublicDashboardBaseUrl } from "../lib/publicDashboardUrl";
import { buildRestobotHttpApiCandidates } from "../lib/restobotHttpApi";

const MAESTRO_CREATE_DEMO_PATH = "/api/maestro/create-demo";
const MAESTRO_DELETE_DEMO_PATH = "/api/maestro/delete-demo";
const DEMO_CREATE_TIMEOUT_MS = 45000;

function readDefaultDemoExpiresDaysFromEnv() {
  const raw = String(import.meta.env.VITE_DEFAULT_DEMO_EXPIRES_DAYS || "").trim();
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return 14;
  return Math.min(366, Math.max(1, n));
}

async function fetchWithTimeout(url, options, timeoutMs = DEMO_CREATE_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    window.clearTimeout(timeout);
  }
}

/** Texto en el selector de plantilla (nombre público + interno si difieren). */
function formatRestaurantTemplateLabel(r) {
  const name = String(r.name || "").trim();
  const pub = String(r.public_name || "").trim();
  if (pub && name && pub !== name) return `${pub} — ${name}`;
  return pub || name || "Sin nombre";
}

export default function MaestroPanel({
  restaurantId,
  deliveryEnabled,
  localEnabled,
  mesaEnabled,
  mesaQrEnabled,
  qrMenuEnabled,
  waiterFulfillmentSelectorEnabled,
  botRuntimeSwitchesVisible,
  cashEnabled,
  mercadoPagoEnabled,
  statsEnabled,
  stockPanelEnabled,
  tableCount,
  restaurantMetadata,
  loadingRestaurant,
  onServiceFlagsUpdated,
  onTableCountUpdated,
  onMesaQrModuleToggle,
  onQrMenuPanelToggle,
  onWaiterFulfillmentSelectorToggle,
  onBotRuntimeSwitchesVisibleToggle,
  onStockPanelToggle,
  onPublicDashboardBaseUrlSave
}) {
  const [savingDelivery, setSavingDelivery] = useState(false);
  const [savingTables, setSavingTables] = useState(false);
  const [savingDashboardBase, setSavingDashboardBase] = useState(false);
  const [localError, setLocalError] = useState("");
  const [localOk, setLocalOk] = useState("");
  const [copyOk, setCopyOk] = useState("");
  const [demoTemplateId, setDemoTemplateId] = useState("");
  const [demoSlug, setDemoSlug] = useState("");
  const [demoDisplayName, setDemoDisplayName] = useState("");
  const [demoExpiresDays, setDemoExpiresDays] = useState(() => String(readDefaultDemoExpiresDaysFromEnv()));
  const [demoAdminUser, setDemoAdminUser] = useState("");
  const [demoAdminPass, setDemoAdminPass] = useState("");
  const [demoWhatsapp, setDemoWhatsapp] = useState("");
  const [demoMaestroPass, setDemoMaestroPass] = useState("");
  const [demoCreating, setDemoCreating] = useState(false);
  const [demoDeleting, setDemoDeleting] = useState(false);
  const [demoError, setDemoError] = useState("");
  const [demoDeleteError, setDemoDeleteError] = useState("");
  const [demoOk, setDemoOk] = useState(null);
  const [deleteDemoRestaurantId, setDeleteDemoRestaurantId] = useState("");
  const [templateListVersion, setTemplateListVersion] = useState(0);
  const [templateOptions, setTemplateOptions] = useState([]);
  const [templateListLoading, setTemplateListLoading] = useState(true);
  const [templateListError, setTemplateListError] = useState("");
  const [tablesDraft, setTablesDraft] = useState(String(tableCount ?? 12));
  const [dashboardBaseDraft, setDashboardBaseDraft] = useState("");
  const restartCommand = "docker compose restart restobot dashboard";

  useEffect(() => {
    setTablesDraft(String(tableCount ?? 12));
  }, [tableCount]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setTemplateListLoading(true);
      setTemplateListError("");
      const { data, error } = await supabase
        .from("restaurants")
        .select("id, name, public_name, demo_slug, is_demo")
        .order("name");
      if (cancelled) return;
      setTemplateListLoading(false);
      if (error) {
        setTemplateListError(error.message);
        setTemplateOptions([]);
        return;
      }
      const rows = data || [];
      const counts = new Map();
      for (const r of rows) {
        const lab = formatRestaurantTemplateLabel(r);
        counts.set(lab, (counts.get(lab) || 0) + 1);
      }
      const opts = rows.map((r) => {
        const baseLabel = formatRestaurantTemplateLabel(r);
        const dup = (counts.get(baseLabel) || 0) > 1;
        const demoSlug = String(r.demo_slug ?? "")
          .trim()
          .toLowerCase();
        return {
          id: r.id,
          label: dup ? `${baseLabel} · ${String(r.id).slice(0, 8)}…` : baseLabel,
          demoSlug: demoSlug || null,
          isDemo: Boolean(r.is_demo)
        };
      });
      opts.sort((a, b) => a.label.localeCompare(b.label, "es", { sensitivity: "base" }));
      setTemplateOptions(opts);
    })();
    return () => {
      cancelled = true;
    };
  }, [templateListVersion]);

  useEffect(() => {
    if (!restaurantId || templateOptions.length === 0) return;
    const found = templateOptions.some((o) => o.id === restaurantId);
    if (found) setDemoTemplateId(String(restaurantId));
  }, [restaurantId, templateOptions]);

  useEffect(() => {
    const stored =
      restaurantMetadata &&
      typeof restaurantMetadata === "object" &&
      typeof restaurantMetadata.public_dashboard_base_url === "string"
        ? restaurantMetadata.public_dashboard_base_url.trim()
        : "";
    setDashboardBaseDraft(stored);
  }, [restaurantMetadata]);

  const effectiveDashboardBase = resolvePublicDashboardBaseUrl(restaurantMetadata);

  const selectedTemplateOption = useMemo(
    () => templateOptions.find((o) => o.id === demoTemplateId) ?? null,
    [templateOptions, demoTemplateId]
  );

  const demoDeleteOptions = useMemo(
    () => templateOptions.filter((o) => o.isDemo && o.demoSlug),
    [templateOptions]
  );
  const templateDemoLoginUrl = useMemo(() => {
    const slug = selectedTemplateOption?.demoSlug;
    if (!slug) return "";
    const base = String(effectiveDashboardBase || (typeof window !== "undefined" ? window.location.origin : "") || "")
      .trim()
      .replace(/\/$/, "");
    if (!base) return "";
    return `${base}/d/${encodeURIComponent(slug)}/login`;
  }, [selectedTemplateOption, effectiveDashboardBase]);

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

  async function setQrMenuFlag(nextEnabled) {
    if (savingDelivery || savingTables) return;
    if (typeof onQrMenuPanelToggle !== "function") {
      setLocalError("No se pudo actualizar QR Menú.");
      return;
    }
    setLocalError("");
    setLocalOk("");
    setSavingDelivery(true);
    const result = await onQrMenuPanelToggle(Boolean(nextEnabled));
    setSavingDelivery(false);
    if (!result?.ok) {
      setLocalError("No se pudo guardar QR Menú.");
      return;
    }
    setLocalOk(nextEnabled ? "QR Menú habilitado." : "QR Menú deshabilitado.");
  }

  async function saveDashboardBaseUrl() {
    if (savingDelivery || savingTables || savingDashboardBase) return;
    if (typeof onPublicDashboardBaseUrlSave !== "function") {
      setLocalError("No se pudo guardar la URL base del panel.");
      return;
    }
    setLocalError("");
    setLocalOk("");
    setSavingDashboardBase(true);
    const result = await onPublicDashboardBaseUrlSave(dashboardBaseDraft);
    setSavingDashboardBase(false);
    if (!result?.ok) return;
    setLocalOk(
      result.value
        ? `URL base guardada: ${result.value}`
        : "URL base vacía: se usará VITE_PUBLIC_DASHBOARD_URL o el dominio del panel."
    );
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

  async function copyText(text, okMessage) {
    try {
      await navigator.clipboard.writeText(text);
      setCopyOk(okMessage || "Copiado.");
      setTimeout(() => setCopyOk(""), 2500);
    } catch (_) {
      setCopyOk("No se pudo copiar.");
      setTimeout(() => setCopyOk(""), 2500);
    }
  }

  async function submitCreateDemo() {
    if (demoCreating) return;
    setDemoError("");
    setDemoOk(null);
    const tpl = String(demoTemplateId || "").trim();
    const slug = String(demoSlug || "").trim().toLowerCase().replace(/\s+/g, "-");
    const name = String(demoDisplayName || "").trim();
    const days = parseInt(String(demoExpiresDays || "").trim(), 10);
    const adminU = String(demoAdminUser || "").trim().toLowerCase();
    const adminP = String(demoAdminPass || "");
    const masterP = String(demoMaestroPass || "");

    if (!tpl) {
      setDemoError("Elegí el restaurante plantilla en la lista.");
      return;
    }
    if (!slug || slug.length < 2) {
      setDemoError("Slug del demo: mínimo 2 caracteres (minúsculas, guiones).");
      return;
    }
    if (!name) {
      setDemoError("Falta el nombre del demo.");
      return;
    }
    if (!Number.isFinite(days) || days < 1 || days > 366) {
      setDemoError("Días de validez: entre 1 y 366.");
      return;
    }
    if (adminU.length < 2) {
      setDemoError("Usuario admin demasiado corto.");
      return;
    }
    if (adminP.length < 6) {
      setDemoError("Contraseña admin: mínimo 6 caracteres.");
      return;
    }
    if (!masterP) {
      setDemoError("Falta la contraseña maestro.");
      return;
    }
    const waDigits = String(demoWhatsapp || "")
      .replace(/\D/g, "")
      .trim();
    if (demoWhatsapp.trim() && waDigits.length > 0 && waDigits.length < 8) {
      setDemoError("WhatsApp del demo: al menos 8 dígitos, o dejá el campo vacío para uno automático.");
      return;
    }

    const urls = buildRestobotHttpApiCandidates(MAESTRO_CREATE_DEMO_PATH);
    if (!urls.length) {
      setDemoError(
        "No hay URL de backend permitida desde este navegador. Configurá VITE_MESA_API_BASE_URL (HTTPS) o probá en local."
      );
      return;
    }

    const body = {
      maestroPassword: masterP,
      templateRestaurantId: tpl,
      demoSlug: slug,
      demoName: name,
      expiresDays: days,
      adminUsername: adminU,
      adminPassword: adminP,
      ...(waDigits.length >= 8 ? { demoWhatsappNumber: waDigits } : {})
    };

    setDemoCreating(true);
    let lastErr = "No se pudo contactar el servidor (¿corre index.js y el proxy?).";
    try {
      for (const url of urls) {
        let res;
        try {
          res = await fetchWithTimeout(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body)
          });
        } catch (e) {
          lastErr = e?.name === "AbortError" ? "Tiempo de espera agotado al contactar el backend." : e?.message || lastErr;
          continue;
        }
        const text = await res.text();
        let json;
        try {
          json = text ? JSON.parse(text) : {};
        } catch {
          const snippet = String(text || "").trim().slice(0, 240);
          json = { error: snippet || res.statusText || "Respuesta no JSON del servidor" };
        }
        if (!res.ok) {
          lastErr = json.error || res.statusText || lastErr;
          if (res.status === 403 || res.status === 503 || res.status === 400 || res.status === 409) {
            setDemoError(lastErr);
            return;
          }
          continue;
        }
        const base = String(effectiveDashboardBase || window.location.origin || "").replace(/\/$/, "");
        const loginUrl = `${base}/d/${json.demoSlug}/login`;
        setDemoOk({ ...json, loginUrl });
        setDemoAdminPass("");
        setDemoMaestroPass("");
        setTemplateListVersion((v) => v + 1);
        return;
      }
      const hint404 =
        /not found/i.test(String(lastErr || ""))
          ? " · 404: ese host/puerto no es el index.js con las rutas /api/maestro/create-demo (proceso viejo u otro servicio). Unificá VITE_BACKEND_PORT con el puerto donde publicás el bot (ej. 3001), reiniciá Vite (proxy /api) y quitá o corregí VITE_MESA_API_BASE_URL si apunta al lugar equivocado."
          : "";
      setDemoError(`${lastErr}${hint404}`);
    } finally {
      setDemoCreating(false);
    }
  }

  async function submitDeleteDemo() {
    if (demoDeleting || demoCreating) return;
    setDemoDeleteError("");
    setLocalOk("");
    const opt = demoDeleteOptions.find((o) => o.id === deleteDemoRestaurantId);
    if (!opt?.demoSlug) {
      setDemoDeleteError("Elegí un demo de la lista (solo aparecen filas con is_demo y slug).");
      return;
    }
    const masterP = String(demoMaestroPass || "");
    if (!masterP) {
      setDemoDeleteError("Ingresá la contraseña maestro (la misma que usás para crear demos).");
      return;
    }
    const slug = String(opt.demoSlug).trim();
    const confirmMsg = [
      `¿Eliminar permanentemente el demo "${opt.label}"?`,
      "",
      `URL: /d/${slug}/`,
      "",
      "Se borrarán pedidos, interacciones del bot, ítems de menú y el restaurante (los usuarios del panel de ese local se eliminan en cascada).",
      "",
      "Esta acción no se puede deshacer."
    ].join("\n");
    if (!window.confirm(confirmMsg)) return;

    const urls = buildRestobotHttpApiCandidates(MAESTRO_DELETE_DEMO_PATH);
    if (!urls.length) {
      setDemoDeleteError(
        "No hay URL de backend permitida desde este navegador. Configurá VITE_MESA_API_BASE_URL (HTTPS) o probá en local."
      );
      return;
    }

    const body = { maestroPassword: masterP, demoSlug: slug, restaurantId: opt.id };
    setDemoDeleting(true);
    let lastErr = "No se pudo contactar el servidor.";
    try {
      for (const url of urls) {
        let res;
        try {
          res = await fetchWithTimeout(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body)
          });
        } catch (e) {
          lastErr = e?.name === "AbortError" ? "Tiempo de espera agotado al contactar el backend." : e?.message || lastErr;
          continue;
        }
        const text = await res.text();
        let json;
        try {
          json = text ? JSON.parse(text) : {};
        } catch {
          const snippet = String(text || "").trim().slice(0, 240);
          json = { error: snippet || res.statusText || "Respuesta no JSON del servidor" };
        }
        if (!res.ok) {
          lastErr = json.error || res.statusText || lastErr;
          if (res.status === 403 || res.status === 503 || res.status === 400 || res.status === 404) {
            let errOut = lastErr;
            if (res.status === 404) {
              const le = String(lastErr || "");
              const fromApi = /no existe|no está marcado|demo_slug|inválid|marcado como demo/i.test(le);
              if (!fromApi) {
                errOut = `${lastErr} Si la consola muestra solo «Not Found» sin mensaje JSON de la API, el backend no tiene desplegado POST /api/maestro/delete-demo (en la VPS: git pull, docker compose build restobot, docker compose up -d; en Vercel: redeploy).`;
              }
            }
            setDemoDeleteError(errOut);
            return;
          }
          continue;
        }
        setDeleteDemoRestaurantId("");
        setDemoMaestroPass("");
        if (String(demoTemplateId || "") === String(json.deletedRestaurantId || "")) {
          setDemoTemplateId("");
        }
        setTemplateListVersion((v) => v + 1);
        setLocalOk(`Demo eliminado: /d/${json.demoSlug}/ (${json.name || json.demoSlug}).`);
        return;
      }
      setDemoDeleteError(lastErr);
    } finally {
      setDemoDeleting(false);
    }
  }

  const busy =
    savingDelivery ||
    savingTables ||
    savingDashboardBase ||
    demoCreating ||
    demoDeleting ||
    !restaurantId ||
    loadingRestaurant;

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
            <strong>QR Menú:</strong> muestra/oculta la pestaña del menú con QR/enlace <code className="text-[11px]">/menu</code> (solo lectura, sin pedidos).
          </li>
          <li>
            <strong>Carta y QR mesas:</strong> controla la pestaña específica del dashboard para gestión de QR por mesa.
          </li>
          <li>
            <strong>URL base de QR:</strong> dominio que llevan los enlaces <code className="text-[11px]">/carta</code>{" "}
            (solo editable acá, no en Carta y QR mesas).
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

      <div className="rounded-xl border border-cyan-500/30 bg-cyan-950/25 p-6 space-y-4">
        <h3 className="text-sm font-semibold text-cyan-100">Nuevo demo (clonar desde plantilla)</h3>
        <p className="text-xs text-cyan-100/85 leading-relaxed">
          Crea un restaurante con <code className="text-[11px]">demo_slug</code>, copia el menú desde el restaurante
          plantilla que elijas en la lista y da de alta un usuario admin. Podés indicar un{" "}
          <strong className="text-cyan-100">WhatsApp propio</strong> para el demo (único en la base); si lo dejás vacío,
          el servidor asigna un número interno que no choca con la plantilla. El pedido lo procesa el backend Node (
          <code className="text-[11px]">index.js</code>) con clave de servicio; en el{" "}
          <code className="text-[11px]">.env</code> del servidor tenés que tener{" "}
          <code className="text-[11px]">MAESTRO_PASSWORD</code> o{" "}
          <code className="text-[11px]">VITE_MAESTRO_PASSWORD</code> (misma contraseña que usás para entrar como Maestro
          en este panel).
        </p>
        <p className="text-xs text-cyan-200/70">
          En Vercel, el POST se reenvía con <code className="text-[11px]">MESA_API_PROXY_ORIGIN</code> igual que los pedidos
          QR y el recetario IA. Los invitados del demo entran con su enlace{" "}
          <code className="text-[11px]">/d/slug/login</code>: en <code className="text-[11px]">/login</code> sin slug no
          aplican sus usuarios de base (solo cuentas legado sin <code className="text-[11px]">restaurant_id</code>). Si
          además querés bloquear el acceso <em>solo con contraseña</em> del <code className="text-[11px]">.env</code> en
          esa pantalla, es opcional <code className="text-[11px]">VITE_DEMO_HOST_STRICT_LOGIN=1</code> (no hace falta si
          vos entrás así al panel principal para revisar demos).
        </p>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1 text-sm sm:col-span-2">
            <span className="block text-cyan-200/90">Restaurante plantilla (se copia el menú)</span>
            {templateListLoading ? (
              <p className="text-xs text-cyan-200/70">Cargando restaurantes…</p>
            ) : null}
            {templateListError ? (
              <p className="text-xs text-rose-300" role="alert">
                No se pudo cargar la lista: {templateListError}
              </p>
            ) : null}
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:gap-4">
              <div className="relative min-w-0 max-w-xl flex-1">
                <select
                  value={demoTemplateId}
                  onChange={(e) => setDemoTemplateId(e.target.value)}
                  disabled={demoCreating || templateListLoading || templateOptions.length === 0}
                  aria-label="Elegir restaurante plantilla para clonar el menú"
                  className="h-10 w-full cursor-pointer appearance-none rounded-lg border border-cyan-800/60 bg-slate-950 pl-3 pr-10 text-sm text-slate-100 shadow-sm transition-colors hover:border-cyan-600/50 focus:border-cyan-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/30 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <option value="">Elegí un restaurante plantilla…</option>
                  {templateOptions.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.label}
                    </option>
                  ))}
                </select>
                <span
                  className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-cyan-400/70"
                  aria-hidden
                >
                  <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
                    <path
                      fillRule="evenodd"
                      d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.94a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z"
                      clipRule="evenodd"
                    />
                  </svg>
                </span>
              </div>
              {demoTemplateId && selectedTemplateOption ? (
                templateDemoLoginUrl ? (
                  <div className="flex shrink-0 flex-col gap-1 sm:pb-0.5">
                    <a
                      href={templateDemoLoginUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm font-semibold text-cyan-300 underline decoration-cyan-500/50 underline-offset-2 hover:text-cyan-200"
                    >
                      Login del demo
                    </a>
                    <button
                      type="button"
                      onClick={() => void copyText(templateDemoLoginUrl, "URL de login copiada.")}
                      className="text-left text-[11px] font-medium text-cyan-400/90 hover:text-cyan-300"
                    >
                      Copiar enlace
                    </button>
                  </div>
                ) : (
                  <p className="max-w-xs text-[11px] leading-snug text-cyan-200/65 sm:pb-1">
                    Este local no tiene <code className="text-[10px]">demo_slug</code>: no hay URL{" "}
                    <code className="text-[10px]">/d/…/login</code> hasta asignárselo (SQL o nuevo demo).
                  </p>
                )
              ) : null}
            </div>
            {demoTemplateId ? (
              <p className="font-mono text-[11px] text-cyan-200/50">
                id: {demoTemplateId}
                {selectedTemplateOption?.demoSlug ? (
                  <>
                    {" "}
                    · slug: <span className="text-cyan-200/70">{selectedTemplateOption.demoSlug}</span>
                  </>
                ) : null}
              </p>
            ) : null}
          </div>
          <label className="block space-y-1 text-sm">
            <span className="text-cyan-200/90">Slug URL (/d/…/login)</span>
            <input
              type="text"
              value={demoSlug}
              onChange={(e) => setDemoSlug(e.target.value)}
              placeholder="ej: cliente-acme"
              disabled={demoCreating}
              className="h-10 w-full rounded-lg border border-cyan-800/60 bg-slate-950 px-3 text-sm text-slate-100 disabled:opacity-50"
              autoComplete="off"
            />
          </label>
          <label className="block space-y-1 text-sm">
            <span className="text-cyan-200/90">Nombre del restaurante demo</span>
            <input
              type="text"
              value={demoDisplayName}
              onChange={(e) => setDemoDisplayName(e.target.value)}
              placeholder="Ej: Demo Cliente ACME"
              disabled={demoCreating}
              className="h-10 w-full rounded-lg border border-cyan-800/60 bg-slate-950 px-3 text-sm text-slate-100 disabled:opacity-50"
              autoComplete="off"
            />
          </label>
          <label className="block space-y-1 text-sm sm:col-span-2">
            <span className="text-cyan-200/90">WhatsApp del restaurante demo (opcional)</span>
            <input
              type="text"
              inputMode="numeric"
              value={demoWhatsapp}
              onChange={(e) => setDemoWhatsapp(e.target.value)}
              placeholder="Ej: 56912345678 — vacío = número automático interno"
              disabled={demoCreating}
              className="h-10 w-full max-w-md rounded-lg border border-cyan-800/60 bg-slate-950 px-3 text-sm text-slate-100 disabled:opacity-50"
              autoComplete="off"
            />
            <span className="block text-[11px] text-cyan-200/60">
              Debe ser único (no puede repetir plantilla ni otro local). Solo dígitos; con prefijo país.
            </span>
          </label>
          <label className="block space-y-1 text-sm">
            <span className="text-cyan-200/90">Días hasta expiración</span>
            <input
              type="number"
              min={1}
              max={366}
              value={demoExpiresDays}
              onChange={(e) => setDemoExpiresDays(e.target.value)}
              disabled={demoCreating}
              className="h-10 w-full rounded-lg border border-cyan-800/60 bg-slate-950 px-3 text-sm text-slate-100 disabled:opacity-50"
            />
            <span className="block text-[11px] text-cyan-200/60 leading-snug">
              Valor por defecto del equipo: variable opcional{" "}
              <code className="text-[10px]">VITE_DEFAULT_DEMO_EXPIRES_DAYS</code> (1–366). Al vencer,{" "}
              <code className="text-[10px]">demo_expires_at</code> bloquea el login; borrar datos o filas es Fase 4 del
              roadmap — ver <code className="text-[10px]">dashboard/sql/demo_cleanup_expired.sql</code>.
            </span>
          </label>
          <label className="block space-y-1 text-sm">
            <span className="text-cyan-200/90">Usuario admin del demo</span>
            <input
              type="text"
              value={demoAdminUser}
              onChange={(e) => setDemoAdminUser(e.target.value)}
              placeholder="admin_demo"
              disabled={demoCreating}
              className="h-10 w-full rounded-lg border border-cyan-800/60 bg-slate-950 px-3 text-sm text-slate-100 disabled:opacity-50"
              autoComplete="off"
            />
            <span className="block text-[11px] text-cyan-200/60 leading-snug">
              Este usuario queda ligado al restaurante del demo: solo puede entrar por{" "}
              <code className="text-[10px]">{"/d/{slug}/login"}</code>, no por el login general{" "}
              <code className="text-[10px]">/login</code> (así no se cruza con el panel principal).
            </span>
          </label>
          <label className="block space-y-1 text-sm">
            <span className="text-cyan-200/90">Contraseña admin (nueva)</span>
            <input
              type="password"
              value={demoAdminPass}
              onChange={(e) => setDemoAdminPass(e.target.value)}
              disabled={demoCreating}
              className="h-10 w-full rounded-lg border border-cyan-800/60 bg-slate-950 px-3 text-sm text-slate-100 disabled:opacity-50"
              autoComplete="new-password"
            />
          </label>
          <label className="block space-y-1 text-sm sm:col-span-2">
            <span className="text-cyan-200/90">Contraseña maestro (para autorizar en el servidor)</span>
            <input
              type="password"
              value={demoMaestroPass}
              onChange={(e) => setDemoMaestroPass(e.target.value)}
              disabled={demoCreating || demoDeleting}
              className="h-10 w-full max-w-md rounded-lg border border-cyan-800/60 bg-slate-950 px-3 text-sm text-slate-100 disabled:opacity-50"
              autoComplete="off"
            />
          </label>
        </div>

        {demoError ? (
          <p className="text-sm text-rose-300" role="alert">
            {demoError}
          </p>
        ) : null}
        {demoOk ? (
          <div className="rounded-lg border border-emerald-500/40 bg-emerald-950/30 p-3 text-sm text-emerald-100 space-y-2">
            <p>Demo listo: slug {demoOk.demoSlug}</p>
            <p className="text-xs break-all">
              Login: <span className="font-mono text-emerald-200">{demoOk.loginUrl}</span>
            </p>
            <p className="text-xs text-emerald-200/85 leading-relaxed">
              Carta y pedidos por mesa (mismo menú clonado, aislado de la plantilla):{" "}
              <span className="font-mono text-emerald-200/90">
                {String(effectiveDashboardBase || (typeof window !== "undefined" ? window.location.origin : "") || "")
                  .replace(/\/$/, "")}
                /d/{demoOk.demoSlug}/carta?mesa=1
              </span>
              {" · "}
              <span className="font-mono text-emerald-200/90">
                {String(effectiveDashboardBase || (typeof window !== "undefined" ? window.location.origin : "") || "")
                  .replace(/\/$/, "")}
                /d/{demoOk.demoSlug}/menu
              </span>{" "}
              (QR desde el admin del demo: pestañas QR Menú y Carta y QR mesas).
            </p>
            <p className="text-xs text-emerald-200/80">
              Platos copiados: {demoOk.menuItemCount ?? "—"} · expira: {demoOk.demoExpiresAt || "—"}
              {demoOk.demoWhatsappNumber ? (
                <>
                  {" "}
                  · WhatsApp: <span className="font-mono text-emerald-200/90">{demoOk.demoWhatsappNumber}</span>
                </>
              ) : null}
            </p>
            <button
              type="button"
              onClick={() => void copyText(demoOk.loginUrl, "URL copiada.")}
              className="rounded border border-emerald-400/40 bg-emerald-600/30 px-2 py-1 text-xs font-semibold text-emerald-50 hover:bg-emerald-600/45"
            >
              Copiar URL de login
            </button>
          </div>
        ) : null}

        <button
          type="button"
          disabled={demoCreating}
          onClick={() => void submitCreateDemo()}
          className="rounded-lg bg-cyan-600 px-4 py-2 text-sm font-semibold text-white hover:bg-cyan-500 disabled:opacity-50"
        >
          {demoCreating ? "Creando demo…" : "Crear demo"}
        </button>

        <div className="border-t border-rose-500/25 pt-4 mt-1 space-y-3">
          <h4 className="text-sm font-semibold text-rose-100">Eliminar demo</h4>
          <p className="text-xs text-rose-100/80 leading-relaxed">
            Quitá demos que ya no necesitás para que no se acumulen en la base antes del vencimiento. Solo aparecen
            locales con <code className="text-[10px]">is_demo = true</code> y slug; no se puede borrar una plantilla ni
            un cliente sin ese flag.
          </p>
          <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
            <div className="min-w-0 max-w-xl flex-1 space-y-1">
              <span className="block text-xs text-rose-200/90">Demo a eliminar</span>
              <div className="relative">
                <select
                  value={deleteDemoRestaurantId}
                  onChange={(e) => {
                    setDeleteDemoRestaurantId(e.target.value);
                    setDemoDeleteError("");
                  }}
                  disabled={demoDeleting || demoCreating || templateListLoading || demoDeleteOptions.length === 0}
                  aria-label="Elegir demo para eliminar"
                  className="h-10 w-full cursor-pointer appearance-none rounded-lg border border-rose-800/50 bg-slate-950 pl-3 pr-10 text-sm text-slate-100 shadow-sm transition-colors hover:border-rose-600/40 focus:border-rose-500 focus:outline-none focus:ring-2 focus:ring-rose-500/30 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <option value="">Elegí un demo…</option>
                  {demoDeleteOptions.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.label} · /d/{o.demoSlug}/
                    </option>
                  ))}
                </select>
                <span
                  className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-rose-400/70"
                  aria-hidden
                >
                  <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
                    <path
                      fillRule="evenodd"
                      d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.94a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z"
                      clipRule="evenodd"
                    />
                  </svg>
                </span>
              </div>
            </div>
            <button
              type="button"
              disabled={demoDeleting || demoCreating || !deleteDemoRestaurantId}
              onClick={() => void submitDeleteDemo()}
              className="h-10 shrink-0 rounded-lg border border-rose-500/50 bg-rose-900/40 px-4 text-sm font-semibold text-rose-50 hover:bg-rose-800/50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {demoDeleting ? "Eliminando…" : "Eliminar demo"}
            </button>
          </div>
          <p className="text-[11px] text-rose-200/60">
            Usá la misma <strong className="text-rose-100/90">contraseña maestro</strong> que en el formulario de arriba
            (se envía al backend con el POST).
          </p>
          {demoDeleteError ? (
            <p className="text-sm text-rose-300" role="alert">
              {demoDeleteError}
            </p>
          ) : null}
        </div>
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
              <p className="text-sm font-medium text-slate-200">QR Menú (Dashboard)</p>
              <p className="mt-1 text-xs text-slate-500">
                {qrMenuEnabled
                  ? "ON · Se muestra la pestaña QR Menú con el menú y precios (solo lectura)."
                  : "OFF · Se oculta la pestaña QR Menú en el dashboard."}
              </p>
            </div>

            <div className="flex shrink-0 items-center gap-3 sm:gap-4">
              <span className={`w-9 text-center text-xs font-bold uppercase tracking-wide ${qrMenuEnabled ? "text-slate-500" : "text-rose-300"}`}>
                Off
              </span>
              <button
                type="button"
                role="switch"
                aria-checked={qrMenuEnabled}
                aria-label={qrMenuEnabled ? "QR Menú activado. Pulsa para desactivar." : "QR Menú desactivado. Pulsa para activar."}
                disabled={busy}
                onClick={() => setQrMenuFlag(!qrMenuEnabled)}
                className={[
                  "relative h-10 w-[4.5rem] shrink-0 rounded-full border border-slate-600/80 transition-colors duration-200",
                  qrMenuEnabled ? "bg-emerald-600" : "bg-slate-700",
                  busy ? "cursor-not-allowed opacity-50" : "cursor-pointer",
                  "focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-900"
                ].join(" ")}
              >
                <span
                  aria-hidden
                  className={[
                    "absolute top-1 left-1 block h-8 w-8 rounded-full bg-white shadow-md ring-1 ring-black/10 transition-transform duration-200 ease-out",
                    qrMenuEnabled ? "translate-x-8" : "translate-x-0"
                  ].join(" ")}
                />
              </button>
              <span className={`w-9 text-center text-xs font-bold uppercase tracking-wide ${qrMenuEnabled ? "text-emerald-300" : "text-slate-500"}`}>
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

            <div className="rounded-lg border border-violet-500/25 bg-violet-950/20 p-4 space-y-3">
              <div>
                <p className="text-sm font-medium text-slate-200">URL base del panel (QR y carta)</p>
                <p className="mt-1 text-xs text-slate-500">
                  Dominio público sin barra final. Los QR usan esta URL +{" "}
                  <code className="text-[11px]">/carta?mesa=…</code>. En Carta y QR mesas solo se muestra.
                </p>
              </div>
              <label className="block space-y-1 text-sm">
                <span className="text-slate-400">URL guardada (vacío = build o dominio actual)</span>
                <input
                  type="url"
                  value={dashboardBaseDraft}
                  onChange={(e) => setDashboardBaseDraft(e.target.value)}
                  placeholder="Ej: https://demo.mesafood.shop"
                  disabled={busy || savingDashboardBase}
                  className="h-10 w-full max-w-xl rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm text-slate-100 disabled:opacity-50"
                  autoComplete="off"
                />
              </label>
              <p className="text-xs text-slate-500">
                En uso ahora: <span className="font-mono text-slate-300">{effectiveDashboardBase || "—"}</span>
              </p>
              <button
                type="button"
                disabled={busy || savingDashboardBase || !restaurantId}
                onClick={() => void saveDashboardBaseUrl()}
                className="rounded-lg bg-violet-600 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-500 disabled:opacity-50"
              >
                {savingDashboardBase ? "Guardando…" : "Guardar URL base"}
              </button>
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
