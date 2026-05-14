/**
 * Proxy en Vercel: el navegador llama POST same-origin /api/mesa/order (HTTPS)
 * y este handler reenvía al backend Node (`index.js`) en la VPS.
 *
 * Variable en Vercel (sin prefijo VITE_): URL base del backend, sin path final.
 * Ejemplo: http://173.212.244.18:3000  o  https://api.tudominio.com
 */

function readStream(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function getRawBody(req) {
  if (req.body != null && typeof req.body === "object" && !Buffer.isBuffer(req.body)) {
    return JSON.stringify(req.body);
  }
  if (typeof req.body === "string" && req.body.length > 0) {
    return req.body;
  }
  const fromStream = await readStream(req);
  return fromStream || "{}";
}

export default async function handler(req, res) {
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

  const base = String(process.env.MESA_API_PROXY_ORIGIN || "")
    .trim()
    .replace(/\/$/, "");
  if (!base) {
    res.status(503).json({
      error:
        "En Vercel definí la variable MESA_API_PROXY_ORIGIN con la URL base del backend (ej. http://TU_VPS:3000 donde corre index.js)."
    });
    return;
  }

  let bodyText;
  try {
    bodyText = await getRawBody(req);
  } catch {
    res.status(400).json({ error: "Cuerpo JSON inválido" });
    return;
  }

  const target = `${base}/api/mesa/order`;

  let upstream;
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 28000);
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
