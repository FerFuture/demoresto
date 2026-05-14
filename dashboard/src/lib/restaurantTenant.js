/** Igual que `database.js`: solo dígitos para comparar WhatsApp. */
export function whatsappDigits(raw) {
  return String(raw ?? "").replace(/\D/g, "");
}

/** Variantes del número del bot (misma lógica que getPossibleIncomingNumbers en database.js). */
export function botNumberMatchCandidates(rawNumber) {
  const normalized = whatsappDigits(rawNumber);
  if (!normalized) return [];

  const variants = new Set([normalized]);

  if (normalized.startsWith("569") && normalized.length === 11) {
    variants.add(`56${normalized.slice(3)}`);
  } else if (normalized.startsWith("56") && normalized.length === 10) {
    variants.add(`569${normalized.slice(2)}`);
  }

  return [...variants];
}

function rowMatchesCandidates(row, candidateSet) {
  const d = whatsappDigits(row?.whatsapp_number);
  if (!d) return false;
  if (candidateSet.has(d)) return true;
  return botNumberMatchCandidates(d).some((v) => candidateSet.has(v));
}

/**
 * Resuelve la fila `restaurants` para el panel (anon).
 * - Con `VITE_BOT_WHATSAPP_NUMBER`: coincide con backend (.in + fallback por dígitos si la columna tiene + / espacios).
 * - Sin número: primera fila por `id` (un solo tenant).
 */
export async function fetchRestaurantForDashboard(supabase) {
  const configuredRaw = import.meta.env.VITE_BOT_WHATSAPP_NUMBER ?? "";
  const candidates = botNumberMatchCandidates(configuredRaw);

  if (candidates.length > 0) {
    const candidateSet = new Set(candidates);

    const { data: rowsIn, error: errIn } = await supabase
      .from("restaurants")
      .select(
        "id, name, whatsapp_number, delivery_enabled, local_enabled, mesa_enabled, cash_enabled, mercadopago_enabled, stats_enabled, table_count, metadata"
      )
      .in("whatsapp_number", candidates);

    if (errIn) return { data: null, error: errIn };

    const firstExact = (rowsIn || [])[0];
    if (firstExact) return { data: firstExact, error: null };

    const { data: rowsScan, error: errScan } = await supabase
      .from("restaurants")
      .select(
        "id, name, whatsapp_number, delivery_enabled, local_enabled, mesa_enabled, cash_enabled, mercadopago_enabled, stats_enabled, table_count, metadata"
      )
      .order("id", { ascending: true })
      .limit(200);

    if (errScan) return { data: null, error: errScan };

    const fallback = (rowsScan || []).find((row) => rowMatchesCandidates(row, candidateSet));
    return { data: fallback || null, error: null };
  }

  const { data, error } = await supabase
    .from("restaurants")
    .select(
      "id, name, whatsapp_number, delivery_enabled, local_enabled, mesa_enabled, cash_enabled, mercadopago_enabled, stats_enabled, table_count, metadata"
    )
    .order("id", { ascending: true })
    .limit(1)
    .maybeSingle();

  return { data: data || null, error: error || null };
}
