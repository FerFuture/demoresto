const axios = require("axios");
const { MercadoPagoConfig, Preference } = require("mercadopago");

const accessToken = process.env.MP_ACCESS_TOKEN;
const currencyId = (process.env.MP_CURRENCY_ID || "ARS").toUpperCase();

let preferenceClient = null;
if (accessToken) {
  const client = new MercadoPagoConfig({ accessToken });
  preferenceClient = new Preference(client);
}

const MP_API_BASE = "https://api.mercadopago.com";

async function createPaymentPreference({ orderId, totalAmount, restaurantName }) {
  if (!preferenceClient) {
    throw new Error("MP_ACCESS_TOKEN no configurado.");
  }

  if (!Number.isFinite(totalAmount) || totalAmount <= 0) {
    throw new Error("El total del pedido debe ser mayor a 0 para generar pago.");
  }

  let preference;
  try {
    preference = await preferenceClient.create({
      body: {
        external_reference: orderId,
        statement_descriptor: "RESTOBOT",
        items: [
          {
            id: orderId,
            title: `Pedido ${restaurantName || "Restaurante"}`,
            quantity: 1,
            currency_id: currencyId,
            unit_price: Number(totalAmount)
          }
        ]
      }
    });
  } catch (error) {
    const msg = String(error?.message || "");
    if (msg.toLowerCase().includes("currency_id invalid")) {
      throw new Error(
        `Mercado Pago rechazo currency_id='${currencyId}'. Configura MP_CURRENCY_ID con una moneda valida para tu cuenta (ej: ARS, CLP, PEN, UYU, BRL, MXN).`
      );
    }
    throw error;
  }

  return preference.init_point;
}

/**
 * Consulta a Mercado Pago si existe un pago para el `orderId` (external_reference).
 * Devuelve el primer pago `approved` encontrado o null si no hay aprobados.
 *
 * Doc: https://www.mercadopago.com.ar/developers/es/reference/payments/_payments_search/get
 */
async function searchApprovedPaymentByExternalReference(orderId) {
  if (!accessToken) {
    throw new Error("MP_ACCESS_TOKEN no configurado.");
  }
  if (!orderId) return null;

  let response;
  try {
    response = await axios.get(`${MP_API_BASE}/v1/payments/search`, {
      params: {
        external_reference: String(orderId),
        sort: "date_created",
        criteria: "desc",
        limit: 5
      },
      headers: {
        Authorization: `Bearer ${accessToken}`
      },
      timeout: 10_000
    });
  } catch (error) {
    const status = error?.response?.status;
    const data = error?.response?.data;
    const detail = typeof data === "object" ? JSON.stringify(data) : String(data || "");
    throw new Error(
      `MP search payments fallo (status=${status || "?"}): ${error.message}${detail ? ` :: ${detail}` : ""}`
    );
  }

  const results = Array.isArray(response?.data?.results) ? response.data.results : [];
  const approved = results.find((p) => String(p?.status || "").toLowerCase() === "approved");
  if (!approved) return null;

  return {
    id: approved.id != null ? String(approved.id) : null,
    status: approved.status || null,
    statusDetail: approved.status_detail || null,
    paymentMethodId: approved.payment_method_id || null,
    paymentTypeId: approved.payment_type_id || null,
    transactionAmount:
      approved.transaction_amount != null ? Number(approved.transaction_amount) : null,
    dateApproved: approved.date_approved || approved.date_created || null,
    rawStatus: approved.status || null
  };
}

module.exports = {
  createPaymentPreference,
  searchApprovedPaymentByExternalReference
};
