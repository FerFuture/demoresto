/**
 * Proxy Vercel: POST /api/maestro/delete-demo → backend (borrar tenant demo en index.js).
 * Usa la misma MESA_API_PROXY_ORIGIN que create-demo.
 */
import { proxyPostJsonToBackend } from "../../lib/mesaProxy.js";

export default async function handler(req, res) {
  await proxyPostJsonToBackend(req, res, {
    upstreamPath: "/api/maestro/delete-demo",
    timeoutMs: 45000
  });
}
