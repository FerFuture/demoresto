import { useEffect, useMemo, useState } from "react";
import { supabase } from "../supabaseClient";
import { currency } from "../lib/format";
import { resolvePublicDashboardBaseUrl } from "../lib/publicDashboardUrl";
import { buildQrDataUrl, downloadDataUrlAsPng, downloadQrPdf } from "../lib/qrCode";

function normalizeCategory(value) {
  const text = String(value ?? "")
    .trim()
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  return text || "SIN CATEGORIA";
}

/**
 * Panel admin: vista previa del menú, enlace público /menu y QR descargable.
 */
export default function QrMenuPanel({ restaurantId, restaurantMetadata, restaurantName }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [qrPreviewUrl, setQrPreviewUrl] = useState("");
  const [downloadingPdf, setDownloadingPdf] = useState(false);
  const [downloadingPng, setDownloadingPng] = useState(false);
  const [copyOk, setCopyOk] = useState(false);

  const baseUrl = useMemo(
    () => resolvePublicDashboardBaseUrl(restaurantMetadata),
    [restaurantMetadata]
  );

  const menuPublicUrl = useMemo(() => {
    const base = String(baseUrl || "").replace(/\/$/, "");
    if (!base) return "";
    return `${base}/menu`;
  }, [baseUrl]);

  useEffect(() => {
    if (!restaurantId) {
      setItems([]);
      setLoading(false);
      return undefined;
    }
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError("");
      const { data, error: qErr } = await supabase
        .from("menu_items")
        .select("id, name, description, price, category")
        .eq("restaurant_id", restaurantId)
        .order("category", { ascending: true })
        .order("name", { ascending: true });
      if (cancelled) return;
      if (qErr) {
        setError(`No se pudo cargar el menú: ${qErr.message}`);
        setItems([]);
      } else {
        setItems(data || []);
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [restaurantId]);

  useEffect(() => {
    let cancelled = false;
    if (!menuPublicUrl) {
      setQrPreviewUrl("");
      return undefined;
    }
    buildQrDataUrl(menuPublicUrl, { width: 240 })
      .then((dataUrl) => {
        if (!cancelled) setQrPreviewUrl(dataUrl);
      })
      .catch(() => {
        if (!cancelled) setQrPreviewUrl("");
      });
    return () => {
      cancelled = true;
    };
  }, [menuPublicUrl]);

  const grouped = useMemo(() => {
    const map = new Map();
    for (const item of items) {
      const cat = normalizeCategory(item.category);
      if (!map.has(cat)) map.set(cat, []);
      map.get(cat).push(item);
    }
    return Array.from(map.entries()).sort(([a], [b]) =>
      a.localeCompare(b, "es", { sensitivity: "base" })
    );
  }, [items]);

  async function copyLink() {
    if (!menuPublicUrl) return;
    try {
      await navigator.clipboard.writeText(menuPublicUrl);
      setCopyOk(true);
      window.setTimeout(() => setCopyOk(false), 2000);
    } catch {
      setCopyOk(false);
    }
  }

  function pdfFilename() {
    const rid = String(restaurantId || "").trim().slice(0, 8) || "restaurante";
    return `qr-menu-${rid}.pdf`;
  }

  function pngFilename() {
    const rid = String(restaurantId || "").trim().slice(0, 8) || "restaurante";
    return `qr-menu-${rid}.png`;
  }

  async function handleDownloadPdf() {
    if (!menuPublicUrl || downloadingPdf) return;
    setDownloadingPdf(true);
    try {
      const dataUrl = await buildQrDataUrl(menuPublicUrl);
      await downloadQrPdf({
        dataUrl,
        title: restaurantName || "Menú",
        subtitle: "Escaneá para ver el menú (solo consulta)",
        filename: pdfFilename()
      });
    } finally {
      setDownloadingPdf(false);
    }
  }

  async function handleDownloadPng() {
    if (!menuPublicUrl || downloadingPng) return;
    setDownloadingPng(true);
    try {
      const dataUrl = await buildQrDataUrl(menuPublicUrl);
      downloadDataUrlAsPng(dataUrl, pngFilename());
    } finally {
      setDownloadingPng(false);
    }
  }

  return (
    <section className="space-y-4">
      <div className="rounded-xl border border-slate-700 bg-slate-900 p-4">
        <h2 className="text-sm font-semibold text-slate-200">QR Menú</h2>
        <p className="mt-1 text-xs text-slate-400">
          Enlace público al menú con precios, sin pedidos ni carrito. Imprimí el QR para mostrar en el local; los
          cambios del menú se hacen en Gestor de Menú.
        </p>
      </div>

      <div className="rounded-xl border border-violet-500/25 bg-violet-950/15 p-4 space-y-4">
        <div>
          <h3 className="text-sm font-semibold text-violet-100">Enlace y código QR</h3>
          <p className="mt-1 text-xs text-slate-500 leading-relaxed">
            Ruta pública:{" "}
            <code className="rounded bg-slate-950 px-1 text-[11px] text-violet-200">/menu</code>
            {baseUrl ? null : (
              <>
                {" "}
                · Configurá la URL base en Maestro si los QR deben apuntar a otro dominio.
              </>
            )}
          </p>
        </div>

        <div className="block space-y-1 rounded-lg border border-slate-800 bg-slate-950/50 px-3 py-2.5 text-sm">
          <span className="text-slate-400">URL del menú</span>
          <p className="mt-1 break-all font-mono text-xs text-slate-200">{menuPublicUrl || "—"}</p>
        </div>

        {!baseUrl ? (
          <p className="rounded-lg border border-amber-500/35 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
            No hay URL base configurada. Se usará el dominio actual al abrir desde este panel; para QR impreso, guardá la
            URL en Maestro.
          </p>
        ) : null}

        <div className="flex flex-col gap-4 rounded-lg border border-slate-800 bg-slate-950/40 p-4 sm:flex-row sm:items-start">
          <div className="flex flex-col items-start gap-2">
            <button
              type="button"
              disabled={!menuPublicUrl}
              onClick={() => void copyLink()}
              className="rounded border border-slate-600 px-3 py-1.5 text-xs text-slate-200 hover:bg-slate-800 disabled:opacity-50"
            >
              {copyOk ? "Copiado" : "Copiar enlace"}
            </button>
            {menuPublicUrl ? (
              <a
                href={menuPublicUrl}
                target="_blank"
                rel="noreferrer"
                className="rounded border border-violet-500/45 bg-violet-500/10 px-3 py-1.5 text-xs font-medium text-violet-200 hover:bg-violet-500/20"
              >
                Abrir menú público
              </a>
            ) : null}
            <button
              type="button"
              onClick={() => void handleDownloadPdf()}
              disabled={downloadingPdf || !menuPublicUrl}
              className="rounded border border-slate-600 px-3 py-1.5 text-xs text-slate-200 hover:bg-slate-800 disabled:opacity-50"
            >
              {downloadingPdf ? "Generando PDF…" : "Descargar QR (PDF)"}
            </button>
            <button
              type="button"
              onClick={() => void handleDownloadPng()}
              disabled={downloadingPng || !menuPublicUrl}
              className="rounded border border-emerald-500/50 bg-emerald-500/10 px-3 py-1.5 text-xs font-medium text-emerald-200 hover:bg-emerald-500/20 disabled:opacity-50"
            >
              {downloadingPng ? "Generando…" : "Descargar QR (PNG)"}
            </button>
          </div>
          <div className="flex flex-col items-center gap-2 sm:ml-auto">
            {qrPreviewUrl ? (
              <img
                src={qrPreviewUrl}
                alt="QR del menú público"
                className="rounded-lg border border-slate-700 bg-white p-2"
                width={240}
                height={240}
              />
            ) : (
              <div className="flex h-[240px] w-[240px] items-center justify-center rounded-lg border border-dashed border-slate-700 text-xs text-slate-500">
                {menuPublicUrl ? "Generando…" : "Sin URL"}
              </div>
            )}
            <p className="max-w-[240px] text-center text-[11px] text-slate-500">
              Al escanear se abre el menú con precios. No permite armar pedidos desde el celular.
            </p>
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-slate-700 bg-slate-900 p-4">
        <h3 className="text-sm font-semibold text-slate-200">Vista previa (panel)</h3>
        <p className="mt-1 text-xs text-slate-500">Misma carta que verán los clientes al escanear el QR.</p>
      </div>

      {error ? (
        <p className="rounded-lg border border-rose-500/35 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">{error}</p>
      ) : null}

      {loading ? (
        <p className="text-sm text-slate-500">Cargando menú…</p>
      ) : items.length === 0 ? (
        <p className="rounded-xl border border-slate-700 bg-slate-900 p-5 text-sm text-slate-500">
          No hay productos en el menú.
        </p>
      ) : (
        <div className="space-y-6">
          {grouped.map(([category, categoryItems]) => (
            <div key={category} className="rounded-xl border border-slate-700 bg-slate-900 p-4">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-violet-300/90">{category}</h3>
              <ul className="mt-3 divide-y divide-slate-800">
                {categoryItems.map((item) => (
                  <li
                    key={item.id}
                    className="flex flex-col gap-1 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-start sm:justify-between"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="font-medium text-slate-100">{item.name}</p>
                      {item.description ? (
                        <p className="mt-0.5 text-xs text-slate-400">{item.description}</p>
                      ) : null}
                    </div>
                    <p className="shrink-0 text-sm font-semibold tabular-nums text-emerald-300">
                      {currency(item.price)}
                    </p>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
