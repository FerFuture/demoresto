/**
 * Firma HMAC-SHA256 hex para anclar QR de mesa a restaurante + número de mesa.
 * Debe coincidir con `MESA_QR_SECRET` en el backend (index.js) y `VITE_MESA_QR_SECRET` en el build del dashboard.
 */
export async function signMesaTableToken(restaurantId, tableNumber, secret) {
  const rid = String(restaurantId || "").trim();
  const s = String(secret || "").trim();
  if (!rid || !s) return "";
  const tn = Number(tableNumber);
  if (!Number.isFinite(tn) || tn < 1) return "";

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(s),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const msg = enc.encode(`${rid}|${tn}`);
  const buf = await crypto.subtle.sign("HMAC", key, msg);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
