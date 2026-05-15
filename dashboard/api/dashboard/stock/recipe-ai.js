/**
 * Proxy Vercel: POST /api/dashboard/stock/recipe-ai → backend (IA recetario en index.js).
 * Usa la misma MESA_API_PROXY_ORIGIN que /api/mesa/order.
 */
import { proxyPostJsonToBackend } from "../../../lib/mesaProxy.js";

export default async function handler(req, res) {
  await proxyPostJsonToBackend(req, res, {
    upstreamPath: "/api/dashboard/stock/recipe-ai",
    timeoutMs: 55000
  });
}
