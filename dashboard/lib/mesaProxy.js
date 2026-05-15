/**
 * Utilidad compartida para proxies Vercel → backend Node (`index.js` en la VPS).
 * Variables (URL base sin path), la primera definida gana:
 * - MESA_API_PROXY_ORIGIN
 * - MESA_API_BASE_URL
 * - VITE_MESA_API_BASE_URL
 */

export function resolveMesaProxyOrigin() {
  for (const key of ["MESA_API_PROXY_ORIGIN", "MESA_API_BASE_URL", "VITE_MESA_API_BASE_URL"]) {
    const base = String(process.env[key] || "")
      .trim()
      .replace(/\/$/, "");
    if (base) return base;
  }
  return "";
}

export const MESA_PROXY_MISSING_ENV_ERROR =
  "Falta la URL del backend en Vercel: agregá MESA_API_PROXY_ORIGIN (recomendado) o MESA_API_BASE_URL con la URL base del servidor donde corre index.js, sin /api al final. Ejemplo con Docker 3001:3000: http://TU_IP:3001";

function readStream(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export async function getRawBody(req) {
  if (req.body != null && typeof req.body === "object" && !Buffer.isBuffer(req.body)) {
    return JSON.stringify(req.body);
  }
  if (typeof req.body === "string" && req.body.length > 0) {
    return req.body;
  }
  const fromStream = await readStream(req);
  return fromStream || "{}";
}

/**
 * Reenvía POST JSON al backend y copia status + cuerpo.
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {{ upstreamPath: string, timeoutMs?: number }} options
 */
export async function proxyPostJsonToBackend(req, res, { upstreamPath, timeoutMs = 28000 }) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ error: "Método no permitido" });
    return;
  }

  const base = resolveMesaProxyOrigin();
  if (!base) {
    res.status(503).json({ error: MESA_PROXY_MISSING_ENV_ERROR });
    return;
  }

  let bodyText;
  try {
    bodyText = await getRawBody(req);
  } catch {
    res.status(400).json({ error: "Cuerpo JSON inválido" });
    return;
  }

  const path = upstreamPath.startsWith("/") ? upstreamPath : `/${upstreamPath}`;
  const target = `${base}${path}`;

  let upstream;
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    upstream = await fetch(target, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: bodyText,
      signal: ac.signal
    });
    clearTimeout(t);
  } catch (e) {
    const msg = e?.name === "AbortError" ? "Timeout contactando el backend" : e?.message || String(e);
    res.status(502).json({ error: `No se pudo contactar el backend: ${msg}` });
    return;
  }

  const text = await upstream.text();
  const ct = upstream.headers.get("content-type") || "application/json; charset=utf-8";
  res.status(upstream.status).setHeader("Content-Type", ct).send(text);
}
