/**
 * URL pública del dashboard para enlaces /carta y códigos QR.
 * Orden: metadata del restaurante → VITE_PUBLIC_DASHBOARD_URL → origin del navegador.
 */
export function resolvePublicDashboardBaseUrl(metadata) {
  const metaObj =
    metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata : null;
  const fromMeta =
    typeof metaObj?.public_dashboard_base_url === "string"
      ? metaObj.public_dashboard_base_url.trim().replace(/\/$/, "")
      : "";
  if (fromMeta) return fromMeta;

  const fromEnv = String(import.meta.env.VITE_PUBLIC_DASHBOARD_URL || "")
    .trim()
    .replace(/\/$/, "");
  if (fromEnv) return fromEnv;

  if (typeof window !== "undefined") {
    return String(window.location.origin || "")
      .trim()
      .replace(/\/$/, "");
  }
  return "";
}

export function normalizePublicDashboardBaseUrlInput(value) {
  return String(value || "")
    .trim()
    .replace(/\/$/, "");
}

export function isValidPublicDashboardBaseUrl(value) {
  const normalized = normalizePublicDashboardBaseUrlInput(value);
  if (!normalized) return true;
  try {
    const url = new URL(normalized.includes("://") ? normalized : `https://${normalized}`);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
