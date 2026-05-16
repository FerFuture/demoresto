/**
 * Proxy Vercel: POST /api/dashboard/db-login → index.js (verificación bcrypt con service role).
 */
import { proxyPostJsonToBackend } from "../../lib/mesaProxy.js";

export default async function handler(req, res) {
  await proxyPostJsonToBackend(req, res, {
    upstreamPath: "/api/dashboard/db-login",
    timeoutMs: 20000
  });
}
