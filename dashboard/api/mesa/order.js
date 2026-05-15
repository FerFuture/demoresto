/**
 * Proxy Vercel: POST /api/mesa/order → backend (pedidos carta QR en index.js).
 */
import { proxyPostJsonToBackend } from "../../lib/mesaProxy.js";

export default async function handler(req, res) {
  await proxyPostJsonToBackend(req, res, {
    upstreamPath: "/api/mesa/order",
    timeoutMs: 28000
  });
}
