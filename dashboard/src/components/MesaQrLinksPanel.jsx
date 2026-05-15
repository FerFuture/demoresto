import { useEffect, useMemo, useState } from "react";
import { jsPDF } from "jspdf";
import QRCode from "qrcode";
import { signMesaTableToken } from "../lib/mesaQrToken";
import { resolvePublicDashboardBaseUrl } from "../lib/publicDashboardUrl";
import { supabase } from "../supabaseClient";

function normalizeBlockedMesaTables(value, maxTableCount = 500) {
  if (!Array.isArray(value)) return [];
  const max = Number.isFinite(maxTableCount) && maxTableCount >= 1 ? Math.floor(maxTableCount) : 500;
  return [...new Set(value.map((entry) => Number(entry)).filter((entry) => Number.isFinite(entry) && entry >= 1 && entry <= max))]
    .sort((a, b) => a - b);
}

/**
 * Gestión de URLs del panel cliente por mesa (para QR). Misma ruta /carta para todos;
 * la mesa va en ?mesa=N y el token en ?t=... Visible en Admin (menú) y Maestro.
 */
export default function MesaQrLinksPanel({
  restaurantId,
  tableCount,
  qrModuleEnabled,
  restaurantMetadata,
  onRestaurantMetadataChange
}) {
  const secret = String(import.meta.env.VITE_MESA_QR_SECRET || "").trim();
  const baseUrl = useMemo(
    () => resolvePublicDashboardBaseUrl(restaurantMetadata),
    [restaurantMetadata]
  );
  const [rows, setRows] = useState([]);
  const [previewTable, setPreviewTable] = useState(1);
  const [qrPreviewUrl, setQrPreviewUrl] = useState("");
  const [downloadingSingle, setDownloadingSingle] = useState(false);
  const [downloadingAll, setDownloadingAll] = useState(false);
  const [savingBlockedTable, setSavingBlockedTable] = useState(null);
  const [blockedTablesFlash, setBlockedTablesFlash] = useState("");

  const n = useMemo(() => {
    const t = Number(tableCount);
    if (!Number.isFinite(t) || t < 1) return 0;
    return Math.min(500, Math.floor(t));
  }, [tableCount]);

  const blockedTables = useMemo(
    () => normalizeBlockedMesaTables(restaurantMetadata?.mesa_qr_blocked_tables, n || 500),
    [restaurantMetadata, n]
  );
  const previewTableBlocked = blockedTables.includes(previewTable);

  useEffect(() => {
    if (n >= 1 && (previewTable < 1 || previewTable > n)) {
      setPreviewTable((t) => (t < 1 || t > n ? 1 : t));
    }
  }, [n, previewTable]);

  useEffect(() => {
    let cancelled = false;
    const rid = String(restaurantId || "").trim();
    if (!rid || !n || !qrModuleEnabled) {
      setRows([]);
      return undefined;
    }
    const base = String(baseUrl || "").replace(/\/$/, "");

    (async () => {
      const out = [];
      for (let table = 1; table <= n; table += 1) {
        let url = `${base}/carta?mesa=${encodeURIComponent(String(table))}`;
        if (secret) {
          const tok = await signMesaTableToken(rid, table, secret);
          if (tok) url += `&t=${encodeURIComponent(tok)}`;
        }
        out.push({ table, url });
      }
      if (!cancelled) setRows(out);
    })();

    return () => {
      cancelled = true;
    };
  }, [restaurantId, n, baseUrl, secret, qrModuleEnabled]);

  useEffect(() => {
    let cancelled = false;
    const row = rows.find((r) => r.table === previewTable);
    if (!row?.url) {
      setQrPreviewUrl("");
      return undefined;
    }
    buildQrDataUrl(row.url, { width: 240 })
      .then((dataUrl) => {
        if (!cancelled) setQrPreviewUrl(dataUrl);
      })
      .catch(() => {
        if (!cancelled) setQrPreviewUrl("");
      });
    return () => {
      cancelled = true;
    };
  }, [rows, previewTable]);

  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      /* ignore */
    }
  }

  function buildQrDataUrl(url, { width = 960 } = {}) {
    return QRCode.toDataURL(url, {
      margin: 1,
      width,
      errorCorrectionLevel: "M",
      color: { dark: "#0f172a", light: "#ffffff" }
    });
  }

  function baseFilename(prefix) {
    const rid = String(restaurantId || "").trim().slice(0, 8) || "restaurante";
    return `${prefix}-${rid}`;
  }

  async function togglePreviewTableBlocked() {
    if (!restaurantId || !previewTable || savingBlockedTable) return;
    setSavingBlockedTable(previewTable);
    setBlockedTablesFlash("");
    try {
      const currentMetadata =
        restaurantMetadata && typeof restaurantMetadata === "object" && !Array.isArray(restaurantMetadata)
          ? restaurantMetadata
          : {};
      const nextBlockedTables = previewTableBlocked
        ? blockedTables.filter((table) => table !== previewTable)
        : [...blockedTables, previewTable].sort((a, b) => a - b);
      const nextMetadata = {
        ...currentMetadata,
        mesa_qr_blocked_tables: nextBlockedTables
      };
      const { error } = await supabase.from("restaurants").update({ metadata: nextMetadata }).eq("id", restaurantId);
      if (error) throw error;
      if (typeof onRestaurantMetadataChange === "function") {
        onRestaurantMetadataChange(nextMetadata);
      }
      setBlockedTablesFlash(
        previewTableBlocked
          ? `Mesa ${previewTable} disponible nuevamente para pedidos QR.`
          : `Mesa ${previewTable} bloqueada para pedidos QR.`
      );
    } catch (error) {
      setBlockedTablesFlash(`No se pudo actualizar la mesa ${previewTable}: ${error?.message || error}`);
    } finally {
      setSavingBlockedTable(null);
    }
  }

  async function downloadSingleQr() {
    const row = rows.find((r) => r.table === previewTable);
    if (!row?.url || downloadingSingle) return;
    setDownloadingSingle(true);
    try {
      const dataUrl = await buildQrDataUrl(row.url);
      const pdf = new jsPDF({ unit: "mm", format: "a4" });
      const pageWidth = pdf.internal.pageSize.getWidth();
      const qrSize = 90;
      const qrX = (pageWidth - qrSize) / 2;
      const qrY = 40;
      pdf.setFont("helvetica", "bold");
      pdf.setFontSize(18);
      pdf.text(`Mesa ${row.table}`, pageWidth / 2, 24, { align: "center" });
      pdf.addImage(dataUrl, "PNG", qrX, qrY, qrSize, qrSize);
      pdf.setFont("helvetica", "normal");
      pdf.setFontSize(12);
      pdf.text("Escaneá para abrir la carta de esta mesa", pageWidth / 2, qrY + qrSize + 12, {
        align: "center"
      });
      pdf.save(`${baseFilename(`qr-mesa-${row.table}`)}.pdf`);
    } finally {
      setDownloadingSingle(false);
    }
  }

  async function downloadAllQrsPdf() {
    if (!rows.length || downloadingAll) return;
    setDownloadingAll(true);
    try {
      const pdf = new jsPDF({ unit: "mm", format: "a4" });
      const pageWidth = pdf.internal.pageSize.getWidth();
      const marginX = 10;
      const marginY = 10;
      const columnGap = 8;
      const rowGap = 8;
      const cellWidth = (pageWidth - marginX * 2 - columnGap) / 2;
      const cellHeight = 86;
      const cardSize = 86;
      const qrSize = 62;
      const cardRadius = 4;
      const maxPerPage = 6;
      let indexOnPage = 0;

      pdf.setFont("helvetica", "normal");
      pdf.setFontSize(11);

      for (let i = 0; i < rows.length; i += 1) {
        if (i > 0 && indexOnPage === 0) {
          pdf.addPage();
        }

        const row = rows[i];
        const dataUrl = await buildQrDataUrl(row.url);
        const col = indexOnPage % 2;
        const pageRow = Math.floor(indexOnPage / 2);
        const baseX = marginX + col * (cellWidth + columnGap);
        const baseY = marginY + pageRow * (cellHeight + rowGap);

        const cardX = baseX + (cellWidth - cardSize) / 2;
        const cardY = baseY;
        const qrX = cardX + (cardSize - qrSize) / 2;
        const qrY = cardY + 8;

        pdf.setDrawColor(148, 163, 184);
        pdf.setLineWidth(0.5);
        pdf.roundedRect(cardX, cardY, cardSize, cardSize, cardRadius, cardRadius);
        pdf.addImage(dataUrl, "PNG", qrX, qrY, qrSize, qrSize);
        pdf.setFont("helvetica", "bold");
        pdf.setFontSize(12);
        pdf.text(`Mesa ${row.table}`, cardX + cardSize / 2, cardY + cardSize - 8, {
          align: "center"
        });
        indexOnPage += 1;

        if (indexOnPage >= maxPerPage) {
          indexOnPage = 0;
        }
      }

      pdf.save(`${baseFilename("qrs-mesas")}.pdf`);
    } finally {
      setDownloadingAll(false);
    }
  }

  if (!qrModuleEnabled) {
    return (
      <div className="rounded-xl border border-slate-700 bg-slate-900 p-6">
        <h3 className="text-sm font-semibold text-slate-200">QR / pedido por mesa</h3>
        <p className="mt-2 text-xs text-slate-500">
          Activá <strong className="text-slate-400">Carta y QR mesas</strong> en el módulo Maestro para generar enlaces.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-slate-700 bg-slate-900 p-6 space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-slate-200">Carta y QR por mesa</h3>
        <p className="mt-1 text-xs text-slate-500 leading-relaxed">
          Todos los clientes usan la misma ruta <code className="rounded bg-slate-950 px-1 text-[11px] text-violet-200">/carta</code>
          ; cada QR añade <code className="rounded bg-slate-950 px-1 text-[11px] text-violet-200">mesa</code> y, si está
          configurado, un token para que el pedido a cocina quede en esa mesa. La ruta antigua{" "}
          <code className="rounded bg-slate-950 px-1 text-[11px] text-slate-400">/mesa/N</code> sigue funcionando.
        </p>
      </div>

      <div className="block space-y-1 rounded-lg border border-slate-800 bg-slate-950/50 px-3 py-2.5 text-sm">
        <span className="text-slate-400">URL base de los QR</span>
        <p className="mt-1 break-all font-mono text-xs text-slate-200">{baseUrl || "—"}</p>
      </div>

      {!secret ? (
        <p className="rounded-lg border border-amber-500/35 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
          Falta secreto: para usar pedido por QR sin que puedan cambiar de mesa, tenés que configurar{" "}
          <code className="text-[11px]">MESA_QR_SECRET</code> en el servidor y{" "}
          <code className="text-[11px]">VITE_MESA_QR_SECRET</code> (mismo valor) en el build del dashboard.
        </p>
      ) : (
        <p className="rounded-lg border border-emerald-500/30 bg-emerald-950/30 px-3 py-2 text-xs text-emerald-100/95">
          Token activo: el servidor solo acepta pedidos si el token coincide con restaurante y mesa.
        </p>
      )}

      <div className="rounded-lg border border-slate-800 bg-slate-950/40 px-3 py-3">
        <p className="text-xs font-medium text-slate-300">Mesas bloqueadas</p>
        {blockedTables.length ? (
          <div className="mt-2 flex flex-wrap gap-2">
            {blockedTables.map((table) => (
              <span
                key={table}
                className="rounded-full border border-rose-500/35 bg-rose-500/10 px-2.5 py-1 text-xs font-medium text-rose-200"
              >
                Mesa {table}
              </span>
            ))}
          </div>
        ) : (
          <p className="mt-2 text-xs text-slate-500">No hay mesas bloqueadas en este momento.</p>
        )}
      </div>

      {blockedTablesFlash ? (
        <p
          className={`rounded-lg px-3 py-2 text-xs ${
            blockedTablesFlash.startsWith("No se pudo")
              ? "border border-rose-500/35 bg-rose-500/10 text-rose-200"
              : "border border-emerald-500/30 bg-emerald-950/30 text-emerald-100/95"
          }`}
        >
          {blockedTablesFlash}
        </p>
      ) : null}

      {!restaurantId || n < 1 ? (
        <p className="text-sm text-slate-500">Definí la cantidad de mesas para generar enlaces y QR.</p>
      ) : (
        <>
          <div className="flex flex-col gap-4 rounded-lg border border-slate-800 bg-slate-950/40 p-4 sm:flex-row sm:items-start">
            <div className="space-y-2">
              <label className="block text-xs font-medium text-slate-400">Vista previa — elegí la mesa</label>
              <select
                value={previewTable}
                onChange={(e) => setPreviewTable(Number(e.target.value))}
                className="h-10 rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm text-slate-100"
              >
                {rows.map((row) => (
                  <option key={row.table} value={row.table}>
                    Mesa {row.table}
                  </option>
                ))}
              </select>
              <div className="rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2 text-xs">
                <span className="text-slate-400">Estado actual:</span>{" "}
                <span
                  className={
                    previewTableBlocked ? "font-semibold text-rose-300" : "font-semibold text-emerald-300"
                  }
                >
                  {previewTableBlocked ? "Bloqueada" : "Disponible"}
                </span>
              </div>
              <div className="flex flex-col items-start gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => {
                    void togglePreviewTableBlocked();
                  }}
                  disabled={savingBlockedTable === previewTable}
                  className={`rounded border px-3 py-1.5 text-xs font-medium disabled:opacity-50 ${
                    previewTableBlocked
                      ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-200 hover:bg-emerald-500/20"
                      : "border-rose-500/45 bg-rose-500/10 text-rose-200 hover:bg-rose-500/20"
                  }`}
                >
                  {savingBlockedTable === previewTable
                    ? "Guardando..."
                    : previewTableBlocked
                      ? "Marcar disponible"
                      : "Bloquear mesa"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const row = rows.find((r) => r.table === previewTable);
                    if (row) copy(row.url);
                  }}
                  className="rounded border border-slate-600 px-3 py-1.5 text-xs text-slate-200 hover:bg-slate-800"
                >
                  Copiar enlace
                </button>
                <button
                  type="button"
                  onClick={() => {
                    void downloadSingleQr();
                  }}
                  disabled={downloadingSingle || !rows.length}
                  className="rounded border border-slate-600 px-3 py-1.5 text-xs text-slate-200 hover:bg-slate-800 disabled:opacity-50"
                >
                  {downloadingSingle ? "Generando..." : "Descargar QR"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    void downloadAllQrsPdf();
                  }}
                  disabled={downloadingAll || !rows.length}
                  className="rounded border border-emerald-500/50 bg-emerald-500/10 px-3 py-1.5 text-xs font-medium text-emerald-200 hover:bg-emerald-500/20 disabled:opacity-50"
                >
                  {downloadingAll ? "Generando PDF..." : "Descargar QRs"}
                </button>
              </div>
            </div>
            <div className="flex flex-col items-center gap-2 sm:ml-auto">
              {qrPreviewUrl ? (
                <img
                  src={qrPreviewUrl}
                  alt={`QR mesa ${previewTable}`}
                  className="rounded-lg border border-slate-700 bg-white p-2"
                  width={240}
                  height={240}
                />
              ) : (
                <div className="flex h-[240px] w-[240px] items-center justify-center rounded-lg border border-dashed border-slate-700 text-xs text-slate-500">
                  Generando...
                </div>
              )}
              <p className="max-w-[240px] text-center text-[11px] text-slate-500">
                Imprimí o mostrá este código; al escanearlo se abre la carta y los pedidos van a esta mesa.
              </p>
            </div>
          </div>

          <div className="max-h-80 overflow-y-auto rounded-lg border border-slate-800">
            <table className="w-full text-left text-sm">
              <thead className="sticky top-0 bg-slate-950/95 text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-3 py-2">Mesa</th>
                  <th className="px-3 py-2">Enlace</th>
                  <th className="px-3 py-2 w-24">Copiar</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.table} className="border-t border-slate-800/80">
                    <td className="px-3 py-2 font-semibold text-slate-200">{row.table}</td>
                    <td className="px-3 py-2 break-all font-mono text-[11px] text-slate-400">{row.url}</td>
                    <td className="px-3 py-2">
                      <button
                        type="button"
                        onClick={() => copy(row.url)}
                        className="rounded border border-slate-600 px-2 py-1 text-xs text-slate-200 hover:bg-slate-800"
                      >
                        Copiar
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
