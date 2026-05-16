/**
 * URLs candidatas hacia el HTTP de `index.js` (mesa-api) desde el navegador.
 * Compartido por Maestro, login BD, etc. (proxy /api en Vite o MESA_API_PROXY en Vercel).
 */

export const RESTOBOT_DB_LOGIN_API_PATH = "/api/dashboard/db-login";

export function isHostedOnVercelOrNetlify() {
  const h = String(window.location.hostname || "").toLowerCase();
  return h.endsWith(".vercel.app") || h.endsWith(".netlify.app");
}

export function restobotApiBaseAllowedFromBrowser(baseRaw) {
  const raw = String(baseRaw || "").trim();
  if (!raw) return false;
  if (!window.isSecureContext) return true;
  try {
    const url = new URL(raw.includes("://") ? raw : `https://${raw}`);
    if (url.protocol !== "http:") return true;
    const host = url.hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
  } catch {
    return false;
  }
}

/**
 * @param {string} apiPath ej. "/api/dashboard/db-login"
 * @returns {string[]} URLs absolutas únicas
 */
export function buildRestobotHttpApiCandidates(apiPath) {
  const path = apiPath.startsWith("/") ? apiPath : `/${apiPath}`;
  const candidates = [];
  const push = (baseRaw) => {
    const base = String(baseRaw || "").trim().replace(/\/$/, "");
    if (!base || !restobotApiBaseAllowedFromBrowser(base)) return;
    candidates.push(`${base}${path}`);
  };
  const origin = window.location.origin.replace(/\/$/, "");
  const configuredBase = String(import.meta.env.VITE_MESA_API_BASE_URL || "").trim();
  const configuredBackendPort = String(import.meta.env.VITE_BACKEND_PORT || "").trim() || "3000";
  if (isHostedOnVercelOrNetlify()) {
    push(origin);
    push(configuredBase);
  } else {
    const hostBackendPort = `${window.location.protocol}//${window.location.hostname}:${configuredBackendPort}`;
    push(origin);
    push(configuredBase);
    push(hostBackendPort);
  }
  return [...new Set(candidates)];
}
