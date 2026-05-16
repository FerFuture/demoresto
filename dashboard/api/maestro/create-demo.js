/**
 * Proxy Vercel: POST /api/maestro/create-demo → backend (provisionar tenant demo en index.js).
 * Usa la misma MESA_API_PROXY_ORIGIN que /api/mesa/order.
 */
import { proxyPostJsonToBackend } from "../../lib/mesaProxy.js";

export default async function handler(req, res) {
  await proxyPostJsonToBackend(req, res, {
    upstreamPath: "/api/maestro/create-demo",
    timeoutMs: 45000
  });
}
